/**
 * Run repository（03 §4 runs 表、08 §3.2/§4.2/§7/§8.1）。
 *
 * 代际与配额都由数据库裁决：
 * - 每 Task 至多一个有效写 run：部分唯一索引 + 代际 CAS（08 §4.2，断网不授权第二个 run）；
 * - runGeneration 在事务内递增，旧代际的 handle/租期/epoch 写入一律不生效；
 * - 配额按「非终态且未确认释放」计数（01 §4.3：终止结果未确认不释放槽）。
 * 恢复扫描（03 §8）用 `listNonTerminal`，不靠内存表重建事实。
 */
import { cloudExecutionRecipeSchema, cloudRunStatusSchema } from "@zcode/shared";
import type { CloudRunRecord } from "@zcode/shared";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { mapRunRow, toJsonColumn } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import type { ReserveRunRequest, RunReservation } from "../../../app/ports/storagePort.js";
import { ACTIVE_RUN_STATUSES } from "../sqlite/schema.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";
import { requireTaskRow } from "./taskRepo.js";

const ACTIVE_STATUS_SQL = ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", ");

export function selectRun(context: StorageContext, runId: string): SqlRow | undefined {
  return context.db.prepare("SELECT * FROM runs WHERE run_id = ?").get(runId);
}

function requireRun(context: StorageContext, runId: string): SqlRow {
  const row = selectRun(context, runId);
  if (!row) {
    throw new CloudStorageError({
      code: "not_found",
      reason: "not-found",
      message: `Run ${runId} 不存在`,
    });
  }
  return row;
}

function selectActiveRun(context: StorageContext, taskId: string): SqlRow | undefined {
  return context.db
    .prepare(
      `SELECT * FROM runs WHERE task_id = ? AND status IN (${ACTIVE_STATUS_SQL})
       ORDER BY run_generation DESC LIMIT 1`,
    )
    .get(taskId);
}

/**
 * 事务内预约新 run（调用方必须已经处于写事务中，acceptInput 与本文件的 handler 共用）。
 * 校验顺序：Task 存在 → 无有效写 run → 配额 → 分配 generation → 写 Task.activeRunId。
 */
export function reserveRunInTransaction(
  context: StorageContext,
  request: ReserveRunRequest,
): RunReservation {
  const task = requireTaskRow(context, request.taskId);
  const recipe = cloudExecutionRecipeSchema.parse(request.executionRecipe);

  if (selectActiveRun(context, request.taskId)) {
    throw new CloudStorageError({
      code: "stale",
      reason: "active-write-run-exists",
      message: "Task 已存在有效写 run，不能并行分配第二个（08 §4.2）",
    });
  }

  // 槽位从预约保留到「provider 确认资源释放」（quota_released_at）：终态但终止结果
  // 未知的 run 仍占槽，不能靠状态变化或删 Task 释放（01 §4.3）。
  const occupied = context.db
    .prepare("SELECT COUNT(*) AS total FROM runs WHERE quota_released_at IS NULL")
    .get();
  const inUse = Number(occupied?.["total"] ?? 0);
  if (inUse >= request.quota.maxConcurrentRuns) {
    throw new CloudStorageError({
      code: "quota_exceeded",
      reason: "invalid-record",
      message: `并发 run 配额已满（${inUse}/${request.quota.maxConcurrentRuns}）`,
    });
  }

  const runGeneration = Number(task["next_run_generation"]);
  context.db
    .prepare(
      `INSERT INTO runs (
         run_id, task_id, run_generation, execution_kind, first_input_command_id,
         execution_recipe_json, provider, workspace_path, status, connection_epoch,
         data_at_risk, created_at, updated_at
       ) VALUES (?, ?, ?, 'sandbox', ?, ?, ?, ?, 'provisioning', 1, 0, ?, ?)`,
    )
    .run(
      request.runId,
      request.taskId,
      runGeneration,
      request.firstInputCommandId ?? null,
      toJsonColumn(recipe),
      recipe.provider,
      request.workspacePath ?? null,
      request.now,
      request.now,
    );
  context.db
    .prepare(
      `UPDATE tasks SET active_run_id = ?, next_run_generation = ?, updated_at = ? WHERE task_id = ?`,
    )
    .run(request.runId, runGeneration + 1, request.now, request.taskId);

  return { run: mapRunRow(requireRun(context, request.runId)), runGeneration };
}

/**
 * 请求寿命落库（01 §4.3、08 §7、审计 D4-7）：接纳事务内与 run 预约同一事务写
 * hardDeadlineAt 及可选的保守估计（估计必须带置信度）。CAS 按 run_generation 匹配；
 * 调用方（acceptInput）必须已处于同一写事务内——create worker 领取操作时硬期限已可见，
 * 不存在「事务提交后补写」的崩溃窗口。写入未命中（run/generation 不匹配）返回 false。
 */
export function applyRunLifetimeInTransaction(
  context: StorageContext,
  input: {
    runId: string;
    runGeneration: number;
    lease: { hardDeadlineAt: number; deadlineEstimate?: number; deadlineConfidence?: string };
    now: number;
  },
): boolean {
  const changes = context.db
    .prepare(
      `UPDATE runs SET
         hard_deadline_at = ?,
         deadline_estimate = COALESCE(?, deadline_estimate),
         deadline_confidence = COALESCE(?, deadline_confidence),
         updated_at = ?
       WHERE run_id = ? AND run_generation = ?`,
    )
    .run(
      input.lease.hardDeadlineAt,
      input.lease.deadlineEstimate ?? null,
      input.lease.deadlineConfidence ?? null,
      input.now,
      input.runId,
      input.runGeneration,
    );
  return Number(changes.changes) > 0;
}

export const runRepoHandlers = {
  "runs.get": (context, params): CloudRunRecord | null => {
    const row = selectRun(context, params.runId);
    return row ? mapRunRow(row) : null;
  },

  "runs.activeOfTask": (context, params): CloudRunRecord | null => {
    const row = selectActiveRun(context, params.taskId);
    return row ? mapRunRow(row) : null;
  },

  "runs.reserveRun": (context, params): RunReservation =>
    withWriteTransaction(context, () => reserveRunInTransaction(context, params)),

  "runs.listNonTerminal": (context): CloudRunRecord[] =>
    context.db
      .prepare(
        `SELECT * FROM runs WHERE status IN (${ACTIVE_STATUS_SQL}) ORDER BY created_at, run_id`,
      )
      .all()
      .map(mapRunRow),

  /** provider handle/期限：必须匹配 runGeneration（01 §5.1 第 3 条）。 */
  "runs.recordProviderHandle": (context, params): boolean => {
    const changes = context.db
      .prepare(
        `UPDATE runs SET
           provider = ?,
           provider_handle = ?,
           workspace_path = COALESCE(?, workspace_path),
           expires_at = COALESCE(?, expires_at),
           deadline_estimate = COALESCE(?, deadline_estimate),
           updated_at = ?
         WHERE run_id = ? AND run_generation = ?`,
      )
      .run(
        params.provider,
        params.providerHandle,
        params.workspacePath ?? null,
        params.providerDeadline ?? null,
        params.deadlineEstimate ?? null,
        params.now,
        params.runId,
        params.runGeneration,
      );
    return Number(changes.changes) > 0;
  },

  "runs.transitionStatus": (context, params): CloudRunRecord | null => {
    cloudRunStatusSchema.parse(params.to);
    for (const status of params.from) cloudRunStatusSchema.parse(status);
    if (params.from.length === 0) return null;
    const placeholders = params.from.map(() => "?").join(", ");
    return withWriteTransaction(context, () => {
      const changes = context.db
        .prepare(
          `UPDATE runs SET
             status = ?,
             end_reason = COALESCE(?, end_reason),
             last_error = COALESCE(?, last_error),
             data_at_risk = CASE WHEN ? = 1 THEN ? ELSE data_at_risk END,
             updated_at = ?
           WHERE run_id = ? AND run_generation = ? AND status IN (${placeholders})
             AND status NOT IN ('stopped','expired','failed')`,
        )
        .run(
          params.to,
          params.endReason ?? null,
          params.lastError ?? null,
          params.dataAtRisk === undefined ? 0 : 1,
          params.dataAtRisk === undefined ? 0 : params.dataAtRisk ? 1 : 0,
          params.now,
          params.runId,
          params.runGeneration,
          ...params.from,
        );
      if (Number(changes.changes) === 0) return null;
      return mapRunRow(requireRun(context, params.runId));
    });
  },

  /** 连接接管：epoch 严格递增 CAS；落后的 expectedEpoch 返回 null（02 §2 不变量 3）。 */
  "runs.bumpConnectionEpoch": (context, params): number | null => {
    return withWriteTransaction(context, () => {
      const changes = context.db
        .prepare(
          `UPDATE runs SET connection_epoch = connection_epoch + 1
           WHERE run_id = ? AND run_generation = ? AND connection_epoch = ?
             AND status IN (${ACTIVE_STATUS_SQL})`,
        )
        .run(params.runId, params.runGeneration, params.expectedEpoch);
      if (Number(changes.changes) === 0) return null;
      return Number(requireRun(context, params.runId)["connection_epoch"]);
    });
  },

  /** 租期事实：只能更新当前代际；估计期限必须带置信度（08 §7）。 */
  "runs.updateLease": (context, params): boolean => {
    const row = selectRun(context, params.runId);
    if (!row || Number(row["run_generation"]) !== params.runGeneration) return false;
    if (params.deadlineEstimate !== undefined && params.deadlineConfidence === undefined) {
      if (row["deadline_confidence"] === null || row["deadline_confidence"] === undefined) {
        throw new CloudStorageError({
          code: "validation_failed",
          reason: "invalid-record",
          message: "估计期限必须携带 deadlineConfidence（08 §7）",
        });
      }
    }
    const changes = context.db
      .prepare(
        `UPDATE runs SET
           expires_at = COALESCE(?, expires_at),
           deadline_estimate = COALESCE(?, deadline_estimate),
           deadline_confidence = COALESCE(?, deadline_confidence),
           hard_deadline_at = COALESCE(?, hard_deadline_at),
           updated_at = ?
         WHERE run_id = ? AND run_generation = ?`,
      )
      .run(
        params.expiresAt ?? null,
        params.deadlineEstimate ?? null,
        params.deadlineConfidence ?? null,
        params.hardDeadlineAt ?? null,
        params.now,
        params.runId,
        params.runGeneration,
      );
    return Number(changes.changes) > 0;
  },

  /** 业务活动：heartbeat/观看不算活动，由调用方保证只写真实业务活动（08 §7）。 */
  "runs.touchBusinessActivity": (context, params): void => {
    context.db
      .prepare("UPDATE runs SET last_business_activity_at = ? WHERE run_id = ?")
      .run(params.at, params.runId);
  },

  /**
   * 停止屏障（08 §8.1）：只写当前有效 run 的持久 stopRequested + operationId，
   * 不改写 run 状态（状态迁移由调用方按允许操作表 CAS）。已经请求停止时保持原
   * operationId 并返回 true：屏障已存在，不得被第二个 stop 请求改写依赖链。
   */
  "runs.requestStop": (context, params): boolean => {
    return withWriteTransaction(context, () => {
      const active = selectActiveRun(context, params.taskId);
      if (!active) return false;
      if (Number(active["stop_requested"]) === 1) return true;
      const changes = context.db
        .prepare(
          `UPDATE runs SET stop_requested = 1, stop_operation_id = ?, updated_at = ?
           WHERE run_id = ? AND stop_requested = 0`,
        )
        .run(params.operationId, params.now, String(active["run_id"]));
      return Number(changes.changes) > 0;
    });
  },

  /** 撤销停止意图：必须匹配原 operationId，且只对非终态 run 生效（08 §8.1）。 */
  "runs.clearStopRequest": (context, params): boolean => {
    const changes = context.db
      .prepare(
        `UPDATE runs SET stop_requested = 0, stop_operation_id = NULL
         WHERE task_id = ? AND stop_requested = 1 AND stop_operation_id = ?
           AND status IN (${ACTIVE_STATUS_SQL})`,
      )
      .run(params.taskId, params.expectedOperationId);
    return Number(changes.changes) > 0;
  },

  /**
   * runtime 会话映射（02 §6.2）：CAS 写，必须匹配 runGeneration 且 run 非终态——
   * 旧代际/终态 run 的迟到 session 不得覆盖新事实（重连不重造会话）。
   */
  "runs.setRunRuntimeSessionId": (context, params): boolean => {
    const changes = context.db
      .prepare(
        `UPDATE runs SET runtime_session_id = ?, updated_at = ?
         WHERE run_id = ? AND run_generation = ? AND status IN (${ACTIVE_STATUS_SQL})`,
      )
      .run(params.runtimeSessionId, params.now, params.runId, params.runGeneration);
    return Number(changes.changes) > 0;
  },

  /**
   * 保存风险标记（08 §7/§8.2）：CAS 写当前代际。**不限制状态**——dataAtRisk 正是在
   * 终止/失败路径上被标记的，加终态条件会让它永远写不进去。
   */
  "runs.setRunDataAtRisk": (context, params): boolean => {
    const changes = context.db
      .prepare(
        `UPDATE runs SET data_at_risk = ?, updated_at = ?
         WHERE run_id = ? AND run_generation = ?`,
      )
      .run(params.dataAtRisk ? 1 : 0, params.now, params.runId, params.runGeneration);
    return Number(changes.changes) > 0;
  },

  /** 配额释放只有在 provider 确认资源释放后才调用（01 §4.3）；重复释放是幂等的。 */
  "runs.releaseQuota": (context, params): void => {
    context.db
      .prepare(
        `UPDATE runs SET quota_released_at = ?, quota_release_reason = ?
         WHERE run_id = ? AND quota_released_at IS NULL`,
      )
      .run(params.now, params.reason, params.runId);
  },
} satisfies Pick<
  StorageHandlerTable,
  | "runs.get"
  | "runs.activeOfTask"
  | "runs.reserveRun"
  | "runs.listNonTerminal"
  | "runs.recordProviderHandle"
  | "runs.transitionStatus"
  | "runs.bumpConnectionEpoch"
  | "runs.updateLease"
  | "runs.touchBusinessActivity"
  | "runs.requestStop"
  | "runs.clearStopRequest"
  | "runs.releaseQuota"
  | "runs.setRunRuntimeSessionId"
  | "runs.setRunDataAtRisk"
>;

/** 供其他 repository 复用的有效 run 查询（acceptInput 用）。 */
export function findActiveRun(context: StorageContext, taskId: string): CloudRunRecord | null {
  const row = selectActiveRun(context, taskId);
  return row ? mapRunRow(row) : null;
}

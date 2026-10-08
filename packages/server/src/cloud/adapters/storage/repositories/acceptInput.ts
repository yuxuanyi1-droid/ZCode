/**
 * 接纳事务（03 §5/§6.1、08 §5、11 §6）：唯一持久入口。
 *
 * 一次事务内完成：去重 → revision/Task/Run/stop/配额校验 → 写 Input（含正文与附件
 * 引用）、acceptanceSeq、Run 与 executionRecipe、firstInputCommandId、Task 基线冻结、
 * create 操作意图。DB 提交成功才可能返回 accepted；失败/磁盘满/迁移未就绪时既没有
 * receipt 也没有 create 意图（03 §4、CP-02）。
 *
 * 合法重放（同 commandId 同 payloadHash）返回原 receipt，不因 revision 增长而失败；
 * 同 commandId 不同 payloadHash 返回 idempotency_conflict（03 §6.1）。
 */
import { randomUUID } from "node:crypto";
import { CLOUD_INPUT_LIMITS, cloudUuidSchema, cloudDraftStartConfigSchema } from "@zcode/shared";
import type { InputReceipt } from "@zcode/shared";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { mapInputRow, toJsonColumn } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import type { AcceptInputRequest, AcceptInputResult } from "../../../app/ports/storagePort.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";
import {
  adoptDraftStartConfigIfAbsent,
  draftStartConfigEquals,
  readPersistedDraftStartConfig,
  requireTaskRow,
  selectTask,
} from "./taskRepo.js";
import {
  applyRunLifetimeInTransaction,
  findActiveRun,
  reserveRunInTransaction,
  selectRun,
} from "./runRepo.js";
import { DEFAULT_ATTACHMENT_LIMITS } from "../attachments/attachmentTypes.js";

type ConflictResult = Extract<AcceptInputResult, { status: "conflict" }>;

function conflict(code: ConflictResult["code"], reason: ConflictResult["reason"]): ConflictResult {
  return { status: "conflict", code, reason };
}

function validateRequest(request: AcceptInputRequest): void {
  cloudUuidSchema.parse(request.taskId);
  cloudUuidSchema.parse(request.commandId);
  if (!/^[0-9a-f]{64}$/.test(request.payloadHash)) invalid("payloadHash 必须是 sha256 十六进制");
  if (request.prompt.length === 0 || request.prompt.length > CLOUD_INPUT_LIMITS.promptMaxChars) {
    invalid(`输入正文长度必须在 1..${CLOUD_INPUT_LIMITS.promptMaxChars} 之间`);
  }
  if (!Number.isInteger(request.quota.maxConcurrentRuns) || request.quota.maxConcurrentRuns < 1) {
    invalid("quota.maxConcurrentRuns 必须是正整数");
  }
  if ((request.attachmentIds?.length ?? 0) > DEFAULT_ATTACHMENT_LIMITS.maxPerInput) {
    invalid("附件数量超过单条输入上限");
  }
  if (request.runId !== undefined) cloudUuidSchema.parse(request.runId);
  // create 操作的持久意图只属于会创建 Run 的意图（W1 CR-2）：append 不创建 create
  // 操作，携带占位 id 会在 outbox 留下永不结算的假操作（见 requireCreateOperationId）。
  if (request.intent === "append" && request.createOperationId !== undefined) {
    invalid("append 不得携带 createOperationId（不创建 create 操作）");
  }
  if (request.createOperationId !== undefined) cloudUuidSchema.parse(request.createOperationId);
  // 请求寿命（D4-7）：start/reopen 必须在接纳事务内落 runs 行；append 不改写租期事实。
  if (request.lease !== undefined) {
    if (request.intent === "append") invalid("append 不得携带 lease（不改写已冻结租期）");
    if (
      !Number.isFinite(request.lease.hardDeadlineAt) ||
      request.lease.hardDeadlineAt <= request.now
    ) {
      invalid("lease.hardDeadlineAt 必须是晚于接纳时刻的有限时间戳");
    }
    if (
      request.lease.deadlineEstimate !== undefined &&
      request.lease.deadlineConfidence === undefined
    ) {
      invalid("lease.deadlineEstimate 必须携带 deadlineConfidence（08 §7）");
    }
  }
}

/** 取 start/reopen 必填的 create 操作 id；缺失是调用方错误，fail closed。 */
function requireCreateOperationId(request: AcceptInputRequest): string {
  if (request.createOperationId === undefined) {
    invalid(`${request.intent} 必须携带 createOperationId`);
  }
  return request.createOperationId;
}

function invalid(message: string): never {
  throw new CloudStorageError({ code: "validation_failed", reason: "invalid-record", message });
}

function selectInput(
  context: StorageContext,
  taskId: string,
  commandId: string,
): SqlRow | undefined {
  return context.db
    .prepare("SELECT * FROM task_inputs WHERE task_id = ? AND command_id = ?")
    .get(taskId, commandId);
}

/** receipt 是按当前持久事实重建的投影，不保存正文与 secret（03 §6.1）。 */
function buildReceipt(context: StorageContext, row: SqlRow): InputReceipt {
  const record = mapInputRow(row);
  const receipt: InputReceipt = {
    taskId: record.taskId,
    commandId: record.commandId,
    deliveryStatus: record.deliveryStatus,
  };
  if (record.targetRunId) {
    receipt.runId = record.targetRunId;
    const run = selectRun(context, record.targetRunId);
    if (run) receipt.runGeneration = Number(run["run_generation"]);
  }
  if (record.runtimeAck) receipt.runtimeAck = record.runtimeAck;
  return receipt;
}

function acceptInputInTransaction(
  context: StorageContext,
  request: AcceptInputRequest,
): AcceptInputResult {
  validateRequest(request);
  const task = requireTaskRow(context, request.taskId);

  // ① 去重先于新请求 CAS：同 key 同 fingerprint 返回原 receipt，不同 fingerprint 409。
  const existing = selectInput(context, request.taskId, request.commandId);
  if (existing) {
    const record = mapInputRow(existing);
    if (record.payloadHash !== request.payloadHash) {
      return conflict("idempotency_conflict", "payload-mismatch");
    }
    return { status: "duplicate", receipt: buildReceipt(context, existing) };
  }

  const activeRun = findActiveRun(context, request.taskId);
  const taskStatus = String(task["status"]);
  const taskRevision = Number(task["revision"]);

  if (request.intent === "start") {
    // start 仅属于 draft：active 上的新 start 冲突，不降级为 append（08 §5）。
    if (taskStatus !== "draft") return conflict("stale", "start-on-active");
    if (activeRun) return conflict("stale", "start-on-active");
    if (
      request.expectedTaskRevision !== undefined &&
      request.expectedTaskRevision !== taskRevision
    ) {
      return conflict("stale", "revision-mismatch");
    }
    // 启动选择必须与已持久 draftStartConfig 一致（03 §6「事务验证两者一致」，W1 CR-1）。
    if (!request.start) invalid("start 必须携带 start 启动选择（与已持久 draft 一致）");
    const persistedDraft = readPersistedDraftStartConfig(task);
    if (persistedDraft && !draftStartConfigEquals(persistedDraft, request.start)) {
      return conflict("stale", "start-config-mismatch");
    }
  }

  if (request.intent === "append") {
    if (!activeRun) return conflict("stale", "no-active-run");
    if (request.expectedRunGeneration === undefined) {
      invalid("append 必须携带 expectedRunGeneration（03 §6.1）");
    }
    if (request.expectedRunGeneration !== activeRun.runGeneration) {
      return conflict("stale", "generation-stale");
    }
    if (activeRun.stopRequested) return conflict("stale", "stop-requested");
    // provisioning/disconnected 不接受新 append；paused 例外＝202 接收+自驱 resume（03 §6 修订）。
    if (activeRun.status !== "ready" && activeRun.status !== "paused")
      return conflict("not_ready", "not-ready");
    if (taskStatus !== "active") return conflict("stale", "not-ready");
  }

  if (request.intent === "reopen") {
    // 旧 run 必须已终态：无法确认旧写权处置时返回 recovery_required（02 §2 不变量 5、08 §9）。
    if (activeRun) return conflict("recovery_required", "start-on-active");
    if (taskStatus === "draft" || taskStatus === "archived") {
      return conflict("stale", "start-on-active");
    }
  }

  // ② 附件引用必须是本 owner 已发布的对象，且在同一事务里被标记引用（03 §4）。
  if (request.attachmentIds && request.attachmentIds.length > 0) {
    markAttachmentsReferenced(context, {
      ownerPrincipalId: String(task["owner_principal_id"]),
      attachmentIds: request.attachmentIds,
      taskId: request.taskId,
      now: request.now,
    });
  }

  // ③ acceptanceSeq 在 Task 内事务性递增（03 §6.2），唯一索引再做一次硬保证。
  const seqRow = context.db
    .prepare(
      "SELECT COALESCE(MAX(acceptance_seq), 0) AS last_seq FROM task_inputs WHERE task_id = ?",
    )
    .get(request.taskId);
  const acceptanceSeq = Number(seqRow?.["last_seq"] ?? 0) + 1;

  let runId: string | undefined;
  let runGeneration: number | undefined;
  if (request.intent === "start" || request.intent === "reopen") {
    if (!request.runRecipe) invalid("start/reopen 必须在接纳事务中固定 executionRecipe");
    const recipe = request.runRecipe;
    if (recipe.baseSha === undefined) invalid("executionRecipe.baseSha 必须已解析冻结（11 §6）");
    runId = request.runId ?? randomUUID();
    let reservation;
    try {
      reservation = reserveRunInTransaction(context, {
        taskId: request.taskId,
        runId,
        executionRecipe: recipe,
        firstInputCommandId: request.commandId,
        workspacePath: undefined,
        quota: request.quota,
        now: request.now,
      });
    } catch (error) {
      if (error instanceof CloudStorageError && error.code === "quota_exceeded") {
        return conflict("quota_exceeded", "quota-exceeded");
      }
      throw error;
    }
    runGeneration = reservation.runGeneration;
    // 请求寿命与 run 预约同一事务落库（D4-7/审计 #10）：create worker 领取操作时
    // hardDeadlineAt 已可见，消除了「事务提交后 gateway 单独 updateLease 补写」的
    // 崩溃窗口（补写丢失 → create 读不到走本地重算、租期无上界）。计算是本地预算，
    // 预检期已完成，事务内只做写入，无 provider IO（03 §5 纪律）。
    if (request.lease) {
      const applied = applyRunLifetimeInTransaction(context, {
        runId,
        runGeneration: reservation.runGeneration,
        lease: request.lease,
        now: request.now,
      });
      if (!applied) invalid("Run 租期在接纳事务中未能落库");
    }
    // 先落唯一 draftStartConfig（无草稿时），再冻结基线：baseBranch 取自该选择（11 §5/§6）。
    if (request.intent === "start" && request.start) {
      adoptDraftStartConfigIfAbsent(context, request);
    }
    freezeBaselineInTransaction(context, request, recipe.baseSha, recipe.resumeSha);
    enqueueCreateOperation(
      context,
      request,
      runId,
      reservation.runGeneration,
      requireCreateOperationId(request),
    );
  } else {
    runId = activeRun?.runId;
    runGeneration = activeRun?.runGeneration;
  }

  context.db
    .prepare(
      `INSERT INTO task_inputs (
         task_id, command_id, owner_principal_id, intent, payload_hash, prompt,
         attachment_ids_json, requested_config_json, resolved_execution_config_json,
         resolved_authorization_ref, retry_of_command_id, acceptance_seq, accepted_at,
         target_run_id, delivery_status, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
    )
    .run(
      request.taskId,
      request.commandId,
      String(task["owner_principal_id"]),
      request.intent,
      request.payloadHash,
      request.prompt,
      toJsonColumn(request.attachmentIds),
      toJsonColumn(request.requestedConfig),
      toJsonColumn(request.resolvedExecutionConfig),
      request.resolvedAuthorizationRef ?? null,
      null,
      acceptanceSeq,
      request.now,
      runId ?? null,
      request.now,
    );

  const statusBeforeTransition = taskStatus;
  if (request.intent === "start" || request.intent === "reopen") {
    // start：draft → active；reopen：终态/active → active（工作委托重新可继续）。
    // 全流程在同一事务内，状态条件足够；revision 在这里统一递增一次（冻结基线不再单独加）。
    const changes = context.db
      .prepare(
        `UPDATE tasks SET status = 'active', revision = revision + 1, updated_at = ?
         WHERE task_id = ? AND status = ?`,
      )
      .run(request.now, request.taskId, statusBeforeTransition);
    if (Number(changes.changes) === 0) invalid("Task 状态在接纳事务中发生变化");
  }

  const inserted = selectInput(context, request.taskId, request.commandId);
  if (!inserted) invalid("输入持久化失败");
  return {
    status: "accepted",
    receipt: buildReceipt(context, inserted),
    ...(runId === undefined ? {} : { runId }),
    ...(runGeneration === undefined ? {} : { runGeneration }),
  };
}

/** 首次接纳冻结 baseBranch/baseSha/taskBranch；已冻结时保持原值（11 §6）。 */
function freezeBaselineInTransaction(
  context: StorageContext,
  request: AcceptInputRequest,
  baseSha: string,
  resumeSha: string | undefined,
): void {
  const task = selectTask(context, request.taskId);
  if (!task) return;
  if (task["base_sha"] !== null && task["base_sha"] !== undefined) return;
  const draftConfig = task["draft_start_config_json"];
  let baseBranch: string | null = null;
  if (typeof draftConfig === "string") {
    try {
      const parsed = cloudDraftStartConfigSchema.safeParse(JSON.parse(draftConfig));
      if (parsed.success) baseBranch = parsed.data.baseBranch;
    } catch {
      // 草稿配置损坏时只丢 baseBranch 回填，不掩盖接纳事务本身。
      baseBranch = null;
    }
  }
  // revision 由接纳事务统一递增（一次接纳只算一次元数据变更），这里不再单独加。
  // 重开路径以最后确认的 checkpoint SHA 作为恢复起点；首次接纳以 baseSha 为起点。
  context.db
    .prepare(
      `UPDATE tasks SET
         base_branch = COALESCE(base_branch, ?),
         base_sha = ?,
         task_branch = COALESCE(task_branch, ?),
         updated_at = ?
       WHERE task_id = ?`,
    )
    .run(baseBranch, resumeSha ?? baseSha, request.taskBranch ?? null, request.now, request.taskId);
}

/**
 * create 操作与接纳同事务持久（03 §5）：provider create 不是 DB 事务，必须先有
 * durable 意图才能在崩溃后按 operationId 对账，避免第二个沙箱。
 */
function enqueueCreateOperation(
  context: StorageContext,
  request: AcceptInputRequest,
  runId: string,
  runGeneration: number,
  createOperationId: string,
): void {
  context.db
    .prepare(
      `INSERT OR IGNORE INTO external_operations (
         operation_id, kind, idempotency_key, task_id, run_id, run_generation,
         state, attempt, created_at, updated_at
       ) VALUES (?, 'create', ?, ?, ?, ?, 'pending', 0, ?, ?)`,
    )
    .run(
      createOperationId,
      `create:${runId}`,
      request.taskId,
      runId,
      runGeneration,
      request.now,
      request.now,
    );
}

/** 附件引用：必须是同一 owner 的已发布对象，否则 fail closed（03 §4、§6）。 */
function markAttachmentsReferenced(
  context: StorageContext,
  input: {
    ownerPrincipalId: string;
    attachmentIds: readonly string[];
    taskId: string;
    now: number;
  },
): void {
  for (const attachmentId of input.attachmentIds) {
    const changes = context.db
      .prepare(
        `UPDATE attachment_objects SET referenced_at = ?, last_referenced_task_id = ?
         WHERE owner_principal_id = ? AND sha256 = ? AND state = 'published'`,
      )
      .run(input.now, input.taskId, input.ownerPrincipalId, attachmentId);
    if (Number(changes.changes) === 0) {
      throw new CloudStorageError({
        code: "validation_failed",
        reason: "attachment-not-published",
        message: `附件 ${attachmentId} 未发布或不属于当前主体`,
      });
    }
  }
}

export const acceptInputHandlers = {
  "storage.acceptInput": (context, params): AcceptInputResult =>
    withWriteTransaction(context, () => acceptInputInTransaction(context, params)),
} satisfies Pick<StorageHandlerTable, "storage.acceptInput">;

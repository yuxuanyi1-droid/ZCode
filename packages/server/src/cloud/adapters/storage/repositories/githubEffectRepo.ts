/**
 * GitHubEffect outbox 的持久实现（09 §5.2 外部幂等 effect、§8 `GitHubEffect` 行、
 * 03 §5 外部操作不是数据库事务）。
 *
 * 同一张 `external_operations` 表承载两个 facet，用 `business_key` 区分：
 * - provider/生命周期操作（`OperationOutboxPort`）：`business_key IS NULL`，幂等键是
 *   `idempotency_key`；
 * - GitHub effect（本文件）：`business_key` 非空，业务键同时充当 `idempotency_key`
 *   （09 §5.2 第 1 条「业务键唯一」）。
 * 两个 facet 的恢复扫描因此互不串台：provider 侧看不到 effect，effect 侧也不会把
 * provider 操作当成 GitHub 发布任务领走。
 *
 * 不变量：`enqueue` 以 businessKey 幂等（不产生第二个 worker 目标）；`leaseNext`
 * 只领取 pending/ambiguous 或租约到期的记录且 `nextAttemptAt <= now`；`settle` 必须
 * 匹配 leaseToken（迟到 worker 不得改写结果）；secret 不进 payload（只存 payloadRef）。
 */
import { randomUUID } from "node:crypto";
import type {
  GitHubEffectKind,
  GitHubEffectRecord,
  GitHubEffectSettleOutcome,
  LeasedGitHubEffect,
} from "../../../app/ports/gitHubEffectPort.js";
import { isCloudErrorCode } from "@zcode/shared";
import type { CloudErrorCode } from "@zcode/shared";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { readInt, readOptionalInt, readOptionalText, readText } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import { GITHUB_EFFECT_KIND_VALUES } from "../sqlite/schema.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

function invalid(message: string): CloudStorageError {
  return new CloudStorageError({ code: "validation_failed", reason: "invalid-record", message });
}

function mapEffectRow(row: SqlRow): GitHubEffectRecord {
  return {
    effectId: readText(row, "operation_id"),
    businessKey: readText(row, "business_key"),
    kind: readText(row, "kind") as GitHubEffectKind,
    ...optional("taskId", readOptionalText(row, "task_id")),
    ...optional("runId", readOptionalText(row, "run_id")),
    ...optional("runGeneration", readOptionalInt(row, "run_generation")),
    ...optional("repositoryId", readOptionalInt(row, "repository_id")),
    ...optional("taskBranch", readOptionalText(row, "task_branch")),
    ...optional("baseBranch", readOptionalText(row, "base_branch")),
    desiredRevision: readOptionalInt(row, "desired_revision") ?? 0,
    ...optional("expectedHeadSha", readOptionalText(row, "expected_head_sha")),
    ...optional("payloadRef", readOptionalText(row, "payload_ref")),
    status: readText(row, "state") as GitHubEffectRecord["status"],
    attempts: readInt(row, "attempt"),
    nextAttemptAt: readOptionalInt(row, "next_attempt_at") ?? 0,
    ...optional("leaseToken", readOptionalText(row, "lease_token")),
    ...optional("leaseExpiresAt", readOptionalInt(row, "lease_expires_at")),
    ...optional("remoteId", readOptionalText(row, "remote_id")),
    ...optional("resultRef", readOptionalText(row, "result_ref")),
    ...optional("lastErrorCode", readEffectErrorCode(row)),
    ...optional("lastError", readOptionalText(row, "last_error")),
    createdAt: readInt(row, "created_at"),
    updatedAt: readInt(row, "updated_at"),
  };
}

/** 目录外的历史错误码按「无错误码」读（见 gitGrantRepo 同名注释）。 */
function readEffectErrorCode(row: SqlRow): CloudErrorCode | undefined {
  const value = readOptionalText(row, "error_code");
  return value !== undefined && isCloudErrorCode(value) ? value : undefined;
}

function optional<Key extends string, Value>(key: Key, value: Value | undefined) {
  return (value === undefined ? {} : { [key]: value }) as { [K in Key]?: Value };
}

function selectEffect(context: StorageContext, effectId: string): SqlRow | undefined {
  return context.db
    .prepare(
      "SELECT * FROM external_operations WHERE operation_id = ? AND business_key IS NOT NULL",
    )
    .get(effectId);
}

function requireEffectRow(context: StorageContext, effectId: string): SqlRow {
  const row = selectEffect(context, effectId);
  if (!row) {
    throw new CloudStorageError({
      code: "not_found",
      reason: "not-found",
      message: `GitHub effect ${effectId} 不存在`,
    });
  }
  return row;
}

const SETTLE_STATE: Readonly<Record<GitHubEffectSettleOutcome, string>> = {
  settled: "settled",
  failed: "failed",
  ambiguous: "ambiguous",
  retry: "pending",
};

export const githubEffectRepoHandlers = {
  "effects.enqueue": (context, params): { effect: GitHubEffectRecord; created: boolean } => {
    if (!GITHUB_EFFECT_KIND_VALUES.includes(params.kind)) {
      throw invalid(`未知 GitHub effect 种类 ${params.kind}`);
    }
    if (params.businessKey.trim().length === 0) throw invalid("businessKey 不能为空");
    return withWriteTransaction(context, () => {
      const byId = context.db
        .prepare("SELECT * FROM external_operations WHERE operation_id = ?")
        .get(params.effectId);
      if (byId && String(byId["business_key"] ?? "") !== params.businessKey) {
        throw invalid("effectId 已被另一业务键占用");
      }
      const existing = context.db
        .prepare("SELECT * FROM external_operations WHERE business_key = ?")
        .get(params.businessKey);
      if (existing) {
        if (String(existing["kind"]) !== params.kind) {
          throw invalid("同一业务键不能对应不同 effect 种类");
        }
        // 同键重复入队：不产生第二个 worker 目标；只把 desiredRevision 单调推进，
        // 并补齐调用方新提供的核验事实（09 §5.2 第 2 条）。
        context.db
          .prepare(
            `UPDATE external_operations SET
               desired_revision = MAX(COALESCE(desired_revision, 0), ?),
               expected_head_sha = COALESCE(?, expected_head_sha),
               payload_ref = COALESCE(?, payload_ref),
               updated_at = ?
             WHERE business_key = ?`,
          )
          .run(
            params.desiredRevision,
            params.expectedHeadSha ?? null,
            params.payloadRef ?? null,
            params.now,
            params.businessKey,
          );
        const row = context.db
          .prepare("SELECT * FROM external_operations WHERE business_key = ?")
          .get(params.businessKey);
        return { effect: mapEffectRow(row as SqlRow), created: false };
      }
      context.db
        .prepare(
          `INSERT INTO external_operations (
             operation_id, kind, idempotency_key, business_key, task_id, run_id, run_generation,
             repository_id, task_branch, base_branch, desired_revision, expected_head_sha,
             payload_ref, state, attempt, next_attempt_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        )
        .run(
          params.effectId,
          params.kind,
          params.businessKey,
          params.businessKey,
          params.taskId ?? null,
          params.runId ?? null,
          params.runGeneration ?? null,
          params.repositoryId ?? null,
          params.taskBranch ?? null,
          params.baseBranch ?? null,
          params.desiredRevision,
          params.expectedHeadSha ?? null,
          params.payloadRef ?? null,
          params.now,
          params.now,
          params.now,
        );
      return { effect: mapEffectRow(requireEffectRow(context, params.effectId)), created: true };
    });
  },

  "effects.get": (context, params): GitHubEffectRecord | null => {
    const row = selectEffect(context, params.effectId);
    return row ? mapEffectRow(row) : null;
  },

  /** 领取：pending/ambiguous 或租约到期的记录，且已到 `nextAttemptAt`。 */
  "effects.leaseNext": (context, params): LeasedGitHubEffect | null => {
    if (params.kinds.length === 0) return null;
    for (const kind of params.kinds) {
      if (!GITHUB_EFFECT_KIND_VALUES.includes(kind))
        throw invalid(`未知 GitHub effect 种类 ${kind}`);
    }
    const placeholders = params.kinds.map(() => "?").join(", ");
    return withWriteTransaction(context, () => {
      const candidate = context.db
        .prepare(
          `SELECT * FROM external_operations
           WHERE business_key IS NOT NULL AND kind IN (${placeholders})
             AND (state = 'pending' OR state = 'ambiguous'
                  OR (state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY COALESCE(next_attempt_at, 0), created_at, operation_id LIMIT 1`,
        )
        .get(...params.kinds, params.now, params.now);
      if (!candidate) return null;
      const effectId = String(candidate["operation_id"]);
      const leaseToken = randomUUID();
      const leaseExpiresAt = params.now + Math.max(1, params.leaseMs);
      const changes = context.db
        .prepare(
          `UPDATE external_operations SET
             state = 'leased', attempt = attempt + 1, lease_token = ?, lease_expires_at = ?, updated_at = ?
           WHERE operation_id = ? AND business_key IS NOT NULL
             AND (state = 'pending' OR state = 'ambiguous'
                  OR (state = 'leased' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)`,
        )
        .run(leaseToken, leaseExpiresAt, params.now, effectId, params.now, params.now);
      if (Number(changes.changes) === 0) return null;
      return {
        effect: mapEffectRow(requireEffectRow(context, effectId)),
        leaseToken,
        leaseExpiresAt,
      };
    });
  },

  /**
   * 结算 CAS：leaseToken 不匹配返回 false。`retry` 回到 pending 并按 nextAttemptAt 退避；
   * `ambiguous` 保留在待对账集合里，不等同 failed（03 §5）。
   */
  "effects.settle": (context, params): boolean => {
    const state = SETTLE_STATE[params.outcome];
    if (!state) throw invalid(`未知结算结果 ${params.outcome}`);
    const settleNow = params.outcome === "settled" || params.outcome === "failed";
    const changes = context.db
      .prepare(
        `UPDATE external_operations SET
           state = ?,
           remote_id = COALESCE(?, remote_id),
           result_ref = COALESCE(?, result_ref),
           error_code = COALESCE(?, error_code),
           last_error = COALESCE(?, last_error),
           next_attempt_at = CASE WHEN ? = 1 THEN ? WHEN ? = 1 THEN NULL ELSE next_attempt_at END,
           settled_at = CASE WHEN ? = 1 THEN ? ELSE NULL END,
           updated_at = ?
         WHERE operation_id = ? AND lease_token = ? AND business_key IS NOT NULL
           AND state IN ('leased','ambiguous')`,
      )
      .run(
        state,
        params.remoteId ?? null,
        params.resultRef ?? null,
        params.errorCode ?? null,
        params.errorMessage ?? null,
        params.outcome === "retry" ? 1 : 0,
        params.nextAttemptAt ?? params.now,
        settleNow ? 1 : 0,
        settleNow ? 1 : 0,
        params.now,
        params.now,
        params.effectId,
        params.leaseToken,
      );
    return Number(changes.changes) > 0;
  },

  /** 启动恢复扫描（09 §8 末段）：只覆盖 effect 分面，不把 provider 操作混进来。 */
  "effects.listUnsettled": (context): GitHubEffectRecord[] =>
    context.db
      .prepare(
        `SELECT * FROM external_operations
         WHERE business_key IS NOT NULL AND state IN ('pending','leased','ambiguous')
         ORDER BY created_at, operation_id`,
      )
      .all()
      .map(mapEffectRow),
} satisfies Pick<
  StorageHandlerTable,
  | "effects.enqueue"
  | "effects.get"
  | "effects.leaseNext"
  | "effects.settle"
  | "effects.listUnsettled"
>;

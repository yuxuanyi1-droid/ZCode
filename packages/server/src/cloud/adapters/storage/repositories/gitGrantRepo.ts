/**
 * git grant 持久仓储（01 §7.1/§7.2 授权与存放、03 §4 `git_grants` 表、09 §4）。
 *
 * 不变量：
 * - `grant_id` 唯一；`claimRedemption` 是**单次兑换 CAS**（只有 `issued` 且未过期、
 *   且 task/run/generation 绑定一致才能置为 `redeemed`），并发兑换只有一个胜出；
 * - 过期与已撤销的 grant 不可兑换（判定交给 broker，本层用 SQL 条件兜底）；
 * - **raw token 不进入任何参数、也不落盘**：只持久 hash（proofHash）与生命周期元数据
 *   （01 §7.2「仅持久 grantId/purpose/issuedAt/expiresAt 等元数据」）。
 */
import { isCloudErrorCode } from "@zcode/shared";
import type { CloudErrorCode } from "@zcode/shared";
import type {
  GitGrantPurpose,
  GitGrantRecord,
  GitGrantStatus,
} from "../../../app/ports/gitGrantPort.js";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { readInt, readOptionalInt, readOptionalText, readText } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

const PURPOSES: readonly GitGrantPurpose[] = ["clone", "fetch", "push"];
const STATUSES: readonly GitGrantStatus[] = ["issued", "redeemed", "revoked"];

function invalid(message: string): CloudStorageError {
  return new CloudStorageError({ code: "validation_failed", reason: "invalid-record", message });
}

function parseRevokeOutcome(row: SqlRow): GitGrantRecord["revokeOutcome"] {
  const raw = row["revoke_outcome_json"];
  if (typeof raw !== "string") return undefined;
  try {
    const parsed = JSON.parse(raw) as { revoked?: unknown; reason?: unknown; at?: unknown };
    if (typeof parsed.revoked !== "boolean" || typeof parsed.reason !== "string") return undefined;
    return {
      revoked: parsed.revoked,
      reason: parsed.reason,
      at: typeof parsed.at === "number" ? parsed.at : 0,
    };
  } catch {
    return undefined;
  }
}

function mapGrantRow(row: SqlRow): GitGrantRecord {
  return {
    grantId: readText(row, "grant_id"),
    taskId: readText(row, "task_id"),
    runId: readText(row, "run_id"),
    runGeneration: readInt(row, "run_generation"),
    repositoryId: readInt(row, "repository_id"),
    installationId: readInt(row, "installation_id"),
    purpose: readText(row, "purpose") as GitGrantPurpose,
    status: readText(row, "status") as GitGrantStatus,
    issuedAt: readInt(row, "issued_at"),
    expiresAt: readInt(row, "expires_at"),
    ...optional("proofHash", readOptionalText(row, "proof_hash")),
    ...optional("redeemedAt", readOptionalInt(row, "redeemed_at")),
    ...optional("revokedAt", readOptionalInt(row, "revoked_at")),
    ...optional("tokenIssuedAt", readOptionalInt(row, "token_issued_at")),
    ...optional("tokenExpiresAt", readOptionalInt(row, "token_expires_at")),
    ...optional("lastErrorCode", readErrorCode(row, "last_error_code")),
    ...optional("revokeOutcome", parseRevokeOutcome(row)),
  };
}

/**
 * 错误码列只在落在 `CloudErrorCode` 目录内时回调：历史值可能来自已下线的目录项，
 * 那种情况下按「无错误码」读，不让一条审计字段阻断恢复路径。
 */
function readErrorCode(row: SqlRow, column: string): CloudErrorCode | undefined {
  const value = readOptionalText(row, column);
  return value !== undefined && isCloudErrorCode(value) ? value : undefined;
}

/** 只把有值的字段放进记录：可选字段的 undefined 与缺省在严格 schema 下等价。 */
function optional<Key extends string, Value>(key: Key, value: Value | undefined) {
  return (value === undefined ? {} : { [key]: value }) as { [K in Key]?: Value };
}

function requireGrantable(record: GitGrantRecord): void {
  if (record.grantId.trim().length === 0) throw invalid("grantId 不能为空");
  if (!PURPOSES.includes(record.purpose)) throw invalid(`未知 grant 用途 ${record.purpose}`);
  if (!STATUSES.includes(record.status)) throw invalid(`未知 grant 状态 ${record.status}`);
  if (!Number.isInteger(record.runGeneration) || record.runGeneration < 1) {
    throw invalid("runGeneration 必须是正整数");
  }
  if (!Number.isInteger(record.repositoryId) || record.repositoryId <= 0) {
    throw invalid("repositoryId 必须是正整数");
  }
  if (!Number.isInteger(record.installationId) || record.installationId <= 0) {
    throw invalid("installationId 必须是正整数");
  }
}

function selectGrant(context: StorageContext, grantId: string): SqlRow | undefined {
  return context.db.prepare("SELECT * FROM git_grants WHERE grant_id = ?").get(grantId);
}

function requireGrantRow(context: StorageContext, grantId: string): SqlRow {
  const row = selectGrant(context, grantId);
  if (!row) {
    throw new CloudStorageError({
      code: "not_found",
      reason: "not-found",
      message: `git grant ${grantId} 不存在`,
    });
  }
  return row;
}

export const gitGrantRepoHandlers = {
  /** 写入/重放同一条 grant 记录（broker 重试幂等）。 */
  "grants.insert": (context, params): void => {
    const record = params.record;
    requireGrantable(record);
    withWriteTransaction(context, () => {
      context.db
        .prepare(
          `INSERT INTO git_grants (
             grant_id, task_id, run_id, run_generation, repository_id, installation_id,
             purpose, status, proof_hash, issued_at, expires_at, redeemed_at, revoked_at,
             token_issued_at, token_expires_at, last_error_code, last_error_message,
             revoke_outcome_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (grant_id) DO UPDATE SET
             status = excluded.status,
             proof_hash = COALESCE(excluded.proof_hash, git_grants.proof_hash),
             expires_at = excluded.expires_at,
             redeemed_at = COALESCE(excluded.redeemed_at, git_grants.redeemed_at),
             revoked_at = COALESCE(excluded.revoked_at, git_grants.revoked_at),
             token_issued_at = COALESCE(excluded.token_issued_at, git_grants.token_issued_at),
             token_expires_at = COALESCE(excluded.token_expires_at, git_grants.token_expires_at),
             last_error_code = COALESCE(excluded.last_error_code, git_grants.last_error_code),
             last_error_message = COALESCE(excluded.last_error_message, git_grants.last_error_message),
             revoke_outcome_json = COALESCE(excluded.revoke_outcome_json, git_grants.revoke_outcome_json),
             updated_at = excluded.updated_at`,
        )
        .run(
          record.grantId,
          record.taskId,
          record.runId,
          record.runGeneration,
          record.repositoryId,
          record.installationId,
          record.purpose,
          record.status,
          record.proofHash ?? null,
          record.issuedAt,
          record.expiresAt,
          record.redeemedAt ?? null,
          record.revokedAt ?? null,
          record.tokenIssuedAt ?? null,
          record.tokenExpiresAt ?? null,
          record.lastErrorCode ?? null,
          null,
          record.revokeOutcome === undefined ? null : JSON.stringify(record.revokeOutcome),
          record.issuedAt,
          record.issuedAt,
        );
    });
  },

  "grants.get": (context, params): GitGrantRecord | null => {
    const row = selectGrant(context, params.grantId);
    return row ? mapGrantRow(row) : null;
  },

  /**
   * 端点不带 grantId，按 (runId, purpose) 取 issuedAt 最新的一条；是否可兑换由
   * broker 判定（端口注释），本层不做过期裁剪，避免把「过期」伪装成「不存在」。
   */
  "grants.findCurrentForRun": (context, params): GitGrantRecord | null => {
    const row = context.db
      .prepare(
        `SELECT * FROM git_grants WHERE run_id = ? AND purpose = ?
         ORDER BY issued_at DESC, grant_id DESC LIMIT 1`,
      )
      .get(params.runId, params.purpose);
    return row ? mapGrantRow(row) : null;
  },

  /** 单次兑换 CAS：绑定字段与 `issued`/未过期同时满足才置为 `redeemed`。 */
  "grants.claimRedemption": (context, params): GitGrantRecord | null => {
    return withWriteTransaction(context, () => {
      const changes = context.db
        .prepare(
          `UPDATE git_grants SET status = 'redeemed', redeemed_at = ?, updated_at = ?
           WHERE grant_id = ? AND status = 'issued' AND expires_at > ?
             AND task_id = ? AND run_id = ? AND run_generation = ?`,
        )
        .run(
          params.now,
          params.now,
          params.grantId,
          params.now,
          params.taskId,
          params.runId,
          params.runGeneration,
        );
      if (Number(changes.changes) === 0) return null;
      return mapGrantRow(requireGrantRow(context, params.grantId));
    });
  },

  /** 只写 token 生命周期元数据，不写 token 本身（01 §7.2）。 */
  "grants.recordIssuedToken": (context, params): void => {
    const changes = context.db
      .prepare(
        `UPDATE git_grants SET token_issued_at = ?, token_expires_at = ?, updated_at = ?
         WHERE grant_id = ?`,
      )
      .run(params.tokenIssuedAt, params.tokenExpiresAt, params.tokenIssuedAt, params.grantId);
    if (Number(changes.changes) === 0) throw invalid(`git grant ${params.grantId} 不存在`);
  },

  "grants.recordFailure": (context, params): void => {
    const changes = context.db
      .prepare(
        `UPDATE git_grants SET last_error_code = ?, last_error_message = ?, updated_at = ?
         WHERE grant_id = ?`,
      )
      .run(params.code, params.message.slice(0, 512), params.now, params.grantId);
    if (Number(changes.changes) === 0) throw invalid(`git grant ${params.grantId} 不存在`);
  },

  /**
   * 记撤销结果：`revoked` 是 **GitHub 侧事实**（尽力语义，失败可重试），grant 本身
   * 同时退休为 `revoked` 状态——不再可兑换，且不把「GitHub 仍持有 token」伪装成已撤销
   * （01 §7.2：broker 删内存不等于 GitHub 已撤销）。
   */
  "grants.recordRevokeOutcome": (context, params): void => {
    const outcome = { revoked: params.revoked, reason: params.reason, at: params.now };
    const changes = context.db
      .prepare(
        `UPDATE git_grants SET status = 'revoked', revoked_at = ?, revoke_outcome_json = ?, updated_at = ?
         WHERE grant_id = ?`,
      )
      .run(params.now, JSON.stringify(outcome), params.now, params.grantId);
    if (Number(changes.changes) === 0) throw invalid(`git grant ${params.grantId} 不存在`);
  },

  "grants.listByRun": (context, params): GitGrantRecord[] =>
    context.db
      .prepare("SELECT * FROM git_grants WHERE run_id = ? ORDER BY issued_at, grant_id")
      .all(params.runId)
      .map(mapGrantRow),
} satisfies Pick<
  StorageHandlerTable,
  | "grants.insert"
  | "grants.get"
  | "grants.findCurrentForRun"
  | "grants.claimRedemption"
  | "grants.recordIssuedToken"
  | "grants.recordFailure"
  | "grants.recordRevokeOutcome"
  | "grants.listByRun"
>;

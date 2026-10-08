/**
 * bridge 凭据仓储（02 §5.1/§5.2 握手与旋转、03 §4 run_credentials 行）。
 *
 * 只持久 hash 与元数据，明文 token 只经秘密注入通道（02 §5.1 第 4 条）。
 * 消费初始凭据是单条 CAS：hash/时效/代际/非终态全部满足才切换 credential_hash
 * 并写 helloAttemptId/candidateHash/rotationId；失败 fail closed，不设置旧 token
 * 的通用有效重叠窗口（02 §5.2）。
 */
import { randomUUID } from "node:crypto";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import { ACTIVE_RUN_STATUSES } from "../sqlite/schema.js";
import { constantTimeEqualHex } from "../../secret/gitGrantBroker.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

const ACTIVE_STATUS_SQL = ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(", ");

function selectCredential(context: StorageContext, runId: string): SqlRow | undefined {
  return context.db.prepare("SELECT * FROM run_credentials WHERE run_id = ?").get(runId);
}

function requireHash(value: string, label: string): string {
  if (value.trim().length === 0 || value.length > 512) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-record",
      message: `${label} 形状非法`,
    });
  }
  return value;
}

export const credentialRepoHandlers = {
  /**
   * 供给时写初始凭据（02 §5.1 第 1 条）。重复保存只在「尚未被消费/旋转」时更新：
   * 恢复中的 provisioning worker 不得用旧初始 hash 覆盖已经切换的 resume token。
   */
  "credentials.saveInitial": (context, params): void => {
    const credentialHash = requireHash(params.credentialHash, "credentialHash");
    // 端口签名不带时间戳（W0 冻结）：创建/更新时间取 worker 真实时钟，只用于审计列，
    // 期限与时效判定仍以调用方传入的 expiresAt 为准。
    const at = Date.now();
    withWriteTransaction(context, () => {
      const existing = selectCredential(context, params.runId);
      if (existing) {
        if (Number(existing["run_generation"]) !== params.runGeneration) {
          throw new CloudStorageError({
            code: "stale",
            reason: "run-generation-mismatch",
            message: "凭据所属 run 代际不匹配",
          });
        }
        if (existing["used_at"] !== null && existing["used_at"] !== undefined) return;
        context.db
          .prepare(
            `UPDATE run_credentials SET credential_hash = ?, expires_at = ?,
               bootstrap_operation_id = ?, updated_at = ?
             WHERE run_id = ? AND used_at IS NULL`,
          )
          .run(credentialHash, params.expiresAt, params.bootstrapOperationId, at, params.runId);
        return;
      }
      context.db
        .prepare(
          `INSERT INTO run_credentials (
             run_id, run_generation, credential_hash, bootstrap_operation_id,
             expires_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          params.runId,
          params.runGeneration,
          credentialHash,
          params.bootstrapOperationId,
          params.expiresAt,
          at,
          at,
        );
    });
  },

  /**
   * 消费初始/当前凭据：单条 CAS 切换 hash 并记录 attempt/候选/rotationId。
   * 失败（hash 不符、过期、已撤销、run 终态）返回 null，由调用方 fail closed。
   */
  "credentials.consumeForHello": (context, params): { rotationId: string } | null => {
    const proofHash = requireHash(params.proofHash, "proofHash");
    const candidateHash = requireHash(params.candidateHash, "candidateHash");
    const rotationId = randomUUID();
    return withWriteTransaction(context, () => {
      const changes = context.db
        .prepare(
          `UPDATE run_credentials SET
             credential_hash = ?, candidate_hash = ?, hello_attempt_id = ?,
             rotation_id = ?, used_at = ?, updated_at = ?,
             -- 有效期跟随 run 当前硬期限（2026-10-07 真实链路：固定 10 分钟 TTL 会让
             -- 存活超过 TTL 的 run 断线后永久 credential-rejected；run 经 /extend 延期时
             -- 凭据也跟着延）。取 MAX 不缩短：mint/测试夹具显式写入的时效不被
             -- 尚未规划的期限（NULL/过去）意外压缩。
             expires_at = MAX(expires_at, COALESCE(
               (SELECT hard_deadline_at FROM runs WHERE runs.run_id = run_credentials.run_id),
               expires_at))
           WHERE run_id = ? AND credential_hash = ?
             AND revoked_at IS NULL AND expires_at > ?
             AND EXISTS (
               SELECT 1 FROM runs WHERE runs.run_id = run_credentials.run_id
                 AND runs.status IN (${ACTIVE_STATUS_SQL})
             )`,
        )
        .run(
          candidateHash,
          candidateHash,
          params.helloAttemptId,
          rotationId,
          params.now,
          params.now,
          params.runId,
          proofHash,
          params.now,
        );
      return Number(changes.changes) > 0 ? { rotationId } : null;
    });
  },

  /**
   * 非消费校验（01 §7.2 run-scoped 认证）：只读确认 proof 仍是该 run 的当前凭据。
   * 不切换 hash、不写 helloAttempt —— 执行节点出站端点（git-grant）用它而不是
   * `consumeForHello`，否则每次兑换都会旋转凭据并打断 bridge 重连。
   */
  "credentials.verifyActiveCredential": (context, params): { runGeneration: number } | null => {
    const proofHash = requireHash(params.proofHash, "proofHash");
    const row = selectCredential(context, params.runId);
    if (!row) return null;
    if (row["revoked_at"] !== null && row["revoked_at"] !== undefined) return null;
    const expiresAt = Number(row["expires_at"]);
    if (!Number.isFinite(expiresAt) || expiresAt <= params.now) return null;
    // 恒定时间比较（01 §7.2）；比较实现只有一份，与 broker 共用。
    if (!constantTimeEqualHex(String(row["credential_hash"] ?? ""), proofHash)) return null;
    const runGeneration = Number(row["run_generation"]);
    return Number.isInteger(runGeneration) && runGeneration > 0 ? { runGeneration } : null;
  },

  /**
   * 旋转响应丢失后的同 attempt 恢复（02 §5.2）：attempt 与候选 hash 都一致才复用
   * rotationId；不一致一律拒绝，不新增重叠窗口。
   */
  "credentials.recoverByAttempt": (
    context,
    params,
  ): { rotationId: string; committed: boolean } | null => {
    const row = selectCredential(context, params.runId);
    if (!row) return null;
    // 撤销/过期的凭据不参与恢复：fail closed，不设置旧 token 的有效重叠窗口（02 §5.2）。
    if (row["revoked_at"] !== null && row["revoked_at"] !== undefined) return null;
    if (Number(row["expires_at"]) <= Date.now()) return null;
    if (row["hello_attempt_id"] !== params.helloAttemptId) return null;
    if (row["candidate_hash"] !== params.candidateHash) return null;
    const rotationId = row["rotation_id"];
    if (typeof rotationId !== "string") return null;
    return { rotationId, committed: row["credential_hash"] === params.candidateHash };
  },

  /**
   * 撤销 run 凭据（02 §5.2 末段：token 到期/Run 终止/代际过旧都 fail closed）。
   * 端口不接受 `now`（W0 定稿）：撤销时间用 worker 真实时钟，只用于审计。
   */
  "credentials.revokeRun": (context, params): number => {
    const now = Date.now();
    const changes = context.db
      .prepare(
        `UPDATE run_credentials SET revoked_at = ?, revoked_reason = ?, updated_at = ?
         WHERE run_id = ? AND revoked_at IS NULL`,
      )
      .run(now, params.reason, now, params.runId);
    return Number(changes.changes);
  },

  /**
   * 续展凭据有效期（B-6，2026-10-09 生命周期 v2）：自驱 resume 成功后把 `expires_at`
   * 沿 run 新租期向外续。**只外推不内缩**（MAX 口径，与 consumeForHello 的期限跟随
   * 一致）：传入早于现值时保持现值；已撤销凭据不复活（revoked_at IS NULL 前置）。
   */
  "credentials.extendForRun": (context, params): boolean => {
    const now = Date.now();
    const changes = context.db
      .prepare(
        `UPDATE run_credentials SET expires_at = MAX(expires_at, ?), updated_at = ?
         WHERE run_id = ? AND revoked_at IS NULL`,
      )
      .run(params.expiresAt, now, params.runId);
    return Number(changes.changes) > 0;
  },
} satisfies Pick<
  StorageHandlerTable,
  | "credentials.saveInitial"
  | "credentials.consumeForHello"
  | "credentials.recoverByAttempt"
  | "credentials.revokeRun"
  | "credentials.verifyActiveCredential"
  | "credentials.extendForRun"
>;

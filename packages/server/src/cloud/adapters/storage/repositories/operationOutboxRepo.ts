/**
 * 外部操作 outbox（03 §5「外部操作不是数据库事务」、01 §5.3 启动对账）。
 *
 * - `operationId` 是幂等键、`idempotency_key` 是业务键唯一：重复入队返回既有行，
 *   重试复用同一 operation，不生成第二个沙箱创建意图。
 * - 租约由 `lease_token` + 到期时间承担：同一 operation 同时只有一个有效租约，
 *   旧 worker 的迟到结果因 token 不匹配而无法覆盖新结算（03 §5）。
 * - `ambiguous` 不是 failed：结果未知的行保留在 unsettled 集合里等对账（03 §8）。
 */
import { randomUUID } from "node:crypto";
import type { ExternalOperationRecord } from "../../../app/ports/operationOutboxPort.js";
import type { CloudErrorCode } from "@zcode/shared";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { mapOperationRow } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import { OPERATION_KIND_VALUES } from "../sqlite/schema.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

function selectByOperationId(context: StorageContext, operationId: string): SqlRow | undefined {
  return context.db
    .prepare("SELECT * FROM external_operations WHERE operation_id = ?")
    .get(operationId);
}

function selectByKey(context: StorageContext, idempotencyKey: string): SqlRow | undefined {
  return context.db
    .prepare("SELECT * FROM external_operations WHERE idempotency_key = ?")
    .get(idempotencyKey);
}

export const operationOutboxHandlers = {
  /** 入队即持久；同 idempotencyKey 幂等返回既有 operation（03 §5）。 */
  "operations.enqueue": (context, params): ExternalOperationRecord => {
    if (!OPERATION_KIND_VALUES.includes(params.kind)) {
      throw invalidOperation(`未知操作种类 ${params.kind}`);
    }
    return withWriteTransaction(context, () => {
      const byId = selectByOperationId(context, params.operationId);
      if (byId) {
        if (String(byId["idempotency_key"]) !== params.idempotencyKey) {
          throw invalidOperation("operationId 已被另一幂等键占用");
        }
        return mapOperationRow(byId);
      }
      const byKey = selectByKey(context, params.idempotencyKey);
      if (byKey) return mapOperationRow(byKey);
      context.db
        .prepare(
          `INSERT INTO external_operations (
             operation_id, kind, idempotency_key, task_id, run_id, run_generation,
             state, attempt, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
        )
        .run(
          params.operationId,
          params.kind,
          params.idempotencyKey,
          params.taskId ?? null,
          params.runId ?? null,
          params.runGeneration ?? null,
          params.now,
          params.now,
        );
      const row = selectByOperationId(context, params.operationId);
      if (!row) throw invalidOperation("operation 入队失败");
      return mapOperationRow(row);
    });
  },

  "operations.findByKey": (context, params): ExternalOperationRecord | null => {
    const row = selectByKey(context, params.idempotencyKey);
    return row ? mapOperationRow(row) : null;
  },

  "operations.get": (context, params): ExternalOperationRecord | null => {
    const row = selectByOperationId(context, params.operationId);
    return row ? mapOperationRow(row) : null;
  },

  /**
   * 租约领取：pending、或租约已到期的 leased。
   * `ambiguous`（结果未知待对账）同样在租约到期后可再次领取，否则对账入口不存在；
   * 领取递增 attempt，但 operationId 不变（03 §5「重试复用同一 id」）。
   */
  "operations.leaseNext": (context, params) => {
    if (params.kinds.length === 0) return null;
    for (const kind of params.kinds) {
      if (!OPERATION_KIND_VALUES.includes(kind)) throw invalidOperation(`未知操作种类 ${kind}`);
    }
    const placeholders = params.kinds.map(() => "?").join(", ");
    return withWriteTransaction(context, () => {
      const candidate = context.db
        .prepare(
          `SELECT * FROM external_operations
           WHERE kind IN (${placeholders})
             AND (state = 'pending' OR (state IN ('leased','ambiguous') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))
           ORDER BY created_at, operation_id LIMIT 1`,
        )
        .get(...params.kinds, params.now);
      if (!candidate) return null;
      const operationId = String(candidate["operation_id"]);
      const leaseToken = randomUUID();
      const leaseExpiresAt = params.now + Math.max(1, params.leaseMs);
      const changes = context.db
        .prepare(
          `UPDATE external_operations SET
             state = 'leased', attempt = attempt + 1, lease_token = ?,
             lease_expires_at = ?, updated_at = ?
           WHERE operation_id = ?
             AND (state = 'pending' OR (state IN ('leased','ambiguous') AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?))`,
        )
        .run(leaseToken, leaseExpiresAt, params.now, operationId, params.now);
      if (Number(changes.changes) === 0) return null;
      const row = selectByOperationId(context, operationId);
      if (!row) return null;
      return {
        operation: mapOperationRow(row),
        leaseToken,
        leaseExpiresAt,
      };
    });
  },

  /** 结算 CAS：租约令牌不匹配（迟到结果）返回 false，只用于对账（03 §5）。 */
  "operations.settle": (context, params): boolean => {
    if (!["settled", "ambiguous", "failed"].includes(params.outcome)) {
      throw invalidOperation(`未知结算结果 ${params.outcome}`);
    }
    const changes = context.db
      .prepare(
        `UPDATE external_operations SET
           state = ?, result_ref = COALESCE(?, result_ref), error_code = COALESCE(?, error_code),
           settled_at = ?, updated_at = ?
         WHERE operation_id = ? AND lease_token = ? AND state IN ('leased','ambiguous')`,
      )
      .run(
        params.outcome,
        params.resultRef ?? null,
        (params.errorCode ?? null) as CloudErrorCode | null,
        params.now,
        params.now,
        params.operationId,
        params.leaseToken,
      );
    return Number(changes.changes) > 0;
  },

  /**
   * 启动恢复扫描（03 §8）：pending/leased/ambiguous 都还没结算。
   * **只覆盖 provider/生命周期分面**（`business_key IS NULL`）：GitHub effect 由
   * `GitHubEffectStore` 自己的恢复扫描处理，混进来会被 provider 对账逻辑误领。
   */
  "operations.listUnsettled": (context): ExternalOperationRecord[] =>
    context.db
      .prepare(
        `SELECT * FROM external_operations
         WHERE business_key IS NULL AND state IN ('pending','leased','ambiguous')
         ORDER BY created_at, operation_id`,
      )
      .all()
      .map(mapOperationRow),
} satisfies Pick<
  StorageHandlerTable,
  | "operations.enqueue"
  | "operations.findByKey"
  | "operations.get"
  | "operations.leaseNext"
  | "operations.settle"
  | "operations.listUnsettled"
>;

function invalidOperation(message: string): CloudStorageError {
  return new CloudStorageError({ code: "validation_failed", reason: "invalid-record", message });
}

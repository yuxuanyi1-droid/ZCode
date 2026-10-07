/**
 * 部署主体仓储（03 §3「首版可信单用户采用稳定的 deploymentPrincipalId，在安装配置/
 * 数据库中生成并持久化」、§4 principals 表）。
 *
 * W0 未冻结 principal 的端口：控制面装配（W5）在启动时确保部署主体存在，其余仓储
 * 只引用 principalId，不做级联创建——避免在业务路径上隐式造主体。
 */
import { withWriteTransaction } from "../sqlite/database.js";
import { readInt, readText } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

export interface PrincipalFacts {
  principalId: string;
  disabled: boolean;
  createdAt: number;
  updatedAt: number;
}

function mapPrincipalRow(row: SqlRow): PrincipalFacts {
  return {
    principalId: readText(row, "principal_id"),
    disabled: readInt(row, "disabled") !== 0,
    createdAt: readInt(row, "created_at"),
    updatedAt: readInt(row, "updated_at"),
  };
}

export const principalRepoHandlers = {
  "principals.ensure": (context, params): PrincipalFacts => {
    if (params.principalId.trim().length === 0) {
      throw new CloudStorageError({
        code: "validation_failed",
        reason: "invalid-record",
        message: "principalId 不能为空",
      });
    }
    return withWriteTransaction(context, () => {
      context.db
        .prepare(
          `INSERT INTO principals (principal_id, disabled, display_name, created_at, updated_at)
           VALUES (?, 0, ?, ?, ?)
           ON CONFLICT (principal_id) DO UPDATE SET
             display_name = COALESCE(excluded.display_name, principals.display_name),
             updated_at = excluded.updated_at`,
        )
        .run(params.principalId, params.displayName ?? null, params.now, params.now);
      const row = context.db
        .prepare("SELECT * FROM principals WHERE principal_id = ?")
        .get(params.principalId);
      if (!row) {
        throw new CloudStorageError({
          code: "not_found",
          reason: "not-found",
          message: "部署主体写入失败",
        });
      }
      return mapPrincipalRow(row);
    });
  },
} satisfies Pick<StorageHandlerTable, "principals.ensure">;

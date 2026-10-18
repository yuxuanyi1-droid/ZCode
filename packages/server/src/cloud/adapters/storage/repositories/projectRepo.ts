/**
 * Project repository（03 §4 projects 表、11 §4/§5）。
 *
 * 唯一约束 `(owner_principal_id, repository_id)` 承担去重：重复添加同一仓库返回既有
 * Project 而不是第二行（11 §4.4）。展示名是独立可编辑元数据，带 revision CAS。
 */
import type { CloudProjectRecord } from "@zcode/shared";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { decodeCursor, encodeCursor, normalizeLimit } from "../sqlite/cursor.js";
import { mapProjectRow, readText } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

const PAGE_LIMIT_MAX = 100;

function selectProject(
  context: StorageContext,
  projectId: string,
  options: { includeArchived?: boolean } = {},
): SqlRow | undefined {
  if (options.includeArchived === true) {
    return context.db.prepare("SELECT * FROM projects WHERE project_id = ?").get(projectId);
  }
  // 软删除（15 §R3）：已归档 Project 对普通读路径不可见。
  return context.db
    .prepare("SELECT * FROM projects WHERE project_id = ? AND archived_at IS NULL")
    .get(projectId);
}

export const projectRepoHandlers = {
  "projects.get": (context, params): CloudProjectRecord | null => {
    const row = selectProject(context, params.projectId, {
      includeArchived: params.includeArchived === true,
    });
    return row ? mapProjectRow(row) : null;
  },

  "projects.findByRepository": (context, params): CloudProjectRecord | null => {
    const row = context.db
      .prepare(
        "SELECT * FROM projects WHERE owner_principal_id = ? AND repository_id = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1",
      )
      .get(params.principalId, params.repositoryId);
    return row ? mapProjectRow(row) : null;
  },

  /**
   * 幂等创建：唯一约束承担去重，并发重复添加（不同请求）返回同一行，不产生第二份
   * projectId（11 §4.4）。repositoryId 必须为正整数，否则在写库前拒绝。
   */
  "projects.createOrGet": (context, params): CloudProjectRecord => {
    if (!Number.isInteger(params.repositoryId) || params.repositoryId <= 0) {
      throw invalidProject("repositoryId 必须是正整数");
    }
    if (!Number.isInteger(params.installationId) || params.installationId <= 0) {
      throw invalidProject("installationId 必须是正整数");
    }
    return withWriteTransaction(context, () => {
      context.db
        .prepare(
          `INSERT OR IGNORE INTO projects (
             project_id, owner_principal_id, kind, repository_id, installation_id,
             repo_owner, repo_name, default_branch, display_name,
             revision, created_at, updated_at
           ) VALUES (?, ?, 'github-repo', ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          params.projectId,
          params.ownerPrincipalId,
          params.repositoryId,
          params.installationId,
          params.repoOwner,
          params.repoName,
          params.defaultBranch ?? null,
          params.displayName ?? null,
          params.now,
          params.now,
        );
      const row = context.db
        .prepare(
          "SELECT * FROM projects WHERE owner_principal_id = ? AND repository_id = ? AND archived_at IS NULL ORDER BY created_at LIMIT 1",
        )
        .get(params.ownerPrincipalId, params.repositoryId);
      if (!row) {
        // 唯一索引仍指向已归档行：不把归档 Project 当作新建成功返回（15 §R3），
        // 也不物理删除任务历史；重复添加需由产品层决定恢复语义。
        throw invalidProject("Project 已归档，不能重复添加");
      }
      return mapProjectRow(row);
    });
  },

  "projects.list": (context, params): { items: CloudProjectRecord[]; nextCursor?: string } => {
    const limit = normalizeLimit(params.page.limit, PAGE_LIMIT_MAX);
    const after = params.page.cursor ? decodeCursor(params.page.cursor) : null;
    const rows =
      after === null
        ? context.db
            .prepare(
              "SELECT * FROM projects WHERE owner_principal_id = ? AND archived_at IS NULL ORDER BY created_at DESC, project_id DESC LIMIT ?",
            )
            .all(params.principalId, limit + 1)
        : context.db
            .prepare(
              `SELECT * FROM projects
               WHERE owner_principal_id = ?
                 AND archived_at IS NULL
                 AND (created_at < ? OR (created_at = ? AND project_id < ?))
               ORDER BY created_at DESC, project_id DESC LIMIT ?`,
            )
            .all(
              params.principalId,
              after[0] as number,
              after[0] as number,
              after[1] as string,
              limit + 1,
            );
    const items = rows.slice(0, limit).map(mapProjectRow);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return last
      ? {
          items,
          nextCursor: encodeCursor([Number(last["created_at"]), readText(last, "project_id")]),
        }
      : { items };
  },

  "projects.patchMetadata": (context, params): CloudProjectRecord | null => {
    return withWriteTransaction(context, () => {
      const changes = context.db
        .prepare(
          `UPDATE projects
             SET display_name = COALESCE(?, display_name), revision = revision + 1, updated_at = ?
           WHERE project_id = ? AND revision = ? AND archived_at IS NULL`,
        )
        .run(params.displayName ?? null, params.now, params.projectId, params.expectedRevision);
      if (Number(changes.changes) === 0) return null;
      const row = selectProject(context, params.projectId);
      return row ? mapProjectRow(row) : null;
    });
  },

  /**
   * 软删除（15 §R3）：只写 archived_at，不物理删除。已归档返回 false 且保留首次
   * 归档时间；调用方（deleteProject）据此区分「本次写入」与「已归档的幂等事实」。
   */
  "projects.archive": (context, params): boolean => {
    return withWriteTransaction(context, () => {
      const changes = context.db
        .prepare(
          `UPDATE projects SET archived_at = ?, updated_at = ?
           WHERE project_id = ? AND archived_at IS NULL`,
        )
        .run(params.now, params.now, params.projectId);
      return Number(changes.changes) > 0;
    });
  },
} satisfies Pick<
  StorageHandlerTable,
  | "projects.get"
  | "projects.findByRepository"
  | "projects.createOrGet"
  | "projects.list"
  | "projects.patchMetadata"
  | "projects.archive"
>;

function invalidProject(message: string): CloudStorageError {
  return new CloudStorageError({
    code: "validation_failed",
    reason: "invalid-record",
    message,
  });
}

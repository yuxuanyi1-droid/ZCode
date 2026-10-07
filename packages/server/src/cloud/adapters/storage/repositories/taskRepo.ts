/**
 * Task repository（03 §4 tasks 表、08 §2/§3.1、11 §5）。
 *
 * 约束承担幂等与并发：`(owner_principal_id, creation_key)` 唯一（响应丢失后用原 key
 * 恢复同一 Task），`revision` CAS（PATCH 与状态迁移都不静默覆盖另一端），
 * `workspace_identity` 在首次创建时固定为 `cloud-task:<taskId>`（08 §4.1）。
 */
import {
  cloudDraftStartConfigSchema,
  cloudGitObjectIdSchema,
  cloudTaskArtifactRecordSchema,
  cloudTaskIdSchema,
  cloudTaskStatusSchema,
} from "@zcode/shared";
import type { CloudTaskRecord } from "@zcode/shared";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { decodeCursor, encodeCursor, normalizeLimit } from "../sqlite/cursor.js";
import { mapTaskRow, toJsonColumn } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

const PAGE_LIMIT_MAX = 100;

export function selectTask(context: StorageContext, taskId: string): SqlRow | undefined {
  return context.db.prepare("SELECT * FROM tasks WHERE task_id = ?").get(taskId);
}

export function requireTaskRow(context: StorageContext, taskId: string): SqlRow {
  const row = selectTask(context, taskId);
  if (!row) {
    throw new CloudStorageError({
      code: "not_found",
      reason: "not-found",
      message: `Task ${taskId} 不存在`,
    });
  }
  return row;
}

function validateTaskId(taskId: string): string {
  const parsed = cloudTaskIdSchema.safeParse(taskId);
  if (!parsed.success) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-record",
      message: "taskId 形状非法",
      cause: parsed.error,
    });
  }
  return parsed.data;
}

export const taskRepoHandlers = {
  "tasks.get": (context, params): CloudTaskRecord | null => {
    const row = selectTask(context, params.taskId);
    return row ? mapTaskRow(row) : null;
  },

  "tasks.findByCreationKey": (context, params): CloudTaskRecord | null => {
    const row = context.db
      .prepare(
        "SELECT * FROM tasks WHERE owner_principal_id = ? AND creation_key = ? ORDER BY created_at LIMIT 1",
      )
      .get(params.ownerPrincipalId, params.creationKey);
    return row ? mapTaskRow(row) : null;
  },

  /** 建 draft：唯一约束去重；重复创建键返回既有 Task（11 §5）。 */
  "tasks.createDraft": (context, params): CloudTaskRecord => {
    validateTaskId(params.taskId);
    const expectedIdentity = `cloud-task:${params.taskId}`;
    if (params.workspaceIdentity !== expectedIdentity) {
      throw new CloudStorageError({
        code: "validation_failed",
        reason: "invalid-record",
        message: "workspaceIdentity 必须是 cloud-task:<taskId>（08 §4.1）",
      });
    }
    const draft = params.draftStartConfig
      ? cloudDraftStartConfigSchema.parse(params.draftStartConfig)
      : undefined;
    return withWriteTransaction(context, () => {
      context.db
        .prepare(
          `INSERT OR IGNORE INTO tasks (
             task_id, owner_principal_id, project_id, title, status, creation_key,
             draft_start_config_json, workspace_identity, next_run_generation,
             revision, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 1, 0, ?, ?)`,
        )
        .run(
          params.taskId,
          params.ownerPrincipalId,
          params.projectId,
          params.title,
          params.creationKey,
          toJsonColumn(draft),
          params.workspaceIdentity,
          params.now,
          params.now,
        );
      const row = context.db
        .prepare(
          "SELECT * FROM tasks WHERE owner_principal_id = ? AND creation_key = ? ORDER BY created_at LIMIT 1",
        )
        .get(params.ownerPrincipalId, params.creationKey);
      if (!row) throw invalidTask("Task 创建失败");
      return mapTaskRow(row);
    });
  },

  "tasks.listByProject": (context, params): { items: CloudTaskRecord[]; nextCursor?: string } => {
    const limit = normalizeLimit(params.page.limit, PAGE_LIMIT_MAX);
    const after = params.page.cursor ? decodeCursor(params.page.cursor) : null;
    const rows =
      after === null
        ? context.db
            .prepare(
              "SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC, task_id DESC LIMIT ?",
            )
            .all(params.projectId, limit + 1)
        : context.db
            .prepare(
              `SELECT * FROM tasks
               WHERE project_id = ? AND (created_at < ? OR (created_at = ? AND task_id < ?))
               ORDER BY created_at DESC, task_id DESC LIMIT ?`,
            )
            .all(
              params.projectId,
              after[0] as number,
              after[0] as number,
              after[1] as string,
              limit + 1,
            );
    const items = rows.slice(0, limit).map(mapTaskRow);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return last
      ? { items, nextCursor: encodeCursor([Number(last["created_at"]), String(last["task_id"])]) }
      : { items };
  },

  /**
   * 标题/draftStartConfig 的 revision CAS；`draftStartConfig` 只在 draft 接受
   * （03 §6、11 §5），启动配置在 active 之后不得被覆盖。
   */
  "tasks.patchMetadata": (context, params): CloudTaskRecord | null => {
    const draft = params.draftStartConfig
      ? cloudDraftStartConfigSchema.parse(params.draftStartConfig)
      : undefined;
    return withWriteTransaction(context, () => {
      const current = selectTask(context, params.taskId);
      if (!current) return null;
      if (draft !== undefined && current["status"] !== "draft") return null;
      const changes = context.db
        .prepare(
          `UPDATE tasks
             SET title = COALESCE(?, title),
                 draft_start_config_json = COALESCE(?, draft_start_config_json),
                 revision = revision + 1,
                 updated_at = ?
           WHERE task_id = ? AND revision = ?`,
        )
        .run(
          params.title ?? null,
          draft === undefined ? null : toJsonColumn(draft),
          params.now,
          params.taskId,
          params.expectedRevision,
        );
      if (Number(changes.changes) === 0) return null;
      return mapTaskRow(requireTaskRow(context, params.taskId));
    });
  },

  /**
   * 状态迁移 CAS（08 §3.1 允许操作表由 domain 裁决）：`from` 不匹配或 revision 未前进
   * 都返回 null。`revision` 是本次要落库的新 revision（调用方按 expected+1 计算）。
   */
  "tasks.transitionStatus": (context, params): CloudTaskRecord | null => {
    cloudTaskStatusSchema.parse(params.to);
    for (const status of params.from) cloudTaskStatusSchema.parse(status);
    const placeholders = params.from.map(() => "?").join(", ");
    return withWriteTransaction(context, () => {
      const changes = context.db
        .prepare(
          `UPDATE tasks
             SET status = ?,
                 revision = ?,
                 active_run_id = CASE WHEN ? = 1 THEN ? ELSE active_run_id END,
                 archived_from_status = COALESCE(?, archived_from_status),
                 complete_requested = CASE WHEN ? = 1 THEN ? ELSE complete_requested END,
                 updated_at = ?
           WHERE task_id = ? AND status IN (${placeholders}) AND revision < ?`,
        )
        .run(
          params.to,
          params.revision,
          params.activeRunId === undefined ? 0 : 1,
          params.activeRunId ?? null,
          params.archivedFromStatus ?? null,
          params.completeRequested === undefined ? 0 : 1,
          params.completeRequested === undefined ? null : params.completeRequested ? 1 : 0,
          params.now,
          params.taskId,
          ...params.from,
          params.revision,
        );
      if (Number(changes.changes) === 0) return null;
      return mapTaskRow(requireTaskRow(context, params.taskId));
    });
  },

  /** 首次接纳/重开冻结基线：first-write-wins，后续不覆盖已冻结事实（11 §6）。 */
  "tasks.freezeBaseline": (context, params): CloudTaskRecord => {
    cloudGitObjectIdSchema.parse(params.baseSha);
    return withWriteTransaction(context, () => {
      requireTaskRow(context, params.taskId);
      context.db
        .prepare(
          `UPDATE tasks
             SET base_branch = COALESCE(base_branch, ?),
                 base_sha = COALESCE(base_sha, ?),
                 task_branch = COALESCE(task_branch, ?),
                 revision = revision + 1,
                 updated_at = ?
           WHERE task_id = ?`,
        )
        .run(params.baseBranch, params.baseSha, params.taskBranch, params.now, params.taskId);
      return mapTaskRow(requireTaskRow(context, params.taskId));
    });
  },

  "tasks.recordCheckpointSha": (context, params): void => {
    cloudGitObjectIdSchema.parse(params.remoteSha);
    const changes = context.db
      .prepare("UPDATE tasks SET last_checkpoint_sha = ?, updated_at = ? WHERE task_id = ?")
      .run(params.remoteSha, params.now, params.taskId);
    if (Number(changes.changes) === 0) {
      throw new CloudStorageError({
        code: "not_found",
        reason: "not-found",
        message: `Task ${params.taskId} 不存在`,
      });
    }
  },

  "tasks.recordArtifact": (context, params): void => {
    const artifact = cloudTaskArtifactRecordSchema.parse(params.artifact);
    withWriteTransaction(context, () => {
      requireTaskRow(context, artifact.taskId);
      context.db
        .prepare(
          `INSERT INTO task_artifacts (
             task_id, kind, task_branch, pr_head, pr_base, pr_number, pr_url, pr_status,
             published_sha, summary_ref, last_checked_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (task_id, kind) DO UPDATE SET
             task_branch = excluded.task_branch,
             pr_head = excluded.pr_head,
             pr_base = excluded.pr_base,
             pr_number = excluded.pr_number,
             pr_url = excluded.pr_url,
             pr_status = excluded.pr_status,
             published_sha = excluded.published_sha,
             summary_ref = excluded.summary_ref,
             last_checked_at = excluded.last_checked_at,
             updated_at = excluded.updated_at`,
        )
        .run(
          artifact.taskId,
          artifact.kind,
          artifact.taskBranch ?? null,
          artifact.prHead ?? null,
          artifact.prBase ?? null,
          artifact.prNumber ?? null,
          artifact.prUrl ?? null,
          artifact.prStatus,
          artifact.publishedSha ?? null,
          artifact.summaryRef ?? null,
          artifact.lastCheckedAt ?? null,
          artifact.lastCheckedAt ?? Date.now(),
        );
    });
  },
  /**
   * 持久验收意图（08 §9、W1 CR-6）：revision CAS，置位后阻断新输入/写入；
   * 真正的 completed 仍要等保存/产物核验与活动 Run 终止确认，本方法只回事实。
   */
  "tasks.setCompleteRequested": (context, params): CloudTaskRecord | null => {
    return withWriteTransaction(context, () => {
      const changes = context.db
        .prepare(
          `UPDATE tasks SET complete_requested = ?, revision = revision + 1, updated_at = ?
           WHERE task_id = ? AND revision = ?`,
        )
        .run(params.requested ? 1 : 0, params.now, params.taskId, params.expectedRevision);
      if (Number(changes.changes) === 0) return null;
      return mapTaskRow(requireTaskRow(context, params.taskId));
    });
  },
} satisfies Pick<
  StorageHandlerTable,
  | "tasks.get"
  | "tasks.findByCreationKey"
  | "tasks.createDraft"
  | "tasks.listByProject"
  | "tasks.patchMetadata"
  | "tasks.transitionStatus"
  | "tasks.freezeBaseline"
  | "tasks.recordCheckpointSha"
  | "tasks.recordArtifact"
  | "tasks.setCompleteRequested"
>;

function invalidTask(message: string): CloudStorageError {
  return new CloudStorageError({ code: "validation_failed", reason: "invalid-record", message });
}

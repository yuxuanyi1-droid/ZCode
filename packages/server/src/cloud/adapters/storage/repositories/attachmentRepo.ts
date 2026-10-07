/**
 * 附件元数据仓储（03 §4「附件正文进入受控存储，数据库保存内容地址/大小/类型/owner」、
 * §6 附件上传）。
 *
 * 字节由 `attachments/attachmentStore.ts` 在主进程异步落盘；这里只持久元数据与引用
 * 事实。内容地址 = sha256，同一 owner 重复上传相同内容幂等返回既有行（不产生第二份
 * 引用）；未引用对象按保留期由 `attachments.sweep` 清理候选行，文件删除由调用方按
 * 返回的 orphanShas 执行。
 */
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { readInt, readOptionalInt, readOptionalText, readText } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import { ATTACHMENT_ID_PATTERN } from "../attachments/attachmentTypes.js";
import type { AttachmentObjectRecord } from "../attachments/attachmentTypes.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

function mapAttachmentRow(row: SqlRow): AttachmentObjectRecord {
  return {
    attachmentId: readText(row, "sha256"),
    ownerPrincipalId: readText(row, "owner_principal_id"),
    fileName: readText(row, "file_name"),
    mime: readText(row, "mime"),
    byteSize: readInt(row, "byte_size"),
    state: readText(row, "state") as AttachmentObjectRecord["state"],
    taskId: readOptionalText(row, "task_id"),
    createdAt: readInt(row, "created_at"),
    publishedAt: readOptionalInt(row, "published_at"),
    referencedAt: readOptionalInt(row, "referenced_at"),
    lastReferencedTaskId: readOptionalText(row, "last_referenced_task_id"),
  };
}

function selectAttachment(
  context: StorageContext,
  ownerPrincipalId: string,
  sha256: string,
): SqlRow | undefined {
  return context.db
    .prepare("SELECT * FROM attachment_objects WHERE owner_principal_id = ? AND sha256 = ?")
    .get(ownerPrincipalId, sha256);
}

export const attachmentRepoHandlers = {
  "attachments.publish": (context, params): AttachmentObjectRecord => {
    if (!ATTACHMENT_ID_PATTERN.test(params.sha256)) {
      throw invalidAttachment("附件内容地址必须是 sha256 十六进制");
    }
    if (!Number.isInteger(params.byteSize) || params.byteSize <= 0) {
      throw invalidAttachment("附件字节数必须是正整数");
    }
    if (params.mime.length === 0 || params.mime.length > 128) {
      throw invalidAttachment("附件 MIME 长度非法");
    }
    return withWriteTransaction(context, () => {
      context.db
        .prepare(
          `INSERT INTO attachment_objects (
             sha256, owner_principal_id, file_name, mime, byte_size, state, task_id,
             created_at, published_at
           ) VALUES (?, ?, ?, ?, ?, 'published', ?, ?, ?)
           ON CONFLICT (owner_principal_id, sha256) DO UPDATE SET
             state = 'published',
             published_at = COALESCE(attachment_objects.published_at, excluded.published_at),
             task_id = COALESCE(excluded.task_id, attachment_objects.task_id)`,
        )
        .run(
          params.sha256,
          params.ownerPrincipalId,
          params.fileName,
          params.mime,
          params.byteSize,
          params.taskId ?? null,
          params.now,
          params.now,
        );
      const row = selectAttachment(context, params.ownerPrincipalId, params.sha256);
      if (!row) throw invalidAttachment("附件元数据写入失败");
      return mapAttachmentRow(row);
    });
  },

  "attachments.get": (context, params): AttachmentObjectRecord | null => {
    const row = selectAttachment(context, params.ownerPrincipalId, params.attachmentId);
    return row ? mapAttachmentRow(row) : null;
  },

  /**
   * 清扫候选（03 §4「未引用对象按保留期清扫」）：
   * - staged 且超过临时保留期（上传中断/崩溃残留）；
   * - published 但从未被任何输入引用且超过保留期。
   * 删除候选行后返回已无任何 owner 引用的内容地址，由调用方删除对象文件。
   */
  "attachments.sweep": (context, params) => {
    if (params.limit <= 0) return { removedRows: 0, orphanShas: [] };
    return withWriteTransaction(context, () => {
      const stagedBefore = params.now - Math.max(0, params.stagedTtlMs);
      const unreferencedBefore = params.now - Math.max(0, params.unreferencedRetentionMs);
      const candidates = context.db
        .prepare(
          `SELECT sha256, owner_principal_id FROM attachment_objects
           WHERE (state = 'staged' AND created_at <= ?)
              OR (state = 'published' AND referenced_at IS NULL
                  AND COALESCE(published_at, created_at) <= ?)
           ORDER BY created_at, sha256 LIMIT ?`,
        )
        .all(stagedBefore, unreferencedBefore, params.limit);
      if (candidates.length === 0) return { removedRows: 0, orphanShas: [] };

      let removedRows = 0;
      const candidateShas = new Set<string>();
      for (const candidate of candidates) {
        const changes = context.db
          .prepare("DELETE FROM attachment_objects WHERE owner_principal_id = ? AND sha256 = ?")
          .run(readText(candidate, "owner_principal_id"), readText(candidate, "sha256"));
        removedRows += Number(changes.changes);
        candidateShas.add(readText(candidate, "sha256"));
      }
      const orphanShas: string[] = [];
      for (const sha256 of candidateShas) {
        const remaining = context.db
          .prepare("SELECT 1 AS present FROM attachment_objects WHERE sha256 = ? LIMIT 1")
          .get(sha256);
        if (!remaining) orphanShas.push(sha256);
      }
      return { removedRows, orphanShas };
    });
  },
} satisfies Pick<
  StorageHandlerTable,
  "attachments.publish" | "attachments.get" | "attachments.sweep"
>;

function invalidAttachment(message: string): CloudStorageError {
  return new CloudStorageError({
    code: "validation_failed",
    reason: "attachment-not-published",
    message,
  });
}

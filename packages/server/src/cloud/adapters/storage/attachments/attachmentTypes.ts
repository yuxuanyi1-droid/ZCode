/**
 * 受控附件存储的类型与限制（03 §4「附件正文进入受控存储，数据库保存内容地址/
 * 大小/类型/owner」、§6 附件上传端点、W2 §5「附件不得引用浏览器临时路径」）。
 *
 * 内容地址 = sha256 十六进制（去重与完整性校验同一事实）。字节只落在附件目录，
 * 数据库行按 (owner, sha256) 记录大小/类型/owner 与引用时间；浏览器临时路径永不
 * 进入持久引用。
 */
export interface AttachmentObjectRecord {
  /** 内容地址（sha256 hex）；attachmentId 与它同形，可由客户端回传。 */
  attachmentId: string;
  ownerPrincipalId: string;
  fileName: string;
  mime: string;
  byteSize: number;
  state: "staged" | "published";
  taskId?: string;
  createdAt: number;
  publishedAt?: number;
  referencedAt?: number;
  lastReferencedTaskId?: string;
}

export interface PublishAttachmentRequest {
  ownerPrincipalId: string;
  sha256: string;
  fileName: string;
  mime: string;
  byteSize: number;
  taskId?: string;
  now: number;
}

export interface AttachmentSweepRequest {
  now: number;
  /** 未发布的临时对象保留期：崩溃/中断的上传按此清扫。 */
  stagedTtlMs: number;
  /** 已发布但从未被输入引用的对象保留期（03 §4「未引用对象按保留期清扫」）。 */
  unreferencedRetentionMs: number;
  limit: number;
}

export interface AttachmentSweepResult {
  removedRows: number;
  /** 行删除后已无任何 owner 引用的内容地址；调用方据此删除对象文件。 */
  orphanShas: string[];
}

export const ATTACHMENT_ID_PATTERN = /^[0-9a-f]{64}$/;

export interface AttachmentLimits {
  /** 单文件字节上限；超限在发布前拒绝，不落对象。 */
  maxBytes: number;
  /** 单条输入可引用的附件数量上限（与 shared `CLOUD_INPUT_LIMITS.maxAttachmentIds` 一致）。 */
  maxPerInput: number;
  /** 文件名长度上限（与响应 schema 的 256 对齐）。 */
  maxFileNameChars: number;
  /** staged 对象保留期。 */
  stagedTtlMs: number;
  /** 已发布未引用对象保留期。 */
  unreferencedRetentionMs: number;
}

export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxBytes: 16 * 1024 * 1024,
  maxPerInput: 16,
  maxFileNameChars: 256,
  stagedTtlMs: 24 * 60 * 60 * 1000,
  unreferencedRetentionMs: 7 * 24 * 60 * 60 * 1000,
};

export function isAttachmentId(value: string): boolean {
  return ATTACHMENT_ID_PATTERN.test(value);
}

/**
 * 文件名只作展示：剥掉任何路径成分（POSIX 与 Windows 分隔符），空名回落到 `file`。
 * 受控存储按内容地址落盘，文件名永远不会成为路径的一部分。
 */
export function sanitizeAttachmentFileName(fileName: string, maxChars: number): string {
  const trimmed = fileName.trim().replaceAll("\\", "/").split("/").filter(Boolean).pop() ?? "";
  // 只保留可打印字符：去掉控制字符（含路径分隔符注入之外的不可见字符）。
  const cleaned = trimmed.replace(/\p{Cc}/gu, "").slice(0, maxChars);
  return cleaned.length > 0 ? cleaned : "file";
}

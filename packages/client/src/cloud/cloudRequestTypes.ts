/**
 * Cloud SDK 的请求选项类型（specs/cloud-agent 03 §6；W7）。
 *
 * 单独成文件：`cloudControlPlaneClient.ts` 已接近 max-lines 门禁，这些类型同时被
 * 主客户端契约与 profile 契约使用，放在独立模块避免契约文件之间互相导入。
 */

export interface CloudRequestOptions {
  readonly signal?: AbortSignal | undefined;
  /** 单请求超时覆盖；events 长轮询由 SDK 按 waitMs 自动上调。 */
  readonly timeoutMs?: number | undefined;
}

/** events 有界长轮询的传输超时余量：waitMs 之上留出服务端处理时间（03 §6 events 行）。 */
export const CLOUD_EVENTS_TIMEOUT_GRACE_MS = 5_000;

/** 附件上传入参：multipart 字段名由 shared `CLOUD_ATTACHMENT_UPLOAD_FORM` 冻结（W7 CR-4）。 */
export interface CloudUploadAttachmentOptions extends CloudRequestOptions {
  /** 归属任务；未声明支持 task-owned 上传的部署返回 `not_configured`（03 §6、11 §9）。 */
  readonly taskId?: string | undefined;
}

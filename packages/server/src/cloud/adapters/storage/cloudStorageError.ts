/**
 * 存储 adapter 结构化错误（specs/cloud-agent/03 §4 持久承诺、§5 operation 对账、
 * W2 §5「事务与唯一约束承担状态迁移」）。
 *
 * 端口签名只声明成功形状（W0 冻结），失败必须能被上层识别为「哪一类」而不是
 * 解析文案：本错误携带归一错误码（`@zcode/shared` 的 `CloudErrorCode`）与稳定的
 * reason 标识。reason 只用于程序分支与日志，不得作为面向用户的文案。
 */
import type { CloudErrorCode } from "@zcode/shared";

/** 存储层失败原因（稳定标识，新增需同步 spec 与用例）。 */
export type CloudStorageErrorReason =
  | "invalid-cursor"
  | "invalid-limit"
  | "invalid-record"
  | "not-found"
  | "active-write-run-exists"
  | "run-generation-mismatch"
  | "task-revision-regressed"
  | "delivery-transition-rejected"
  | "attachment-not-published"
  | "attachment-too-large"
  | "attachment-type-rejected"
  | "attachment-hash-mismatch"
  | "storage-not-ready"
  | "migration-failed"
  | "migration-checksum-mismatch"
  | "migration-downgrade-blocked"
  | "database-error"
  | "database-closed"
  | "unknown-method"
  | "fault-injected"
  | "queued-before-ready"
  | "worker-unavailable";

export interface CloudStorageErrorOptions {
  code: CloudErrorCode;
  reason: CloudStorageErrorReason;
  message: string;
  cause?: unknown;
}

export class CloudStorageError extends Error {
  readonly code: CloudErrorCode;
  readonly reason: CloudStorageErrorReason;

  constructor(options: CloudStorageErrorOptions) {
    super(options.message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CloudStorageError";
    this.code = options.code;
    this.reason = options.reason;
  }
}

export function isCloudStorageError(value: unknown): value is CloudStorageError {
  return value instanceof CloudStorageError;
}

/** 跨线程/跨边界传输用的错误载荷（不含堆栈与原文，避免泄漏内部 SQL）。 */
export interface CloudStorageErrorPayload {
  code: CloudErrorCode;
  reason: CloudStorageErrorReason;
  message: string;
}

export function toCloudStorageErrorPayload(error: unknown): CloudStorageErrorPayload {
  if (isCloudStorageError(error)) {
    return { code: error.code, reason: error.reason, message: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  return {
    // 未归一的底层错误（SQLITE_FULL、I/O error、约束竞态…）是存储不可用事实，
    // 不是请求校验失败：上层必须 fail closed 并走对账/运维，不得返回 accepted。
    code: "recovery_required",
    reason: "database-error",
    // SQLite 原始错误只保留有限长度，避免把整个 SQL 语句带进响应/日志。
    message: message.slice(0, 200),
  };
}

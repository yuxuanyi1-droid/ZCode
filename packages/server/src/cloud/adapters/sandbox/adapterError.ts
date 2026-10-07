/**
 * 沙箱 provider adapter 的归一错误（specs/cloud-agent/01 §9 错误类别表、03 §6）。
 * provider 原始响应/错误码不得透出：统一映射到 @zcode/shared 的 cloud 错误码目录，
 * message 有界且不含 API key、provider metadata 值或原始响应体。
 *
 * retryable 语义直接取 `CLOUD_ERROR_RETRYABLE`（shared 目录）：副作用结果未知的码
 * （provider_create_unknown / provider_termination_unknown）永远不是 retryable——
 * 必须先按 operationKey 对账（01 §4.1、03 §5），不得盲目第二次 create/terminate。
 */
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode } from "@zcode/shared";

export class CloudAdapterError extends Error {
  readonly code: CloudErrorCode;
  readonly retryable: boolean;
  /** 脱敏上下文（有界），用于日志关联；不含凭据、prompt 或 provider 原始 body。 */
  readonly safeContext: Record<string, string | number> | undefined;

  constructor(
    code: CloudErrorCode,
    message: string,
    safeContext?: Record<string, string | number>,
  ) {
    super(message.length > 300 ? `${message.slice(0, 300)}…` : message);
    this.name = "CloudAdapterError";
    this.code = code;
    this.retryable = CLOUD_ERROR_RETRYABLE[code];
    this.safeContext = safeContext;
  }
}

export function isCloudAdapterError(error: unknown): error is CloudAdapterError {
  return error instanceof CloudAdapterError;
}

/**
 * 与 `createServiceLogger(scope)`（@zcode/services/node，AGENTS.md 日志约定）结构
 * 兼容的注入型 logger。方法声明（而非函数属性）以便既有 ServiceLogger 直接传入，
 * 适配层不为日志再引入一层包装。
 */
export interface CloudAdapterLogger {
  debug(traceId: undefined | string, ...args: unknown[]): void;
  info(traceId: undefined | string, ...args: unknown[]): void;
  warn(traceId: undefined | string, ...args: unknown[]): void;
  error(traceId: undefined | string, ...args: unknown[]): void;
}

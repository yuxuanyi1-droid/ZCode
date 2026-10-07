/**
 * app 层统一返回形状（03 §6 错误信封的语义部分、§6.2「新请求的配置/目标冲突是结构化错误」）。
 *
 * app 只决定 `code` 与 `reason`；`retryable` 直接取 shared 的 `CLOUD_ERROR_RETRYABLE`
 * （errors.ts 是该语义的唯一事实源），HTTP 信封、traceId 与状态码映射归 W5 入口层。
 */
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode } from "@zcode/shared";

export interface CloudAppFailure {
  ok: false;
  code: CloudErrorCode;
  /** 有界、可读的原因标签；不是给用户看的最终文案，也不含 secret/正文。 */
  reason: string;
  retryable: boolean;
  /** 结构化细节（有界 JSON）：不得写入 prompt、token 或 provider 原始响应。 */
  details?: Record<string, string | number | boolean>;
}

export interface CloudAppSuccess<T> {
  ok: true;
  value: T;
}

export type CloudAppResult<T> = CloudAppSuccess<T> | CloudAppFailure;

export function ok<T>(value: T): CloudAppSuccess<T> {
  return { ok: true, value };
}

export function fail(
  code: CloudErrorCode,
  reason: string,
  details?: CloudAppFailure["details"],
): CloudAppFailure {
  const failure: CloudAppFailure = {
    ok: false,
    code,
    reason,
    retryable: CLOUD_ERROR_RETRYABLE[code],
  };
  if (details) failure.details = details;
  return failure;
}

/** 把端口抛出的异常折叠成结构化失败：不把原始异常文案透给用户或日志。 */
export function failureFromError(code: CloudErrorCode, reason: string): CloudAppFailure {
  return fail(code, reason);
}

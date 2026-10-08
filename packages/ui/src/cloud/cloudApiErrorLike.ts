/**
 * 云错误的结构化识别（specs/cloud-agent/04 §6「UI 不解析异常文字」）。
 *
 * UI 不 import `@zcode/client`（组件不直连 SDK，W8 §4），因此按**形状**识别
 * SDK 抛出的 `CloudApiError`：只要有 shared 目录里的 `code` 就按 code 分支，
 * `message` 只用于展示。形状不匹配就退化为「结果未知」，绝不解析文案猜语义
 * （09 §8 归一要求）。
 */
import { isCloudErrorCode, type CloudErrorCode } from "@zcode/shared";

export interface CloudApiErrorLike {
  readonly code: CloudErrorCode;
  /** retryable 语义沿用 shared 目录：true = 可用同一幂等键安全重试同一操作。 */
  readonly retryable: boolean;
  readonly source?: string | undefined;
  readonly httpStatus?: number | undefined;
}

export function isCloudApiErrorLike(value: unknown): value is CloudApiErrorLike {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.code === "string" && isCloudErrorCode(record.code);
}

/** 读取归一错误码；拿不到返回 null（调用方按「未知结果」处理，不猜）。 */
export function readCloudErrorCode(value: unknown): CloudErrorCode | null {
  return isCloudApiErrorLike(value) ? value.code : null;
}

/**
 * 读取服务端失败 reason（2026-10-08 终态 run 发送行为修订）。
 *
 * 服务端把稳定机器可读 reason 同时放进信封 `message` 与 `details.reason`
 * （http support `respondFailure`），客户端 SDK 原样保留 `details`。UI 不解析
 * message 文案，只按结构化 `details.reason` 细分语义；形状不匹配返回 null，
 * 调用方回落到 code 级文案，不猜（04 §6、09 §8）。
 */
export function readCloudErrorReason(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const details = (value as Record<string, unknown>).details;
  if (!details || typeof details !== "object") {
    return null;
  }
  const reason = (details as Record<string, unknown>).reason;
  return typeof reason === "string" && reason.trim().length > 0 ? reason : null;
}

export function isCloudApiErrorRetryable(value: unknown): boolean {
  if (!isCloudApiErrorLike(value)) {
    return false;
  }
  const record = value as unknown as Record<string, unknown>;
  return typeof record.retryable === "boolean" ? record.retryable : false;
}

/**
 * resync 信号：SDK 的 `CloudResyncRequiredError` 是**客户端恢复控制信号**而不是 wire 错误码
 * （见 client `cloudApiError.ts`）。这里按 `name` 识别，避免把它误当成投递失败。
 */
export function isCloudResyncRequiredError(value: unknown): boolean {
  return value instanceof Error && value.name === "CloudResyncRequiredError";
}

/**
 * 云任务动作错误的用户可读文案归一（specs/cloud-agent/04 §6「UI 不解析异常文字」、
 * 2026-10-08 巡检修订）。
 *
 * 背景（实测缺陷）：归档被服务端拒绝时，toast 直接显示 `describeCloudSubmissionError`
 * 返回的**原始错误码**（如 `validation_failed`），用户看到的是内部目录而非可行动提示。
 *
 * 规则（纯函数，node:test 直接覆盖）：
 * - 只按 shared 冻结错误码目录映射（`CLOUD_ERROR_CODES`），不解析 message 文案；
 * - 未映射的错误码回落到 `describeCloudSubmissionError` 的原结果（错误码本身），
 *   不猜语义（09 §8）；
 * - 文案由调用方经 intl 取得，本模块只产出 i18n key。
 */
import { readCloudErrorCode } from "./cloudApiErrorLike.js";
import { describeCloudSubmissionError } from "./cloudTaskSubmission.js";

/**
 * 任务生命周期动作（归档/恢复/停止/重开）可能遇到的错误码 → i18n key。
 * 只收录有明确用户动作含义的码；其余码由调用方回落到原始码展示。
 */
const TASK_ACTION_ERROR_MESSAGE_KEYS: Readonly<Partial<Record<string, string>>> = {
  not_found: "cloud.errors.not_found",
  validation_failed: "cloud.errors.validation_failed",
  stale: "cloud.errors.stale",
  unauthenticated: "cloud.errors.unauthenticated",
  unauthorized: "cloud.errors.unauthorized",
  permission_revoked: "cloud.errors.permission_revoked",
  installation_revoked: "cloud.errors.installation_revoked",
  quota_exceeded: "cloud.errors.quota_exceeded",
  budget_exceeded: "cloud.errors.budget_exceeded",
  not_ready: "cloud.errors.not_ready",
  idempotency_conflict: "cloud.errors.idempotency_conflict",
  rate_limited: "cloud.errors.rate_limited",
  network_unknown: "cloud.errors.network_unknown",
  provider_unreachable: "cloud.errors.provider_unreachable",
  bridge_disconnected: "cloud.errors.bridge_disconnected",
  recovery_required: "cloud.errors.recovery_required",
};

/** 错误码 → i18n key；未映射返回 null（调用方回落到原始码，不猜语义）。 */
export function cloudTaskErrorCodeMessageKey(code: string): string | null {
  return TASK_ACTION_ERROR_MESSAGE_KEYS[code] ?? null;
}

/**
 * 归一任务动作失败文案：结构化错误码优先映射成用户可读 i18n 文案；
 * 非结构化错误维持 `describeCloudSubmissionError` 的结果（04 §6）。
 *
 * @param translate i18n key → 文案的取值函数（通常 `(id) => intl.formatMessage({ id })`）。
 */
export function describeCloudTaskActionError(
  error: unknown,
  translate: (id: string) => string,
): string {
  const code = readCloudErrorCode(error);
  if (code !== null) {
    const key = cloudTaskErrorCodeMessageKey(code);
    if (key !== null) {
      return translate(key);
    }
  }
  return describeCloudSubmissionError(error);
}

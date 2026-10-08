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
import { readCloudErrorCode, readCloudErrorReason } from "./cloudApiErrorLike.js";
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

/**
 * 输入提交（append/reopen）失败的 `not_ready` reason → i18n key
 * （2026-10-08 终态 run 发送行为修订）。
 *
 * reason 是服务端稳定机器可读标签（`respondFailure` 放进 `details.reason`），
 * 取值以服务端 precheck/gateway 实际产出为准，只收录语义明确的三档；未知或
 * 缺失 reason 回落到 `not_ready` 的通用文案，不猜语义（04 §6、09 §8）。
 */
const NOT_READY_REASON_MESSAGE_KEYS: Readonly<Partial<Record<string, string>>> = {
  "no-active-run": "cloud.errors.not_ready.no_active_run",
  "stop-requested": "cloud.errors.not_ready.stop_requested",
  "run-not-ready": "cloud.errors.not_ready.run_not_ready",
  // 归档被拒（taskLifecycle archive 预检 2026-10-09 生命周期 v2：409 not_ready）：
  // 「存在活动 run」与「runtime 未就绪稍后再试」的用户动作完全不同（前者要先停止），
  // 必须细分，否则归档入口给出误导性重试暗示（2026-10-07 终验缺陷 E）。
  "task-has-active-run": "cloud.errors.not_ready.task_has_active_run",
};

/** 错误码 → i18n key；未映射返回 null（调用方回落到原始码，不猜语义）。 */
export function cloudTaskErrorCodeMessageKey(code: string): string | null {
  return TASK_ACTION_ERROR_MESSAGE_KEYS[code] ?? null;
}

/**
 * 输入提交失败的错误码 + reason → i18n key；无映射返回 null（调用方回落原始信息）。
 * 仅 `not_ready` 按 reason 细分；其余码沿用任务动作文案表（04 §6：UI 不解析异常文字）。
 */
export function cloudInputRejectionMessageKey(code: string, reason: string | null): string | null {
  if (code === "not_ready") {
    return (
      (reason !== null ? NOT_READY_REASON_MESSAGE_KEYS[reason] : undefined) ??
      "cloud.errors.not_ready"
    );
  }
  return TASK_ACTION_ERROR_MESSAGE_KEYS[code] ?? null;
}

/**
 * 归一任务动作失败文案：结构化错误码优先映射成用户可读 i18n 文案；
 * 非结构化错误维持 `describeCloudSubmissionError` 的结果（04 §6）。
 *
 * `not_ready` 按 `details.reason` 细分（2026-10-07 终验缺陷 E）：归档对活动 run 的
 * 拒绝（`task-has-active-run`）必须呈现「先停止再归档」而不是通用「稍后再试」；
 * 未知/缺失 reason 仍回落通用 `cloud.errors.not_ready`，不猜语义（09 §8）。
 *
 * @param translate i18n key → 文案的取值函数（通常 `(id) => intl.formatMessage({ id })`）。
 */
export function describeCloudTaskActionError(
  error: unknown,
  translate: (id: string) => string,
): string {
  const code = readCloudErrorCode(error);
  if (code === "not_ready") {
    const reason = readCloudErrorReason(error);
    const key = reason !== null ? NOT_READY_REASON_MESSAGE_KEYS[reason] : undefined;
    return translate(key ?? "cloud.errors.not_ready");
  }
  if (code !== null) {
    const key = cloudTaskErrorCodeMessageKey(code);
    if (key !== null) {
      return translate(key);
    }
  }
  return describeCloudSubmissionError(error);
}

/**
 * 归一输入提交失败文案（2026-10-08 终态 run 发送行为修订）：与任务动作同表，
 * 但 `not_ready` 按 `details.reason` 细分（no-active-run/stop-requested/run-not-ready），
 * 未映射码回落 `describeCloudSubmissionError` 的原始结果，不猜语义。
 */
export function describeCloudInputRejection(
  error: unknown,
  translate: (id: string) => string,
): string {
  const code = readCloudErrorCode(error);
  if (code !== null) {
    const key = cloudInputRejectionMessageKey(code, readCloudErrorReason(error));
    if (key !== null) {
      return translate(key);
    }
  }
  return describeCloudSubmissionError(error);
}

/**
 * 归一 composer 发送结果里的结构化拒绝（useCloudComposerSubmit.send 的
 * blocked/unknown 变体）：code+reason 命中文案表即翻译；否则回落原始 detail
 * （错误码本身，09 §8），两者皆无返回 null（本地前置失败，由调用方决定提示）。
 */
export function describeCloudComposerRejection(
  rejection: {
    readonly code: string | null;
    readonly reason: string | null;
    readonly detail: string | null;
  },
  translate: (id: string) => string,
): string | null {
  if (rejection.code !== null) {
    const key = cloudInputRejectionMessageKey(rejection.code, rejection.reason);
    if (key !== null) {
      return translate(key);
    }
  }
  return rejection.detail;
}

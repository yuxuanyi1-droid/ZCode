/**
 * create 失败的归一分类与错误文本（01 §9、03 §5）。
 *
 * 从 `createOperation.ts` 拆出（该文件触及 max-file-lines）。判定与文本是同一条规则的两面：
 * **确定失败**（provider 明确没建资源）要立即落 `failed` 并让 run 以可读原因收口，不进对账；
 * 只有**结果未知**（网络超时、provider 不可达、限流抖动）才留 `ambiguous`；
 * 而任何未归类异常也至少要留下有界文本，避免"只有 errorCode、没有原因"的可诊断性损失。
 */
import { isCloudErrorCode, type CloudErrorCode } from "@zcode/shared";

/**
 * 确定失败（01 §9 / 03 §5）：这些归一码表示 provider 侧**明确没有创建资源**，
 * 立即把 operation 落 `failed` 并让 run 以可读原因收口，不进对账循环。
 * 其余（网络超时、provider 不可达、限流抖动等）按"结果未知"处理。
 */
const DEFINITE_CREATE_FAILURE_CODES: ReadonlySet<CloudErrorCode> = new Set([
  "validation_failed",
  "unsupported_template",
  "resource_unsupported",
  "invalid_ref",
  "permission_revoked",
  "installation_revoked",
  "unauthorized",
  "unauthenticated",
  "quota_exceeded",
  "budget_exceeded",
  "bootstrap_failed",
]);

/** 归一码 → 稳定的 run 收口原因标签（UI/i18n 决定文案，03 §6）。 */
const CREATE_FAILURE_REASONS: Partial<Record<CloudErrorCode, string>> = {
  validation_failed: "create-rejected",
  unsupported_template: "template-unsupported",
  resource_unsupported: "resource-unsupported",
  invalid_ref: "invalid-ref",
  permission_revoked: "provider-permission-revoked",
  installation_revoked: "provider-permission-revoked",
  unauthorized: "provider-unauthorized",
  unauthenticated: "provider-unauthenticated",
  quota_exceeded: "provider-quota-exceeded",
  budget_exceeded: "provider-budget-exceeded",
  bootstrap_failed: "bootstrap-failed",
};

/** 三分支结论：确定失败（归一码 + 原因标签）或结果未知（进对账）。 */
export type CreateFailureClassification =
  | { definite: true; code: CloudErrorCode; reason: string }
  | { definite: false; code: "provider_create_unknown"; reason: "create-unknown" };

export function classifyCreateFailure(error: unknown): CreateFailureClassification {
  const rawCode = (error as { code?: unknown } | null)?.code;
  if (
    typeof rawCode === "string" &&
    isCloudErrorCode(rawCode) &&
    DEFINITE_CREATE_FAILURE_CODES.has(rawCode)
  ) {
    return {
      definite: true,
      code: rawCode,
      reason: CREATE_FAILURE_REASONS[rawCode] ?? "create-failed",
    };
  }
  return { definite: false, code: "provider_create_unknown", reason: "create-unknown" };
}

/**
 * 脱敏 + 有界的错误文本（run.lastError 上限 512）：只取 message、压平换行、截断；
 * 不拼接 provider 原始响应体、不含 header/token。任何未归类的异常也至少留下这段文本，
 * 避免"只有 errorCode、没有原因"的可诊断性损失。
 */
export function describeCreateError(error: unknown): string {
  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : (() => {
            try {
              return JSON.stringify(error);
            } catch {
              return "unprintable error";
            }
          })();
  const flattened = raw.replace(/\s+/g, " ").trim();
  const detail = flattened.length > 0 ? flattened : "unknown provider error";
  return detail.slice(0, 480);
}

/**
 * 沙箱 bootstrap 步骤（clone grant 签发 + 拉起 supervisor）与失败补偿
 * （specs/cloud-agent 01 §5.1 第 3 条、§7.2、§9 错误与审计）。
 *
 * 顺序依据：create 成功**立即持久 handle/deadline，再由控制面启动 supervisor**（W3 已把启动
 * 从 `create()` 拆出，因此"建完沙箱就拉起"的旧语义不再成立）。正常 create 路径与
 * `findCreateResult` 对账恢复路径都必须调用本过程，否则会出现"沙箱活着但没人连"的静默态。
 *
 * 失败语义：启动失败即视为 bootstrap 失败 → 要求终止沙箱；终止**已确认**时才让 run 收口
 * 并释放配额，未确认则保留配额槽等对账（01 §4.3「结果未知保留槽」、§9）。
 */
import type { CloudRunRecord } from "@zcode/shared";
import type { CloudErrorCode } from "@zcode/shared";
import { cloudCoreLogger } from "../logger.js";
import { describeCreateError } from "./createFailure.js";
import type { RunCompensation, TerminationVerdict } from "./compensation.js";

export type BootstrapAttempt =
  | { ok: true }
  | { ok: false; code: CloudErrorCode; verdict: TerminationVerdict; detail: string };

/**
 * bootstrap 步骤内的失败：携带归一错误码与稳定原因标签，供补偿路径记录
 * （supervisor 启动失败用 `bootstrap_failed`；clone grant 签发失败用其自身错误码）。
 */
export class SandboxBootstrapError extends Error {
  constructor(
    readonly code: CloudErrorCode,
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "SandboxBootstrapError";
  }
}

export async function bootstrapSandboxWithCompensation(input: {
  /** bootstrap 步骤（clone grant → supervisor 启动）；抛出 `SandboxBootstrapError` 表示不可自愈失败。 */
  bootstrap: () => Promise<void>;
  run: CloudRunRecord;
  compensation: RunCompensation;
  /** 把本 operation 记成失败（由调用方带租约结算）。 */
  settleFailed: (code: CloudErrorCode) => Promise<void>;
}): Promise<BootstrapAttempt> {
  try {
    await input.bootstrap();
    return { ok: true };
  } catch (error) {
    const detail = describeCreateError(error);
    const failureCode: CloudErrorCode =
      error instanceof SandboxBootstrapError ? error.code : "bootstrap_failed";
    const failureReason =
      error instanceof SandboxBootstrapError ? error.reason : "bootstrap-failed";
    const terminated = await input.compensation.terminateRun({
      runId: input.run.runId,
      runGeneration: input.run.runGeneration,
      reason: failureReason,
      // 终止确认后由补偿路径收口 run（stopped + 该可读原因）；未确认时保留槽等对账。
      lastError: detail,
    });
    const verdict: TerminationVerdict = terminated.ok ? terminated.value.verdict : "unknown";
    await input.settleFailed(failureCode);
    cloudCoreLogger.warn(undefined, "cloud sandbox bootstrap failed", {
      runId: input.run.runId,
      code: failureCode,
      reason: failureReason,
      terminationVerdict: verdict,
      detail,
    });
    return { ok: false, code: failureCode, verdict, detail };
  }
}

/**
 * E2B 暂停/恢复的 REST 分支语义（specs/cloud-agent/01 §4.1 修订 2026-10-09）。
 *
 * 从 e2bDriver.ts 拆出（行数预算）：端点常量与状态归一在 e2bRest.ts，本文件承载
 * pause/resume 两个操作的分支判定——成功（204 paused / 200·201 running）、确定失败
 * （4xx，抛归一错误）、结果未知（网络/5xx → unknown 观察，绝不写成 paused/failed）。
 * **能力门禁（A-7）不在此处**：门禁读 `resolvePauseResumeCapability` 并由 driver 方法
 * 在调用本文件前执行（fail-closed：none 时根本不会发起 provider 请求）。
 */
import type { ProviderObservation } from "../../app/ports/sandboxDriverPort.js";
import type { CloudAdapterLogger } from "./adapterError.js";
import { boundEvidence } from "./reconcile.js";
import { E2B_PATH_PAUSE, E2B_PATH_RESUME, isAbortLike, isDefiniteRejection } from "./e2bRest.js";
import type { E2bRestClient } from "./e2bRest.js";

/**
 * 暂停：POST /sandboxes/{id}/pause，204 = provider 确认已暂停且可恢复。
 * 只有 paused 观察才算暂停成功（B-4：确认前控制面不得写 run=paused）。
 */
export async function pauseE2bSandbox(input: {
  rest: E2bRestClient;
  logger: CloudAdapterLogger;
  now: () => number;
  sandboxId: string;
}): Promise<ProviderObservation> {
  const { rest, logger, now, sandboxId } = input;
  const evidenceOf = (outcome: string) =>
    boundEvidence(`e2b POST ${E2B_PATH_PAUSE(sandboxId)} -> ${outcome}`);
  let response;
  try {
    // memory 级默认：保留完整内存快照（body 缺省即 true，显式写出以钉死语义）。
    response = await rest.request(E2B_PATH_PAUSE(sandboxId), {
      method: "POST",
      body: { memory: true },
    });
  } catch (error) {
    const cause = isAbortLike(error) ? "aborted" : "network-error";
    logger.warn(undefined, "e2b pause unavailable", {
      sandboxId,
      evidence: evidenceOf(cause),
    });
    return {
      status: "unknown",
      observedAt: now(),
      evidenceSource: "none",
      evidence: evidenceOf(cause),
      errorCode: "provider_unreachable",
    };
  }
  if (response.status === 204) {
    // provider 确认：已暂停、可恢复（B-4 的「provider paused 确认」以此为准）。
    return {
      status: "paused",
      observedAt: now(),
      evidenceSource: "provider-api",
      evidence: evidenceOf("204 paused"),
    };
  }
  if (response.status === 404) {
    return {
      status: "notFound",
      observedAt: now(),
      evidenceSource: "provider-api",
      evidence: evidenceOf("404 not-found"),
    };
  }
  if (isDefiniteRejection(response.status)) {
    // 409（已在运行态不可暂停/已暂停）等明确拒绝：抛归一错误，不伪造 paused。
    throw await rest.rejectionError(response, "pause");
  }
  throw rest.unknownOutcomeError("query", response.status);
}

/**
 * 恢复：POST /sandboxes/{id}/resume，body.timeout 设恢复后的新 TTL（provider 缺省只有
 * 15 秒，必须显式传收敛后的请求寿命）。200 = 已在运行、201 = 恢复成功；两者都是
 * 「provider 确认运行」。
 */
export async function resumeE2bSandbox(input: {
  rest: E2bRestClient;
  logger: CloudAdapterLogger;
  now: () => number;
  sandboxId: string;
  /** 收敛后的请求寿命（秒）：由 driver 的 clampTimeoutSeconds 计算（01 §4.3 上限收敛）。 */
  timeoutSeconds: number;
}): Promise<ProviderObservation> {
  const { rest, logger, now, sandboxId, timeoutSeconds } = input;
  const evidenceOf = (outcome: string) =>
    boundEvidence(`e2b POST ${E2B_PATH_RESUME(sandboxId)} -> ${outcome}`);
  let response;
  try {
    response = await rest.request(E2B_PATH_RESUME(sandboxId), {
      method: "POST",
      body: { timeout: timeoutSeconds },
    });
  } catch (error) {
    const cause = isAbortLike(error) ? "aborted" : "network-error";
    logger.warn(undefined, "e2b resume unavailable", {
      sandboxId,
      evidence: evidenceOf(cause),
    });
    return {
      status: "unknown",
      observedAt: now(),
      evidenceSource: "none",
      evidence: evidenceOf(cause),
      errorCode: "provider_unreachable",
    };
  }
  if (response.ok) {
    // 200（已在运行）/ 201（恢复成功）都是 provider 确认的运行观察。
    return {
      status: "running",
      observedAt: now(),
      evidenceSource: "provider-api",
      evidence: evidenceOf(`${response.status} running`),
    };
  }
  if (response.status === 404) {
    // provider 保留期已尽、快照不存在：notFound（调用方交 keepalive liveness 收口）。
    return {
      status: "notFound",
      observedAt: now(),
      evidenceSource: "provider-api",
      evidence: evidenceOf("404 not-found"),
    };
  }
  if (isDefiniteRejection(response.status)) {
    throw await rest.rejectionError(response, "resume");
  }
  throw rest.unknownOutcomeError("query", response.status);
}

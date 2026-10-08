/**
 * Daytona 暂停/恢复（disk 级）的 REST 分支语义（specs/cloud-agent/01 §4.2 修订 2026-10-09）。
 *
 * 从 daytonaDriver.ts 拆出（行数预算）：stop 只停不删（文件系统保留、计费保留、进程态
 * 丢失），start 冷启动恢复。**门禁（A-7）不在此处**：由 driver 方法在调用本文件前读
 * `resolvePauseResumeCapability` 执行（fail-closed：none 时根本不会发起 provider 请求）。
 * 实测解禁前该通路不可达；端点形状按官方 OpenAPI（stop/start），TTL 续期复用既有
 * `DAYTONA_PATH_TTL`。
 */
import type { ProviderObservation } from "../../app/ports/sandboxDriverPort.js";
import type { CloudAdapterLogger } from "./adapterError.js";
import { boundEvidence } from "./reconcile.js";
import {
  DAYTONA_PATH_START,
  DAYTONA_PATH_STOP,
  DAYTONA_PATH_TTL,
  isAbortLike,
  isDefiniteRejection,
} from "./daytonaRest.js";
import type { DaytonaRestClient } from "./daytonaRest.js";

/**
 * disk 级暂停：POST /sandbox/{id}/stop——只停不删。停止受理（2xx）或资源已不存在
 * （404）后回查一次观察： Daytona 的 stop 落点是 stop 系停态，对 disk 级暂停而言是
 * 「实例被保留」的确认，映射为 paused 观测（实测解禁后钉死语义）。
 */
export async function pauseDaytonaSandbox(input: {
  rest: DaytonaRestClient;
  logger: CloudAdapterLogger;
  now: () => number;
  sandboxId: string;
  /** 回查观察（复用 driver 的 inspect 实现，避免对象字面量内 `this` 依赖）。 */
  inspect: (sandboxId: string) => Promise<ProviderObservation>;
}): Promise<ProviderObservation> {
  const { rest, now, sandboxId, inspect } = input;
  const evidenceOf = (outcome: string) =>
    boundEvidence(`daytona POST ${DAYTONA_PATH_STOP(sandboxId)} -> ${outcome}`);
  let response;
  try {
    response = await rest.request(DAYTONA_PATH_STOP(sandboxId), { method: "POST" });
  } catch (error) {
    const cause = isAbortLike(error) ? "aborted" : "network-error";
    return {
      status: "unknown",
      observedAt: now(),
      evidenceSource: "none",
      evidence: evidenceOf(cause),
      errorCode: "provider_unreachable",
    };
  }
  if (response.ok || response.status === 404) {
    const observation = await inspect(sandboxId);
    return observation.status === "stopped"
      ? {
          ...observation,
          // stop 是 disk 级暂停的 provider 动作：stop 系停态视为「已暂停保留」。
          status: "paused",
          evidence: boundEvidence(`daytona stop confirmed -> ${observation.status}`),
        }
      : observation;
  }
  if (isDefiniteRejection(response.status)) {
    throw await rest.rejectionError(response, "pause");
  }
  throw rest.unknownOutcomeError("query", response.status);
}

/**
 * disk 级恢复：POST /sandbox/{id}/start 冷启动（文件系统保留、进程态丢失），随后尽力
 * 把 TTL 续到请求寿命。TTL 续期失败不否定恢复本身——「网络超时不等于失败」，控制面
 * keepalive 周期会兜底重试续期。
 */
export async function resumeDaytonaSandbox(input: {
  rest: DaytonaRestClient;
  logger: CloudAdapterLogger;
  now: () => number;
  sandboxId: string;
  /** 收敛后的请求寿命（epoch 毫秒）；由 driver 校验晚于当前时刻后传入。 */
  requestedDeadline: number;
  /** 请求寿命 → TTL 分钟（向上取整：绝不欠配期限；01 §4.3 上限收敛）。 */
  ttlMinutes: () => Promise<number>;
}): Promise<ProviderObservation> {
  const { rest, logger, now, sandboxId, requestedDeadline, ttlMinutes } = input;
  const evidenceOf = (outcome: string) =>
    boundEvidence(`daytona POST ${DAYTONA_PATH_START(sandboxId)} -> ${outcome}`);
  let response;
  try {
    response = await rest.request(DAYTONA_PATH_START(sandboxId), { method: "POST" });
  } catch (error) {
    const cause = isAbortLike(error) ? "aborted" : "network-error";
    return {
      status: "unknown",
      observedAt: now(),
      evidenceSource: "none",
      evidence: evidenceOf(cause),
      errorCode: "provider_unreachable",
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
  if (!response.ok) {
    if (isDefiniteRejection(response.status)) {
      throw await rest.rejectionError(response, "resume");
    }
    throw rest.unknownOutcomeError("query", response.status);
  }
  // 恢复受理：尽力把 TTL 续到请求寿命（失败只记 warn，不否定恢复）。
  try {
    const minutes = await ttlMinutes();
    await rest.request(DAYTONA_PATH_TTL(sandboxId, minutes), { method: "POST" });
  } catch (error) {
    logger.warn(undefined, "daytona resume ttl extension failed", {
      sandboxId,
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return {
    status: "running",
    observedAt: now(),
    evidenceSource: "provider-api",
    evidence: evidenceOf(`${response.status} started`),
  };
}

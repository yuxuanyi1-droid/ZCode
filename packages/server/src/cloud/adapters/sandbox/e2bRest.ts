/**
 * E2B REST wire 层（specs/cloud-agent/01 §4.2/§9）：共享骨架在 sandboxRest.ts，
 * 本文件只提供 E2B 的鉴权头（X-API-Key，key 只进 header）与端点常量。
 * 端点按 E2B 官方 API 参考与历史真实账号实测校准：create / inspect / setTimeout /
 * delete / list。运行中执行命令走官方 SDK（e2bBootstrap.ts），不在这里手写 envd 协议。
 */
import type { ProviderObservation } from "../../app/ports/sandboxDriverPort.js";
import type { CloudAdapterLogger } from "./adapterError.js";
import { boundEvidence } from "./reconcile.js";
import { asRecord, asString, isAbortLike } from "./sandboxRest.js";
import {
  createSandboxRestClient,
  type SandboxFetch,
  type SandboxRestClient,
} from "./sandboxRest.js";

// ── E2B REST 端点常量 ──
export const E2B_PATH_CREATE = "/sandboxes";
export const E2B_PATH_LIST = "/sandboxes";
export const E2B_PATH_SANDBOX = (id: string) => `/sandboxes/${encodeURIComponent(id)}`;
/** setTimeout 的 REST 形态：POST /sandboxes/{id}/timeout body {timeout: 秒}。 */
export const E2B_PATH_TIMEOUT = (id: string) => `/sandboxes/${encodeURIComponent(id)}/timeout`;
export const E2B_TIMEOUT_BODY_FIELD = "timeout";
/**
 * 暂停/恢复（2026-10-09 生命周期 v2；端点定义见 node_modules/e2b/dist 的 REST 契约，
 * SDK 2.52.1）：POST /sandboxes/{id}/pause（204 = 已暂停、可恢复）；POST
 * /sandboxes/{id}/resume（200 = 已在运行 / 201 = 恢复成功，body {timeout: 秒} 设新 TTL，
 * 缺省只有 15 秒，必须显式传收敛后的请求寿命）。
 */
export const E2B_PATH_PAUSE = (id: string) => `/sandboxes/${encodeURIComponent(id)}/pause`;
export const E2B_PATH_RESUME = (id: string) => `/sandboxes/${encodeURIComponent(id)}/resume`;

export const E2B_DEFAULT_BASE_URL = "https://api.e2b.dev";
export const E2B_DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const E2B_GET_RETRY_ATTEMPTS = 2;

export type { SandboxFetch, SandboxFetchInit, SandboxFetchResponse } from "./sandboxRest.js";
export {
  asRecord,
  asString,
  isAbortLike,
  isDefiniteRejection,
  readProviderRejectionMessage,
  sanitizeErrorMessage,
} from "./sandboxRest.js";

/**
 * E2B 状态 → 归一观测状态（01 §4.1，含 2026-10-09 修订）：running 类含创建/启动中
 * （资源已在提供方存在并计费）；**paused 是独立的观测态**——暂停保留期的实例被
 * provider 保留（仍计存储/保留费），不得归入 stopped，否则 keepalive liveness 会把
 * 暂停中的 run 误收口为 expired；stopped 类含确定的停态（archived）；**过渡态
 * （suspending = 暂停进行中）与未映射状态都返回 undefined**（调用方判 unknown）——
 * 生命周期 v2 审计第二批：suspending 曾被归 stopped，暂停进行中的实例会被
 * startup/keepalive 当终局误收 expired（孤儿实例计费）；三个消费者对 unknown 都是
 * 安全的「不收口」，过渡态必须留在可重试的未知里。
 */
const E2B_RUNNING_STATES = new Set(["running", "creating", "started", "active", "provisioning"]);
const E2B_PAUSED_STATES = new Set(["paused"]);
const E2B_STOPPED_STATES = new Set(["stopped", "archived"]);
/** 过渡态：非终局、也非运行/暂停的确定事实（如 suspending = 暂停进行中），归 unknown。 */
const E2B_TRANSITIONAL_STATES = new Set(["suspending"]);

export function mapE2bSandboxState(state: string): "running" | "paused" | "stopped" | undefined {
  if (E2B_RUNNING_STATES.has(state)) return "running";
  if (E2B_PAUSED_STATES.has(state)) return "paused";
  if (E2B_STOPPED_STATES.has(state)) return "stopped";
  // 过渡态与未映射状态一致：undefined → 调用方判 unknown（不猜测、不收口）。
  if (E2B_TRANSITIONAL_STATES.has(state)) return undefined;
  return undefined;
}

export interface E2bRestClient extends SandboxRestClient {}

export interface E2bRestOptions {
  apiKey: () => string | Promise<string>;
  baseUrl: string;
  requestTimeoutMs: number;
  fetch?: SandboxFetch;
  logger: CloudAdapterLogger;
}

export function createE2bRestClient(options: E2bRestOptions): E2bRestClient {
  // provider API key 经注入函数读取，只进请求头，绝不进 URL、日志或 metadata。
  return createSandboxRestClient({
    providerName: "e2b",
    buildHeaders: async () => ({ "X-API-Key": await options.apiKey() }),
    baseUrl: options.baseUrl,
    requestTimeoutMs: options.requestTimeoutMs,
    fetch: options.fetch,
    logger: options.logger,
    // E2B create 404 = templateID 不存在（unsupported_template），
    // 与 Daytona 的 404=资源不存在（not_found）区分，不抹平。
    notFoundCode: "unsupported_template",
  });
}

/**
 * bootstrap 失败时的补偿终止探测（01 §5.1/§9）：DELETE 的 ok/404 是 provider 已确认
 * 资源不存在的事实（供补偿分类判定），其余状态不推测。网络异常由调用方归为未确认。
 */
export function createE2bTerminateProbe(
  rest: E2bRestClient,
): (sandboxId: string) => Promise<{ ok: boolean; status: number }> {
  return async (sandboxId) => {
    const response = await rest.request(E2B_PATH_SANDBOX(sandboxId), { method: "DELETE" });
    return { ok: response.ok, status: response.status };
  };
}

export async function inspectE2bSandbox(input: {
  rest: E2bRestClient;
  logger: CloudAdapterLogger;
  now: () => number;
  sandboxId: string;
}): Promise<ProviderObservation> {
  const { rest, logger, now, sandboxId } = input;
  const path = E2B_PATH_SANDBOX(sandboxId);
  // 证据串只含端点/状态/状态原文要点（≤160 字符），不含凭据、labels 或响应体。
  const evidenceOf = (outcome: string) => boundEvidence(`e2b GET ${path} -> ${outcome}`);
  let response;
  try {
    response = await rest.request(path, { method: "GET", attempts: E2B_GET_RETRY_ATTEMPTS });
  } catch (error) {
    // 网络超时/权限丢失一律 unknown，不是 notFound（01 §4.1）。
    const cause = isAbortLike(error) ? "aborted" : "network-error";
    logger.warn(undefined, "e2b inspect unavailable", {
      sandboxId,
      error: cause,
    });
    return {
      status: "unknown",
      observedAt: now(),
      evidenceSource: "none",
      evidence: evidenceOf(cause),
      errorCode: "provider_unreachable",
    };
  }
  if (response.status === 404) {
    // provider 明确确认资源不存在 → notFound（可释放计费槽）。
    return {
      status: "notFound",
      observedAt: now(),
      evidenceSource: "provider-api",
      evidence: evidenceOf("404 not-found"),
    };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      status: "unknown",
      observedAt: now(),
      evidenceSource: "provider-api",
      evidence: evidenceOf(`${response.status} auth-lost`),
      errorCode: "permission_revoked",
    };
  }
  if (!response.ok) {
    return {
      status: "unknown",
      observedAt: now(),
      evidenceSource: "provider-api",
      evidence: evidenceOf(`${response.status} provider-error`),
      errorCode: "provider_unreachable",
    };
  }
  const body = asRecord(await response.json().catch(() => null));
  const state = asString(body?.["state"]) ?? asString(body?.["status"]) ?? "";
  const mapped = mapE2bSandboxState(state);
  if (mapped !== undefined) {
    return {
      status: mapped,
      observedAt: now(),
      evidenceSource: "provider-api",
      evidence: evidenceOf(`200 state=${state}`),
    };
  }
  // 未映射的 provider 状态不猜测：unknown + 证据留给运营核对。
  logger.warn(undefined, "e2b inspect returned unmapped state", {
    sandboxId,
    state: state.slice(0, 32),
  });
  return {
    status: "unknown",
    observedAt: now(),
    evidenceSource: "provider-api",
    evidence: evidenceOf(`200 unmapped-state=${state.slice(0, 32)}`),
    errorCode: "provider_unreachable",
  };
}

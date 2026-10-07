/**
 * E2B REST wire 层（specs/cloud-agent/01 §4.2/§9）：共享骨架在 sandboxRest.ts，
 * 本文件只提供 E2B 的鉴权头（X-API-Key，key 只进 header）与端点常量。
 * 端点按 E2B 官方 API 参考与历史真实账号实测校准：create / inspect / setTimeout /
 * delete / list。运行中执行命令走官方 SDK（e2bBootstrap.ts），不在这里手写 envd 协议。
 */
import type { CloudAdapterLogger } from "./adapterError.js";
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
 * E2B 状态 → 归一观测状态（01 §4.1）：running 类含创建/启动中（资源已在提供方存在并计费）；
 * stopped 类含暂停/归档；其余不猜测，返回 undefined 由调用方判 unknown。
 */
const E2B_RUNNING_STATES = new Set(["running", "creating", "started", "active", "provisioning"]);
const E2B_STOPPED_STATES = new Set(["paused", "stopped", "archived", "suspending"]);

export function mapE2bSandboxState(state: string): "running" | "stopped" | undefined {
  if (E2B_RUNNING_STATES.has(state)) return "running";
  if (E2B_STOPPED_STATES.has(state)) return "stopped";
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

/**
 * Daytona REST wire 层（specs/cloud-agent/01 §4.2）：共享传输骨架在 sandboxRest.ts；
 * 本文件承载 Daytona 的鉴权头（Authorization: Bearer dtn_…，key 只进 header）、
 * 端点常量与请求/响应形状（labels 合并、handle 解析、状态分类）。
 *
 * 端点与形状按 Daytona 官方 OpenAPI / SDK 契约：REST base `https://app.daytona.io/api`；
 * 响应统一 NestJS 形状（错误 `{statusCode,message}`、列表 `{items:[…]}`）。
 * 状态与期限语义的最终判定在 daytonaDriver（差异不抹平）。
 */
import type {
  ProviderSandboxHandle,
  SandboxCreateInput,
} from "../../app/ports/sandboxDriverPort.js";
import type { CloudAdapterLogger } from "./adapterError.js";
import { buildReconcileLabels } from "./reconcile.js";
import {
  asString,
  createSandboxRestClient,
  type SandboxFetch,
  type SandboxRestClient,
} from "./sandboxRest.js";

// ── Daytona REST 端点常量 ──
export const DAYTONA_PATH_CREATE = "/sandbox";
export const DAYTONA_PATH_LIST = "/sandbox";
export const DAYTONA_PATH_SANDBOX = (id: string) => `/sandbox/${encodeURIComponent(id)}`;
/** 墙钟 TTL（分钟）：设置/更新 autoDestroyAt，作为 provider 确认的期限。 */
export const DAYTONA_PATH_TTL = (id: string, minutes: number) =>
  `/sandbox/${encodeURIComponent(id)}/ttl/${minutes}`;
/**
 * 对账清单查询：labels 的服务端过滤格式未核实（历史实测按 key:val / json 形式返回 0
 * 命中），因此按 limit 拉取后在客户端按 labels.operationKey 匹配。
 */
export const DAYTONA_LIST_LIMIT = 200;

export const DAYTONA_DEFAULT_BASE_URL = "https://app.daytona.io/api";
export const DAYTONA_DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
export const DAYTONA_GET_RETRY_ATTEMPTS = 2;

export interface DaytonaRestClient extends SandboxRestClient {}

export interface DaytonaRestOptions {
  apiKey: () => string | Promise<string>;
  baseUrl: string;
  requestTimeoutMs: number;
  fetch?: SandboxFetch;
  logger: CloudAdapterLogger;
}

export function createDaytonaRestClient(options: DaytonaRestOptions): DaytonaRestClient {
  // API key（dtn_ 前缀）经注入函数读取，只进 Authorization 头。
  return createSandboxRestClient({
    providerName: "daytona",
    buildHeaders: async () => ({ Authorization: `Bearer ${await options.apiKey()}` }),
    baseUrl: options.baseUrl,
    requestTimeoutMs: options.requestTimeoutMs,
    fetch: options.fetch,
    logger: options.logger,
    notFoundCode: "not_found",
  });
}

// ── 请求/响应形状（wire 层，语义决策在 daytonaDriver）──

/** labels 合并（对账键 + 调用方标签，保留键/格式校验在 reconcile.ts）。 */
export function buildDaytonaLabels(input: SandboxCreateInput): Record<string, string> {
  return buildReconcileLabels(input, "label");
}

/**
 * 状态分类（Daytona SandboxState 枚举）：向运行态迁移归 running；停态归 stopped
 * （destroying 仍在计费，资源未释放）；destroyed 才是资源不存在；其余不猜测。
 */
const DAYTONA_RUNNING_STATES = new Set([
  "started",
  "starting",
  "creating",
  "restoring",
  "resuming",
  "pending_build",
  "building_snapshot",
  "pulling_snapshot",
]);
const DAYTONA_STOPPED_STATES = new Set([
  "stopped",
  "stopping",
  "paused",
  "pausing",
  "archived",
  "archiving",
  "snapshotting",
  "forking",
  "destroying",
]);

/** provider 状态原文 → 归一观测状态；未映射返回 undefined（由调用方判 unknown）。 */
export function mapDaytonaSandboxState(
  state: string,
): "running" | "stopped" | "notFound" | undefined {
  if (DAYTONA_RUNNING_STATES.has(state)) return "running";
  if (DAYTONA_STOPPED_STATES.has(state)) return "stopped";
  if (state === "destroyed") return "notFound";
  return undefined;
}

/** ISO 字符串 → epoch 毫秒；非法/缺失返回 undefined（不猜测）。 */
export function parseEpochMs(value: unknown): number | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * create 响应 → handle：`autoDestroyAt` 是 provider 确认期限；缺失时保存估计值
 * （01 §4.3：不把控制面时间当 provider 保证，也不冒充确认期限）。
 */
export function buildDaytonaHandle(
  sandboxId: string,
  imageRef: string,
  body: Record<string, unknown> | null,
  ttlMinutes: number,
  now: () => number,
): ProviderSandboxHandle {
  const confirmed = parseEpochMs(body?.["autoDestroyAt"]);
  const created = parseEpochMs(body?.["createdAt"]);
  const base = {
    provider: "daytona",
    sandboxId,
    templateRevision: asString(body?.["snapshot"]) ?? imageRef,
  };
  if (confirmed !== undefined) {
    return { ...base, providerDeadline: confirmed };
  }
  return { ...base, deadlineEstimate: (created ?? now()) + ttlMinutes * 60_000 };
}

/**
 * bootstrap 失败时的补偿终止探测（01 §5.1/§9）：复用 DELETE 事实（200/404 都算
 * provider 确认资源不存在）供补偿分类判定；网络/5xx 归未确认，由调用方抛
 * provider_termination_unknown 保留对账。
 */
export function createDaytonaTerminateProbe(
  rest: DaytonaRestClient,
): (sandboxId: string) => Promise<{ ok: boolean; status: number }> {
  return async (sandboxId) => {
    const response = await rest.request(DAYTONA_PATH_SANDBOX(sandboxId), { method: "DELETE" });
    return { ok: response.ok, status: response.status };
  };
}

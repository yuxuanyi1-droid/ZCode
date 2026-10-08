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
  ProviderObservation,
  ProviderSandboxHandle,
  SandboxCreateInput,
} from "../../app/ports/sandboxDriverPort.js";
import type { CloudAdapterLogger } from "./adapterError.js";
import { boundEvidence, buildReconcileLabels } from "./reconcile.js";
import {
  asRecord,
  asString,
  createSandboxRestClient,
  isAbortLike,
  isDefiniteRejection,
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
 * disk 级暂停/恢复（2026-10-09 生命周期 v2；01 §4.2 修订）：stop 只停不删
 * （文件系统保留、计费保留），start 冷启动恢复——进程态丢失，须如实向用户披露。
 * 实测解禁前该路径被能力门禁挡住（A-7），端点常量先行落地（驱动头注释预留位）。
 */
export const DAYTONA_PATH_STOP = (id: string) => `/sandbox/${encodeURIComponent(id)}/stop`;
export const DAYTONA_PATH_START = (id: string) => `/sandbox/${encodeURIComponent(id)}/start`;
/**
 * 对账清单查询：labels 的服务端过滤格式未核实（历史实测按 key:val / json 形式返回 0
 * 命中），因此按 limit 拉取后在客户端按 labels.operationKey 匹配。
 */
export const DAYTONA_LIST_LIMIT = 200;

export const DAYTONA_DEFAULT_BASE_URL = "https://app.daytona.io/api";
export { asString, isAbortLike, isDefiniteRejection } from "./sandboxRest.js";
export type { SandboxFetch, SandboxFetchInit, SandboxFetchResponse } from "./sandboxRest.js";
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
 * 状态分类（Daytona SandboxState 枚举，含 2026-10-09 修订）：向运行态迁移归 running；
 * **paused/pausing 是独立的观测态**（provider 保留实例、暂停保留期，不归 stopped，
 * 否则 keepalive liveness 会把暂停中的 run 误收口）；stop 系停态归 stopped
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
const DAYTONA_PAUSED_STATES = new Set(["paused", "pausing"]);
const DAYTONA_STOPPED_STATES = new Set([
  "stopped",
  "stopping",
  "archived",
  "archiving",
  "snapshotting",
  "forking",
  "destroying",
]);

/** provider 状态原文 → 归一观测状态；未映射返回 undefined（由调用方判 unknown）。 */
export function mapDaytonaSandboxState(
  state: string,
): "running" | "paused" | "stopped" | "notFound" | undefined {
  if (DAYTONA_RUNNING_STATES.has(state)) return "running";
  if (DAYTONA_PAUSED_STATES.has(state)) return "paused";
  if (DAYTONA_STOPPED_STATES.has(state)) return "stopped";
  if (state === "destroyed") return "notFound";
  return undefined;
}

/**
 * TTL 分钟换算（01 §4.3 上限收敛的唯一实现）：请求 epoch 毫秒 → provider TTL 分钟，
 * 取生效上限较小值、向上取整（绝不欠配期限）。driver 的 create/extend/resume 共用。
 */
export function createDaytonaTtlMinutesClamp(input: {
  now: () => number;
  /** 生效上限解析（秒）；undefined = 未核实不虚构上限。 */
  resolveMaxLifetimeSeconds: () => Promise<number | undefined>;
}): (requestedDeadlineMs: number) => Promise<number> {
  return async (requestedDeadlineMs) => {
    let usableMs = requestedDeadlineMs - input.now();
    const cap = await input.resolveMaxLifetimeSeconds();
    if (cap !== undefined) {
      usableMs = Math.min(usableMs, cap * 1000);
    }
    return Math.max(1, Math.ceil(usableMs / 60_000));
  };
}

/**
 * 对账清单条目读取（NestJS 形状 `{items:[…]}` 或裸数组；客户端按 labels 匹配）。
 * driver 的 findCreateResult 与对账工具共用，不在 driver 里重复形状分支。
 */
export function readDaytonaListEntries(body: unknown): unknown[] {
  const record = asRecord(body);
  if (Array.isArray(body)) return body;
  return Array.isArray(record?.["items"]) ? (record["items"] as unknown[]) : [];
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

/**
 * inspect 的实现（pause 回查与 driver 共用同一实现，避免对象字面量内 `this` 依赖）。
 * 证据串只含端点/状态/状态原文要点（≤160 字符），不含凭据、labels 或响应体。
 */
export async function inspectDaytonaSandbox(input: {
  rest: DaytonaRestClient;
  logger: CloudAdapterLogger;
  now: () => number;
  sandboxId: string;
}): Promise<ProviderObservation> {
  const { rest, logger, now, sandboxId } = input;
  const path = DAYTONA_PATH_SANDBOX(sandboxId);
  const evidenceOf = (outcome: string) => boundEvidence(`daytona GET ${path} -> ${outcome}`);
  let response;
  try {
    response = await rest.request(path, {
      method: "GET",
      attempts: DAYTONA_GET_RETRY_ATTEMPTS,
    });
  } catch (error) {
    // 网络超时/权限丢失一律 unknown，不是 notFound（01 §4.1）。
    const cause = isAbortLike(error) ? "aborted" : "network-error";
    logger.warn(undefined, "daytona inspect unavailable", {
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
  if (response.status === 404) {
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
  const state = asString(body?.["state"]) ?? "";
  const mapped = mapDaytonaSandboxState(state);
  if (mapped !== undefined) {
    return {
      status: mapped,
      observedAt: now(),
      evidenceSource: "provider-api",
      evidence: evidenceOf(`200 state=${state}`),
    };
  }
  logger.warn(undefined, "daytona inspect returned unmapped state", {
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

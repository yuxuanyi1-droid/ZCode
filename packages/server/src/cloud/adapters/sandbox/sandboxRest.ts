/**
 * 沙箱 provider 共享 REST 传输层（specs/cloud-agent/01 §4.1「所有 SDK 调用异步、
 * 有限重试并支持请求取消」、§9 错误归一）。
 *
 * 提供 provider 无关的部分：注入 fetch（默认 undici）、请求级超时与调用方取消、
 * GET 类有限重试、4xx「明确失败」与 5xx/网络「结果未知」的错误归一骨架。
 * 鉴权头与 404 语义由各 provider 的 rest 模块提供（差异不抹平）。
 */
import { fetch as undiciFetch } from "undici";
import { CloudAdapterError, type CloudAdapterLogger } from "./adapterError.js";

export interface SandboxFetchInit {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

export interface SandboxFetchResponse {
  readonly status: number;
  readonly ok: boolean;
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type SandboxFetch = (url: string, init: SandboxFetchInit) => Promise<SandboxFetchResponse>;

// ── 小型运行时解析工具（server 包不依赖 zod，不重复引入校验依赖）──

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function isAbortLike(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** 「请求是否可能在 provider 侧已生效」的判定：只有非 408 的 4xx 是明确未生效。 */
export function isDefiniteRejection(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}

export function sanitizeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "request failed";
  // 只保留有界摘要；凭据在 header 不在 URL，message 仍做长度截断。
  return message.slice(0, 200);
}

/** provider 拒绝原因的长度上限（不透传完整响应体；01 §9 审计边界）。 */
export const PROVIDER_REJECTION_MESSAGE_MAX_CHARS = 200;
/** 解析拒绝原因时最多读取的响应体字节数（防御超大 body）。 */
const MAX_PROVIDER_REJECTION_BODY_CHARS = 4_096;

/**
 * 从 4xx 响应里取 **provider 的原话**（可诊断性；01 §9）。
 * 边界：只取 JSON 的 `message` / `error.message` / `error` 字段——不透传完整响应体、
 * header 或 token；请求体本身也不含秘密（key 只在 header）。非 JSON、超长、缺失都返回
 * undefined，不猜、不回退整段 body（那可能是 HTML 或堆栈）。
 */
export async function readProviderRejectionMessage(
  response: SandboxFetchResponse,
): Promise<string | undefined> {
  const raw = await response.text().catch(() => "");
  if (raw === "") return undefined;
  let message: string | undefined;
  try {
    const record = asRecord(JSON.parse(raw.slice(0, MAX_PROVIDER_REJECTION_BODY_CHARS)));
    const error = record?.["error"];
    const nested = asRecord(error);
    message =
      asString(record?.["message"]) ??
      asString(nested?.["message"]) ??
      asString(nested?.["code"]) ??
      asString(error);
  } catch {
    return undefined;
  }
  if (message === undefined) return undefined;
  // 压成单行再截断：provider 文案里可能带换行/制表符。
  return message.replace(/\s+/g, " ").trim().slice(0, PROVIDER_REJECTION_MESSAGE_MAX_CHARS);
}

/** 副作用操作的归一三分支类别（01 §4.1）：查询类失败不等于资源不存在。 */
export type SandboxSideEffectOperation = "create" | "terminate" | "query";

export interface SandboxRestClient {
  /** 单次请求 + 请求级超时；查询类可传 attempts 做有限重试。 */
  request(
    path: string,
    init: { method: string; body?: unknown; signal?: AbortSignal; attempts?: number },
  ): Promise<SandboxFetchResponse>;
  /**
   * 4xx 等可判定「provider 未生效」的响应 → 归一错误（01 §9）。
   * `providerMessage` 是 `readProviderRejectionMessage` 取到的 provider 原话（有界、
   * 脱敏），带进 message 与 safeContext 供定位，例如 E2B 的
   * 「Timeout cannot be greater than 1 hours」。
   */
  definiteFailure(status: number, operation: string, providerMessage?: string): CloudAdapterError;
  /**
   * 4xx 明确拒绝的便捷入口：读 provider 原话 + 归一（driver 一行调用，避免每处重复）。
   * 需要把原话同时写日志时，先调 `readProviderRejectionMessage` 再调 `definiteFailure`。
   */
  rejectionError(response: SandboxFetchResponse, operation: string): Promise<CloudAdapterError>;
  /** 网络/超时/5xx → 结果未知：按操作映射到 *_unknown，绝不写成失败。 */
  unknownOutcomeError(
    operation: SandboxSideEffectOperation,
    status: number | "network",
    error?: unknown,
  ): CloudAdapterError;
}

export interface SandboxRestOptions {
  /** provider 展示名（错误 message 前缀，如 "e2b"/"daytona"）。 */
  providerName: string;
  /** 每次请求构建鉴权头；凭据只在此处读取，绝不进 URL/path/日志。 */
  buildHeaders: () => Promise<Record<string, string>> | Record<string, string>;
  baseUrl: string;
  requestTimeoutMs: number;
  fetch?: SandboxFetch;
  logger: CloudAdapterLogger;
  /**
   * 404 的归一码：E2B create 404 = 模板不存在（unsupported_template），
   * Daytona 404 = 资源不存在（not_found）。不抹平两家差异。
   */
  notFoundCode?: CloudAdapterError["code"];
}

export function createSandboxRestClient(options: SandboxRestOptions): SandboxRestClient {
  const fetchImpl: SandboxFetch =
    options.fetch ?? ((url, init) => undiciFetch(url, init) as Promise<SandboxFetchResponse>);

  async function request(
    path: string,
    init: { method: string; body?: unknown; signal?: AbortSignal; attempts?: number },
  ): Promise<SandboxFetchResponse> {
    const headers = { ...(await options.buildHeaders()) };
    let body: string | undefined;
    if (init.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = JSON.stringify(init.body);
    }
    const maxAttempts = init.attempts ?? 1;
    let lastError: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const timeoutSignal = AbortSignal.timeout(options.requestTimeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
      try {
        return await fetchImpl(`${options.baseUrl}${path}`, {
          method: init.method,
          headers,
          body,
          signal,
        });
      } catch (error) {
        lastError = error;
        // 网络/超时错误：查询类可有限重试；副作用请求的重试语义由调用方决定。
        if (attempt < maxAttempts && !init.signal?.aborted) {
          continue;
        }
      }
    }
    throw lastError ?? new Error("request failed");
  }

  function definiteFailure(
    status: number,
    operation: string,
    providerMessage?: string,
  ): CloudAdapterError {
    const map: Record<number, { code: CloudAdapterError["code"]; message: string }> = {
      400: { code: "validation_failed", message: "provider rejected request payload" },
      401: { code: "unauthenticated", message: "provider api key rejected" },
      402: { code: "quota_exceeded", message: "provider account quota or billing exhausted" },
      403: { code: "permission_revoked", message: "provider api key lacks permission" },
      404: { code: options.notFoundCode ?? "not_found", message: "provider resource not found" },
      422: { code: "validation_failed", message: "provider rejected request semantics" },
      429: { code: "rate_limited", message: "provider rate limit reached" },
    };
    const entry = map[status];
    const reason = entry?.message ?? `http ${status}`;
    return new CloudAdapterError(
      entry?.code ?? "validation_failed",
      // provider 原话（有界、已脱敏）跟在归一原因后面：没有它无法定位账号上限之类的差异。
      `${options.providerName} ${operation} failed: ${reason}${providerMessage ? ` [provider: ${providerMessage}]` : ""}`,
      { status, operation, ...(providerMessage ? { providerMessage } : {}) },
    );
  }

  function unknownOutcomeError(
    operation: SandboxSideEffectOperation,
    status: number | "network",
    error?: unknown,
  ): CloudAdapterError {
    const cause = status === "network" ? sanitizeErrorMessage(error) : `http ${status}`;
    const code =
      operation === "create"
        ? "provider_create_unknown"
        : operation === "terminate"
          ? "provider_termination_unknown"
          : "provider_unreachable";
    return new CloudAdapterError(
      code,
      `${options.providerName} ${operation} result unknown (${cause}); reconcile before retrying`,
      { operation, status: status === "network" ? "network" : status },
    );
  }

  async function rejectionError(
    response: SandboxFetchResponse,
    operation: string,
  ): Promise<CloudAdapterError> {
    return definiteFailure(
      response.status,
      operation,
      await readProviderRejectionMessage(response),
    );
  }

  return { request, definiteFailure, rejectionError, unknownOutcomeError };
}

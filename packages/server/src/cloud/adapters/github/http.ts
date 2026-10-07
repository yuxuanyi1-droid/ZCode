/**
 * GitHub REST 传输层（specs/cloud-agent/09 §8 外部 API 错误归一、§3 权限矩阵、
 * 01 §7.1/§7.2 秘密边界、03 §6 错误信封、02 §2 不变量 5）。
 *
 * 硬性边界：
 * - installation token / App JWT 只经 Authorization 头出站；不进 URL query、日志、
 *   错误 payload 或持久存储。本文件是所有 GitHub 出站请求的唯一收口。
 * - provider 原始错误文案不透传：只保留归一错误码、HTTP 状态与 request id（09 §8）。
 * - 传输层不做无限重试：只回传归一失败事实与 retryAfterMs，重试由 outbox 有界驱动
 *   （09 §5.2 第 6 条、§8「网络/5xx 重试有界」）。
 */
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode } from "@zcode/shared";
import type { CloudAdapterLogger } from "./logging.js";
import type { GitHubErrorFacts } from "../../app/ports/gitHubPort.js";

export type GitHubHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** 两类凭据是不同的东西：App JWT 是 App 身份，installation token 是安装身份（09 §3）。 */
export type GitHubCredential =
  | { kind: "app-jwt"; jwt: string }
  | { kind: "installation-token"; token: string };

/** query 里出现这些键即视为把凭据放进 URL，直接拒绝（01 §7.2）。 */
const FORBIDDEN_QUERY_KEY = /(token|secret|signature|password|private_key)/i;

export interface GitHubHttpRequest {
  method: GitHubHttpMethod;
  /** 以 `/` 开头的 API 路径，不含 origin 与 query。 */
  path: string;
  credential: GitHubCredential;
  /** 非凭据参数；键名命中 FORBIDDEN_QUERY_KEY 直接拒绝。 */
  query?: Readonly<Record<string, string | number>>;
  body?: unknown;
  traceId?: string;
}

export interface GitHubHttpFailure extends GitHubErrorFacts {
  code: CloudErrorCode;
  /** 已脱敏、有界的说明；不含 token、私有仓库内容或 provider 原文。 */
  message: string;
  retryAfterMs?: number;
}

export interface GitHubHttpResponse<T> {
  ok: boolean;
  status: number;
  body?: T;
  failure?: GitHubHttpFailure;
  /** 分页 `Link` 头（原样）；用于如实判断是否还有下一页而不是猜（09 §2.2 分页）。 */
  link?: string;
}

export interface GitHubTransport {
  send<T>(request: GitHubHttpRequest): Promise<GitHubHttpResponse<T>>;
}

export interface CreateGitHubTransportOptions {
  apiBaseUrl?: string;
  fetchImpl?: typeof globalThis.fetch;
  logger?: CloudAdapterLogger;
  /** 单请求上限；超时必须归一为 network_unknown 而不是挂住 outbox 租约。 */
  timeoutMs?: number;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ERROR_BODY_CHARS = 2_048;

/** token 是 opaque string：不按前缀解析，但已知前缀与 JWT 形状要在文本里抹掉（09 §3）。 */
const SECRET_LIKE_PATTERNS: readonly RegExp[] = [
  /\bgh[hsruop]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{16,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

/** 先按字面量抹掉调用方已知的凭据，再按形状兜底；不假定 token 长度或前缀（09 §3）。 */
export function scrubGitHubSecrets(text: string, knownSecrets: readonly string[] = []): string {
  let scrubbed = text;
  for (const secret of knownSecrets) {
    if (secret.length >= 8) scrubbed = scrubbed.split(secret).join("[redacted]");
  }
  for (const pattern of SECRET_LIKE_PATTERNS) scrubbed = scrubbed.replace(pattern, "[redacted]");
  return scrubbed;
}

function credentialSecret(credential: GitHubCredential): string {
  return credential.kind === "app-jwt" ? credential.jwt : credential.token;
}

function buildUrl(
  apiBaseUrl: string,
  request: GitHubHttpRequest,
): { url: string } | { failure: GitHubHttpFailure } {
  if (!request.path.startsWith("/") || request.path.includes("?")) {
    return {
      failure: {
        code: "validation_failed",
        retryable: false,
        message: "github request path must be origin-relative and query-free",
      },
    };
  }
  const url = new URL(request.path, apiBaseUrl);
  for (const [key, value] of Object.entries(request.query ?? {})) {
    if (FORBIDDEN_QUERY_KEY.test(key)) {
      return {
        failure: {
          code: "validation_failed",
          retryable: false,
          message: `credential-like query key rejected: ${key}`,
        },
      };
    }
    url.searchParams.set(key, String(value));
  }
  return { url: url.toString() };
}

function parseRetryAfterMs(headers: Headers, nowMs: number): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter) {
    const seconds = Number.parseInt(retryAfter, 10);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.max(0, date - nowMs);
  }
  const remaining = headers.get("x-ratelimit-remaining");
  const reset = headers.get("x-ratelimit-reset");
  if (remaining === "0" && reset) {
    const resetMs = Number.parseInt(reset, 10) * 1_000;
    if (Number.isFinite(resetMs)) return Math.max(0, resetMs - nowMs);
  }
  return undefined;
}

function isRateLimited(status: number, headers: Headers, retryAfterMs?: number): boolean {
  if (status === 429) return true;
  if (status !== 403) return false;
  return headers.get("x-ratelimit-remaining") === "0" || retryAfterMs !== undefined;
}

/**
 * 状态码 → 归一错误（09 §8）。404 不区分「真实不存在」与「无权限」，避免泄漏私有仓库
 * 存在性；调用方需要区分时必须先用自己的授权投影（09 §2.2）。
 */
export function normalizeGitHubFailure(request: {
  status: number;
  headers: Headers;
  bodyText: string;
  requestId?: string;
  knownSecrets?: readonly string[];
  nowMs: number;
}): GitHubHttpFailure {
  const retryAfterMs = parseRetryAfterMs(request.headers, request.nowMs);
  const code: CloudErrorCode =
    request.status === 429 || isRateLimited(request.status, request.headers, retryAfterMs)
      ? "rate_limited"
      : request.status === 401
        ? "permission_revoked"
        : request.status === 403
          ? "permission_revoked"
          : request.status === 404
            ? "repo_not_found"
            : request.status === 409
              ? "branch_conflict"
              : request.status === 422
                ? "validation_failed"
                : request.status >= 500
                  ? "network_unknown"
                  : "validation_failed";
  const trimmed = request.bodyText.slice(0, DEFAULT_MAX_ERROR_BODY_CHARS);
  return {
    code,
    retryable: CLOUD_ERROR_RETRYABLE[code],
    status: request.status,
    requestId: request.requestId,
    retryAfterMs,
    message: scrubGitHubSecrets(trimmed, request.knownSecrets).slice(0, 512),
  };
}

export function createGitHubTransport(options: CreateGitHubTransportOptions = {}): GitHubTransport {
  const apiBaseUrl = options.apiBaseUrl ?? DEFAULT_API_BASE_URL;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function send<T>(request: GitHubHttpRequest): Promise<GitHubHttpResponse<T>> {
    const built = buildUrl(apiBaseUrl, request);
    if ("failure" in built) return { ok: false, status: 0, failure: built.failure };
    const secret = credentialSecret(request.credential);
    const headers: Record<string, string> = {
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
      "user-agent": "zcode-cloud",
      authorization:
        request.credential.kind === "app-jwt"
          ? `Bearer ${request.credential.jwt}`
          : `Bearer ${request.credential.token}`,
    };
    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(built.url, {
        method: request.method,
        headers,
        body: request.body === undefined ? undefined : JSON.stringify(request.body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // 超时/连接失败都不是「否定结果」：保留可对账语义，由上层有界重试（03 §5）。
      const failure: GitHubHttpFailure = {
        code: "network_unknown",
        retryable: true,
        message: scrubGitHubSecrets(error instanceof Error ? error.message : "network error", [
          secret,
        ]).slice(0, 512),
      };
      options.logger?.warn(request.traceId, "github request failed", {
        method: request.method,
        path: request.path,
        code: failure.code,
        durationMs: Date.now() - startedAt,
      });
      return { ok: false, status: 0, failure };
    }

    const text = await response.text();
    const requestId = response.headers.get("x-github-request-id") ?? undefined;
    options.logger?.debug(request.traceId, "github response", {
      method: request.method,
      path: request.path,
      status: response.status,
      requestId,
      durationMs: Date.now() - startedAt,
      bodyChars: text.length,
    });
    if (!response.ok) {
      const failure = normalizeGitHubFailure({
        status: response.status,
        headers: response.headers,
        bodyText: text,
        requestId,
        knownSecrets: [secret],
        nowMs: Date.now(),
      });
      options.logger?.warn(request.traceId, "github request rejected", {
        method: request.method,
        path: request.path,
        status: response.status,
        requestId,
        code: failure.code,
      });
      return { ok: false, status: response.status, failure };
    }

    if (response.status === 204 || text.length === 0) {
      return { ok: true, status: response.status, link: response.headers.get("link") ?? undefined };
    }
    try {
      return {
        ok: true,
        status: response.status,
        body: JSON.parse(text) as T,
        link: response.headers.get("link") ?? undefined,
      };
    } catch {
      return {
        ok: false,
        status: response.status,
        failure: {
          code: "validation_failed",
          retryable: false,
          status: response.status,
          requestId,
          message: "github response was not valid JSON",
        },
      };
    }
  }

  return { send };
}

/** 调用方（读路径/写路径）统一的失败抛出类型；不携带原始响应体（09 §8）。 */
export class GitHubApiError extends Error {
  readonly code: CloudErrorCode;
  readonly retryable: boolean;
  readonly status?: number;
  readonly requestId?: string;
  readonly retryAfterMs?: number;

  constructor(failure: GitHubHttpFailure) {
    super(`github ${failure.code}: ${failure.message}`);
    this.name = "GitHubApiError";
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.status = failure.status;
    this.requestId = failure.requestId;
    this.retryAfterMs = failure.retryAfterMs;
  }

  /** 端口约定的归一事实（app/ports/gitHubPort.ts）。 */
  toFacts(): GitHubErrorFacts & { code: CloudErrorCode } {
    return {
      code: this.code,
      retryable: this.retryable,
      status: this.status,
      requestId: this.requestId,
    };
  }
}

/** 期望成功却拿到失败时抛出；调用方对 404/422 等有语义分支时不要用它。 */
export function expectOk<T>(response: GitHubHttpResponse<T>, context: string): T {
  if (!response.ok) {
    const failure = response.failure ?? {
      code: "network_unknown" as CloudErrorCode,
      retryable: true,
      message: `${context}: unknown failure`,
    };
    throw new GitHubApiError({ ...failure, message: `${context}: ${failure.message}` });
  }
  return response.body as T;
}

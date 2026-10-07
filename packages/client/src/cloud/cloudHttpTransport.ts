/**
 * Cloud HTTP 传输（specs/cloud-agent/03 §6/§6.2、04 §4「显式 origin」、00 §8 版本纪律）。
 *
 * 职责边界：
 * - 只做传输与校验：拼 URL、带鉴权、超时、把响应交给冻结 schema 校验、把失败归一成
 *   `CloudApiError`（03 §6 错误信封）。不含业务状态、不缓存 Task/Run 权威事实。
 * - origin 必须显式给出且是裸 http(s) origin；token 只放请求头，绝不进 URL query
 *   （04 §7：日志与 URL 不得出现凭据）。
 * - 写操作不自动重试：重试语义属于调用方（必须复用同一 commandId/creationKey，03 §6.2）。
 */
import { findCloudHttpEndpoint, type CloudHttpEndpointDescriptor } from "@zcode/shared";
import {
  CloudApiError,
  cloudConfigurationError,
  cloudProtocolError,
  cloudTransportError,
  cloudValidationError,
  readCloudErrorEnvelope,
} from "./cloudApiError.js";
import {
  CLOUD_SDK_ENDPOINT_SCHEMAS,
  parseCloudResponse,
  type CloudEndpointResponse,
  type CloudSdkEndpointId,
} from "./cloudWireSchemas.js";

// fetch 相关类型一律从全局 `fetch` 派生：server 项目（经 `@zcode/client` 入口解析本文件）
// 的 lib 只有 ES2022、没有 DOM，直接引用 `RequestInfo`/`BodyInit` 这类 DOM-only 名字会在
// 仓库根 `pnpm typecheck` 下编译失败（包内 lib 含 dom 时反而是干净的）。
type CloudFetchInit = NonNullable<Parameters<typeof fetch>[1]>;
type CloudFetchResponse = Awaited<ReturnType<typeof fetch>>;

export type CloudFetchLike = (
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
) => ReturnType<typeof fetch>;

/** fetch body 位置的取值类型（multipart/二进制等非 JSON 体）。 */
export type CloudRequestBody = NonNullable<CloudFetchInit["body"]>;

/** 鉴权模式：bearer 只放 Authorization 头；cookie 依赖同源主体认证（03 §3、§7.1）。 */
export type CloudHttpAuth =
  | { readonly mode: "bearer"; readonly token: string }
  | { readonly mode: "cookie" };

/** 单请求默认超时。events 有界长轮询需按 waitMs 上调（03 §6 events 行）。 */
export const CLOUD_HTTP_DEFAULT_TIMEOUT_MS = 30_000;

export interface CloudHttpTransportOptions {
  /** 云服务端 origin，例如 `https://cloud.example.com`（不含路径、query、凭据）。 */
  readonly origin: string;
  readonly auth?: CloudHttpAuth;
  readonly fetch?: CloudFetchLike;
  readonly timeoutMs?: number;
}

export interface CloudHttpRequest<K extends CloudSdkEndpointId> {
  readonly endpointId: K;
  /** 冻结模板里的 `:param` 取值；多余或缺失都拒绝，不构造模糊路径。 */
  readonly pathParams?: Readonly<Record<string, string | number>>;
  readonly query?: Readonly<Record<string, string | number | boolean | undefined>>;
  /** 已按冻结 request schema 校验过的 JSON 体；与 `body` 互斥。 */
  readonly json?: unknown;
  /** 非 JSON 体（附件上传 multipart）：SDK 不发明字段名，由调用方给出。 */
  readonly body?: CloudRequestBody;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number;
}

export interface CloudHttpResponse<K extends CloudSdkEndpointId> {
  readonly endpointId: K;
  readonly status: number;
  readonly data: CloudEndpointResponse<K>;
}

export interface CloudHttpTransport {
  readonly origin: string;
  readonly auth: CloudHttpAuth;
  request<K extends CloudSdkEndpointId>(spec: CloudHttpRequest<K>): Promise<CloudHttpResponse<K>>;
}

// ── URL 构造 ──

const PATH_PARAM_PATTERN = /:([A-Za-z][A-Za-z0-9]*)/gu;

/** 显式 origin：绝对 http(s)、无路径/query/hash/凭据，避免拼接歧义与开放重定向。 */
export function normalizeCloudOrigin(rawOrigin: string): string {
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw cloudConfigurationError(`cloud origin must be an absolute URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw cloudConfigurationError(`cloud origin must use http(s)`);
  }
  const bareOrigin = url.pathname === "/" && !url.search && !url.hash;
  if (!bareOrigin || url.username || url.password) {
    throw cloudConfigurationError(`cloud origin must not contain path, query, hash or credentials`);
  }
  return url.origin;
}

/** 用冻结模板展开路径参数；缺失/多余/未替换一律拒绝（不静默丢掉约束）。 */
export function buildCloudRequestPath(
  pathTemplate: string,
  pathParams?: Readonly<Record<string, string | number>>,
): string {
  const used = new Set<string>();
  const path = pathTemplate.replace(PATH_PARAM_PATTERN, (_match, name: string) => {
    const value = pathParams?.[name];
    if (value === undefined) {
      throw cloudConfigurationError(`cloud request is missing path parameter ${name}`);
    }
    used.add(name);
    return encodeURIComponent(String(value));
  });
  // encodeURIComponent 会把 ':' 转义，因此残留的 ':' 只可能来自未识别的模板片段。
  if (path.includes(":")) {
    throw cloudConfigurationError(`cloud path template has unresolved parameters`);
  }
  for (const key of Object.keys(pathParams ?? {})) {
    if (!used.has(key)) {
      throw cloudConfigurationError(`cloud request has unknown path parameter ${key}`);
    }
  }
  return path;
}

function appendCloudQuery(
  url: URL,
  query?: Readonly<Record<string, string | number | boolean | undefined>>,
): void {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined) continue;
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw cloudConfigurationError(`cloud query parameter ${key} must be a primitive`);
    }
    url.searchParams.append(key, String(value));
  }
}

/** 构造绝对 URL 并复核 origin：路径参数被注入绝对 URL 时 fail-closed。 */
export function buildCloudUrl(
  origin: string,
  pathTemplate: string,
  pathParams?: Readonly<Record<string, string | number>>,
  query?: Readonly<Record<string, string | number | boolean | undefined>>,
): string {
  const path = buildCloudRequestPath(pathTemplate, pathParams);
  const url = new URL(path, `${origin}/`);
  if (url.origin !== origin) {
    throw cloudConfigurationError(`cloud request escaped the configured origin`);
  }
  appendCloudQuery(url, query);
  return url.toString();
}

/** attachment 通道地址：同一 origin 上的 wss/ws 升级路径（03 §7.1 通道分面）。 */
export function buildCloudWebSocketUrl(
  origin: string,
  pathTemplate: string,
  pathParams?: Readonly<Record<string, string | number>>,
): string {
  const url = new URL(buildCloudUrl(origin, pathTemplate, pathParams));
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

// ── 传输实现 ──

function resolveEndpoint(endpointId: CloudSdkEndpointId): CloudHttpEndpointDescriptor {
  const endpoint = findCloudHttpEndpoint(endpointId);
  if (!endpoint) {
    throw cloudConfigurationError(`endpoint ${endpointId} is not in the frozen cloud matrix`);
  }
  return endpoint;
}

function normalizeAuth(auth: CloudHttpAuth | undefined): CloudHttpAuth {
  if (!auth) return { mode: "cookie" };
  if (auth.mode === "bearer" && auth.token.trim().length === 0) {
    throw cloudConfigurationError(`bearer auth requires a non-empty token`);
  }
  return auth;
}

function createTimeout(timeoutMs: number | undefined): number {
  const resolved = timeoutMs ?? CLOUD_HTTP_DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(resolved) || resolved <= 0) {
    throw cloudConfigurationError(`cloud request timeout must be a positive number`);
  }
  return resolved;
}

/** 失败响应必须是冻结信封；否则按 wire 违约处理，不按状态码猜语义（00 §8）。 */
function normalizeCloudHttpFailure(
  endpointId: string,
  status: number,
  payload: unknown,
): CloudApiError {
  const envelope = readCloudErrorEnvelope(payload);
  if (envelope) return CloudApiError.fromEnvelope(envelope, { httpStatus: status });
  return cloudProtocolError(
    `HTTP ${String(status)} response for ${endpointId} is not a cloud error envelope`,
    { endpointId, httpStatus: status },
  );
}

function describeThrown(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`.slice(0, 200);
  return "unknown failure";
}

async function readCloudJsonBody(
  response: CloudFetchResponse,
  endpointId: string,
): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch (error) {
    throw cloudTransportError(`reading response body for ${endpointId} failed`, {
      details: { endpointId, failure: describeThrown(error) },
    });
  }
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw cloudProtocolError(`response for ${endpointId} is not JSON`, {
      endpointId,
      httpStatus: response.status,
    });
  }
}

export function createCloudHttpTransport(options: CloudHttpTransportOptions): CloudHttpTransport {
  const origin = normalizeCloudOrigin(options.origin);
  const auth = normalizeAuth(options.auth);
  const fetchImpl = options.fetch ?? (globalThis.fetch as CloudFetchLike | undefined);
  if (typeof fetchImpl !== "function") {
    throw cloudConfigurationError(`cloud transport requires a fetch implementation`);
  }
  const defaultTimeoutMs = createTimeout(options.timeoutMs);

  return {
    origin,
    auth,
    async request<K extends CloudSdkEndpointId>(
      spec: CloudHttpRequest<K>,
    ): Promise<CloudHttpResponse<K>> {
      if (spec.json !== undefined && spec.body !== undefined) {
        throw cloudValidationError(`cloud request cannot carry both json and raw body`);
      }
      const endpoint = resolveEndpoint(spec.endpointId);
      if (spec.json !== undefined && CLOUD_SDK_ENDPOINT_SCHEMAS[spec.endpointId].request === null) {
        throw cloudValidationError(`endpoint ${endpoint.id} does not accept a request body`);
      }
      const url = buildCloudUrl(origin, endpoint.path, spec.pathParams, spec.query);
      const timeoutMs = spec.timeoutMs ?? defaultTimeoutMs;

      const headers: Record<string, string> = { accept: "application/json" };
      let body: CloudRequestBody | undefined;
      if (spec.json !== undefined) {
        headers["content-type"] = "application/json";
        body = JSON.stringify(spec.json);
      } else if (spec.body !== undefined) {
        body = spec.body;
      }
      // token 只出现在请求头；query/URL 由 buildCloudUrl 构造，不接受鉴权字段。
      if (auth.mode === "bearer") headers.authorization = `Bearer ${auth.token}`;

      const init: CloudFetchInit = { method: endpoint.method, headers };
      if (body !== undefined) init.body = body;
      if (auth.mode === "cookie") init.credentials = "include";

      if (spec.signal?.aborted) {
        throw cloudTransportError(
          `${endpoint.method} ${endpoint.id} was canceled before it started`,
          { canceled: true },
        );
      }

      const controller = new AbortController();
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onCallerAbort = () => controller.abort();
      spec.signal?.addEventListener("abort", onCallerAbort);
      init.signal = controller.signal;

      let response: CloudFetchResponse;
      try {
        response = await fetchImpl(url, init);
      } catch (error) {
        if (spec.signal?.aborted) {
          throw cloudTransportError(`${endpoint.method} ${endpoint.id} canceled by caller`, {
            canceled: true,
          });
        }
        if (timedOut) {
          throw cloudTransportError(
            `${endpoint.method} ${endpoint.id} timed out after ${String(timeoutMs)}ms`,
            { details: { endpointId: endpoint.id, timeoutMs } },
          );
        }
        throw cloudTransportError(`${endpoint.method} ${endpoint.id} failed before a response`, {
          details: { endpointId: endpoint.id, failure: describeThrown(error) },
        });
      } finally {
        clearTimeout(timer);
        spec.signal?.removeEventListener("abort", onCallerAbort);
      }

      const payload = await readCloudJsonBody(response, endpoint.id);
      if (!response.ok) {
        throw normalizeCloudHttpFailure(endpoint.id, response.status, payload);
      }
      return {
        endpointId: spec.endpointId,
        status: response.status,
        data: parseCloudResponse(spec.endpointId, payload),
      };
    },
  };
}

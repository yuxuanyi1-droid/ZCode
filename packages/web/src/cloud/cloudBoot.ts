/**
 * Web 入口启动探测与错误分类（specs/cloud-agent/04 §2.1、modules/W9 §3/§4；03 §7.1）。
 *
 * 原则（2026-10-07 修订）：**模式是服务端事实**，客户端不再有 `?mode=` / 构建期
 * `VITE_*` / origin 一致性校验。启动时向同源 `GET /api/cloud/capabilities` 探测一次，
 * 结果只有四种：`200 mode=cloud` → 云壳；`401/403` → 云壳 + 凭据门；`200 mode=local`
 * → 原本地 Web 路径；其余一切（404/5xx/网络失败/非契约响应体/协议不兼容）→ 错误屏。
 *
 * 反 fallback 要求保留且更强：**没有一种不确定会变成 local 计划**——服务端不回答就
 * 进不了任何模式（04 §2.1）。本文件因此只做「探测 + 计划 + 失败分类」，不触 DOM、
 * 不 import UI，可直接在 node 下测试。
 */
import {
  CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS,
  capabilitiesResponseSchema,
  cloudTaskIdSchema,
  type CloudErrorCode,
  type CapabilitiesResponse,
  type CloudErrorEnvelope,
} from "@zcode/shared";
import { isCloudApiError, readCloudErrorEnvelope } from "@zcode/client";

/** 模式探测端点：模式判定的**唯一**来源（03 §6 端点表 capabilities 行；不用 /api/server-info）。 */
export const CLOUD_CAPABILITIES_PATH = "/api/cloud/capabilities";
/** host 本体服务通道（03 §7.1 host 分面；同源、lite-token）。 */
export const CLOUD_HOST_CHANNEL_PATH = "/ws";

/** `?task=` 云任务主路由；`?remote=` 保持原本机 Web 语义（04 §5）；`?token=` 凭据通道。 */
export const WEB_ENTRY_TASK_PARAM = "task";
export const WEB_ENTRY_REMOTE_PARAM = "remote";
/** lite-token 既有约定：`?token=` 命中即下发 HttpOnly cookie（03 §7.1、12 §5）。 */
export const WEB_ENTRY_TOKEN_PARAM = "token";

export type WebEntryMode = "local" | "cloud";

export interface WebEntryBootInput {
  /** `window.location.search`。 */
  readonly search: string;
  /** `window.location.origin`（同源地址一律由它拼装，不再是构建期契约）。 */
  readonly runtimeOrigin: string;
  /** 探测得出的服务端模式（04 §2.1）。 */
  readonly serverMode: WebEntryMode;
  /**
   * 探测是否被凭据拒绝（401/403）：此时服务端已明确是云入口，只是要求凭据，
   * 入口直接进凭据门，不重跑一次必然失败的启动流程。
   */
  readonly credentialRequired?: boolean;
}

export interface LocalEntryPlan {
  readonly mode: "local";
  /** `?remote=<id>` 原语义不变：桌面远控 attachment（04 §5）。 */
  readonly remoteId?: string;
}

export interface CloudEntryPlan {
  readonly mode: "cloud";
  readonly origin: string;
  /** 探测被 401/403 拒绝：先过凭据门（`CloudTokenGate`）再启动（04 §2.1）。 */
  readonly credentialRequired: boolean;
  /**
   * 部署链接 `?token=` 携带的 lite-token：只用于一次握手（凭据门或服务端 cookie 下发），
   * 不由客户端保存，也不写 storage（03 §3、12 §5）。
   */
  readonly token?: string;
  /** `?task=<taskId>` 深链；不合法时直接失败，不当作「没有 task」继续。 */
  readonly taskId?: string;
}

export type WebEntryPlan = LocalEntryPlan | CloudEntryPlan;

/**
 * 启动失败原因全集（W9 §5：启动错误必须可操作、各自区分）。数组即唯一来源：
 * 类型由它推导，恢复动作表对它做穷尽检查。
 *
 * 已作废（2026-10-07 §2.1）：`mode-invalid`（不再有客户端模式声明）与
 * `origin-mismatch`（不再有构建期 origin 声明）。
 */
export const CLOUD_BOOT_FAILURE_REASONS = [
  /** 云入口没有桌面 attachment：`?remote=` 不被云入口服务，也不回落本机（04 §5）。 */
  "remote-unsupported",
  /** `?task=` 不是合法 cloud taskId（04 §5 主路由）。 */
  "invalid-task-id",
  /**
   * `?task=` 是合法 taskId 但控制面返回 not_found（2026-10-08 巡检修订）：任务不存在
   * 或已被删除。与 `invalid-task-id` 同样呈现错误屏，不静默回落欢迎页。
   */
  "task-not-found",
  /** 客户端没有任何凭据：给出 CloudTokenGate（03 §3）。 */
  "missing-token",
  /** 凭据存在但被拒绝：认证失效，需重新取访问链接。 */
  "invalid-token",
  /** 凭据有效但无权访问该部署（撤权/主体不匹配）。 */
  "not-authorized",
  /** 探测端点未按契约回答（404/503 等）：这个地址不是可用的入口。 */
  "not-configured",
  /** bundle 与 wire 协议版本不兼容（00 §8、capabilities.protocolVersion）。 */
  "incompatible-bundle",
  /** 后端不可达/结果未知：保留失败面，不回落本机（04 §2.1）。 */
  "backend-unreachable",
  /** host `/ws` 通道建立失败（账号域不可用）。 */
  "host-channel-unavailable",
  /** 会话路由（控制面 origin / taskId）构造失败：身份解析失败必须拒绝，不猜也不回落本机。 */
  "bootstrap-unavailable",
] as const;

export type CloudBootFailureReason = (typeof CLOUD_BOOT_FAILURE_REASONS)[number];

export type CloudBootRecovery = "retry" | "reload" | "provide-token" | "open-home";

export interface CloudBootFailure {
  readonly reason: CloudBootFailureReason;
  /** shared 冻结错误码（03 §6）；UI 只按 code/reason 分支，不解析文案。 */
  readonly code?: CloudErrorCode;
  readonly traceId?: string;
  /** 诊断事实。禁止写入 token、prompt 正文、仓库内容（AGENTS 日志规范）。 */
  readonly detail?: Readonly<Record<string, string | number>>;
  /** 可操作恢复动作；由 `CloudBootstrapErrorScreen` 渲染成按钮。 */
  readonly recoveries: readonly CloudBootRecovery[];
}

export type WebEntryBootResult =
  | { readonly ok: true; readonly plan: WebEntryPlan }
  | { readonly ok: false; readonly failure: CloudBootFailure };

/** 每个失败原因都必须给出可操作动作（W9 §5「不用白屏或通用报错」）。 */
const FAILURE_RECOVERIES: Readonly<Record<CloudBootFailureReason, readonly CloudBootRecovery[]>> = {
  "remote-unsupported": ["open-home"],
  "invalid-task-id": ["open-home"],
  "task-not-found": ["open-home", "reload"],
  "missing-token": ["provide-token", "retry"],
  "invalid-token": ["provide-token", "retry"],
  "not-authorized": ["provide-token", "retry"],
  "not-configured": ["retry"],
  "incompatible-bundle": ["reload"],
  "backend-unreachable": ["retry"],
  "host-channel-unavailable": ["retry"],
  "bootstrap-unavailable": ["retry"],
};

export function createCloudBootFailure(
  reason: CloudBootFailureReason,
  options?: {
    readonly code?: CloudErrorCode | undefined;
    readonly traceId?: string | undefined;
    readonly detail?: Readonly<Record<string, string | number>> | undefined;
  },
): CloudBootFailure {
  return {
    reason,
    recoveries: FAILURE_RECOVERIES[reason],
    ...(options?.code === undefined ? {} : { code: options.code }),
    ...(options?.traceId === undefined ? {} : { traceId: options.traceId }),
    ...(options?.detail === undefined ? {} : { detail: options.detail }),
  };
}

/** 空串按「未提供」处理：`?task=` / `?token=` 这类空值不构成配置。 */
function readParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value ? value : undefined;
}

/**
 * 用探测结果解析入口计划（纯函数，04 §2.1）。
 *
 * 模式来自服务端，URL 只能决定路由细节：cloud 下 `?remote=` 明确失败（不静默忽略，
 * 也不回落本机），`?task=` 必须合法；local 下 `?remote=` 原语义不变。
 */
export function resolveWebEntryBoot(input: WebEntryBootInput): WebEntryBootResult {
  const params = new URLSearchParams(input.search);
  const remoteId = readParam(params, WEB_ENTRY_REMOTE_PARAM);
  const taskIdParam = readParam(params, WEB_ENTRY_TASK_PARAM);
  const token = readParam(params, WEB_ENTRY_TOKEN_PARAM);

  if (input.serverMode === "local") {
    // 本地路径不认 `?task=`/`?token=`（云主路由与云凭据），也不做任何本机回落判断。
    return { ok: true, plan: { mode: "local", ...(remoteId ? { remoteId } : {}) } };
  }

  if (remoteId) {
    // 云入口只挂 host `/ws` 与 `/ws/cloud/*`，没有 `/ws/remote/:id`；静默忽略等于让用户
    // 以为自己在远控桌面，因此显式失败（04 §5、W9 §6 模式隔离）。
    return { ok: false, failure: createCloudBootFailure("remote-unsupported") };
  }

  if (taskIdParam !== undefined && !cloudTaskIdSchema.safeParse(taskIdParam).success) {
    // identity 解析失败必须拒绝，不能当作「没有 task」继续（00 §5、04 §5）。
    return { ok: false, failure: createCloudBootFailure("invalid-task-id") };
  }

  return {
    ok: true,
    plan: {
      mode: "cloud",
      origin: input.runtimeOrigin,
      credentialRequired: input.credentialRequired === true,
      ...(token ? { token } : {}),
      ...(taskIdParam ? { taskId: taskIdParam } : {}),
    },
  };
}

/** host `/ws` 地址：同源 + ws(s) 协议；不承载 token（凭据走 cookie，见握手函数）。 */
export function buildCloudHostChannelUrl(origin: string, path = CLOUD_HOST_CHANNEL_PATH): string {
  const url = new URL(path, origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

/** 错误码 → 失败原因（03 §6 错误目录；未知码走 `classifyCloudBootError` 的保守兜底）。 */
function reasonFromErrorCode(
  code: CloudErrorCode,
  context: { readonly tokenProvided: boolean },
): CloudBootFailureReason {
  switch (code) {
    case "unauthenticated":
      return context.tokenProvided ? "invalid-token" : "missing-token";
    case "unauthorized":
    case "installation_revoked":
    case "permission_revoked":
      return "not-authorized";
    case "protocol_incompatible":
      return "incompatible-bundle";
    case "not_configured":
    case "not_implemented":
    case "resource_unsupported":
      return "not-configured";
    case "network_unknown":
    case "provider_unreachable":
    case "bridge_disconnected":
      return "backend-unreachable";
    default:
      return "backend-unreachable";
  }
}

/**
 * HTTP 状态兜底：响应不是合法信封时按状态判（不解析文案，03 §6 尾段）。
 * 取值来自 shared 冻结的 `CLOUD_ERROR_HTTP_STATUS`：401 unauthenticated、403
 * unauthorized、409 protocol_incompatible、503 not_configured。
 */
function reasonFromHttpStatus(status: number): CloudBootFailureReason {
  if (status === 401) return "missing-token";
  if (status === 403) return "not-authorized";
  if (status === 404 || status === 503) return "not-configured";
  if (status === 409) return "incompatible-bundle";
  return "backend-unreachable";
}

export interface CloudBootFailureContext {
  /** 本次启动是否携带了凭据（URL `?token=`）：决定「缺少」与「失效」的分面。 */
  readonly tokenProvided: boolean;
}

/**
 * 把启动期异常归一成失败面。默认分支是「后端不可达」而不是回退本机：
 * 网络失败、未知错误都必须停在失败面（04 §2.1）。
 */
export function classifyCloudBootError(
  error: unknown,
  context: CloudBootFailureContext,
): CloudBootFailure {
  if (isCloudApiError(error)) {
    const code = error.code;
    const source = error.source;
    const reason =
      source === "transport"
        ? "backend-unreachable"
        : source === "protocol"
          ? "incompatible-bundle"
          : source === "configuration" || source === "validation"
            ? "not-configured"
            : reasonFromErrorCode(code, context);
    const httpStatus = error.httpStatus;
    return createCloudBootFailure(reason, {
      code,
      traceId: error.traceId,
      ...(httpStatus === undefined ? {} : { detail: { source, httpStatus } }),
    });
  }
  return createCloudBootFailure("backend-unreachable");
}

export function classifyCloudBootHttpStatus(
  status: number,
  envelope: CloudErrorEnvelope | undefined,
  context: CloudBootFailureContext,
): CloudBootFailure {
  const reason =
    envelope === undefined
      ? reasonFromHttpStatus(status)
      : reasonFromErrorCode(envelope.code, context);
  return createCloudBootFailure(reason, {
    ...(envelope === undefined ? {} : { code: envelope.code, traceId: envelope.traceId }),
    detail: { httpStatus: status },
  });
}

/**
 * 探测/启动拿到的能力响应是否可用（04 §2.1）。
 *
 * - 两个模式都是合法答案：模式判定服务端驱动，`local` 是服务端事实，不是「没配置云」；
 * - 传 `expectedMode` 时（云启动流程、TokenGate）要求模式相符，否则 `not-configured`；
 * - 协议版本不在支持集 → `incompatible-bundle`（00 §8 fail-closed，不按旧字段猜测解析）。
 */
export function classifyCapabilitiesMismatch(
  capabilities: CapabilitiesResponse,
  options?: { readonly expectedMode?: WebEntryMode },
): CloudBootFailure | undefined {
  const expected = options?.expectedMode;
  if (expected !== undefined && capabilities.mode !== expected) {
    return createCloudBootFailure("not-configured", {
      detail: { mode: capabilities.mode, expectedMode: expected },
    });
  }
  if (
    !(CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS as readonly number[]).includes(
      capabilities.protocolVersion,
    )
  ) {
    return createCloudBootFailure("incompatible-bundle", {
      detail: { protocolVersion: capabilities.protocolVersion },
    });
  }
  return undefined;
}

export interface WebEntryProbeInput {
  /** 探测 origin：永远是页面同源地址（`window.location.origin`）。 */
  readonly origin: string;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** 探测结果：两个模式、需要凭据、或明确的失败面（没有第五种，也没有 local 回落）。 */
export type WebEntryProbeResult =
  | {
      readonly kind: "mode";
      readonly mode: WebEntryMode;
      readonly capabilities: CapabilitiesResponse;
    }
  | { readonly kind: "credential-required" }
  | { readonly kind: "failure"; readonly failure: CloudBootFailure };

/**
 * 启动模式探测：同源、**不带凭据**（04 §2.1——带 token 探测会让「需要凭据」这类部署
 * 直接变成 200，客户端就再也分不出「云入口要 token」与「本地部署」）。
 *
 * `401/403` 是**明确回答**而非错误：服务端在，且要求凭据 → 云壳 + 凭据门。
 */
export async function probeWebEntryMode(input: WebEntryProbeInput): Promise<WebEntryProbeResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  let response: Response;
  try {
    response = await fetchImpl(new URL(CLOUD_CAPABILITIES_PATH, input.origin), {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    // 不把异常文案带出来：连接类失败只报「不可达」，也不回落本机。
    return { kind: "failure", failure: createCloudBootFailure("backend-unreachable") };
  }

  if (response.status === 401 || response.status === 403) {
    return { kind: "credential-required" };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    return {
      kind: "failure",
      failure: classifyCloudBootHttpStatus(response.status, readCloudErrorEnvelope(payload), {
        tokenProvided: false,
      }),
    };
  }

  const parsed = capabilitiesResponseSchema.safeParse(payload);
  if (!parsed.success) {
    // 200 但不是契约响应体（HTML、别的服务、旧版本）：这个地址不是可用入口，
    // 不猜也不回落本机（04 §2.1）。
    return { kind: "failure", failure: createCloudBootFailure("incompatible-bundle") };
  }
  const mismatch = classifyCapabilitiesMismatch(parsed.data);
  if (mismatch) {
    return { kind: "failure", failure: mismatch };
  }
  return { kind: "mode", mode: parsed.data.mode, capabilities: parsed.data };
}

/**
 * 入口启动：探测一次 → 解析计划（04 §2.1）。
 *
 * `main.tsx` 只调用这一个入口函数；失败面（含 404/不可达/非法响应体）由调用方渲染错误屏。
 */
export async function bootWebEntry(input: {
  readonly search: string;
  readonly runtimeOrigin: string;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<WebEntryBootResult> {
  const probe = await probeWebEntryMode({
    origin: input.runtimeOrigin,
    ...(input.fetchImpl === undefined ? {} : { fetchImpl: input.fetchImpl }),
  });
  if (probe.kind === "failure") {
    return { ok: false, failure: probe.failure };
  }
  if (probe.kind === "credential-required") {
    return resolveWebEntryBoot({
      search: input.search,
      runtimeOrigin: input.runtimeOrigin,
      serverMode: "cloud",
      credentialRequired: true,
    });
  }
  return resolveWebEntryBoot({
    search: input.search,
    runtimeOrigin: input.runtimeOrigin,
    serverMode: probe.mode,
  });
}

export type CloudTokenHandshakeResult =
  | { readonly ok: true; readonly capabilities: CapabilitiesResponse }
  | { readonly ok: false; readonly failure: CloudBootFailure };

/**
 * CloudTokenGate 的握手：用用户提供的 lite-token 请求一次同源能力端点。
 * 命中 `?token=` 时服务端按既有约定下发 HttpOnly `zcode_lite_token` cookie
 * （03 §3、12 §5），此后 `/api/cloud/*` 与 `/ws` 都用 cookie，令牌正文不再出现在任何
 * 客户端可达位置，也不写 storage。
 */
export async function completeCloudTokenHandshake(input: {
  readonly origin: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch | undefined;
}): Promise<CloudTokenHandshakeResult> {
  const fetchImpl = input.fetchImpl ?? globalThis.fetch;
  const url = new URL(CLOUD_CAPABILITIES_PATH, input.origin);
  url.searchParams.set(WEB_ENTRY_TOKEN_PARAM, input.token);
  let response: Response;
  try {
    response = await fetchImpl(url, {
      credentials: "same-origin",
      cache: "no-store",
      headers: { accept: "application/json" },
    });
  } catch {
    // 不把异常文案带出来：连接类失败只报「不可达」，也不回落本机。
    return { ok: false, failure: createCloudBootFailure("backend-unreachable") };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    return {
      ok: false,
      failure: classifyCloudBootHttpStatus(response.status, readCloudErrorEnvelope(payload), {
        tokenProvided: true,
      }),
    };
  }

  const parsed = capabilitiesResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, failure: createCloudBootFailure("incompatible-bundle") };
  }
  // 凭据门的对象只能是云入口：本地模式不该走到这里（探测早已把它分流到本地路径）。
  const mismatch = classifyCapabilitiesMismatch(parsed.data, { expectedMode: "cloud" });
  return mismatch ? { ok: false, failure: mismatch } : { ok: true, capabilities: parsed.data };
}

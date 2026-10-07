/**
 * Web 入口启动解析与错误分类（specs/cloud-agent/modules/W9 §3/§4；04 §2/§4/§6/§8；03 §7.1）。
 *
 * 只做三件事，且都是纯函数（不触 DOM、不 import UI，可直接在 node 下测试）：
 * 1) mode / origin / token / task 路由解析：由 URL 与构建期 env 显式决定（04 §2「模式由
 *    部署/客户端显式配置」）；缺 remote、网络失败、identity 解析失败都不回落本机；
 * 2) 同源通道地址：云模式的 host `/ws` 与 `/api/cloud/capabilities` 一律按同源拼装，
 *    不存在「开发机 / 本机 workspace bootstrap」这条路径（04 §6 落点表、03 §7.1）；
 * 3) 启动错误分类：未配置 / 认证失效 / origin 不符 / bundle 不兼容 / 后端不可达各自
 *    可操作（W9 §5「不用白屏或通用报错」），且分类结果一律是失败，不会变成 local 计划。
 */
import {
  CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS,
  capabilitiesResponseSchema,
  cloudTaskIdSchema,
  type CloudErrorCode,
  type CapabilitiesResponse,
  type CloudErrorEnvelope,
} from "@zcode/shared";
import { isCloudApiError, normalizeCloudOrigin, readCloudErrorEnvelope } from "@zcode/client";

/** 构建期注入的 mode 来源（部署契约，见 W9 报告：`VITE_*` 只决定 bundle 身份与期望 origin）。 */
export const CLOUD_WEB_MODE_ENV = "VITE_ZCODE_SERVER_MODE";
/** 构建期声明「本 bundle 为哪个 origin 构建」；与运行时 origin 不一致即 fail-closed。 */
export const CLOUD_WEB_ORIGIN_ENV = "VITE_ZCODE_CLOUD_ORIGIN";

/** 云模式能力/模式端点（03 §6 端点表 capabilities 行；不用 /api/server-info）。 */
export const CLOUD_CAPABILITIES_PATH = "/api/cloud/capabilities";
/** host 本体服务通道（03 §7.1 host 分面；同源、lite-token）。 */
export const CLOUD_HOST_CHANNEL_PATH = "/ws";

/** `?mode=` 运行时覆盖；`?task=` 云任务主路由；`?remote=` 保持原本机 Web 语义（04 §5）。 */
export const WEB_ENTRY_MODE_PARAM = "mode";
export const WEB_ENTRY_TASK_PARAM = "task";
export const WEB_ENTRY_REMOTE_PARAM = "remote";
/** lite-token 既有约定：`?token=` 命中即下发 HttpOnly cookie（03 §7.1、12 §5）。 */
export const WEB_ENTRY_TOKEN_PARAM = "token";

export type WebEntryMode = "local" | "cloud";

/**
 * 构建期 env 声明。`env.d.ts` 不在 W9 的可写 roots，因此把云入口需要的两个键在这里
 * 合并进全局 `ImportMetaEnv`（保持 `import.meta.env.VITE_*` 的静态读取形态，Vite 才能在
 * 构建期替换）。部署契约见 W9 报告：`VITE_ZCODE_SERVER_MODE` 决定 bundle 模式，
 * `VITE_ZCODE_CLOUD_ORIGIN`（可选）声明构建期 origin，运行时 origin 必须与它一致。
 */
declare global {
  interface ImportMetaEnv {
    readonly VITE_ZCODE_SERVER_MODE?: string;
    readonly VITE_ZCODE_CLOUD_ORIGIN?: string;
  }
}

export interface WebEntryBootInput {
  /** `window.location.search`。 */
  readonly search: string;
  /** `window.location.origin`（云模式必须与它同源，03 §7.1）。 */
  readonly runtimeOrigin: string;
  /** `import.meta.env.VITE_ZCODE_SERVER_MODE`（构建期）。 */
  readonly buildMode?: string | undefined;
  /** `import.meta.env.VITE_ZCODE_CLOUD_ORIGIN`（构建期，可选）。 */
  readonly buildCloudOrigin?: string | undefined;
}

export interface LocalEntryPlan {
  readonly mode: "local";
  /** `?remote=<id>` 原语义不变：桌面远控 attachment（04 §5）。 */
  readonly remoteId?: string;
}

export interface CloudEntryPlan {
  readonly mode: "cloud";
  readonly origin: string;
  /**
   * 部署链接 `?token=` 携带的 lite-token：只用于一次握手（HTML 请求或 CloudTokenGate），
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
 */
export const CLOUD_BOOT_FAILURE_REASONS = [
  /** `?mode=` 取值非法：显式配置错误，不静默当 local。 */
  "mode-invalid",
  /** 构建期 origin ≠ 运行时 origin（W9 §8 的预览环境问题）。 */
  "origin-mismatch",
  /** 云入口没有桌面 attachment：`?remote=` 不被云入口服务，也不回落本机（04 §5）。 */
  "remote-unsupported",
  /** `?task=` 不是合法 cloud taskId（04 §5 主路由）。 */
  "invalid-task-id",
  /** 客户端没有任何凭据：给出 CloudTokenGate（03 §3）。 */
  "missing-token",
  /** 凭据存在但被拒绝：认证失效，需重新取访问链接。 */
  "invalid-token",
  /** 凭据有效但无权访问该部署（撤权/主体不匹配）。 */
  "not-authorized",
  /** 服务端/部署未配置 cloud（含 origin 不是云入口、能力端点未就绪）。 */
  "not-configured",
  /** bundle 与 wire 协议版本不兼容（00 §8、capabilities.protocolVersion）。 */
  "incompatible-bundle",
  /** 后端不可达/结果未知：保留失败面，不回落本机（04 §2）。 */
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
  "mode-invalid": ["open-home", "retry"],
  "origin-mismatch": ["retry"],
  "remote-unsupported": ["open-home"],
  "invalid-task-id": ["open-home"],
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

/** 空串按「未提供」处理：`?mode=` / `?token=` 这类空值不构成配置。 */
function readParam(params: URLSearchParams, name: string): string | undefined {
  const value = params.get(name)?.trim();
  return value ? value : undefined;
}

function readDeclaredValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : undefined;
}

/**
 * 解析入口计划。mode 只来自显式来源（`?mode=` 优先于构建期 env，缺省 local）；
 * 其它一切不确定都变成失败面，绝不返回 local 计划（04 §2）。
 */
export function resolveWebEntryBoot(input: WebEntryBootInput): WebEntryBootResult {
  const params = new URLSearchParams(input.search);
  const urlMode = params.get(WEB_ENTRY_MODE_PARAM);
  const buildMode = input.buildMode === undefined ? undefined : input.buildMode;

  // `?mode=` 出现但取值非法/为空时直接失败：拼错的模式不能静默降级成本机入口。
  if (urlMode !== null) {
    const declared = readDeclaredValue(urlMode);
    if (declared !== "local" && declared !== "cloud") {
      return {
        ok: false,
        failure: createCloudBootFailure("mode-invalid", {
          detail: {
            param: WEB_ENTRY_MODE_PARAM,
            value: readDeclaredValue(urlMode)?.slice(0, 16) ?? "",
          },
        }),
      };
    }
  }

  const declaredMode = readDeclaredValue(urlMode ?? buildMode);
  if (declaredMode !== undefined && declaredMode !== "local" && declaredMode !== "cloud") {
    return {
      ok: false,
      failure: createCloudBootFailure("mode-invalid", {
        detail: { source: CLOUD_WEB_MODE_ENV, value: declaredMode.slice(0, 16) },
      }),
    };
  }

  const remoteId = readParam(params, WEB_ENTRY_REMOTE_PARAM);
  if (declaredMode !== "cloud") {
    return { ok: true, plan: { mode: "local", ...(remoteId ? { remoteId } : {}) } };
  }

  // ── cloud ──
  if (remoteId) {
    // 云入口只挂 host `/ws` 与 `/ws/cloud/*`，没有 `/ws/remote/:id`；静默忽略等于让用户
    // 以为自己在远控桌面，因此显式失败（04 §5、W9 §6 模式隔离）。
    return { ok: false, failure: createCloudBootFailure("remote-unsupported") };
  }

  const declaredOrigin = readDeclaredValue(input.buildCloudOrigin);
  if (declaredOrigin !== undefined) {
    let normalized: string;
    try {
      normalized = normalizeCloudOrigin(declaredOrigin);
    } catch {
      return {
        ok: false,
        failure: createCloudBootFailure("not-configured", {
          detail: { env: CLOUD_WEB_ORIGIN_ENV },
        }),
      };
    }
    if (normalized !== input.runtimeOrigin) {
      // 只能在预览/换域名部署里暴露：构建期 origin 与运行时 origin 不一致时，cookie 与
      // WS 都到不了真正的服务端，必须显式报错而不是发跨域请求（03 §7.1 同源、W9 §8）。
      return {
        ok: false,
        failure: createCloudBootFailure("origin-mismatch", {
          detail: { buildOrigin: normalized, runtimeOrigin: input.runtimeOrigin },
        }),
      };
    }
  }

  const taskIdParam = readParam(params, WEB_ENTRY_TASK_PARAM);
  if (taskIdParam !== undefined) {
    if (!cloudTaskIdSchema.safeParse(taskIdParam).success) {
      // identity 解析失败必须拒绝，不能当作「没有 task」继续（00 §5、04 §5）。
      return { ok: false, failure: createCloudBootFailure("invalid-task-id") };
    }
  }

  const token = readParam(params, WEB_ENTRY_TOKEN_PARAM);
  return {
    ok: true,
    plan: {
      mode: "cloud",
      origin: input.runtimeOrigin,
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
 * 网络失败、未知错误都必须停在失败面（04 §2）。
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

/** `capabilities.mode` 不是 cloud：该 origin 不是云入口，既不是认证问题也不是网络问题。 */
export function classifyCapabilitiesMismatch(
  capabilities: CapabilitiesResponse,
): CloudBootFailure | undefined {
  if (capabilities.mode === "cloud") {
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
  return createCloudBootFailure("not-configured", { detail: { mode: capabilities.mode } });
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
  const mismatch = classifyCapabilitiesMismatch(parsed.data);
  return mismatch ? { ok: false, failure: mismatch } : { ok: true, capabilities: parsed.data };
}

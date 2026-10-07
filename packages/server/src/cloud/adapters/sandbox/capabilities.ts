/**
 * 沙箱 provider 能力声明与门控（specs/cloud-agent/01 §4.1/§4.2、W3 §3）。
 *
 * 两条规则，互相独立：
 * 1. **能力声明如实**：四家差异（期限来源、能否续期、能否确认终止、create 对账
 *    通道）按 provider 各自声明，不抹平、不用共同接口伪造能力（01 §4.2）。
 * 2. **可选性门控**：规范要求「真实账号实测后才解禁；验证完成前 capability 门控
 *    不显示可选」（01 §4.2、W3 §6）。未实测的 provider 默认不出现在可选列表里；
 *    部署若要带着「未验证」证据启用，必须显式列出（`allowUnverified`），并留下
 *    warn 级日志与证据引用。**不得**把未验证写成已验证。
 *
 * 能力错误的表达在调用侧：不支持的能力返回 `unsupported`（续期）或归一错误
 * （resource_unsupported / validation_failed），永不伪造成功（01 §4.1）。
 */
import type { SandboxDriverCapabilities } from "../../app/ports/sandboxDriverPort.js";

export const SANDBOX_PROVIDER_IDS = ["e2b", "modal", "daytona"] as const;
export type SandboxProviderId = (typeof SANDBOX_PROVIDER_IDS)[number];

export function isSandboxProviderId(value: string): value is SandboxProviderId {
  return (SANDBOX_PROVIDER_IDS as readonly string[]).includes(value);
}

// ── 能力声明（差异不抹平）──

/**
 * E2B（01 §4.2）：模板固定 runtime/资源，create/inspect/kill/setTimeout 映射。
 * `deadlineSource=provider`：setTimeout 是 provider 确认的运行中期限。
 *
 * **账号上限必须实测后由部署注入** `maxLifetimeSeconds`（收敛请求寿命 + 如实上报能力）；
 * 未核实时保持 undefined，**不虚构上限**。首个实测证据（2026-10-07，真实账号）：
 * 请求 `timeout=14400` 被 provider 400 拒绝，原文
 * 「Timeout cannot be greater than 1 hours」→ 该账号上限 **3600 秒**
 * （部署键 `ZCODE_CLOUD_SANDBOX_TEMPLATE_REF` 同族的 `provider:seconds` 形状传入）。
 */
export const E2B_SANDBOX_CAPABILITIES = {
  createOperationLookup: "metadata-search", // 无原生 idempotency key：按 metadata.operationKey 查清单
  canInspect: true,
  canExtendDeadline: true, // setTimeout 续期
  canConfirmTermination: true,
  deadlineSource: "provider",
  supportsOutboundWss: true,
} as const satisfies Omit<SandboxDriverCapabilities, "maxLifetimeSeconds">;

/**
 * Daytona（01 §4.2）：snapshot/image、resources、labels、get/stop/delete 与显式
 * 生命周期配置。stop/pause/archive 只停不删（不释放计费），terminate 映射 delete；
 * 墙钟 TTL（autoDestroyAt）是 provider 返回的期限。
 */
export const DAYTONA_SANDBOX_CAPABILITIES = {
  createOperationLookup: "metadata-search", // labels.operationKey 清单匹配
  canInspect: true,
  canExtendDeadline: true, // POST /ttl/{minutes}
  canConfirmTermination: true, // DELETE 受理 / 二次查询 404
  deadlineSource: "provider",
  supportsOutboundWss: true, // 默认网段不阻断出站；未单独做 WSS 压测
} as const satisfies Omit<SandboxDriverCapabilities, "maxLifetimeSeconds">;

/**
 * Modal SDK 通道（01 §6.2 第二批实施决议）：控制面经官方 Python SDK 子进程桥
 * create/exec/terminate/inspect/list。
 * - `canExtendDeadline=false`：create timeout 不能等价运行中续期（无官方通道）；
 * - `deadlineSource=estimated`：无 provider 返回的期限时间戳，只能记估计值；
 * - `createOperationLookup=metadata-search`：tags.operationKey + 服务端过滤，
 *   但官方 `Sandbox.list` 固定 include_finished=False（只反映存活资源）。
 */
export const MODAL_SDK_CHANNEL_CAPABILITIES = {
  createOperationLookup: "metadata-search",
  canInspect: true,
  canExtendDeadline: false,
  canConfirmTermination: true,
  deadlineSource: "estimated",
  supportsOutboundWss: true,
} as const satisfies Omit<SandboxDriverCapabilities, "maxLifetimeSeconds">;

/**
 * Modal 无通道（未注入 SDK 桥）时的门禁声明：全部按「无通道」如实声明，不是待验证
 * 假设——本地确定性拒绝（resource_unsupported），不发起 provider 请求、不占 quota。
 */
export const MODAL_GATED_CAPABILITIES = {
  createOperationLookup: "none",
  canInspect: false,
  canExtendDeadline: false,
  canConfirmTermination: false,
  deadlineSource: "estimated",
  supportsOutboundWss: true,
} as const satisfies Omit<SandboxDriverCapabilities, "maxLifetimeSeconds">;

/**
 * 声明 + 账号核实上限 → 端口要求的完整能力对象。
 * `maxLifetimeSeconds` 只在账号上限已核实时出现（未核实不得虚构默认上限）。
 */
export function describeCapabilities(
  declared: Omit<SandboxDriverCapabilities, "maxLifetimeSeconds">,
  maxLifetimeSeconds?: number,
): SandboxDriverCapabilities {
  return maxLifetimeSeconds === undefined ? { ...declared } : { ...declared, maxLifetimeSeconds };
}

// ── 可选性门控（实测解禁）──

export interface SandboxProviderEvidence {
  /** 最近一次真实账号联调的日期（YYYY-MM-DD）；未实测为 null。 */
  verifiedAt: string | null;
  /** 证据来源引用（spec 章节 / 联调记录）；不含账号、域名或凭据。 */
  source: string;
  /** 仍未实测、不得当已验证的能力点。 */
  unverified: readonly string[];
}

export interface SandboxProviderGate {
  /** 是否出现在可选的 provider 列表里（01 §4.2：验证完成前不显示可选）。 */
  selectable: boolean;
  evidence: SandboxProviderEvidence;
  /** 不可选或「带未验证证据启用」的原因（可操作说明）。 */
  reason?: string;
}

/**
 * 门控表（本波次状态）：三家 driver 已实现 adapter contract 级语义，但**尚未用
 * 真实账号在本波次复验**（能力/期限/停止/启动开销四项证据不齐）→ 默认不可选。
 * 未实测项如实列出，供后续联调逐项勾选；解禁流程见 README「provider 解禁」。
 */
export const SANDBOX_PROVIDER_GATES: Readonly<Record<SandboxProviderId, SandboxProviderEvidence>> =
  {
    e2b: {
      verifiedAt: null,
      source: "specs/cloud-agent/01 §4.2/§6.2（历史联调结论，待本波次复验）",
      unverified: ["账号生命周期上限", "setTimeout 续期确认", "create 对账命中", "出站 WSS 回连"],
    },
    modal: {
      verifiedAt: null,
      source: "specs/cloud-agent/01 §6.2 第二批实施决议（历史联调结论，待本波次复验）",
      unverified: [
        "镜像 Modal 端构建耗时",
        "inspect 退出码语义",
        "terminate 确认",
        "tags 对账命中",
      ],
    },
    daytona: {
      verifiedAt: null,
      source: "specs/cloud-agent/01 §4.2/§6.2（历史联调结论，待本波次复验）",
      unverified: ["toolboxProxyUrl 通道", "TTL 续期确认", "delete 确认", "labels 对账命中"],
    },
  };

export interface SandboxGateOptions {
  /**
   * 部署显式允许使用的「未实测」provider（非默认；W5 配置注入）。
   * 启用只影响可选性，不改变能力声明——未验证的能力仍按声明拒绝，不伪造成功。
   */
  allowUnverified?: readonly SandboxProviderId[];
}

/**
 * 解析某个 provider 的门控结论。默认（无 allowUnverified）未实测 provider 一律
 * 不可选；显式 allowUnverified 时可选但 reason 说明「未实测」。
 */
export function resolveProviderGate(
  provider: SandboxProviderId,
  options?: SandboxGateOptions,
): SandboxProviderGate {
  const evidence = SANDBOX_PROVIDER_GATES[provider];
  if (evidence.verifiedAt !== null) {
    return { selectable: true, evidence };
  }
  if (options?.allowUnverified?.includes(provider)) {
    return {
      selectable: true,
      evidence,
      reason: `${provider} is not verified with a real account yet; enabled by explicit deployment opt-in`,
    };
  }
  return {
    selectable: false,
    evidence,
    reason: `${provider} is gated until a real-account verification records capability/deadline/stop evidence`,
  };
}

/** 可选 provider 列表（能力列表端点与 UI 门控的输入；顺序稳定）。 */
export function listSelectableProviders(options?: SandboxGateOptions): SandboxProviderId[] {
  return SANDBOX_PROVIDER_IDS.filter(
    (provider) => resolveProviderGate(provider, options).selectable,
  );
}

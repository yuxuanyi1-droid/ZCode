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
import type {
  SandboxDriverCapabilities,
  SandboxDriverPort,
} from "../../app/ports/sandboxDriverPort.js";
import { CloudAdapterError } from "./adapterError.js";

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
  // 目标分级（01 §4.2 修订）：memory 级——SDK 2.52.1 原生 pause（POST /sandboxes/{id}/pause，
  // 204 即确认）、resume/connect 即恢复、create 可配 onTimeout=pause（TTL 到点自动暂停）。
  // **实测解禁前不外报**：driver describeCapabilities 经 resolvePauseResumeCapability 收敛。
  pauseResume: "memory",
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
  // 目标分级（01 §4.2 修订）：disk 级——stop/start 只停不删（文件系统保留），resume 为
  // 冷启动、进程态丢失（须如实向用户披露）。**实测解禁前不外报**（同 E2B 门禁）。
  pauseResume: "disk",
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
  pauseResume: "none", // Modal 终态走 reopen（01 §4.2 修订：分级能力目标值 none）
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
  pauseResume: "none",
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

/** 生效上限解析的 driver 选项切片（`maxLifetimeSeconds` 静态值 + create 时点覆盖）。 */
export interface SandboxLifetimeOptions {
  /** env 核实的静态上限（秒）；未核实保持 undefined（不虚构上限）。 */
  readonly maxLifetimeSeconds?: number;
  /**
   * create 时点的生效上限解析（01 §4.3 修订 2026-10-08）：账号设置覆盖
   * （min(设置值, env 核实上限)）；缺省回落静态 `maxLifetimeSeconds`。能力声明仍只
   * 上报静态 env 核实值（部署事实），账号覆盖只收敛请求。
   */
  readonly resolveMaxLifetimeSeconds?: () => number | undefined | Promise<number | undefined>;
}

/**
 * 生效上限：账号设置覆盖优先（create 时点解析），回落静态 env 核实值。
 * 三家 driver 的 create/extend clamp 共用同一收敛语义（01 §4.3）。
 */
export async function resolveEffectiveMaxLifetimeSeconds(
  options: SandboxLifetimeOptions,
): Promise<number | undefined> {
  const resolved = options.resolveMaxLifetimeSeconds
    ? await options.resolveMaxLifetimeSeconds()
    : undefined;
  return resolved ?? options.maxLifetimeSeconds;
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
      unverified: [
        "账号生命周期上限",
        "setTimeout 续期确认",
        "create 对账命中",
        "出站 WSS 回连",
        // pauseResume 项已于 2026-10-09 真实账号实测后从清单移除（解禁记录见
        // SANDBOX_PAUSE_RESUME_GATES.e2b，覆盖 pause/resume 语义、暂停保留与到期语义）。
      ],
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
      unverified: [
        "toolboxProxyUrl 通道",
        "TTL 续期确认",
        "delete 确认",
        "labels 对账命中",
        // 2026-10-09 生命周期 v2（A-7）：disk 级解禁条件——stop/start 只停不删、文件系统
        // 保留、进程态丢失须如实披露（01 §4.2 修订解除「首期不依赖磁盘恢复」冻结）。
        "pauseResume（disk 级：stop/start 冷恢复语义与启动开销）",
      ],
    },
  };

// ── pauseResume 实测解禁门禁（A-7，2026-10-09 生命周期 v2）──

export interface PauseResumeProviderGate {
  /**
   * 真实账号实测通过日期（YYYY-MM-DD）；null = 未实测。**这是唯一的开关**：
   * 翻开关（写入实测日期）之前，该 provider 的 pauseResume 能力一律按 "none" 行为。
   */
  verifiedAt: string | null;
  /** 实测目标分级（声明如实）；未实测时不外报。 */
  level: "memory" | "disk" | "none";
  /** 证据来源引用（spec 章节 / 联调记录）；不含账号、域名或凭据。 */
  source: string;
}

/**
 * pauseResume 分级能力的实测解禁门禁表（01 §4.2 修订、定稿附录 A-7）。
 *
 * fail-closed 规则：`verifiedAt === null` 时 `resolvePauseResumeCapability` 返回 "none"，
 * 三家一律按 none 行为——pause/resume 代码与契约在（driver 有真实调用实现），但路径
 * 不可达：`describeCapabilities()` 上报 none、`pause`/`resume` 本地抛能力错误，不发起
 * provider 请求、不虚构暂停状态、UI 不出现 paused 投影。真实账号实测（覆盖能力声明、
 * 期限语义、停止语义、暂停/恢复语义与启动开销）后**才**把 `verifiedAt` 翻成实测日期。
 */
export const SANDBOX_PAUSE_RESUME_GATES: Readonly<
  Record<SandboxProviderId, PauseResumeProviderGate>
> = {
  e2b: {
    verifiedAt: "2026-10-09",
    level: "memory",
    source:
      "live verification: 2026-10-09 真实账号实测（重建模板 zcode-sandbox-template）——POST pause 204 后暂停 30s，resume 与 connect 均内存态原地恢复（同一进程 PID、心跳计数续走不重启、恢复后墙钟跨暂停连续）；create autoPause 到期实测自动转 paused",
  },
  daytona: {
    verifiedAt: null,
    level: "disk",
    source:
      "specs/cloud-agent/01 §4.2 修订（stop/start 只停不删、文件系统保留、进程态丢失须披露；待真实账号实测）",
  },
  modal: {
    verifiedAt: null,
    level: "none",
    source: "specs/cloud-agent/01 §4.2 修订（Modal 分级能力目标值 none，终态走 reopen）",
  },
};

/**
 * 生效的 pauseResume 能力：未实测（verifiedAt === null）一律收敛为 "none"（fail-closed），
 * 已实测才放行声明分级。三家 driver 的 `describeCapabilities()` 统一经本函数收敛，
 * 能力表端点（shared `pauseResume` 字段）与控制面分支读到的是同一份收敛结果。
 */
export function resolvePauseResumeCapability(
  provider: SandboxProviderId,
): "memory" | "disk" | "none" {
  const gate = SANDBOX_PAUSE_RESUME_GATES[provider];
  return gate.verifiedAt === null ? "none" : gate.level;
}

/**
 * pause/resume 的统一门禁断言（A-7，driver 方法在 provider 通路前执行）：能力为 none
 * （未实测）时本地抛能力错误——不发起 provider 请求、不虚构暂停状态（01 §4.1 修订：
 * 路径不可达，fail-closed）。
 */
export function gatePauseResumeOrThrow(provider: SandboxProviderId): void {
  if (resolvePauseResumeCapability(provider) !== "none") return;
  throw new CloudAdapterError(
    "resource_unsupported",
    `capability-not-enabled: ${provider} pauseResume is gated until real-account verification`,
    { provider },
  );
}

/**
 * 不支持 pause/resume 的 provider（Modal，01 §4.2 修订目标值 none）共用的端口方法：
 * 两方法确定性抛能力错误（不是 unknown）——无 provider 请求、不伪造暂停状态。
 */
export function unsupportedPauseResume(
  provider: SandboxProviderId,
): Pick<SandboxDriverPort, "pause" | "resume"> {
  const reject = async (): Promise<never> => {
    throw new CloudAdapterError(
      "resource_unsupported",
      `capability-not-enabled: ${provider} does not support pause/resume (terminal runs go through reopen)`,
      { provider },
    );
  };
  return { pause: reject, resume: reject };
}

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

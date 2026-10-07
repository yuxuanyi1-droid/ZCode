/**
 * 沙箱 driver 装配与绑定表（specs/cloud-agent/01 §4.2/§4.3；W5 §3/§4 的消费面）。
 *
 * 归属划分：**秘密名到 driver 的映射在本模块**（谁实现 driver，谁知道它的秘密形状与
 * 能力门控）；入口（W5 `entry-cloud-drivers.ts`）只负责读配置 → 门控 → 契约版本校验 →
 * 装配。绑定表因此只声明三件事：provider、契约版本、必需秘密名；真正的 driver 在
 * `createDriver` 里惰性构造（启动校验通过之前不创建任何 driver，也不触达 provider API）。
 *
 * 三条不变量：
 * 1. **只接受显式配置**：缺配置（无秘密）就不产生该 provider 的绑定——不抛错、不造空
 *    driver、不静默换 provider；
 * 2. **能力门控沿用 `capabilities.ts`**：未实测解禁的 provider 默认不可选，部署显式
 *    `allowUnverified` 才放行（并留 warn），且**能力声明不因门控而改变**；
 * 3. **秘密只经参数流动**：值不进日志、不进错误 details、不进 provider labels/metadata。
 */
import type { SandboxDriverPort } from "../../app/ports/sandboxDriverPort.js";
import type { CloudAdapterLogger } from "./adapterError.js";
import { type SandboxProviderId } from "./capabilities.js";
import { createDaytonaSandboxDriver } from "./daytonaDriver.js";
import { createE2bSandboxDriver } from "./e2bDriver.js";
import { createModalSandboxDriver } from "./modalDriver.js";
import { createModalSdkBridge } from "./modalSdkBridge.js";

/**
 * 适配器实现的 driver 契约版本（能力声明字段、期限单位、对账结论的语义版本）。
 * 入口持有同值的期望版本，不匹配即 fail-closed（`protocol_incompatible`），不做兼容猜测。
 * driver 语义变更时必须同时递增两处（00 §8 版本纪律）。
 */
export const SANDBOX_ADAPTER_CONTRACT_VERSION = 1;

/** 每家的必需部署秘密名（只校验存在性；值不进日志或错误 details）。 */
export const SANDBOX_DRIVER_SECRET_NAMES = {
  e2b: ["E2B_API_KEY"],
  modal: ["MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET"],
  daytona: ["DAYTONA_API_KEY"],
} as const satisfies Record<SandboxProviderId, readonly string[]>;

/** 入口传给 `createDriver` 的上下文（与 W5 `CloudSandboxDriverContext` 结构一致）。 */
export interface SandboxDriverBindingContext {
  readonly provider: SandboxProviderId;
  /** 读取该 provider 的部署秘密；值不进日志、不进错误 details。 */
  readonly readSecret: (name: string) => string | undefined;
  readonly logger: CloudAdapterLogger;
  /**
   * 部署按 provider **核实过的**生命周期上限（秒；部署键形如 `e2b:3600`）。
   * 有值 → driver 用它收敛请求寿命（`Math.min`），并在 `describeCapabilities()` 里如实
   * 上报 `maxLifetimeSeconds`；缺省 → **未经核实，不得声称有上限**，保持原样放行。
   * 优先于绑定配置里的同名值（部署键是运行期事实，配置只用于直接构造）。
   */
  readonly maxLifetimeSeconds?: number;
}

/** 单条 driver 绑定（与 W5 `CloudSandboxDriverBinding` 结构一致）。 */
export interface SandboxDriverBinding {
  readonly provider: SandboxProviderId;
  readonly contractVersion: number;
  readonly requiredSecretNames: readonly string[];
  readonly createDriver: (context: SandboxDriverBindingContext) => SandboxDriverPort;
}

export interface E2bDriverDeploymentConfig {
  /** 部署秘密（`E2B_API_KEY`）。 */
  apiKey?: string;
  /** 覆盖 REST base（自托管/测试用）。 */
  baseUrl?: string;
  /** 账号核实的生命周期上限（秒）；未核实保持 undefined。 */
  maxLifetimeSeconds?: number;
}

export interface DaytonaDriverDeploymentConfig {
  /** 部署秘密（`DAYTONA_API_KEY`）。 */
  apiKey?: string;
  /** 覆盖 REST base（自托管/测试用）。 */
  baseUrl?: string;
  /** 账号核实的墙钟 TTL 上限（秒）；未核实保持 undefined。 */
  maxLifetimeSeconds?: number;
}

/**
 * Modal 通道配置（非秘密）：镜像来源、App 名、解释器与桥脚本路径。
 * 镜像来源缺配置时 create 明确失败（validation_failed），不在装配期拒绝注册 provider
 * （能力列表照常展示，错误在创建时给出可操作解释）。
 */
export interface ModalDriverDeploymentConfig {
  /** 部署秘密（`MODAL_TOKEN_ID`）。 */
  tokenId?: string;
  /** 部署秘密（`MODAL_TOKEN_SECRET`）。 */
  tokenSecret?: string;
  /** 模板目录（内含 Dockerfile = 构建上下文根；01 §6.2）。 */
  templateDir?: string;
  /** 显式 Dockerfile 路径（优先于 templateDir）。 */
  imageDockerfile?: string;
  /** 构建上下文目录（缺省 Dockerfile 所在目录）。 */
  imageContextDir?: string;
  /** Modal App 名（沙箱归属；缺省 zcode-cloud-agent）。 */
  appName?: string;
  /** 装载 modal SDK 的解释器（venv 部署必须显式指定）。 */
  pythonPath?: string;
  /** 桥脚本路径（打包部署改变布局时必须显式指定）。 */
  scriptPath?: string;
  /** 账号核实的生命周期上限（秒）。 */
  maxLifetimeSeconds?: number;
}

/** 部署显式配置（值已解析；秘密只在本结构里传递）。 */
export interface SandboxDriverDeploymentConfigs {
  e2b?: E2bDriverDeploymentConfig;
  modal?: ModalDriverDeploymentConfig;
  daytona?: DaytonaDriverDeploymentConfig;
}

export interface CreateSandboxDriverBindingsOptions {
  /** 绑定表构造期日志；`createDriver` 优先用入口传入的 context.logger。 */
  logger?: CloudAdapterLogger;
}

/** 本部署实际配置齐全的 provider（顺序稳定；缺秘密的一律不出现）。 */
export function configuredSandboxProviders(
  configs: SandboxDriverDeploymentConfigs,
): SandboxProviderId[] {
  const configured: SandboxProviderId[] = [];
  if (configs.e2b?.apiKey?.trim()) configured.push("e2b");
  if (configs.modal?.tokenId?.trim() && configs.modal.tokenSecret?.trim()) configured.push("modal");
  if (configs.daytona?.apiKey?.trim()) configured.push("daytona");
  return configured;
}

/**
 * 构造 driver 绑定表：**配置齐全的 provider 各产出一条绑定，缺配置的直接不出现**
 * （不是抛错、不是造空 driver）。门控与契约版本校验由入口按绑定表执行
 * （`requiredSecretNames` + `contractVersion` + `capabilities.resolveProviderGate`）。
 */
export function createSandboxDriverBindings(
  configs: SandboxDriverDeploymentConfigs,
  options?: CreateSandboxDriverBindingsOptions,
): SandboxDriverBinding[] {
  return configuredSandboxProviders(configs).map((provider) => ({
    provider,
    contractVersion: SANDBOX_ADAPTER_CONTRACT_VERSION,
    requiredSecretNames: SANDBOX_DRIVER_SECRET_NAMES[provider],
    createDriver: (context: SandboxDriverBindingContext): SandboxDriverPort =>
      buildDriver(provider, configs, context, options?.logger),
  }));
}

// ── 内部：按 provider 装配 driver（唯一构造点） ──

function buildDriver(
  provider: SandboxProviderId,
  configs: SandboxDriverDeploymentConfigs,
  context: SandboxDriverBindingContext,
  fallbackLogger: CloudAdapterLogger | undefined,
): SandboxDriverPort {
  const logger = context.logger ?? fallbackLogger;
  if (provider === "e2b") {
    const config = configs.e2b!;
    // 部署核实的上限优先（context），配置值只作直接构造时的兜底。
    const maxLifetimeSeconds = context.maxLifetimeSeconds ?? config.maxLifetimeSeconds;
    return createE2bSandboxDriver({
      apiKey: () => config.apiKey!,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(maxLifetimeSeconds === undefined ? {} : { maxLifetimeSeconds }),
      ...(logger === undefined ? {} : { logger }),
    });
  }
  if (provider === "daytona") {
    const config = configs.daytona!;
    const maxLifetimeSeconds = context.maxLifetimeSeconds ?? config.maxLifetimeSeconds;
    return createDaytonaSandboxDriver({
      apiKey: () => config.apiKey!,
      ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
      ...(maxLifetimeSeconds === undefined ? {} : { maxLifetimeSeconds }),
      ...(logger === undefined ? {} : { logger }),
    });
  }
  const config = configs.modal!;
  const maxLifetimeSeconds = context.maxLifetimeSeconds ?? config.maxLifetimeSeconds;
  const bridge = createModalSdkBridge({
    tokenId: () => config.tokenId!,
    tokenSecret: () => config.tokenSecret!,
    ...(config.pythonPath === undefined ? {} : { pythonPath: config.pythonPath }),
    ...(config.scriptPath === undefined ? {} : { scriptPath: config.scriptPath }),
    ...(logger === undefined ? {} : { logger }),
  });
  return createModalSandboxDriver({
    bridge,
    ...(config.templateDir === undefined ? {} : { templateDir: config.templateDir }),
    ...(config.imageDockerfile === undefined ? {} : { imageDockerfile: config.imageDockerfile }),
    ...(config.imageContextDir === undefined ? {} : { imageContextDir: config.imageContextDir }),
    ...(config.appName === undefined ? {} : { appName: config.appName }),
    ...(maxLifetimeSeconds === undefined ? {} : { maxLifetimeSeconds }),
    ...(logger === undefined ? {} : { logger }),
  });
}

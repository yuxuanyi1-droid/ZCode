/**
 * 沙箱 driver 装配（specs/cloud-agent/01 §4.2/§4.3、W5 §3/§4）。
 *
 * 职责边界（与 W3 `adapters/sandbox/providers.ts` 的分工）：**秘密名到 driver 的映射
 * 归 W3 的绑定表**（谁实现 driver，谁知道它的秘密形状）；入口只做四件事——
 * 读配置 → 门控 → 契约版本校验 → 装配成 `SandboxDriverRegistryPort`。
 *
 * fail-closed（W5 §5）：
 * - 操作员显式声明的 provider 产不出绑定（缺秘密）→ 启动失败，错误点名 provider 与缺失
 *   的秘密名；不静默降级成「没有 provider 也能起」（那会让所有 run 创建必然失败）；
 * - 未实测解禁且未显式 `allowUnverified` → 拒绝启动（01 §4.2）；
 * - 绑定声明的契约版本与入口期望不一致 → `protocol_incompatible`，不做兼容猜测（00 §8）。
 *
 * 秘密来源：v1 只从 env 读取（`readSecret`）。W3 的绑定表**不依赖 env 名**，未来换成
 * 文件 / secret store 时只改本文件的 `resolveDriverDeploymentConfigs`，绑定表不动。
 * 任一步校验失败都发生在**创建任何 driver 之前**，因此不会产生 provider 调用。
 */
import type {
  SandboxDriverPort,
  SandboxTemplateResolverPort,
} from "../app/ports/sandboxDriverPort.js";
import type {
  SandboxDriverRegistryPort,
  SandboxProviderEntry,
} from "../app/ports/sandboxDriverRegistryPort.js";
import type { SandboxRuntimeSettingsPort } from "../app/ports/sandboxRuntimeSettingsPort.js";
import {
  isSandboxProviderId,
  resolveProviderGate,
  type SandboxProviderId,
} from "./sandbox/capabilities.js";
import type { CloudAdapterLogger } from "./sandbox/adapterError.js";
import {
  SANDBOX_DRIVER_SECRET_NAMES,
  createSandboxDriverBindings,
  type SandboxDriverBinding,
  type SandboxDriverBindingContext,
  type SandboxDriverDeploymentConfigs,
} from "./sandbox/providers.js";
import { CloudEntryStartupError } from "./entry-cloud-config.js";

/**
 * 入口持有的期望契约版本。与 W3 `SANDBOX_ADAPTER_CONTRACT_VERSION` 必须同值——
 * driver 语义变更时**两处同时递增**，旧入口配新 adapter 会在启动期暴露为
 * `protocol_incompatible`，而不是在运行期按旧语义解析（用例断言两处相等）。
 */
export const SANDBOX_DRIVER_CONTRACT_VERSION = 1;

export interface CreateCloudDriverRegistryOptions {
  /** 部署启用清单（已通过配置校验的非空列表）。 */
  readonly providers: readonly string[];
  readonly bindings: readonly SandboxDriverBinding[];
  readonly readSecret: (name: string) => string | undefined;
  readonly logger: CloudAdapterLogger;
  /** 部署显式勾选的未实测 provider（01 §4.2 门控输入）。 */
  readonly allowUnverified?: readonly string[];
  /**
   * 账号设置覆盖端口（01 §4.3/§5.1 修订 2026-10-08）：driver 的 key 与生效超时在
   * **create 时点**经它解析（credential ?? env；min(设置值, env 核实上限)），
   * 不在启动期固化。未接线（测试注入 bindings）时 driver 保持 env 静态值。
   */
  readonly runtimeSettings?: SandboxRuntimeSettingsPort;
}

/** 缺失的必需秘密名（只回名字，不回值）。 */
function missingSecretNames(
  provider: SandboxProviderId,
  readSecret: (name: string) => string | undefined,
): string[] {
  return SANDBOX_DRIVER_SECRET_NAMES[provider].filter((name) => !readSecret(name)?.trim());
}

/**
 * env → W3 部署配置。秘密名取自 W3 的 `SANDBOX_DRIVER_SECRET_NAMES`（单一事实源），
 * 只有「哪个字段对应哪个秘密」这层映射属于入口。
 *
 * `maxLifetimeSeconds` 来自「用真实账号核实过」的部署配置（01 §4.3）：有值才传给 driver
 * （driver 用它收敛 provider 请求期限），未核实则保持 undefined，不虚构账号能力。
 */
export function resolveDriverDeploymentConfigs(
  readSecret: (name: string) => string | undefined,
  maxLifetimeSeconds?: Readonly<Record<string, number>>,
): SandboxDriverDeploymentConfigs {
  const names = SANDBOX_DRIVER_SECRET_NAMES;
  const lifetime = (provider: SandboxProviderId): { maxLifetimeSeconds?: number } => {
    const seconds = maxLifetimeSeconds?.[provider];
    return seconds === undefined ? {} : { maxLifetimeSeconds: seconds };
  };
  return {
    e2b: { apiKey: readSecret(names.e2b[0]), ...lifetime("e2b") },
    modal: {
      tokenId: readSecret(names.modal[0]),
      tokenSecret: readSecret(names.modal[1]),
      ...lifetime("modal"),
    },
    daytona: { apiKey: readSecret(names.daytona[0]), ...lifetime("daytona") },
  };
}

/** 生产绑定表：W3 的工厂（缺配置的 provider 不产生绑定，由本文件按启用清单 fail-closed）。 */
export function resolveProductionDriverBindings(
  configs: SandboxDriverDeploymentConfigs,
  logger: CloudAdapterLogger,
): readonly SandboxDriverBinding[] {
  return createSandboxDriverBindings(configs, { logger });
}

function assertKnownProviders(providers: readonly string[]): SandboxProviderId[] {
  return providers.map((provider) => {
    if (!isSandboxProviderId(provider)) {
      throw new CloudEntryStartupError("validation_failed", `未知的沙箱 provider: ${provider}`, {
        provider,
      });
    }
    return provider;
  });
}

function indexBindings(
  bindings: readonly SandboxDriverBinding[],
): Map<SandboxProviderId, SandboxDriverBinding> {
  const index = new Map<SandboxProviderId, SandboxDriverBinding>();
  for (const binding of bindings) {
    if (index.has(binding.provider)) {
      throw new CloudEntryStartupError(
        "validation_failed",
        `driver 绑定重复注册: ${binding.provider}`,
        {
          provider: binding.provider,
        },
      );
    }
    index.set(binding.provider, binding);
  }
  return index;
}

/**
 * 校验并装配 registry。校验顺序固定：取值域 → 绑定存在（缺秘密在此点名）→ 契约版本 →
 * 秘密齐备 → 门控；全部通过之前不调用任何 `createDriver`（更不会触达 provider API）。
 */
export async function createCloudDriverRegistry(
  options: CreateCloudDriverRegistryOptions,
): Promise<SandboxDriverRegistryPort> {
  const providers = assertKnownProviders(options.providers);
  const bindings = indexBindings(options.bindings);
  const allowUnverified = assertKnownProviders(options.allowUnverified ?? []);
  const drivers = new Map<SandboxProviderId, SandboxDriverPort>();

  if (providers.length === 0) {
    // 没有 provider 就无法创建任何 run：这是部署配置缺失，不是「降级运行」。
    throw new CloudEntryStartupError("not_configured", "cloud 模式必须至少启用一个沙箱 provider");
  }

  for (const provider of providers) {
    const binding = bindings.get(provider);
    if (!binding) {
      const missingSecrets = missingSecretNames(provider, options.readSecret);
      throw new CloudEntryStartupError(
        "not_configured",
        missingSecrets.length > 0
          ? `provider ${provider} 缺少部署秘密: ${missingSecrets.join(", ")}`
          : `provider ${provider} 未产出 driver 绑定`,
        { provider, missingSecrets },
      );
    }
    if (binding.contractVersion !== SANDBOX_DRIVER_CONTRACT_VERSION) {
      throw new CloudEntryStartupError(
        "protocol_incompatible",
        `provider ${provider} 的 driver 契约版本不兼容`,
        { provider, expected: SANDBOX_DRIVER_CONTRACT_VERSION, actual: binding.contractVersion },
      );
    }
    const missing = binding.requiredSecretNames.filter((name) => !options.readSecret(name)?.trim());
    if (missing.length > 0) {
      throw new CloudEntryStartupError("not_configured", `provider ${provider} 缺少部署秘密`, {
        provider,
        missingSecrets: missing,
      });
    }
    const gate = resolveProviderGate(provider, { allowUnverified });
    if (!gate.selectable) {
      throw new CloudEntryStartupError(
        "validation_failed",
        `provider ${provider} 未解禁：${gate.reason ?? "未通过实测门控"}`,
        { provider, source: gate.evidence.source },
      );
    }
    if (gate.reason) {
      options.logger.warn(undefined, `[cloud-drivers] ${gate.reason}`);
    }
  }

  const createDriverFor = async (provider: SandboxProviderId): Promise<SandboxDriverPort> => {
    const cached = drivers.get(provider);
    if (cached) {
      return cached;
    }
    const binding = bindings.get(provider);
    if (!binding) {
      // registry 只能解析已通过启动校验的 provider；这里是编程错误而非部署错误。
      throw new CloudEntryStartupError("not_configured", `provider ${provider} 未装配`, {
        provider,
      });
    }
    const context: SandboxDriverBindingContext = {
      provider,
      readSecret: options.readSecret,
      logger: options.logger,
      ...(options.runtimeSettings ? { runtimeSettings: options.runtimeSettings } : {}),
    };
    const driver = binding.createDriver(context);
    drivers.set(provider, driver);
    return driver;
  };

  return {
    async resolve(provider: string): Promise<SandboxDriverPort | null> {
      if (!isSandboxProviderId(provider) || !providers.includes(provider)) {
        // 未启用/未知 provider 一律 null：不无声换成别的 provider（11 §5）。
        return null;
      }
      return createDriverFor(provider);
    },
    async listProviders(): Promise<SandboxProviderEntry[]> {
      const entries: SandboxProviderEntry[] = [];
      for (const provider of providers) {
        const driver = await createDriverFor(provider);
        entries.push({ provider, capabilities: await driver.describeCapabilities() });
      }
      return entries;
    },
  };
}

/**
 * 沙箱模板解析（`context.templates` 的**唯一提供方**；01 §5.1 第 2 条、§7.3）。
 *
 * 这是镜像引用的部署侧来源：Run recipe 冻结时把 `provider`（可带客户端指定的
 * `templateRef`）解析成固定的 `imageRef`/`templateRevision`。三条 fail-closed 语义：
 * - 部署未给该 provider 配模板 → `null`：不造默认镜像、**不回落其它 provider**；
 * - 客户端给了 templateRef 但不在部署固定值里 → `null`：任意字符串不得直接当镜像引用
 *   （否则客户端可以自选镜像，绕过部署侧控制）；多模板部署应改为按 W3 资产目录校验；
 * - 模板 id 非秘密，可进日志，但**不与凭据混打**（本函数只接触模板与 provider 名）。
 */
export function createConfiguredSandboxTemplateResolver(
  refs: Readonly<Record<string, string>> | undefined,
  logger: CloudAdapterLogger,
): SandboxTemplateResolverPort {
  const presets = refs ?? {};
  const providers = Object.keys(presets).sort();
  if (providers.length > 0) {
    logger.info(undefined, "[cloud-templates] 沙箱模板引用已配置", { providers });
  }

  return {
    async resolve({ provider, templateRef }) {
      const configured = presets[provider];
      if (!configured) {
        return null;
      }
      if (templateRef !== undefined && templateRef !== configured) {
        logger.warn(undefined, "[cloud-templates] 拒绝未在部署中固定的模板引用", {
          provider,
          templateRef,
        });
        return null;
      }
      return { imageRef: configured, templateRevision: configured };
    },
  };
}

/** 部署秘密只按名字读取；缺失返回 undefined，由装配校验统一拒绝。 */
export function createDriverSecretReader(
  env: Record<string, string | undefined>,
): (name: string) => string | undefined {
  return (name) => env[name]?.trim() || undefined;
}

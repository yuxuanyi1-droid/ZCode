/**
 * `SandboxRuntimeSettingsPort` 的 host 本体实现（specs/cloud-agent/12 §2 修订 2026-10-08）。
 *
 * 数据来源都是 host 自带能力（决议⑧，零新增账号装配）：
 * - 非秘密超时：`ISettingService.get()` 的 `AppSettings.cloudRuntime.sandboxTimeoutSeconds`；
 * - provider key：`ICredentialService.load("cloud-sandbox/<provider>")`（落盘已加密）。
 * 两侧与浏览器 `/ws` 看到的是**同一个 host 服务图**，因此设置页保存后本端口立即可读。
 *
 * 失败语义（01 §5.1 决议）：设置/凭据读取失败时回落 env 基线并留 warn——env 装配校验
 * 在启动期已完成，设置存储故障不能阻断 create，也不解除 fail-closed 装配语义。
 * key 任何路径不进日志（包括 warn 的上下文字段，只带 provider 名与失败原因类别）。
 */
import { ICredentialService, ISettingService, type ServiceCollection } from "@zcode/services";
import { cloudSandboxCredentialKey } from "@zcode/shared";
import type {
  EffectiveSandboxRuntimeConfig,
  SandboxRuntimeSettingsPort,
} from "../../app/ports/sandboxRuntimeSettingsPort.js";
import type { CloudAdapterLogger } from "./adapterError.js";

export interface HostSandboxRuntimeSettingsOptions {
  /** host 服务图的惰性取用：入口在 drivers 装配后才启动 host 本体（03 §8 顺序）。 */
  readonly getServices: () => ServiceCollection | undefined;
  /** env 核实上限（启动期解析的部署基线，01 §4.3）。 */
  readonly envMaxLifetimeSeconds?: Readonly<Record<string, number>>;
  /** env 部署 key 基线（provider → 秘密值）；值不进日志。 */
  readonly envApiKeys?: Readonly<Record<string, string | undefined>>;
  readonly logger: CloudAdapterLogger;
}

interface HostAccountStores {
  readonly settings: ISettingService;
  readonly credentials: ICredentialService;
}

function resolveHostAccountStores(
  services: ServiceCollection | undefined,
): HostAccountStores | undefined {
  if (!services) {
    return undefined;
  }
  // getOptional 与 host 通道裁剪（entry-cloud-host-ws）同款取用方式：缺失即未装配，
  // 不从别处补替代实现（fail-closed），本轮解析回落 env 基线。
  const settings = services.getOptional(ISettingService);
  const credentials = services.getOptional(ICredentialService);
  if (!settings || !credentials) {
    return undefined;
  }
  return { settings, credentials };
}

/** 读取账号设置里的按 provider 超时（秒）；读取失败返回 undefined（回落 env 基线）。 */
async function readAccountTimeoutSeconds(
  stores: HostAccountStores | undefined,
  provider: string,
  logger: CloudAdapterLogger,
): Promise<number | undefined> {
  if (!stores) {
    return undefined;
  }
  try {
    const settings = await stores.settings.get();
    const seconds = settings.cloudRuntime?.sandboxTimeoutSeconds?.[provider];
    return typeof seconds === "number" ? seconds : undefined;
  } catch (error) {
    logger.warn(undefined, "[cloud-sandbox-settings] timeout read failed; env baseline", {
      provider,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** 读取账号覆盖的 provider key；读取失败返回 undefined（回落 env 基线）。 */
async function readAccountApiKey(
  stores: HostAccountStores | undefined,
  provider: string,
  logger: CloudAdapterLogger,
): Promise<string | undefined> {
  if (!stores) {
    return undefined;
  }
  try {
    const value = await stores.credentials.load(cloudSandboxCredentialKey(provider));
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  } catch (error) {
    logger.warn(undefined, "[cloud-sandbox-settings] credential read failed; env baseline", {
      provider,
      reason: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

export function createHostSandboxRuntimeSettings(
  options: HostSandboxRuntimeSettingsOptions,
): SandboxRuntimeSettingsPort {
  return {
    async readEffectiveSandboxConfig(provider): Promise<EffectiveSandboxRuntimeConfig> {
      // 服务图按调用时点取用（create 时解析，不启动期固化）；每轮解析都重读，
      // 设置页保存后无需任何失效通知即对新 create 生效。
      const stores = resolveHostAccountStores(options.getServices());
      const envMaxLifetimeSeconds = options.envMaxLifetimeSeconds?.[provider];
      const [accountTimeout, accountApiKey] = await Promise.all([
        readAccountTimeoutSeconds(stores, provider, options.logger),
        readAccountApiKey(stores, provider, options.logger),
      ]);

      // 生效超时 = min(设置值（若有）, env 核实上限)；env 是硬上界（01 §4.3 修订）。
      const timeoutSeconds =
        accountTimeout !== undefined && envMaxLifetimeSeconds !== undefined
          ? Math.min(accountTimeout, envMaxLifetimeSeconds)
          : (accountTimeout ?? envMaxLifetimeSeconds);
      // 生效 key = credential 存储值 ?? env 部署值（01 §4.3 修订）。
      const envApiKey = options.envApiKeys?.[provider]?.trim() || undefined;
      const apiKey = accountApiKey ?? envApiKey;

      return {
        ...(envMaxLifetimeSeconds === undefined ? {} : { envMaxLifetimeSeconds }),
        ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
        timeoutSource: accountTimeout !== undefined ? "account-setting" : "deployment-env",
        ...(apiKey === undefined ? {} : { apiKey }),
        apiKeyConfigured: apiKey !== undefined,
      };
    },
  };
}

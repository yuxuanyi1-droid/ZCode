/**
 * 沙箱运行时账号设置端口（specs/cloud-agent/01 §4.3/§5.1 修订 2026-10-08、12 §2 修订）。
 *
 * 「账号设置覆盖部署基线」的唯一解析面：部署 env 是基线与硬上界，账号设置（设置页）
 * 可覆盖 provider key 与超时预算。收敛公式：
 * - 生效超时 `timeoutSeconds` = min(设置值（若有）, env 核实上限)；两侧都缺省时 undefined；
 * - 生效 key `apiKey` = credential 存储值 ?? env 部署值。
 *
 * 调用时点：**create 前解析**（01 §5.1 决议），不在启动期固化——设置保存后对新 create
 * 立即生效；进行中 Run 的 recipe 不变。实现负责在 host 设置/凭据读取失败时回落 env 基线
 * 并留 warn，不让设置存储故障阻断 create（env 装配校验在启动期完成，语义不被本端口解除）。
 *
 * 秘密边界：`apiKey` 只流向 driver 的 provider 请求，不进日志、错误 details 或任何响应体；
 * 对外投影只有 capabilities 的 `apiKeyConfigured` 布尔（12 §2 修订）。
 */
export interface EffectiveSandboxRuntimeConfig {
  /** env 核实上限（秒；未核实保持 undefined，不虚构账号能力，01 §4.2）。 */
  readonly envMaxLifetimeSeconds?: number;
  /** 生效超时预算（秒）；账号设置与 env 核实上限都缺省时 undefined。 */
  readonly timeoutSeconds?: number;
  /** 生效超时的来源：账号设置覆盖 / 部署 env 基线（UI 展示用，非秘密）。 */
  readonly timeoutSource: "account-setting" | "deployment-env";
  /** 生效 provider key（credential ?? env）；只在 driver 消费，不进投影与日志。 */
  readonly apiKey?: string;
  /** 生效 key 是否已配置（capabilities 投影的唯一秘密相关输出）。 */
  readonly apiKeyConfigured: boolean;
}

export interface SandboxRuntimeSettingsPort {
  /**
   * 解析某 provider 的生效运行时配置。未知 provider 返回 env 基线形状（不含 key 覆盖），
   * 不抛错：provider 取值域由装配层校验，这里不做第二次门控。
   */
  readEffectiveSandboxConfig(provider: string): Promise<EffectiveSandboxRuntimeConfig>;
}

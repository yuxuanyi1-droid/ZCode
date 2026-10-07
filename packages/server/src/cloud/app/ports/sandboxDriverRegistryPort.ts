/**
 * provider driver 解析端口（03 §6 capabilities 行、01 §4.2 provider 差异）。
 *
 * `SandboxDriverPort`（W0 冻结）是按 provider 实例化的能力面，方法签名里不带 provider；
 * run recipe 冻结了 provider 名（03 §6.1），执行时必须解析到「当时那个 provider」的
 * driver，且不得在 worker 中静默换 provider（01 §4.3、§9：不支持就返回能力错误）。
 */
import type { SandboxDriverCapabilities, SandboxDriverPort } from "./sandboxDriverPort.js";

export interface SandboxProviderEntry {
  provider: string;
  capabilities: SandboxDriverCapabilities;
}

export interface SandboxDriverRegistryPort {
  /** 未配置/未启用的 provider 返回 null：不无声换 provider（11 §5）。 */
  resolve(provider: string): Promise<SandboxDriverPort | null>;
  /** capabilities 端点用；只列出已配置且实际解禁项（01 §4.1）。 */
  listProviders(): Promise<SandboxProviderEntry[]>;
}

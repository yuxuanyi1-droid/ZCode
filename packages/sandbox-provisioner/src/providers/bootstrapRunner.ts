import { SANDBOX_SSH_PORT } from "@zcode/shared";
import { buildSandboxBootstrapScript } from "../sandboxBootstrap.js";
import type { ProvisionContext } from "./types.js";

/**
 * bootstrap 的整体预算。
 *
 * 冷启动包含 apt（可能几十兆）+ clone，给到 10 分钟；这与
 * DEFAULT_SANDBOX_PROVISION_TIMEOUT_MS（客户端侧的整请求预算）同量级，
 * 但**必须小于**它，否则客户端先超时、provisioner 还在跑，用户看到的是一个
 * 被丢弃但仍然在烧配额的沙箱。
 */
export const SANDBOX_BOOTSTRAP_TIMEOUT_MS = 8 * 60 * 1000;

export interface RunBootstrapOptions {
  ctx: ProvisionContext;
  /** 只有走 WS 传输的 provider 需要传（E2B）。 */
  webSocketRelayPort?: number;
  sshPort?: number;
  /**
   * 镜像已预装 sshd/git 时跳过 apt。
   *
   * 这与"镜像里有什么"强相关，所以由**驱动**决定（它才知道自己用了哪个镜像），
   * 不由请求或全局配置决定。
   */
  skipPackageInstall?: boolean;
}

/**
 * 拼脚本 + 执行 + 统一的失败文案。
 *
 * 三个驱动都要这一步，区别只在 relay 端口和镜像是否预装依赖。
 */
export async function runSandboxBootstrap(options: RunBootstrapOptions): Promise<void> {
  const script = buildSandboxBootstrapScript({
    publicKey: options.ctx.publicKey,
    checkout: options.ctx.checkout,
    workspacePath: options.ctx.workspacePath,
    sshPort: options.sshPort ?? SANDBOX_SSH_PORT,
    ...(options.webSocketRelayPort === undefined
      ? {}
      : { webSocketRelayPort: options.webSocketRelayPort }),
    ...(options.skipPackageInstall ? { skipPackageInstall: true } : {}),
  });

  await options.ctx.runShell(script, { timeoutMs: SANDBOX_BOOTSTRAP_TIMEOUT_MS });
}

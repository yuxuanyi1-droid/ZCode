import type { SandboxProvider, SandboxProvisionRequest, SandboxSSHTransport } from "@zcode/shared";
import type { ResolvedRepositoryCheckout } from "../gitRef.js";

export interface ProvisionerLogger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * provider 驱动能用的全部能力。
 *
 * 三个 provider 的差别只有两件事：**怎么开一个沙箱**、**attach 入口长什么样**。
 * 密钥、仓库、bootstrap 内容都是共享的，所以这里只给驱动跑 shell 和记日志的原语，
 * 外加它需要拼 bootstrap 脚本的那几项输入。
 */
export interface ProvisionContext {
  request: SandboxProvisionRequest;
  log: ProvisionerLogger;
  /** 已按 provider 上限收敛过的沙箱存活秒数。 */
  timeoutSeconds: number;
  /** 本沙箱的一次性公钥（authorized_keys 那一行）。 */
  publicKey: string;
  checkout: ResolvedRepositoryCheckout;
  /** checkout 目录；已保证严格位于 /workspace 之下。 */
  workspacePath: string;
  /**
   * 在沙箱内执行一段 shell。
   *
   * 非零退出必须抛错（带上 stderr 摘要）：bootstrap 是一串强依赖步骤，
   * 上一步失败下一步必然无意义，早失败才能让驱动清理掉半成品沙箱。
   */
  runShell(command: string, options?: { timeoutMs?: number }): Promise<ShellResult>;
}

export interface ProvisionedSandbox {
  /** provider 侧的沙箱标识，必须满足 shared 的 sandboxId 字符集（不含 ':' 和 '/'）。 */
  sandboxId: string;
  transport: SandboxSSHTransport;
  /** SSH 登录用户名；私钥由编排层统一注入，驱动不接触。 */
  username: string;
  /** 沙箱硬性到期时间（epoch ms）；provider 给不出来就省略。 */
  expiresAt?: number;
}

/**
 * 驱动拿到的那一半上下文。
 *
 * `runShell` 不在里面：怎么在沙箱里跑命令只有驱动知道（exec / executeCommand /
 * commands.run），所以由驱动自己造出来，再补进 `ProvisionContext` 交给共享 bootstrap。
 */
export type SandboxDriverContext = Omit<ProvisionContext, "runShell">;

export interface SandboxProviderDriver {
  readonly provider: SandboxProvider;
  /** 给 /healthz 用：这个部署当前是否具备该 provider 需要的凭据与 SDK。 */
  isConfigured(): boolean;
  create(ctx: SandboxDriverContext): Promise<ProvisionedSandbox>;
}

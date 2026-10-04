import type { Sandbox as DaytonaSandbox } from "@daytonaio/sdk";
import type { SandboxProvider } from "@zcode/shared";
import { SANDBOX_SSH_PORT } from "@zcode/shared";
import { upstreamFailure, unavailable } from "../errors.js";
import { runSandboxBootstrap } from "./bootstrapRunner.js";
import type {
  ProvisionedSandbox,
  SandboxDriverContext,
  SandboxProviderDriver,
  ShellResult,
} from "./types.js";

/** Daytona 的托管 SSH 网关；自建部署要覆盖。 */
export const DEFAULT_DAYTONA_SSH_HOST = "ssh.app.daytona.io";

/**
 * Daytona 创建沙箱本身是有超时的服务端等待，SDK 默认 60 秒；
 * 预装镜像的沙箱通常几秒就绪，给到 5 分钟以免冷启动被误杀。
 */
const DAYTONA_CREATE_TIMEOUT_SECONDS = 300;

export interface DaytonaDriverConfig {
  apiKey?: string;
  apiUrl?: string;
  target?: string;
  /** 自定义镜像；不给就用 Daytona 的默认快照。 */
  image?: string;
  sshHost: string;
  packagesPreinstalled: boolean;
}

/**
 * Daytona 驱动。
 *
 * attach 路径：沙箱内起 sshd → `sandbox.createSshAccess(n)` 换一个短期 token →
 * 拿 token 当**用户名**连 `ssh.app.daytona.io:22`。Daytona 的网关认这个 token，
 * 没有独立密码。token 会过期，所以它的有效期必须覆盖沙箱存活期。
 */
export class DaytonaSandboxDriver implements SandboxProviderDriver {
  readonly provider: SandboxProvider = "daytona";

  constructor(private readonly config: DaytonaDriverConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey?.trim() || process.env.DAYTONA_API_KEY);
  }

  async create(ctx: SandboxDriverContext): Promise<ProvisionedSandbox> {
    const { Daytona } = await import("@daytonaio/sdk").catch((error: unknown) => {
      throw unavailable(
        `daytona provider is not available: the "@daytonaio/sdk" SDK is not installed (${describe(error)})`,
        error,
      );
    });

    const daytona = new Daytona({
      ...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
      ...(this.config.apiUrl ? { apiUrl: this.config.apiUrl } : {}),
      ...(this.config.target ? { target: this.config.target } : {}),
    });

    const sandbox = await daytona
      .create(this.buildCreateParams(ctx), { timeout: DAYTONA_CREATE_TIMEOUT_SECONDS })
      .catch((error: unknown) => {
        throw upstreamFailure(this.provider, describe(error), error);
      });

    try {
      const access = await sandbox.createSshAccess(timeoutToMinutes(ctx.timeoutSeconds));

      await runSandboxBootstrap({
        ctx: { ...ctx, runShell: createDaytonaRunShell(sandbox) },
        skipPackageInstall: this.config.packagesPreinstalled,
      });

      return {
        sandboxId: sandbox.id,
        transport: { kind: "tcp", host: this.config.sshHost, port: SANDBOX_SSH_PORT },
        // Daytona 把 SSH token 放在用户名位，没有独立密码。
        username: access.token,
        expiresAt: Date.now() + ctx.timeoutSeconds * 1000,
      };
    } catch (error) {
      // bootstrap 失败意味着没人能 attach 进去，留着只会白烧配额。
      await daytona.delete(sandbox).catch(() => undefined);
      throw error;
    }
  }

  private buildCreateParams(ctx: SandboxDriverContext): Record<string, unknown> {
    return {
      ...(this.config.image ? { image: this.config.image } : {}),
      // 统一以 root 启动：共享 bootstrap 往 /root/.ssh 写授权公钥，
      // 换成普通用户就得在脚本里到处塞 sudo。
      user: "root",
      // 沙箱生命周期由 ttlMinutes 兜底，不能依赖"空闲多久就停"——ZCode 的 attach
      // 会话是长连接，但用户思考时并没有流量，自动停机会把正在用的沙箱停掉。
      autoStopInterval: 0,
      ttlMinutes: timeoutToMinutes(ctx.timeoutSeconds),
      labels: { managedBy: "zcode-provisioner" },
    };
  }
}

function timeoutToMinutes(seconds: number): number {
  // 至少 1 分钟：ttlMinutes=0 在 Daytona 语义里是"不限制"，与"尽量短"正好相反。
  return Math.max(1, Math.ceil(seconds / 60));
}

function createDaytonaRunShell(sandbox: DaytonaSandbox) {
  return async (command: string, options?: { timeoutMs?: number }): Promise<ShellResult> => {
    const response = await sandbox.process.executeCommand(
      command,
      undefined,
      undefined,
      // executeCommand 的超时单位是秒；0 表示不限制，所以至少要给 1。
      options?.timeoutMs === undefined
        ? undefined
        : Math.max(1, Math.ceil(options.timeoutMs / 1000)),
    );

    const stdout = response.artifacts?.stdout ?? response.result ?? "";
    if (response.exitCode !== 0) {
      throw upstreamFailure(
        "daytona",
        `sandbox bootstrap failed with exit code ${response.exitCode}: ${tail(stdout)}`,
      );
    }

    return { exitCode: response.exitCode, stdout, stderr: "" };
  };
}

const MAX_ERROR_OUTPUT_LENGTH = 2_000;

function tail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length > MAX_ERROR_OUTPUT_LENGTH
    ? `…${trimmed.slice(-MAX_ERROR_OUTPUT_LENGTH)}`
    : trimmed;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

import type { Sandbox as E2BSandbox } from "e2b";
import type { SandboxProvider } from "@zcode/shared";
import { upstreamFailure, unavailable } from "../errors.js";
import { runSandboxBootstrap } from "./bootstrapRunner.js";
import type {
  ProvisionedSandbox,
  SandboxDriverContext,
  SandboxProviderDriver,
  ShellResult,
} from "./types.js";

/**
 * 沙箱内 WS→TCP 桥的监听端口。
 *
 * E2B 的入站流量只能通过它的网关以 HTTPS/WSS 到达指定端口，没有裸 TCP。
 * 所以 attach 路径是：客户端 `wss://<网关>/` → 沙箱内的 websocat → 本地 22 端口 sshd。
 * 选 8081 只是避开常用的 3000/8000 等应用端口。
 */
export const DEFAULT_E2B_RELAY_PORT = 8081;

export interface E2BDriverConfig {
  apiKey?: string;
  /** 模板名；模板里要有 openssh-server 与 git（或允许 sudo apt 装）。 */
  template: string;
  domain?: string;
  relayPort: number;
  packagesPreinstalled: boolean;
}

/**
 * E2B 驱动。
 *
 * 与另外两家的关键差异：**没有裸 TCP**。因此 transport 是 `websocket`，
 * 由客户端把 WS 流适配成 duplex 再交给 ssh2（见 server 包的 websocket-duplex）。
 */
export class E2BSandboxDriver implements SandboxProviderDriver {
  readonly provider: SandboxProvider = "e2b";

  constructor(private readonly config: E2BDriverConfig) {}

  isConfigured(): boolean {
    return Boolean(this.config.apiKey?.trim() || process.env.E2B_API_KEY);
  }

  async create(ctx: SandboxDriverContext): Promise<ProvisionedSandbox> {
    const { Sandbox } = await import("e2b").catch((error: unknown) => {
      throw unavailable(
        `e2b provider is not available: the "e2b" SDK is not installed (${describe(error)})`,
        error,
      );
    });

    const timeoutMs = ctx.timeoutSeconds * 1000;
    const sandbox = await Sandbox.create(this.config.template, {
      timeoutMs,
      ...this.buildConnectionOptions(),
      metadata: { managedBy: "zcode-provisioner" },
    }).catch((error: unknown) => {
      throw upstreamFailure(this.provider, describe(error), error);
    });

    try {
      await runSandboxBootstrap({
        ctx: { ...ctx, runShell: createE2BRunShell(sandbox) },
        webSocketRelayPort: this.config.relayPort,
        skipPackageInstall: this.config.packagesPreinstalled,
      });

      return {
        sandboxId: sandbox.sandboxId,
        transport: { kind: "websocket", url: `wss://${sandbox.getHost(this.config.relayPort)}` },
        username: "root",
        // E2B 的 timeoutMs 就是硬上限，没有单独的 expiresAt 字段可查。
        expiresAt: Date.now() + timeoutMs,
      };
    } catch (error) {
      // bootstrap 失败意味着没人能 attach 进去，留着只会白烧配额。
      await sandbox.kill().catch(() => undefined);
      throw error;
    }
  }

  private buildConnectionOptions(): { apiKey?: string; domain?: string } {
    return {
      ...(this.config.apiKey ? { apiKey: this.config.apiKey } : {}),
      ...(this.config.domain ? { domain: this.config.domain } : {}),
    };
  }
}

/**
 * 以 root 跑 bootstrap。
 *
 * E2B 的沙箱默认以普通用户启动，而共享 bootstrap 要写 /root/.ssh 并起系统服务，
 * 所以整段脚本都用 `user: "root"` 执行（模板必须允许 root）。
 */
function createE2BRunShell(sandbox: E2BSandbox) {
  return async (command: string, options?: { timeoutMs?: number }): Promise<ShellResult> => {
    const result = await sandbox.commands
      .run(command, {
        user: "root",
        ...(options?.timeoutMs === undefined ? {} : { requestTimeoutMs: options.timeoutMs }),
      })
      .catch((error: unknown) => {
        // commands.run 非零退出时抛 CommandExitError，它本身带着 CommandResult 字段。
        const exitCode = readExitCode(error);
        if (exitCode === undefined) {
          throw upstreamFailure("e2b", describe(error), error);
        }

        throw upstreamFailure(
          "e2b",
          `sandbox bootstrap failed with exit code ${exitCode}: ${tail(readOutput(error))}`,
        );
      });

    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  };
}

function readExitCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("exitCode" in error)) {
    return undefined;
  }
  const exitCode = (error as { exitCode: unknown }).exitCode;
  return typeof exitCode === "number" ? exitCode : undefined;
}

function readOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return describe(error);
  }
  const { stderr, stdout } = error as { stderr?: unknown; stdout?: unknown };
  const text = typeof stderr === "string" && stderr.trim() ? stderr : stdout;
  return typeof text === "string" ? text : describe(error);
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

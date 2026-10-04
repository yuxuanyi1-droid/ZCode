import type { Image, Sandbox } from "modal";
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

export interface ModalDriverConfig {
  /** Modal App 名；沙箱挂在它下面，同一 App 内的沙箱共享配额与命名空间。 */
  appName: string;
  /** 基础镜像（registry tag）。 */
  baseImage: string;
  /**
   * 镜像里已装好 openssh-server 与 git 时置 true：bootstrap 跳过 apt。
   *
   * Modal 的镜像层是缓存的，默认（false）也只慢第一次构建。
   */
  packagesPreinstalled: boolean;
}

/**
 * Modal 驱动。
 *
 * attach 路径：沙箱内起 sshd → 创建时声明 `unencryptedPorts: [22]` → `tunnel.tcpSocket`
 * 给出公网可直连的 host:port。Modal 对未加密端口做的是**裸 TCP 转发**（不是 TLS 终止），
 * 所以客户端可以直接把它当普通 host:port 交给 ssh2。
 *
 * 不用 encryptedPorts 的原因：那条路径上 Modal 会终止 TLS，ssh2 见到的是已被代理过的
 * 连接，需要额外处理 SNI/证书；而 SSH 会话本身已经有端到端加密，再套一层没有收益。
 */
export class ModalSandboxDriver implements SandboxProviderDriver {
  readonly provider: SandboxProvider = "modal";

  constructor(private readonly config: ModalDriverConfig) {}

  isConfigured(): boolean {
    // 凭据由 SDK 自己从 MODAL_TOKEN_ID/MODAL_TOKEN_SECRET（或 ~/.modal.toml）解析；
    // 这里只判断"部署方给没给"，不重复实现 SDK 的解析逻辑。
    return Boolean(
      (process.env.MODAL_TOKEN_ID && process.env.MODAL_TOKEN_SECRET) ||
      process.env.MODAL_CONFIG_PATH,
    );
  }

  async create(ctx: SandboxDriverContext): Promise<ProvisionedSandbox> {
    const { ModalClient } = await import("modal").catch((error: unknown) => {
      throw unavailable(
        `modal provider is not available: the "modal" SDK is not installed (${describe(error)})`,
        error,
      );
    });

    const client = new ModalClient();
    const app = await client.apps.fromName(this.config.appName, { createIfMissing: true });
    const image = this.buildImage(client.images.fromRegistry(this.config.baseImage));

    const sandbox = await client.sandboxes
      .create(app, image, {
        timeoutMs: ctx.timeoutSeconds * 1000,
        unencryptedPorts: [SANDBOX_SSH_PORT],
        // 入口进程默认就是"一直睡"，正是想要的：attach 之前不许退出。
        workdir: "/workspace",
      })
      .catch((error: unknown) => {
        throw upstreamFailure(this.provider, describe(error), error);
      });

    try {
      const tunnels = await sandbox.tunnels();
      const tunnel = tunnels[SANDBOX_SSH_PORT];
      if (!tunnel) {
        throw upstreamFailure(
          this.provider,
          `sandbox ${sandbox.sandboxId} did not expose a tunnel on port ${SANDBOX_SSH_PORT}`,
        );
      }
      const [host, port] = tunnel.tcpSocket;

      await runSandboxBootstrap({
        ctx: { ...ctx, runShell: createModalRunShell(sandbox) },
        skipPackageInstall: this.config.packagesPreinstalled,
      });

      return {
        sandboxId: sandbox.sandboxId,
        transport: { kind: "tcp", host, port },
        username: "root",
        expiresAt: Date.now() + ctx.timeoutSeconds * 1000,
      };
    } catch (error) {
      // bootstrap 失败意味着没人能 attach 进去；留着只会白烧配额。
      // 成功路径绝不销毁——沙箱归 provisioner 的到期策略管，不归 ZCode 管。
      await sandbox.terminate().catch(() => undefined);
      throw error;
    }
  }

  private buildImage(base: Image): Image {
    if (this.config.packagesPreinstalled) {
      return base;
    }

    // 层结果被 Modal 缓存，这一行只慢第一次。
    return base.dockerfileCommands([
      "RUN apt-get update && apt-get install -y --no-install-recommends git openssh-server ca-certificates && rm -rf /var/lib/apt/lists/*",
    ]);
  }
}

/**
 * Modal 没有"跑一段 shell 拿退出码"的便捷方法，只能自己拼 exec + 收流 + wait。
 *
 * 输出只在失败时进错误摘要，全量留在沙箱里（bootstrap 自己写到 /var/log）：clone 一个
 * monorepo 的进度输出可以很大，没必要搬回 provisioner 内存。
 */
function createModalRunShell(sandbox: Sandbox) {
  return async (command: string, options?: { timeoutMs?: number }): Promise<ShellResult> => {
    // 沙箱自身的 timeoutMs 已经是这段执行的兜底；这里不再叠一层计时，
    // 免得同一件事有两个超时来源。
    void options;

    const process_ = await sandbox.exec(["bash", "-lc", command]);
    const [exitCode, stdout, stderr] = await Promise.all([
      process_.wait(),
      process_.stdout.readText(),
      process_.stderr.readText(),
    ]);

    if (exitCode !== 0) {
      throw upstreamFailure(
        "modal",
        `sandbox bootstrap failed with exit code ${exitCode}: ${tail(stderr || stdout)}`,
      );
    }

    return { exitCode, stdout, stderr };
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

/**
 * 沙箱内 provisioning 安装与 workspace 准备（specs/cloud-agent/01 §6.2 步骤 2、§7.1、
 * 12 §6 A-08；W6 §3「provisioning target 安装」）。
 *
 * 凭据边界：只安装 run 授权清单内的 provider/model 配置与凭据；不复制整个 credential store；
 * envelope 正文不进日志（只记字节数与代际）。envelope 只能来自已认证 bridge 通道的
 * `bootstrap.config`，不走 provider env/元数据（01 §6.2、12 §6）。
 */
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { providerProvisioningEnvelopeSchema, ServiceChannels } from "@zcode/shared";
import type { IChannel } from "@zcode/rpc";
import type {
  PolicySnapshotPort,
  ProvisioningInstallPort,
  WorkspacePort,
} from "../app/bootstrap.js";
import type { ExecutionLogger } from "../app/ports.js";
import { DEFAULT_RUNTIME_STATE_DIR } from "./credentialStateFile.js";

export interface ProvisioningInstallerOptions {
  /** 本地 runtime 的 provider-provisioning-target 通道（未连接返回 null）。 */
  channel(): IChannel | null;
  logger: ExecutionLogger;
  stateDir?: string;
}

export function createProvisioningInstaller(
  options: ProvisioningInstallerOptions,
): ProvisioningInstallPort {
  const stateDir = options.stateDir ?? DEFAULT_RUNTIME_STATE_DIR;
  const generationPath = join(stateDir, "credential-generation.json");

  return {
    async appliedGeneration() {
      const raw = await readFile(generationPath, "utf8").catch(() => null);
      if (raw === null) return null;
      try {
        const value = JSON.parse(raw) as { version?: unknown; credentialGeneration?: unknown };
        if (value.version !== 1 || typeof value.credentialGeneration !== "number") return null;
        return value.credentialGeneration;
      } catch {
        return null;
      }
    },

    async install(envelopeJson, credentialGeneration) {
      const channel = options.channel();
      if (!channel) {
        // 通道缺失是明确的装配缺口，不静默跳过（会让 ready 变成假 ready）。
        throw new Error(
          `provider provisioning target channel ${ServiceChannels.ProviderProvisioningTarget} is unavailable`,
        );
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(envelopeJson);
      } catch {
        throw new Error("provisioning envelope is not valid json");
      }
      const envelope = providerProvisioningEnvelopeSchema.safeParse(parsed);
      if (!envelope.success) {
        throw new Error("provisioning envelope failed schema validation");
      }
      // 只记字节数/代际，不记正文（可能含凭据）。
      options.logger.info(undefined, "installing provisioning envelope", {
        credentialGeneration,
        envelopeBytes: envelopeJson.length,
      });
      // 通道调用约定：`IChannel.call(command, args)` 的 args 是**参数数组**
      // （`ProxyChannel.fromService` 里 `target.apply(handler, args || [])`）。传裸对象会被
      // 当成零参数调用，runtime 侧 `apply()` 收到 undefined 并抛 zod「expected object,
      // received undefined」——真实链路就是这样报的。
      await channel.call("apply", [envelope.data]);
      await mkdir(dirname(generationPath), { recursive: true, mode: 0o700 });
      const temporary = `${generationPath}.${randomUUID()}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, credentialGeneration, appliedAt: Date.now() })}\n`,
        { mode: 0o600 },
      );
      await rename(temporary, generationPath);
    },
  };
}

/**
 * 版本化 runtime preferences/policy snapshot 安装（07 §8 表首行：执行节点自己应答，
 * 页面不承担 Host 应答）。v1 的 snapshot 内容由控制面 policyVersion 标识，本地只记录
 * 已应用版本，供运行时 responder 读取；不写入账号设置存储（避免第二条写路径）。
 */
export function createPolicySnapshotInstaller(options: {
  logger: ExecutionLogger;
  stateDir?: string;
}): PolicySnapshotPort {
  const stateDir = options.stateDir ?? DEFAULT_RUNTIME_STATE_DIR;
  const path = join(stateDir, "applied-policy.json");
  return {
    async install(policyVersion) {
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: 1, policyVersion })}\n`, {
        mode: 0o600,
      });
      await rename(temporary, path);
      options.logger.info(undefined, "runtime policy snapshot applied", { policyVersion });
    },
  };
}

/**
 * workspace 准备：`/workspace/<repo>` 由服务端下发的绝对路径提供；identity 不作 cwd
 * （01 §6.2 步骤 2）。防 path traversal / symlink 越界：解析后必须仍在 workspaceRoot 内。
 */
export function createSandboxWorkspace(options: {
  workspaceRoot: string;
  logger: ExecutionLogger;
}): WorkspacePort {
  const root = resolve(options.workspaceRoot);

  function assertInsideRoot(candidate: string): void {
    const normalized = resolve(candidate);
    const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
    if (normalized !== root && !normalized.startsWith(prefix)) {
      throw new Error("workspace path escapes the configured workspace root");
    }
  }

  return {
    async ensure(path) {
      assertInsideRoot(path);
      await mkdir(path, { recursive: true });
      // symlink 越界：真实路径同样必须落在 root 内（否则 clone 会写到 root 之外）。
      const real = await realpath(path).catch(() => path);
      assertInsideRoot(real);
      options.logger.debug(undefined, "workspace ready", { ws: real });
    },

    async exists(path) {
      assertInsideRoot(path);
      const info = await stat(join(path, ".git")).catch(() => null);
      return info !== null;
    },
  };
}

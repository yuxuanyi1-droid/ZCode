import type { RemoteAssetInstallMode } from "./remoteAssetInstallMode.js";
import type { RemoteResourcePackageSelection } from "./remoteResourcePackages.js";

export interface SSHConnectOptions {
  kind: "ssh";
  host: string;
  port?: number;
  username: string;
  sshConfigAlias?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
}

export interface WSLConnectOptions {
  kind: "wsl";
  distro?: string;
  user?: string;
}

export interface DockerConnectOptions {
  kind: "docker";
  container: string;
}

/** 外部 provisioner 支持的沙箱供应商。 */
export const SANDBOX_PROVIDERS = ["modal", "e2b", "daytona"] as const;
export type SandboxProvider = (typeof SANDBOX_PROVIDERS)[number];

/**
 * sandbox attach 的传输层。
 *
 * 显式建模是因为三家 provider 的能力并不相同：
 * - Modal：沙箱内跑 sshd，用 unencrypted 端口隧道拿到裸 TCP 端点
 * - Daytona：官方 SSH 网关，token 当用户名，也是裸 TCP
 * - E2B：端口只以 HTTPS/WSS 暴露，**没有裸 TCP**，只能走 WebSocket 隧道
 *
 * 端点放在 transport 里而不是与它平级，避免表达出「websocket 传输却带着一个 host」
 * 这种没有意义的组合。
 */
export type SandboxSSHTransport =
  | { kind: "tcp"; host: string; port?: number }
  | { kind: "websocket"; url: string; headers?: Record<string, string> };

/**
 * 沙箱 attach 连接信息。由外部 provisioner 建立，ZCode 只读不改。
 * 凭据字段与 SSHConnectOptions 对齐，因为 attach 的传输层就是 SSH。
 */
export interface SandboxSSHAttach {
  transport: SandboxSSHTransport;
  username: string;
  password?: string;
  /**
   * 内联私钥。provisioner 在远端为每个沙箱生成一次性密钥后只能这样下发——
   * 它没法往用户机器上写一个 privateKeyPath 指向的文件。
   */
  privateKey?: string;
  /** 客户端本地已存在的私钥路径；本机自建的沙箱可以走这条。 */
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
}

/**
 * 沙箱远端目标（Plan A：外置 provisioner）。
 *
 * 生命周期归 provisioner——ZCode 从不创建或销毁沙箱，只 attach 进去执行。
 * `sandboxId` 仅用于身份、展示与遥测；`ssh` 是 provisioner 给出的 attach 入口。
 */
export interface SandboxConnectOptions {
  kind: "sandbox";
  provider: SandboxProvider;
  /** 沙箱 id；作为 identity authority 段使用，故限定为不含 ":" / "/" 的字符集。 */
  sandboxId: string;
  ssh: SandboxSSHAttach;
  assetInstallMode?: RemoteAssetInstallMode;
  resourcePackages?: RemoteResourcePackageSelection;
}

export type RemoteTarget =
  | SSHConnectOptions
  | WSLConnectOptions
  | DockerConnectOptions
  | SandboxConnectOptions;

/** 删除只应存在于当前连接流程中的 secret，供长期内存状态和跨进程回包使用。 */
export function stripRemoteTargetSecrets(target: RemoteTarget): RemoteTarget {
  if (target.kind === "ssh") {
    const {
      password: _password,
      privateKeyPassphrase: _privateKeyPassphrase,
      ...sanitized
    } = target;
    return sanitized;
  }

  if (target.kind === "sandbox") {
    const {
      password: _password,
      privateKey: _privateKey,
      privateKeyPassphrase: _privateKeyPassphrase,
      ...sanitizedSsh
    } = target.ssh;
    return { ...target, ssh: sanitizedSsh };
  }

  return target;
}

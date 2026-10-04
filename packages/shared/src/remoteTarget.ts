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
 * 沙箱 attach 连接信息。由外部 provisioner 建立，ZCode 只读不改。
 * 字段与 SSHConnectOptions 的凭据部分对齐，因为 v1 的 attach 传输层就是 SSH。
 */
export interface SandboxSSHAttach {
  host: string;
  port?: number;
  username: string;
  password?: string;
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
      privateKeyPassphrase: _privateKeyPassphrase,
      ...sanitizedSsh
    } = target.ssh;
    return { ...target, ssh: sanitizedSsh };
  }

  return target;
}

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

/**
 * 活跃远端连接目标。Docker/WSL 目标已退役（specs/cloud-agent/06 §3.1），
 * SSH 是唯一保留的手动远端目标；旧 kind 只能作为只读失效记录存在
 * （见 ./retiredRemoteWorkspace.js 的 RetiredRemoteWorkspaceEntry）。
 */
export type RemoteTarget = SSHConnectOptions;

/** 已退役的远端目标 kind；仅用于识别旧数据与旧请求，不再可连接。 */
export const RETIRED_REMOTE_TARGET_KINDS = ["wsl", "docker"] as const;
export type RetiredRemoteTargetKind = (typeof RETIRED_REMOTE_TARGET_KINDS)[number];

export function isRetiredRemoteTargetKind(value: unknown): value is RetiredRemoteTargetKind {
  return value === "wsl" || value === "docker";
}

/**
 * 从任意 HTTP/IPC payload 中识别已退役的 target kind。
 * 旧 kind 必须稳定拒绝（remote.targetRetired），不能静默转成 SSH 或本机路径执行。
 */
export function detectRetiredRemoteTargetKind(value: unknown): RetiredRemoteTargetKind | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const kind = (value as { kind?: unknown }).kind;
  return isRetiredRemoteTargetKind(kind) ? kind : null;
}

/** 删除只应存在于当前连接流程中的 secret，供长期内存状态和跨进程回包使用。 */
export function stripRemoteTargetSecrets(target: RemoteTarget): RemoteTarget {
  const { password: _password, privateKeyPassphrase: _privateKeyPassphrase, ...sanitized } = target;
  return sanitized;
}

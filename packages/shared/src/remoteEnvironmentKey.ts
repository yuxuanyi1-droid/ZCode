import type { RemoteTarget } from "./remoteTarget.js";
import { buildSshRemoteHostKey } from "./remoteSshHostKey.js";

/**
 * Provider Provisioning 等 Environment 级状态的稳定身份；不得混用 workspace/session 身份。
 * 活跃远端目标只有 SSH（Docker/WSL 已退役，specs/cloud-agent/06 §3.1）。
 */
export function buildRemoteEnvironmentKey(target: RemoteTarget): string {
  return `ssh:${buildSshRemoteHostKey(target)}`;
}

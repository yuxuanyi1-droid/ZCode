import type { SandboxProvider, SandboxSSHAttach, SandboxConnectOptions } from "./remoteTarget.js";

/**
 * 沙箱 provisioner 契约（Plan A）。
 *
 * 生命周期**刻意只有一半**：ZCode 只会调用 `create`。销毁不在这里，
 * 因为沙箱归 provisioner 所有——ZCode 进程崩溃、重连、切 workspace 都不该
 * 影响别人的沙箱。要回收就由 provisioner 的自己到期/回收策略负责。
 */

/**
 * 仓库定位信息。
 *
 * `owner` 不保证是单段：GitHub 是单段，但 GitLab 子组是 `group/subgroup`。
 * 因此只有 `name` 能当路径段用（checkout 目录名）。
 */
export interface SandboxRepositoryRef {
  owner: string;
  name: string;
}

export interface SandboxProvisionRequest {
  provider: SandboxProvider;
  repository: SandboxRepositoryRef;
  /** 要 checkout 的分支。provisioner 负责 clone + checkout。 */
  branch: string;
  /** 可选的精确 revision；给了就 detached checkout 到它，而不是 branch 尖端。 */
  ref?: string;
  /** 期望的 checkout 目录；缺省由 provisioner 决定，并以返回值里的 workspacePath 为准。 */
  workspacePath?: string;
  /** 沙箱存活上限（秒）。provisioner 可下调，不可上调。 */
  timeoutSeconds?: number;
}

export interface SandboxProvisionResult {
  sandboxId: string;
  /** attach 入口；与 ssh target 用同一套凭据字段。 */
  ssh: SandboxSSHAttach;
  /** provisioner 实际把仓库放在哪里。attach 后 ZCode 直接以此为 workspace。 */
  workspacePath: string;
  /** 沙箱硬性到期时间（epoch ms），供上层提示用户；不参与身份计算。 */
  expiresAt?: number;
}

/**
 * provisioner 返回的 attach 信息 → 内部 target。
 *
 * provider 由请求方持有（响应里不重复），因此必须显式传入——不能让两者漂移。
 */
export function toSandboxConnectOptions(
  provider: SandboxProvider,
  result: SandboxProvisionResult,
): SandboxConnectOptions {
  return {
    kind: "sandbox",
    provider,
    sandboxId: result.sandboxId,
    ssh: { ...result.ssh },
  };
}

import type {
  SandboxProvider,
  SandboxSSHAttach,
  SandboxSSHTransport,
  SandboxConnectOptions,
} from "./remoteTarget.js";

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
 * provisioner 的 HTTP 路径。
 *
 * 两端（ZCode 客户端 / provisioner 服务）都必须用这两个常量：任何一侧写死字面量，
 * 都会在对方改路径时变成一个只在生产暴露的 404。
 */
export const SANDBOX_PROVISION_PATH = "/sandboxes";
export const SANDBOX_HEALTH_PATH = "/healthz";

/** 沙箱存活上限的默认值（秒）。客户端据此提示，provisioner 据此创建——只定义一次。 */
export const DEFAULT_SANDBOX_TIMEOUT_SECONDS = 2 * 60 * 60;

/** 沙箱内 checkout 的根目录；repo_name 是它下面的单个目录名。 */
export const SANDBOX_WORKSPACE_ROOT = "/workspace";

/** 沙箱内 sshd 监听的端口；attach 由 provider 的隧道指到这里。 */
export const SANDBOX_SSH_PORT = 22;

function stripTrailingSlashes(path: string): string {
  return path.replace(/\/+$/, "");
}

/**
 * 判断一个**已去掉尾部斜杠**的路径是否严格位于 SANDBOX_WORKSPACE_ROOT 之下。
 *
 * 三条同时成立才算合法：
 * 1) 是 `${SANDBOX_WORKSPACE_ROOT}/` 的前缀（否则 checkout 会落在根目录外面）
 * 2) 不等于根目录本身（否则针对它的 `rm -rf` 落在根上）
 * 3) 没有 `..` / `.` / 空段（`/workspace/../etc` 前缀合法，展开后却在外面）
 *
 * 单独抽出来是因为 bootstrap 脚本在 `rm -rf` 前也要挡一次，两处必须用同一条规则——
 * 各写一份就会在一边修好、另一边继续放行 `/workspace/../etc`。
 */
function isSandboxWorkspacePathSafe(normalized: string): boolean {
  const prefix = `${SANDBOX_WORKSPACE_ROOT}/`;
  if (!normalized.startsWith(prefix)) {
    return false;
  }

  const relative = normalized.slice(prefix.length);
  if (relative.length === 0) {
    return false;
  }

  return !relative
    .split("/")
    .some((segment) => segment === "" || segment === ".." || segment === ".");
}

/**
 * 解析 checkout 目录。
 *
 * 请求方可以指定，但必须落在 SANDBOX_WORKSPACE_ROOT 之内：这个路径会被写进
 * workspace identity 和后续所有 attach 后的文件操作，逃出根目录等于让远端内容
 * 覆盖沙箱自己的系统文件。
 */
export function resolveSandboxWorkspacePath(
  request: Pick<SandboxProvisionRequest, "repository" | "workspacePath">,
): string {
  const requested = request.workspacePath?.trim();
  if (!requested) {
    return `${SANDBOX_WORKSPACE_ROOT}/${request.repository.name}`;
  }

  const normalized = stripTrailingSlashes(requested);
  if (isSandboxWorkspacePathSafe(normalized)) {
    return normalized;
  }

  throw new Error(
    `Sandbox workspacePath must be under ${SANDBOX_WORKSPACE_ROOT}: ${request.workspacePath}`,
  );
}

/** bootstrap 侧的同一规则；传入原始路径，内部自行规整。 */
export function isSandboxWorkspacePathWithinRoot(path: string): boolean {
  return isSandboxWorkspacePathSafe(stripTrailingSlashes(path.trim()));
}

/**
 * 解析沙箱存活上限。
 *
 * provider 只能**下调**不能上调：请求方写的时长可能超过该 provider 的硬上限
 * （例如 E2B Hobby 账号 1 小时），真按请求值创建会在 provider 侧被静默截断，
 * 让 expiresAt 变成谎话。宁可在这里就收敛成双方都认的值。
 */
export function resolveSandboxTimeoutSeconds(
  request: Pick<SandboxProvisionRequest, "timeoutSeconds">,
  maxSeconds: number,
): number {
  const requested = request.timeoutSeconds;
  if (requested === undefined) {
    return Math.min(DEFAULT_SANDBOX_TIMEOUT_SECONDS, maxSeconds);
  }

  return Math.min(requested, maxSeconds);
}

/**
 * 深拷贝传输层。
 *
 * transport 是嵌套对象，浅拷贝会让调用方此后的改写（例如刷新隧道端点）穿透到正在使用的
 * 底层连接上；headers 里装的是 WS 鉴权头，同样不能共享引用。
 */
function copySandboxSSHTransport(transport: SandboxSSHTransport): SandboxSSHTransport {
  if (transport.kind === "tcp") {
    return { ...transport };
  }
  return { ...transport, ...(transport.headers ? { headers: { ...transport.headers } } : {}) };
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
    ssh: { ...result.ssh, transport: copySandboxSSHTransport(result.ssh.transport) },
  };
}

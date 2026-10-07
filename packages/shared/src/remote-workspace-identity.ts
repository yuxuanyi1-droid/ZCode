// 远程 workspace identity 的统一解析工具（Workspace Identity 约束：构造与解析
// 必须复用统一工具，禁止业务代码手写拼接/拆解规则）。
// 构造侧（对偶）：packages/ui/src/lib/remoteWorkspaceHistory.ts 的
// buildRemoteWorkspaceIdentity —— 格式契约：
//   remote:ssh:<host>:<port>:<username>:<posixPath>
//   remote:wsl:<distro>[:<user>]:<posixPath>
//   remote:docker:<container>:<posixPath>
//   cloud-task:<taskId>（构造/解析见 ./cloud/identity.ts；不含 path，执行路径
//   必须由 run 元数据显式携带 workspacePath，specs/cloud-agent/08 §4.1）
// path 段经 normalizeWorkspacePathForIdentity 归一（分隔符 → "/"，去收尾斜杠，
// 空 → "/"），因此恒以 "/" 开头；authority 各段不含 "/"（host 小写、port 数字、
// docker 容器名/wsl 发行版名的合法字符集均不含 ":" 与 "/"）。
// 消费方：CLI v4 createSession 的 workspaceId（远程 pane 里 workspaceKey =
// identity）需要还原出真实 workspacePath 作为会话 workingDirectory。
// cloud-task 身份不可还原路径：parseRemoteWorkspaceIdentity 仍只覆盖
// ssh/wsl/docker；识别 cloud-task/退役/非法身份请用 classifyWorkspaceIdentity，
// 它把「无法识别的远端身份」与「本地 identity」显式区分，消费方不得把前者
// 回落成本地 workspacePath 继续执行（specs/cloud-agent/06 §4）。
import type { RemoteTarget } from "./remoteTarget.js";
import {
  CLOUD_TASK_IDENTITY_PREFIX,
  parseCloudTaskWorkspaceIdentity,
  type CloudTaskId,
} from "./cloud/identity.js";

export type RemoteWorkspaceIdentityKind = "ssh" | "wsl" | "docker";

export interface ParsedRemoteWorkspaceIdentity {
  kind: RemoteWorkspaceIdentityKind;
  /** 远端真实路径（posix 归一形态）。 */
  workspacePath: string;
}

const REMOTE_IDENTITY_PREFIX = "remote:";

/** authority 必选段数（不含 kind）：ssh = host/port/username，其余远端类型 = 单段。 */
const AUTHORITY_SEGMENTS: Record<RemoteWorkspaceIdentityKind, number> = {
  ssh: 3,
  wsl: 1,
  docker: 1,
};

function isRemoteWorkspaceIdentityKind(value: string): value is RemoteWorkspaceIdentityKind {
  return value === "ssh" || value === "wsl" || value === "docker";
}

function normalizeWorkspacePathForIdentity(workspacePath: string): string {
  const normalized = workspacePath.replace(/\\/g, "/").replace(/\/+/g, "/");
  const trimmed = normalized.replace(/^\/+|\/+$/g, "");
  return `/${trimmed}`;
}

/**
 * 统一构造远程 workspace identity。Host、Main 和 UI 禁止自行拼接 authority；
 * `workspacePath` 只在这里归一后进入身份键，实际 IO 仍使用调用方原路径。
 *
 * 活跃目标只有 SSH；Docker/WSL 目标已退役（specs/cloud-agent/06 §4），
 * 它们的旧 identity 仍需被 parseRemoteWorkspaceIdentity / classifyWorkspaceIdentity
 * 识别为退役远端身份，因此这里不再提供其构造分支。
 */
export function buildRemoteWorkspaceIdentity(workspacePath: string, target: RemoteTarget): string {
  const normalizedPath = normalizeWorkspacePathForIdentity(workspacePath);
  return `remote:ssh:${target.host.trim().toLowerCase()}:${target.port ?? 22}:${target.username.trim()}:${normalizedPath}`;
}

/**
 * 解析远程 workspace identity；非法/非远程 identity 返回 null（调用方回落
 * 「按本地 workspacePath 处理」）。只提取 workspacePath——authority 细节
 * （host/port 等）对消费方（CLI 运行在远端机器上）无意义，不透出。
 */
export function parseRemoteWorkspaceIdentity(
  identity: string,
): ParsedRemoteWorkspaceIdentity | null {
  if (!identity.startsWith(REMOTE_IDENTITY_PREFIX)) {
    return null;
  }
  const rest = identity.slice(REMOTE_IDENTITY_PREFIX.length);
  const kindEnd = rest.indexOf(":");
  if (kindEnd <= 0) {
    return null;
  }
  const kind = rest.slice(0, kindEnd);
  if (!isRemoteWorkspaceIdentityKind(kind)) {
    return null;
  }
  // 逐段消费 authority；path 段可能含 ":"（理论上 posix 路径允许），
  // 因此不能整体 split——按段推进后取剩余整段为 path。
  let cursor = kindEnd + 1;
  for (let i = 0; i < AUTHORITY_SEGMENTS[kind]; i++) {
    const next = rest.indexOf(":", cursor);
    if (next <= cursor) {
      return null;
    }
    cursor = next + 1;
  }
  // WSL identity 为区分默认用户与显式用户增加了可选 user 段，旧解析器
  // 仍只消费 distro，导致 user 被误判为路径并让 identity 整体解析失败。远端路径
  // 必须以 "/" 开头，因此可以无歧义地区分 legacy 无 user 格式与显式 user 格式。
  if (kind === "wsl" && rest[cursor] !== "/") {
    const userEnd = rest.indexOf(":", cursor);
    if (userEnd <= cursor) {
      return null;
    }
    cursor = userEnd + 1;
  }
  const workspacePath = rest.slice(cursor);
  if (!workspacePath.startsWith("/")) {
    return null;
  }
  return { kind, workspacePath };
}

/** identity 是否是远程 workspace identity（可被 parseRemoteWorkspaceIdentity 解析）。 */
export function isRemoteWorkspaceIdentity(identity: string): boolean {
  return parseRemoteWorkspaceIdentity(identity) !== null;
}

/**
 * workspace identity 的统一分类（specs/cloud-agent/06 §4 退役识别原则）。
 * 只有 kind=local 才允许消费方回落「按本地 workspacePath 处理」；
 * retired-remote / invalid-remote / cloud-task 一律不得按本地路径执行。
 */
export type WorkspaceIdentityClassification =
  | { kind: "local" }
  | { kind: "remote"; identity: ParsedRemoteWorkspaceIdentity }
  /** WSL / Docker 远端目标已退役：只读失效投影，禁止 reconnect/Agent/terminal。 */
  | { kind: "retired-remote"; identity: ParsedRemoteWorkspaceIdentity }
  /** Cloud Task 身份：taskId 隔离元数据，路径必须由 run 元数据显式提供。 */
  | { kind: "cloud-task"; taskId: CloudTaskId }
  /** 带远端标记但无法解析：明确错误，不回落本地（含非法 cloud-task:taskId）。 */
  | { kind: "invalid-remote" };

const RETIRED_REMOTE_KINDS: ReadonlySet<RemoteWorkspaceIdentityKind> = new Set(["wsl", "docker"]);

export function classifyWorkspaceIdentity(identity: string): WorkspaceIdentityClassification {
  if (identity.startsWith(CLOUD_TASK_IDENTITY_PREFIX)) {
    const cloudTask = parseCloudTaskWorkspaceIdentity(identity);
    return cloudTask
      ? { kind: "cloud-task", taskId: cloudTask.taskId }
      : { kind: "invalid-remote" };
  }
  const parsed = parseRemoteWorkspaceIdentity(identity);
  if (parsed) {
    return RETIRED_REMOTE_KINDS.has(parsed.kind)
      ? { kind: "retired-remote", identity: parsed }
      : { kind: "remote", identity: parsed };
  }
  if (identity.startsWith(REMOTE_IDENTITY_PREFIX)) {
    // remote: 前缀存在但解析失败：无法识别的远端身份，禁止按本地路径继续。
    return { kind: "invalid-remote" };
  }
  return { kind: "local" };
}

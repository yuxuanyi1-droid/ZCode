/**
 * 云任务沙箱内 checkout 路径（specs/cloud-agent 01 §6.2 步骤 2：控制面创建
 * `/workspace/<repo>`，服务端解析展示名并防 path traversal/symlink 越界；仅
 * `workspacePath` 作 cwd，identity 不作 cwd）。
 *
 * 唯一计算点：本函数是 workspacePath 的**唯一**来源——创建期经 provider 命令通道 env
 * 下发给 supervisor、同一值持久化到 `run.workspacePath`、并用于校验 bridge hello 上报的
 * 值（08 §4.1「workspacePath 来自 run 的已验证工作区描述」）。三处必须一致，
 * 其它文件不得再算一遍。
 *
 * 纯函数：确定性（同一 repoName 恒定得到同一路径）、无 IO、不读时钟。
 */

/** 沙箱内工作区根目录（01 §6.2 步骤 2 固定的 `/workspace`）。 */
export const CLOUD_WORKSPACE_ROOT = "/workspace";

/** 仓库段长度上限：足够辨识、避免路径长度问题。 */
const SEGMENT_MAX_LENGTH = 64;

export type WorkspacePathResult =
  | { ok: true; path: string; segment: string }
  | { ok: false; reason: "repo-name-empty" | "repo-name-unsafe" };

/**
 * 判定仓库名是否可用于路径：
 * - 必须是**单个路径段**：含 `/`、`\`、驱动器前缀或绝对路径一律拒绝（不做静默截断，
 *   否则 `../x` 一类输入会被「净化」成看似合法的路径）；
 * - 拒绝 `.`/`..` 与以 `-` 开头（避免被当作命令选项）；
 * - 控制字符与空白由净化阶段处理，但要求净化后仍非空。
 */
function isSafeRepoNameSegment(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === "." || trimmed === "..") return false;
  if (trimmed.startsWith("-")) return false;
  if (trimmed.includes("/") || trimmed.includes("\\")) return false;
  if (trimmed.includes("\u0000")) return false;
  if (/^[a-zA-Z]:/.test(trimmed)) return false;
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/** 净化：NFKD → 小写 → 只保留 `[a-z0-9._-]`，其余折叠为 `-`；折叠重复分隔符并裁掉首尾。 */
export function normalizeRepoPathSegment(name: string): string {
  const normalized = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-._]+/, "")
    .replace(/[-._]+$/, "");
  return normalized.slice(0, SEGMENT_MAX_LENGTH).replace(/[-._]+$/, "");
}

/**
 * 计算任务沙箱内 checkout 路径。不安全或净化后为空的仓库名**明确失败**，
 * 由调用方按 `validation_failed` 收口，不落临时目录、不回退到别的路径。
 */
export function buildCloudTaskWorkspacePath(repoName: string): WorkspacePathResult {
  if (!isSafeRepoNameSegment(repoName)) return { ok: false, reason: "repo-name-unsafe" };
  const segment = normalizeRepoPathSegment(repoName);
  if (segment.length === 0) return { ok: false, reason: "repo-name-empty" };
  return { ok: true, path: `${CLOUD_WORKSPACE_ROOT}/${segment}`, segment };
}

/** 路径是否位于工作区根之内（用于校验 hello 上报值；不解析符号链接，越界检查在远端 owner）。 */
export function isWithinCloudWorkspaceRoot(path: string): boolean {
  if (!path.startsWith(`${CLOUD_WORKSPACE_ROOT}/`)) return false;
  const relative = path.slice(CLOUD_WORKSPACE_ROOT.length + 1);
  if (relative.length === 0) return false;
  return relative
    .split("/")
    .every((segment) => segment.length > 0 && segment !== "." && segment !== "..");
}

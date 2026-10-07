/**
 * 任务分支命名（09 §4.1：`zcode/task-<taskId>-<slug>`）。
 *
 * 规则：使用完整唯一 taskId，slug 只作展示、截断/规范化后不参与唯一性；名称按 Git ref
 * 规则校验。首次输入接纳事务中生成并持久化，不因重开、标题更改、provider 变更重算
 * （09 §4.1、08 §9）。外部已占用同名分支且不能证实由该 Task 建立时拒绝覆盖。
 */

const SLUG_MAX_LENGTH = 32;

/** 规范化 slug：仅保留 ASCII 字母数字，其余折叠为 `-`；结果只作展示。 */
export function buildTaskBranchSlug(title: string): string {
  const normalized = title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const trimmed = normalized.slice(0, SLUG_MAX_LENGTH).replace(/-+$/g, "");
  return trimmed.length > 0 ? trimmed : "task";
}

export function buildTaskBranchName(input: { taskId: string; title: string }): string {
  return `zcode/task-${input.taskId}-${buildTaskBranchSlug(input.title)}`;
}

/**
 * Git ref 形态校验（git check-ref-format 的核心约束；不依赖 Git 进程）。
 * 拒绝：空、控制字符、空格、`~ ^ : ? * [ \`、`..`、`@{`、首尾 `/`/`.`、`.lock` 结尾、`//`。
 */
export function isValidGitRefName(name: string): boolean {
  if (name.length === 0 || name.length > 256) return false;
  for (const char of name) {
    const code = char.codePointAt(0) ?? 0;
    if (code <= 0x1f || code === 0x7f) return false;
  }
  if (/[~^:?*[\\\s]/.test(name)) return false;
  if (name.includes("..") || name.includes("@{")) return false;
  if (name.startsWith("/") || name.endsWith("/") || name.includes("//")) return false;
  if (name.startsWith(".") || name.endsWith(".") || name.endsWith(".lock")) return false;
  if (name.split("/").some((segment) => segment.length === 0 || segment.endsWith(".lock")))
    return false;
  return true;
}

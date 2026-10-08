/**
 * 沙箱 git 命令规划（specs/cloud-agent/01 §6.2 步骤 3–4、§7.2 Git grant、§8 checkpoint）。
 *
 * 纯函数：只产出 argv 数组与判定，不执行、不拼 shell。要求：
 * - 一律 argv 形式，ref/prompt 不拼 shell 程序（01 §6.2 步骤 3）；
 * - clone/fetch 以冻结 SHA checkout 并建 taskBranch；重开按 lastCheckpointSha 核对远端关系；
 * - push 禁止 force；远端 SHA 由 `ls-remote` 核验，不用本地推断（01 §8）；
 * - 无变更不建空 WIP 提交（01 §8）。
 */

/** git ref 的严格形状（先 schema 再交给 Git 原生 ref 检查，不用宽松正则兜底）。 */
const REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,254}$/;

export function isSafeRef(ref: string): boolean {
  if (!REF_PATTERN.test(ref)) return false;
  // Git 原生禁止的形态（`..`、`.lock` 结尾、连续斜杠、结尾斜杠或点）在此一并拒绝。
  if (ref.includes("..") || ref.includes("//")) return false;
  if (ref.endsWith("/") || ref.endsWith(".") || ref.endsWith(".lock")) return false;
  return true;
}

export interface CloneFacts {
  /** 权限核验用的仓库 id（展示名不用于授权，11 §4.3）。 */
  repositoryId: number;
  repositoryFullName: string;
  baseSha: string;
  taskBranch: string;
}

export type GitPlan =
  | { ok: true; argv: string[] }
  | { ok: false; reason: "invalid-ref" | "invalid-sha" | "invalid-origin" };

const SHA_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FULL_NAME_PATTERN = /^[A-Za-z0-9._-]{1,120}\/[A-Za-z0-9._-]{1,120}$/;

/** 固定 origin：展示名来自控制面 clone 事实，权限仍按 repositoryId 核验（11 §4.3）。 */
export function originUrl(repositoryFullName: string): string | null {
  if (!FULL_NAME_PATTERN.test(repositoryFullName)) return null;
  return `https://github.com/${repositoryFullName}.git`;
}

/** 首 Run：clone 后 checkout 冻结 baseSha，再建 taskBranch（01 §6.2 步骤 4）。 */
export function planClone(facts: CloneFacts, workspacePath: string): GitPlan {
  const url = originUrl(facts.repositoryFullName);
  if (!url) return { ok: false, reason: "invalid-origin" };
  if (!SHA_PATTERN.test(facts.baseSha)) return { ok: false, reason: "invalid-sha" };
  if (!isSafeRef(facts.taskBranch)) return { ok: false, reason: "invalid-ref" };
  return { ok: true, argv: ["clone", "--no-tags", "--", url, workspacePath] };
}

/** clone 之后固定 SHA 的 checkout（`--detach` 保证不是分支名歧义）。 */
export function planCheckoutBase(baseSha: string): GitPlan {
  if (!SHA_PATTERN.test(baseSha)) return { ok: false, reason: "invalid-sha" };
  return { ok: true, argv: ["checkout", "--detach", baseSha] };
}

/** 建任务分支（已存在则失败，不静默复用旧分支）。 */
export function planCreateTaskBranch(taskBranch: string): GitPlan {
  if (!isSafeRef(taskBranch)) return { ok: false, reason: "invalid-ref" };
  return { ok: true, argv: ["switch", "-c", taskBranch] };
}

/** 重开：取任务分支并核对与 lastCheckpointSha 的关系（不静默重建覆盖工作）。 */
export function planFetchTaskBranch(taskBranch: string): GitPlan {
  if (!isSafeRef(taskBranch)) return { ok: false, reason: "invalid-ref" };
  return { ok: true, argv: ["fetch", "--no-tags", "origin", taskBranch] };
}

export function planCheckoutRemoteBranch(taskBranch: string): GitPlan {
  if (!isSafeRef(taskBranch)) return { ok: false, reason: "invalid-ref" };
  return { ok: true, argv: ["checkout", "--detach", `refs/remotes/origin/${taskBranch}`] };
}

/** 追平本地任务分支到远端（正常快进；非快进由上层对账，不在此 force）。 */
export function planFastForwardBranch(taskBranch: string): GitPlan {
  if (!isSafeRef(taskBranch)) return { ok: false, reason: "invalid-ref" };
  return { ok: true, argv: ["branch", "-f", taskBranch, `refs/remotes/origin/${taskBranch}`] };
}

export function planRevParse(ref: string): GitPlan {
  if (!isSafeRef(ref)) return { ok: false, reason: "invalid-ref" };
  return { ok: true, argv: ["rev-parse", ref] };
}

/**
 * 本地 HEAD 的 SHA（01 §8：checkpoint 只有被远端 HEAD 查询确认才推进 lastCheckpointSha，
 * 确认对象就是这里的本地 sha，而不是「远端存在任意 HEAD」）。
 *
 * `--verify` 保证 HEAD 不可解析（未提交的空仓库、损坏 worktree）时直接非零退出，
 * 而不是把符号名 `HEAD` 当成 SHA 返回——调用方据此 fail closed，不猜。
 */
export function planRevParseHead(): GitPlan {
  return { ok: true, argv: ["rev-parse", "--verify", "HEAD"] };
}

/** 工作区状态：porcelain 输出为空 = 无变更（此时不建空提交）。 */
export function planStatusPorcelain(): GitPlan {
  return { ok: true, argv: ["status", "--porcelain", "--untracked-files=normal"] };
}

export function planAddTrackedAndUntracked(): GitPlan {
  // 文件范围 = tracked + non-ignored untracked（01 §8：ignored 产物/缓存不入 checkpoint）。
  return { ok: true, argv: ["add", "--all", "--", "."] };
}

export function planCommit(message: string): GitPlan {
  return { ok: true, argv: ["commit", "--no-verify", "-m", message] };
}

/** 正常 push，禁止 force（01 §8）。 */
export function planPush(taskBranch: string): GitPlan {
  if (!isSafeRef(taskBranch)) return { ok: false, reason: "invalid-ref" };
  return { ok: true, argv: ["push", "--porcelain", "origin", `${taskBranch}:${taskBranch}`] };
}

/** 远端 HEAD 核验：只有它确认才推进 lastCheckpointSha（01 §8）。 */
export function planLsRemote(taskBranch: string): GitPlan {
  if (!isSafeRef(taskBranch)) return { ok: false, reason: "invalid-ref" };
  return { ok: true, argv: ["ls-remote", "--heads", "origin", taskBranch] };
}

/** 无变更判定：porcelain 空输出即 clean。 */
export function isWorktreeClean(porcelainOutput: string): boolean {
  return porcelainOutput.trim().length === 0;
}

/** 解析 `ls-remote --heads` 输出中的远端 SHA；无匹配返回 null（不猜测）。 */
export function parseLsRemoteSha(output: string, taskBranch: string): string | null {
  const expectedRef = `refs/heads/${taskBranch}`;
  for (const line of output.split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    if (!sha || !ref) continue;
    if (ref === expectedRef && SHA_PATTERN.test(sha)) return sha;
  }
  return null;
}

/** 外部改写/回退对账：远端 HEAD 与本地 checkpoint 的关系（01 §6.2 步骤 4、§8）。 */
export type ReconciledCommits =
  | { kind: "equal" }
  | { kind: "ahead" }
  | { kind: "behind" }
  | { kind: "diverged" };

export function classifyAncestry(input: {
  mergeBaseSha: string | null;
  localSha: string;
  remoteSha: string;
}): ReconciledCommits {
  if (input.localSha === input.remoteSha) return { kind: "equal" };
  if (input.mergeBaseSha === null) return { kind: "diverged" };
  if (input.mergeBaseSha === input.localSha) return { kind: "behind" };
  if (input.mergeBaseSha === input.remoteSha) return { kind: "ahead" };
  return { kind: "diverged" };
}

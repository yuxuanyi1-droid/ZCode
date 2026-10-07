/**
 * 沙箱 git 执行（specs/cloud-agent/01 §6.2 clone/checkout、§7.2 Git grant、§8 checkpoint；
 * W6 §3「sandboxGit」）。
 *
 * 凭据边界（01 §7.2）：
 * - token 只经**进程 env**（`GIT_CONFIG_*` 的 http.extraHeader）进入 git，不写 argv、
 *   不写 `.git/config`、不落盘、不进日志；系统/全局/仓库 helper 一律清空防继承缓存；
 * - grant 短效单次，只经 TLS 取回；任务结束/失败即释放引用（尽力 revoke 在控制面）。
 *
 * 远端事实优先：push 是否成功以 `ls-remote` 的 HEAD 为准，不用本地推断（01 §8）。
 */
import { Buffer } from "node:buffer";
import type { CloudErrorCode } from "@zcode/shared";
import {
  isWorktreeClean,
  parseLsRemoteSha,
  planAddTrackedAndUntracked,
  planCheckoutBase,
  planClone,
  planCommit,
  planCreateTaskBranch,
  planFetchTaskBranch,
  planLsRemote,
  planPush,
  planRevParse,
  planStatusPorcelain,
  planCheckoutRemoteBranch,
  type CloneFacts,
  type GitPlan,
} from "../domain/gitPlan.js";
import type { ExecutionLogger } from "./ports.js";

export interface GitRunOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export interface GitRunnerPort {
  /** 以 argv 形式执行 git；env 只为本次调用准备，token 不缓存。 */
  run(
    argv: readonly string[],
    options: { cwd: string; env?: Record<string, string>; timeoutMs?: number },
  ): Promise<GitRunOutcome>;
}

export type GitGrantPurpose = "clone" | "fetch" | "push";

export interface SandboxGitGrantPort {
  /** 单次兑换：返回的 token 只应存在于本次调用的内存里（01 §7.2）。 */
  fetch(
    purpose: GitGrantPurpose,
  ): Promise<{ token: string; expiresAt: number; repositoryId: number }>;
}

export type GitStepResult =
  | { ok: true; stdout: string }
  | { ok: false; code: CloudErrorCode; message: string };

export interface SandboxGitOptions {
  runner: GitRunnerPort;
  grants: SandboxGitGrantPort;
  logger: ExecutionLogger;
}

export interface SandboxGit {
  /** 首 Run：clone → checkout 冻结 baseSha → 建 taskBranch（01 §6.2 步骤 4）。 */
  cloneAtBase(facts: CloneFacts, workspacePath: string, cwd: string): Promise<GitStepResult>;
  /** 重开：取任务分支并检出远端 HEAD（不重建、不覆盖）。 */
  resumeTaskBranch(taskBranch: string, workspacePath: string): Promise<GitStepResult>;
  localHead(cwd: string, ref: string): Promise<string | null>;
  /** 远端 HEAD（`ls-remote`）；无匹配返回 null，不猜测（01 §8）。 */
  remoteHead(taskBranch: string, cwd: string): Promise<string | null>;
  /** 收口提交：无变更返回 committed=false，不建空提交（01 §8）。 */
  commitWorktree(input: {
    cwd: string;
    message: string;
  }): Promise<
    | { ok: true; clean: boolean; committed: boolean }
    | { ok: false; code: CloudErrorCode; message: string }
  >;
  /** 正常 push（禁止 force）+ 远端 SHA 核验。 */
  pushAndVerify(input: {
    cwd: string;
    taskBranch: string;
  }): Promise<
    { ok: true; remoteSha: string } | { ok: false; code: CloudErrorCode; message: string }
  >;
}

/**
 * git 的凭据环境（01 §7.2）：
 * - `http.<url>.extraHeader` 带 Basic 认证，token 不进 URL、不进 argv、不落 .git/config；
 * - `credential.helper=` 置空 + `GIT_CONFIG_NOSYSTEM=1` 防继承系统/全局 helper 缓存；
 * - `GIT_TERMINAL_PROMPT=0` 保证失败即失败，不阻塞等输入。
 *
 * **本函数只能设置一个 `extraHeader`**（修复依据：真实链路 clone 被 GitHub 以
 * `remote: Duplicate header: "Authorization"` + `400` 拒绝——`http.extraHeader` 与
 * `http.<url>.extraHeader` 是各自独立的多值配置，两者都命中同一 URL 时 git 会把两个
 * `Authorization` 头一并发出，而不是后者覆盖前者）。这里保留 URL 作用域的那一个：
 * `originUrl` 固定产出 `https://github.com/<fullName>.git`（gitPlan.ts），作用域必然命中，
 * 且比通用键更窄——同一命令里若再碰到别的 host 也不会带上凭据。
 */
export function gitCredentialEnv(token: string): Record<string, string> {
  const basic = Buffer.from(`x-access-token:${token}`, "utf8").toString("base64");
  return {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "credential.helper",
    GIT_CONFIG_VALUE_0: "",
    GIT_CONFIG_KEY_1: "http.https://github.com/.extraHeader",
    GIT_CONFIG_VALUE_1: `Authorization: Basic ${basic}`,
    GIT_TERMINAL_PROMPT: "0",
  };
}

export function createSandboxGit(options: SandboxGitOptions): SandboxGit {
  const timeoutMs = 10 * 60 * 1000;

  async function runPlan(
    cwd: string,
    plan: GitPlan,
    env?: Record<string, string>,
  ): Promise<GitRunOutcome> {
    if (!plan.ok) {
      return { code: -1, stdout: "", stderr: `invalid git plan: ${plan.reason}` };
    }
    return options.runner.run(plan.argv, env ? { cwd, env, timeoutMs } : { cwd, timeoutMs });
  }

  /** 带 grant 执行：token 只活在该闭包内，退出即失去引用（不写文件、不进日志）。 */
  async function withGrant(
    purpose: GitGrantPurpose,
    fn: (env: Record<string, string>) => Promise<GitRunOutcome>,
  ): Promise<GitRunOutcome> {
    const grant = await options.grants.fetch(purpose);
    return fn(gitCredentialEnv(grant.token));
  }

  function failure(
    result: GitRunOutcome,
    code: CloudErrorCode,
  ): { ok: false; code: CloudErrorCode; message: string } {
    return {
      ok: false,
      code,
      message: result.stderr.trim().slice(0, 512) || `git exited ${result.code}`,
    };
  }

  return {
    async cloneAtBase(facts, workspacePath, cwd) {
      const clone = planClone(facts, workspacePath);
      if (!clone.ok) return { ok: false, code: "invalid_ref", message: clone.reason };
      const cloned = await withGrant("clone", (env) =>
        options.runner.run(clone.argv, { cwd, env, timeoutMs }),
      );
      if (cloned.code !== 0) return failure(cloned, "bootstrap_failed");
      const checkout = planCheckoutBase(facts.baseSha);
      const checkedOut = await runPlan(workspacePath, checkout);
      if (checkedOut.code !== 0) return failure(checkedOut, "bootstrap_failed");
      const branch = planCreateTaskBranch(facts.taskBranch);
      const created = await runPlan(workspacePath, branch);
      if (created.code !== 0) return failure(created, "checkpoint_failed");
      options.logger.info(undefined, "sandbox clone completed", {
        repositoryId: facts.repositoryId,
        taskBranch: facts.taskBranch,
      });
      return { ok: true, stdout: created.stdout };
    },

    async resumeTaskBranch(taskBranch, workspacePath) {
      const fetchPlan = planFetchTaskBranch(taskBranch);
      if (!fetchPlan.ok) return { ok: false, code: "invalid_ref", message: fetchPlan.reason };
      const fetched = await withGrant("fetch", (env) =>
        options.runner.run(fetchPlan.argv, { cwd: workspacePath, env, timeoutMs }),
      );
      if (fetched.code !== 0) return failure(fetched, "bootstrap_failed");
      const checkout = planCheckoutRemoteBranch(taskBranch);
      const checkedOut = await runPlan(workspacePath, checkout);
      if (checkedOut.code !== 0) return failure(checkedOut, "bootstrap_failed");
      return { ok: true, stdout: checkedOut.stdout };
    },

    async localHead(cwd, ref) {
      const plan = planRevParse(ref);
      const result = await runPlan(cwd, plan);
      if (result.code !== 0) return null;
      const sha = result.stdout.trim();
      return /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(sha) ? sha : null;
    },

    async remoteHead(taskBranch, cwd) {
      const plan = planLsRemote(taskBranch);
      const result = await withGrant("fetch", (env) =>
        options.runner.run(plan.ok ? plan.argv : [], { cwd, env, timeoutMs }),
      );
      if (result.code !== 0) return null;
      return parseLsRemoteSha(result.stdout, taskBranch);
    },

    async commitWorktree({ cwd, message }) {
      const status = await runPlan(cwd, planStatusPorcelain());
      if (status.code !== 0) return failure(status, "checkpoint_failed");
      if (isWorktreeClean(status.stdout)) {
        // 无变更：不建空 WIP 提交（01 §8）。
        return { ok: true, clean: true, committed: false };
      }
      const add = await runPlan(cwd, planAddTrackedAndUntracked());
      if (add.code !== 0) return failure(add, "checkpoint_failed");
      const commit = await runPlan(cwd, planCommit(message));
      if (commit.code !== 0) return failure(commit, "checkpoint_failed");
      return { ok: true, clean: false, committed: true };
    },

    async pushAndVerify({ cwd, taskBranch }) {
      const push = planPush(taskBranch);
      const pushed = await withGrant("push", (env) =>
        options.runner.run(push.ok ? push.argv : [], { cwd, env, timeoutMs }),
      );
      const plan = planLsRemote(taskBranch);
      // push 丢响应/非零退出都按远端 SHA 对账，不重做 commit、不 force（01 §8）。
      const verified = await withGrant("fetch", (env) =>
        options.runner.run(plan.ok ? plan.argv : [], { cwd, env, timeoutMs }),
      );
      if (verified.code !== 0) {
        return { ok: false, code: "checkpoint_failed", message: "remote HEAD verification failed" };
      }
      const remoteSha = parseLsRemoteSha(verified.stdout, taskBranch);
      if (!remoteSha) {
        return {
          ok: false,
          code: pushed.code === 0 ? "checkpoint_failed" : "non_fast_forward",
          message: "task branch head not found on remote",
        };
      }
      return { ok: true, remoteSha };
    },
  };
}

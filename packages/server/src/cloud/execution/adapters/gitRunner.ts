/**
 * git 进程执行与 grant 取回（specs/cloud-agent/01 §7.2、§8；W6 §3「git-grant 取回」）。
 *
 * 秘密边界：
 * - grant 经 TLS 的单次兑换端点取回，凭据只放 **Authorization 头**（不放 query、不进日志）；
 * - git 子进程的 token 只经 env（见 app/sandboxGit.ts 的 gitCredentialEnv），不进 argv；
 * - 本文件不打印任何 token/URL query，只记录 purpose/状态码/遥控 SHA 等脱敏事实。
 */
import { spawn } from "node:child_process";
import { cloudGitGrantResponseSchema, type CloudGitGrantResponse } from "@zcode/shared";
import type { GitRunOutcome, GitRunnerPort, SandboxGitGrantPort } from "../app/sandboxGit.js";
import type { ExecutionLogger } from "../app/ports.js";

export interface GitRunnerOptions {
  logger: ExecutionLogger;
  /** git 可执行文件（默认 PATH 上的 git）。 */
  gitPath?: string;
  killGraceMs?: number;
}

/** argv 执行的 git runner；stdout/stderr 有界收集，超限截断（不进会话投影）。 */
export function createGitRunner(options: GitRunnerOptions): GitRunnerPort {
  const gitPath = options.gitPath ?? "git";
  const killGraceMs = options.killGraceMs ?? 5_000;

  return {
    run(argv, runOptions) {
      return new Promise<GitRunOutcome>((resolve) => {
        const child = spawn(gitPath, [...argv], {
          cwd: runOptions.cwd,
          env: runOptions.env ? { ...process.env, ...runOptions.env } : process.env,
          stdio: ["ignore", "pipe", "pipe"],
          shell: false,
        });
        const limit = 1 << 20;
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
          if (stdout.length < limit) stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
          if (stderr.length < limit) stderr += chunk.toString("utf8");
        });
        const timer = setTimeout(
          () => {
            options.logger.warn(undefined, "git command timed out", { argv: argv[0] });
            child.kill("SIGTERM");
            setTimeout(() => child.kill("SIGKILL"), killGraceMs);
          },
          runOptions.timeoutMs ?? 10 * 60 * 1000,
        );
        child.once("error", (error) => {
          clearTimeout(timer);
          resolve({ code: -1, stdout, stderr: `${stderr}${error.message}` });
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code: code ?? -1, stdout, stderr });
        });
      });
    },
  };
}

export interface GitGrantClientOptions {
  /** 控制面公网 origin（自举 env 下发；只用于拼接端点，不含凭据）。 */
  publicOrigin: string;
  runId: string;
  /** run-scoped 凭据（bootstrap ticket / resume token）；只放请求头。 */
  credential(): Promise<string>;
  logger: ExecutionLogger;
  fetchImpl?: typeof fetch;
}

/** `/api/cloud/runs/:runId/git-grant` 单次兑换客户端（01 §7.2）。 */
export function createGitGrantClient(options: GitGrantClientOptions): SandboxGitGrantPort {
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    async fetch(purpose) {
      const credential = await options.credential();
      const url = new URL(
        `/api/cloud/runs/${encodeURIComponent(options.runId)}/git-grant`,
        options.publicOrigin,
      );
      url.searchParams.set("purpose", purpose);
      const response = await fetchImpl(url, {
        method: "GET",
        headers: { authorization: `Bearer ${credential}`, accept: "application/json" },
      });
      if (!response.ok) {
        // 状态码可记，响应体可能含细节但不含 token；只记状态码避免意外落盘。
        options.logger.warn(undefined, "git grant request failed", {
          purpose,
          status: response.status,
        });
        throw new Error(`git grant request failed with status ${response.status}`);
      }
      const parsed = cloudGitGrantResponseSchema.safeParse(await response.json());
      if (!parsed.success) {
        throw new Error("git grant response failed schema validation");
      }
      const grant: CloudGitGrantResponse = parsed.data;
      options.logger.info(undefined, "git grant redeemed", {
        purpose: grant.purpose,
        repositoryId: grant.repositoryId,
        expiresInMs: Math.max(0, grant.expiresAt - Date.now()),
      });
      return { token: grant.token, expiresAt: grant.expiresAt, repositoryId: grant.repositoryId };
    },
  };
}

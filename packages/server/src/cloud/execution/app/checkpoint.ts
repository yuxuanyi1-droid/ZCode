/**
 * checkpoint 执行（specs/cloud-agent/01 §8 Checkpoint 与停止、08 §8.1 事实要求；
 * W6 §3「checkpoint.ts」）。
 *
 * 通路固定为「quiesce → 固定文件范围 snapshot → 必要时 commit → 正常 push（禁 force）
 * → 远端 SHA 核验」，不独立 terminate 绕过 checkpoint。三条事实纪律：
 * 1. operationId 幂等：重放复用结果，不重做 commit、不产生第二个保存事实（01 §8）；
 * 2. 无变更不建空 WIP 提交，结果带 `hadNewCommits=false`（additive 缺席不推断）；
 * 3. `status=saved` 必须有 `ls-remote` 确认的 remoteSha，push 结果未知按远端对账。
 */
import type { CheckpointRequestFrame } from "@zcode/shared";
import type { CheckpointPort, ExecutionClock, ExecutionLogger } from "./ports.js";
import type { SandboxGit } from "./sandboxGit.js";

export interface QuiescePort {
  /**
   * 投递屏障 + 工作区收口：阻止新 admission，收口 terminal/后台 shell/子 Agent/工具子进程
   * 写入，返回 writer lease。无法 quiesce 时不承诺一致 snapshot（01 §8）。
   */
  quiesce(input: {
    runId: string;
    runGeneration: number;
    operationId: string;
  }): Promise<{ ok: true } | { ok: false; code: string; message: string }>;
  /** checkpoint 结束后释放 writer lease，让新投递恢复（停止通路不释放）。 */
  release(input: { runId: string; operationId: string }): Promise<void>;
}

export interface CheckpointOptions {
  git: SandboxGit;
  quiesce: QuiescePort;
  /** 当前 checkout 事实（bootstrap 提供；缺席时 checkpoint 明确失败，不猜路径）。 */
  checkout(): { workspacePath: string; taskBranch: string } | null;
  logger: ExecutionLogger;
  clock: ExecutionClock;
  commitMessage?(request: CheckpointRequestFrame): string;
}

export function createCheckpoint(options: CheckpointOptions): CheckpointPort {
  /** operationId → 结果；重放直接复用，不重做 commit、不伪造 saved（01 §8）。 */
  const results = new Map<string, Awaited<ReturnType<CheckpointPort["run"]>>>();

  async function execute(request: CheckpointRequestFrame) {
    const target = options.checkout();
    if (!target) {
      return {
        operationId: request.operationId,
        status: "failed" as const,
        errorCode: "not_ready",
        error: "no checkout facts: bootstrap has not produced a workspace",
      };
    }

    // 1. 投递屏障 + 工作区收口（08 §8.1：writer lease 由 supervisor 独占）。
    const quiesced = await options.quiesce.quiesce({
      runId: request.runId,
      runGeneration: request.runGeneration,
      operationId: request.operationId,
    });
    if (!quiesced.ok) {
      return {
        operationId: request.operationId,
        status: "failed" as const,
        branch: target.taskBranch,
        errorCode: quiesced.code,
        error: quiesced.message,
      };
    }

    try {
      // 2. 固定文件范围 snapshot：tracked + non-ignored untracked，无变更不建空提交。
      const message =
        options.commitMessage?.(request) ?? `checkpoint ${request.operationId.slice(0, 8)}`;
      const commit = await options.git.commitWorktree({ cwd: target.workspacePath, message });
      if (!commit.ok) {
        return {
          operationId: request.operationId,
          status: "failed" as const,
          branch: target.taskBranch,
          hadNewCommits: false,
          errorCode: commit.code,
          error: commit.message,
        };
      }

      // 3. push + 远端 SHA 核验（禁止 force；push 丢响应按远端对账）。
      const pushed = await options.git.pushAndVerify({
        cwd: target.workspacePath,
        taskBranch: target.taskBranch,
      });
      if (!pushed.ok) {
        return {
          operationId: request.operationId,
          status: pushed.code === "non_fast_forward" ? ("failed" as const) : ("unknown" as const),
          branch: target.taskBranch,
          hadNewCommits: commit.committed,
          errorCode: pushed.code,
          error: pushed.message,
        };
      }
      return {
        operationId: request.operationId,
        status: "saved" as const,
        branch: target.taskBranch,
        remoteSha: pushed.remoteSha,
        hadNewCommits: commit.committed,
      };
    } finally {
      if (request.purpose === "manual") {
        await options.quiesce.release({ runId: request.runId, operationId: request.operationId });
      }
    }
  }

  return {
    async run(request) {
      const cached = results.get(request.operationId);
      if (cached) {
        options.logger.info(undefined, "checkpoint replay: reusing result", {
          operationId: request.operationId,
          status: cached.status,
        });
        return cached;
      }
      const result = await execute(request);
      results.set(request.operationId, result);
      // 结果表有界：checkpoint 在一个 Run 内条数很少，但仍避免无限增长。
      if (results.size > 64) {
        const oldest = results.keys().next().value;
        if (oldest !== undefined) results.delete(oldest);
      }
      return result;
    },
  };
}

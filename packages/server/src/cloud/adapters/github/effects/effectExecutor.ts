/**
 * GitHubEffect outbox 执行器（specs/cloud-agent/09 §5.2 外部幂等 effect 六条、
 * §5.3 follow-up 与外部修改、§8 错误归一与控制面重启恢复、01 §7.2 撤销尽力语义）。
 *
 * 执行顺序（pull-request）：
 *   1. 按租约向 W1 确认 Task/Run 归属与最新 desiredRevision；
 *   2. expectedHeadSha 与远端 taskBranch 核验（missing/advanced/rewound/diverged 都是冲突）；
 *   3. **先按 head+受控标记查询已有 PR**，再决定是否创建（响应丢失/重试都不重复建）；
 *   4. 写操作结果未知 → ambiguous（必须对账），不写成 failed（03 §5、09 §5.2 第 4 条）。
 *
 * 未启用的能力（check/comment 属 M7）不得伪装成功：明确失败为 not_implemented。
 */
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode } from "@zcode/shared";
import type { CloudAdapterLogger } from "../logging.js";
import { GitHubApiError } from "../http.js";
import type { GitHubBranchService } from "../branches.js";
import type { GitHubPullRequestService } from "../pullRequests.js";
import {
  type GitHubEffectKind,
  type GitHubEffectRecord,
  type GitHubEffectStore,
} from "../../../app/ports/gitHubEffectPort.js";
import { HANDLED_GITHUB_EFFECT_KINDS, EFFECT_RESULT_NO_CHANGES } from "./effectStore.js";

export interface PullRequestEffectTarget {
  repositoryId: number;
  taskId: string;
  taskBranch: string;
  baseBranch: string;
  title: string;
  /** 受控状态段内容；不含 prompt/secret/私有日志（09 §5.2 第 3 条）。 */
  managed: string;
  expectedHeadSha?: string;
}

export type EffectTargetResolution =
  | { ok: true; target: PullRequestEffectTarget }
  | { ok: false; code: CloudErrorCode; message: string; retryable?: boolean };

export type GitHubEffectRunResult =
  | { outcome: "idle" }
  | {
      effectId: string;
      kind: GitHubEffectKind;
      outcome: "settled" | "retried" | "failed" | "ambiguous";
      code?: CloudErrorCode;
      remoteId?: string;
      resultRef?: string;
    };

export interface GitHubEffectExecutor {
  /** 处理至多一个 effect；调用方按节奏循环（不在此处 setInterval）。 */
  runOnce(traceId?: string): Promise<GitHubEffectRunResult>;
  listUnsettled(): Promise<GitHubEffectRecord[]>;
}

const HANDLED_KINDS: readonly GitHubEffectKind[] = HANDLED_GITHUB_EFFECT_KINDS;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;

/** 有界退避：确定性（无抖动）便于验收与复现；上限 1 分钟。 */
export function defaultBackoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** Math.max(0, attempt - 1), 60_000);
}

export function createGitHubEffectExecutor(deps: {
  store: GitHubEffectStore;
  pullRequests: GitHubPullRequestService;
  branches: GitHubBranchService;
  /** W1 注入：Task/Run 归属、desiredRevision 裁决与 step 归属（09 §5.2 第 2 条）。 */
  resolvePullRequestTarget: (effect: GitHubEffectRecord) => Promise<EffectTargetResolution>;
  /** token-revoke 由组合层接 grant broker（01 §7.2 撤销结果持久且可重试）。 */
  revokeGrantToken?: (request: {
    grantId: string;
    traceId?: string;
  }) => Promise<{ settled: boolean; detail: string; retryable?: boolean }>;
  workerId: string;
  leaseMs?: number;
  maxAttempts?: number;
  backoffMs?: (attempt: number) => number;
  now?: () => number;
  logger?: CloudAdapterLogger;
}): GitHubEffectExecutor {
  const now = deps.now ?? Date.now;
  const leaseMs = deps.leaseMs ?? DEFAULT_LEASE_MS;
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoffMs = deps.backoffMs ?? defaultBackoffMs;

  function describe(error: unknown): {
    code: CloudErrorCode;
    message: string;
    retryAfterMs?: number;
  } {
    if (error instanceof GitHubApiError) {
      return { code: error.code, message: error.message, retryAfterMs: error.retryAfterMs };
    }
    return {
      code: "network_unknown",
      message: error instanceof Error ? error.message : "unexpected github effect failure",
    };
  }

  async function settleFailure(
    leased: { effect: GitHubEffectRecord; leaseToken: string },
    error: unknown,
    phase: "read" | "write",
    traceId?: string,
  ): Promise<GitHubEffectRunResult> {
    const { code, message, retryAfterMs } = describe(error);
    const attempt = leased.effect.attempts;
    // 写路径的未知结果必须走对账；读路径的未知结果可以安全重试（03 §5）。
    const ambiguous = phase === "write" && code === "network_unknown";
    const retryable =
      !ambiguous && (code === "rate_limited" || (phase === "read" && code === "network_unknown"));
    if (retryable && attempt < maxAttempts) {
      await deps.store.settle({
        effectId: leased.effect.effectId,
        leaseToken: leased.leaseToken,
        outcome: "retry",
        errorCode: code,
        errorMessage: message,
        nextAttemptAt: now() + (retryAfterMs ?? backoffMs(attempt)),
        now: now(),
      });
      deps.logger?.warn(traceId, "github effect retry scheduled", {
        effectId: leased.effect.effectId,
        kind: leased.effect.kind,
        code,
        attempt,
      });
      return {
        effectId: leased.effect.effectId,
        kind: leased.effect.kind,
        outcome: "retried",
        code,
      };
    }
    if (ambiguous && attempt < maxAttempts) {
      await deps.store.settle({
        effectId: leased.effect.effectId,
        leaseToken: leased.leaseToken,
        outcome: "ambiguous",
        errorCode: code,
        errorMessage: message,
        nextAttemptAt: now() + backoffMs(attempt),
        now: now(),
      });
      deps.logger?.warn(traceId, "github effect result unknown, reconciliation required", {
        effectId: leased.effect.effectId,
        code,
      });
      return {
        effectId: leased.effect.effectId,
        kind: leased.effect.kind,
        outcome: "ambiguous",
        code,
      };
    }
    // 401/403/404 不盲重试、不扩大 scope；attempts 用尽也以明确失败收口（09 §5.2 第 6 条）。
    await deps.store.settle({
      effectId: leased.effect.effectId,
      leaseToken: leased.leaseToken,
      outcome: "failed",
      errorCode: code,
      errorMessage: message,
      now: now(),
    });
    deps.logger?.warn(traceId, "github effect failed", {
      effectId: leased.effect.effectId,
      kind: leased.effect.kind,
      code,
      attempts: attempt,
    });
    return { effectId: leased.effect.effectId, kind: leased.effect.kind, outcome: "failed", code };
  }

  async function handlePullRequest(
    leased: { effect: GitHubEffectRecord; leaseToken: string },
    traceId?: string,
  ): Promise<GitHubEffectRunResult> {
    const resolution = await deps.resolvePullRequestTarget(leased.effect);
    if (!resolution.ok) {
      const retryable = resolution.retryable ?? CLOUD_ERROR_RETRYABLE[resolution.code];
      return settleFailure(
        leased,
        new GitHubApiError({
          code: resolution.code,
          retryable,
          message: resolution.message,
        }),
        retryable ? "read" : "write",
        traceId,
      );
    }
    const target = resolution.target;

    if (target.expectedHeadSha) {
      const verification = await deps.branches.verifyTaskBranch({
        repositoryId: target.repositoryId,
        branch: target.taskBranch,
        expectedSha: target.expectedHeadSha,
        traceId,
      });
      if (verification.relation !== "identical") {
        const code: CloudErrorCode =
          verification.relation === "rewound" || verification.relation === "diverged"
            ? "non_fast_forward"
            : "branch_conflict";
        // 外部 push/改写一律暂停发布并保留 workspace，不 force、不自动恢复（09 §4.1/§5.3）。
        return settleFailure(
          leased,
          new GitHubApiError({
            code,
            retryable: false,
            message: `task branch ${target.taskBranch} diverged: ${verification.relation}`,
          }),
          "write",
          traceId,
        );
      }
    }

    try {
      // 先查询再创建：这一步同时承担「创建响应丢失」的对账（09 §5.2 第 4 条）。
      const existing = await deps.pullRequests.findTaskPullRequest({
        repositoryId: target.repositoryId,
        taskId: target.taskId,
        head: target.taskBranch,
        base: target.baseBranch,
        traceId,
      });
      if (existing) {
        await deps.store.settle({
          effectId: leased.effect.effectId,
          leaseToken: leased.leaseToken,
          outcome: "settled",
          remoteId: String(existing.prNumber),
          resultRef: existing.status,
          now: now(),
        });
        return {
          effectId: leased.effect.effectId,
          kind: leased.effect.kind,
          outcome: "settled",
          remoteId: String(existing.prNumber),
          resultRef: existing.status,
        };
      }
      const created = await deps.pullRequests.createDraftPullRequest({
        repositoryId: target.repositoryId,
        taskId: target.taskId,
        head: target.taskBranch,
        base: target.baseBranch,
        title: target.title,
        managed: target.managed,
        traceId,
      });
      if (created.kind === "no-changes") {
        // 无差异不是失败：结束为 noChanges，不建空 PR、不造空 commit（09 §5.1）。
        await deps.store.settle({
          effectId: leased.effect.effectId,
          leaseToken: leased.leaseToken,
          outcome: "settled",
          resultRef: EFFECT_RESULT_NO_CHANGES,
          now: now(),
        });
        return {
          effectId: leased.effect.effectId,
          kind: leased.effect.kind,
          outcome: "settled",
          resultRef: EFFECT_RESULT_NO_CHANGES,
        };
      }
      await deps.store.settle({
        effectId: leased.effect.effectId,
        leaseToken: leased.leaseToken,
        outcome: "settled",
        remoteId: String(created.pullRequest.prNumber),
        resultRef: created.kind,
        now: now(),
      });
      return {
        effectId: leased.effect.effectId,
        kind: leased.effect.kind,
        outcome: "settled",
        remoteId: String(created.pullRequest.prNumber),
        resultRef: created.kind,
      };
    } catch (error) {
      return settleFailure(leased, error, "write", traceId);
    }
  }

  async function handleTokenRevoke(
    leased: { effect: GitHubEffectRecord; leaseToken: string },
    traceId?: string,
  ): Promise<GitHubEffectRunResult> {
    const grantId = leased.effect.payloadRef;
    if (!grantId || !deps.revokeGrantToken) {
      return settleFailure(
        leased,
        new GitHubApiError({
          code: "not_implemented",
          retryable: false,
          message: "token revoke effect requires a grant broker and payloadRef",
        }),
        "read",
        traceId,
      );
    }
    try {
      const result = await deps.revokeGrantToken({ grantId, traceId });
      if (!result.settled) {
        if (result.retryable) {
          return settleFailure(
            leased,
            new GitHubApiError({
              code: "network_unknown",
              retryable: true,
              message: result.detail,
            }),
            "read",
            traceId,
          );
        }
        // 无法撤销（例如 broker 已不持有该 token）：如实记录事实，等待最晚到期或
        // 确认沙箱死亡，不伪造撤销完成（01 §7.2）。
        return settleFailure(
          leased,
          new GitHubApiError({
            code: "permission_revoked",
            retryable: false,
            message: result.detail,
          }),
          "read",
          traceId,
        );
      }
      await deps.store.settle({
        effectId: leased.effect.effectId,
        leaseToken: leased.leaseToken,
        outcome: "settled",
        resultRef: result.detail,
        now: now(),
      });
      return {
        effectId: leased.effect.effectId,
        kind: leased.effect.kind,
        outcome: "settled",
        resultRef: result.detail,
      };
    } catch (error) {
      return settleFailure(leased, error, "read", traceId);
    }
  }

  return {
    async runOnce(traceId) {
      const leased = await deps.store.leaseNext({
        kinds: HANDLED_KINDS,
        workerId: deps.workerId,
        leaseMs,
        now: now(),
      });
      if (!leased) return { outcome: "idle" };
      switch (leased.effect.kind) {
        case "pull-request":
          return handlePullRequest(leased, traceId);
        case "token-revoke":
          return handleTokenRevoke(leased, traceId);
        default:
          // check/comment 是 M7 条件性范围（09 §3 矩阵、00 §11 决议⑤）：不实现、不伪装成功。
          return settleFailure(
            leased,
            new GitHubApiError({
              code: "not_implemented",
              retryable: false,
              message: `${leased.effect.kind} effects are M7-conditional and not enabled`,
            }),
            "read",
            traceId,
          );
      }
    },

    listUnsettled: () => deps.store.listUnsettled(),
  };
}

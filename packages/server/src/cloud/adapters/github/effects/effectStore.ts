/**
 * GitHubEffect outbox 的适配边界与入队适配（specs/cloud-agent 09 §5.2/§8、08 §8.2）。
 *
 * 归属（W0 冻结）：
 * - **类型**唯一来源是 `app/ports/gitHubEffectPort.ts`（`GitHubEffectStore`/`GitHubEffectRecord`/
 *   `GitHubEffectKind`/`LeasedGitHubEffect`/`GitHubEffectSettleOutcome` 与业务键 helper）；
 * - **实现**由 W2 落 `external_operations` 的 GitHub 分面；
 * - **能力**（幂等键、expectedHeadSha、对账、有界重试）在 `effectExecutor.ts`。
 *
 * 本文件只做两件适配：
 * 1. 端口级描述符（`EnqueueGitHubEffectRequest`）→ store 入队形状（effectId/businessKey）；
 * 2. 幂等键前缀 `publish-pr:`（08 §8.2）与 effect 业务键 `ensure-draft-pr:`（ports 的
 *    `draftPullRequestBusinessKey`，09 §5.2 第 1 条）双轨并存——W0 决定不改名。
 */
import { randomUUID } from "node:crypto";
import type {
  EnqueueGitHubEffectRequest,
  EnqueuedGitHubEffect,
} from "../../../app/ports/gitHubPort.js";
import {
  draftPullRequestBusinessKey,
  type GitHubEffectEnqueueRequest,
  type GitHubEffectKind,
  type GitHubEffectRecord,
  type GitHubEffectStatus,
  type GitHubEffectStore,
  type LeasedGitHubEffect,
} from "../../../app/ports/gitHubEffectPort.js";
import { GitHubApiError } from "../http.js";

export type {
  GitHubEffectEnqueueRequest,
  GitHubEffectKind,
  GitHubEffectRecord,
  GitHubEffectSettleOutcome,
  GitHubEffectStatus,
  GitHubEffectStore,
  LeasedGitHubEffect,
} from "../../../app/ports/gitHubEffectPort.js";
export { draftPullRequestBusinessKey };

/** 08 §8.2 的发布幂等键前缀：`publish-pr:<runId>:<checkpointId>`（仅端口发布用，不改名）。 */
export const PUBLISH_PR_IDEMPOTENCY_PREFIX = "publish-pr:";

function invalid(message: string): GitHubApiError {
  return new GitHubApiError({ code: "validation_failed", retryable: false, message });
}

/**
 * 业务键（唯一约束）：同 key 的重复入队返回既有 effect，不产生第二个 worker 目标
 * （09 §5.2 第 1 条）。缺字段是调用方错误，直接拒绝而不是拼一个含糊的键。
 */
export function effectBusinessKey(request: EnqueueGitHubEffectRequest): string {
  const { kind, repositoryId, taskId, taskBranch, runId, payloadRef } = request;
  switch (kind) {
    case "pull-request": {
      if (!taskId || !taskBranch) {
        throw invalid("pull-request effect requires taskId and taskBranch");
      }
      return draftPullRequestBusinessKey({ repositoryId, taskId, taskBranch });
    }
    case "check": {
      if (!taskId || !runId) throw invalid("check effect requires taskId and runId");
      return `check-run:${repositoryId}:${taskId}:${runId}`;
    }
    case "comment": {
      if (!taskId || !payloadRef) throw invalid("comment effect requires taskId and payloadRef");
      return `comment:${repositoryId}:${taskId}:${payloadRef}`;
    }
    case "token-revoke": {
      if (!payloadRef) throw invalid("token-revoke effect requires payloadRef");
      return `token-revoke:${payloadRef}`;
    }
  }
}

export interface GitHubEffectEnqueuer {
  /** 端口级描述符 → 持久 effect；同业务键幂等（返回既有 effectId）。 */
  enqueue(request: EnqueueGitHubEffectRequest): Promise<EnqueuedGitHubEffect>;
}

export function createGitHubEffectEnqueuer(deps: {
  store: GitHubEffectStore;
  now?: () => number;
  newEffectId?: () => string;
}): GitHubEffectEnqueuer {
  const now = deps.now ?? Date.now;
  const newEffectId = deps.newEffectId ?? randomUUID;

  return {
    async enqueue(request) {
      const businessKey = effectBusinessKey(request);
      const storeRequest: GitHubEffectEnqueueRequest = {
        effectId: newEffectId(),
        kind: request.kind,
        businessKey,
        taskId: request.taskId,
        runId: request.runId,
        runGeneration: request.runGeneration,
        repositoryId: request.repositoryId,
        taskBranch: request.taskBranch,
        baseBranch: request.baseBranch,
        desiredRevision: request.desiredRevision,
        expectedHeadSha: request.expectedHeadSha,
        payloadRef: request.payloadRef,
        now: now(),
      };
      const { effect } = await deps.store.enqueue(storeRequest);
      // 幂等命中时返回既有 effectId：调用方能据此对账，而不是以为新建了一次。
      return { effectId: effect.effectId, businessKey: effect.businessKey };
    },
  };
}

/** 供装配层复用的 kind 清单（执行器与 W2 的 leaseNext 必须一致）。 */
export const HANDLED_GITHUB_EFFECT_KINDS: readonly GitHubEffectKind[] = [
  "pull-request",
  "check",
  "comment",
  "token-revoke",
];

/** 结果事实常量：no-changes 是结论而不是失败（09 §5.1）。 */
export const EFFECT_RESULT_NO_CHANGES = "no-changes";

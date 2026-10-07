/**
 * GitHubEffect outbox 端口（specs/cloud-agent 09 §5.2 外部幂等 effect、§8 `GitHubEffect`
 * 行、03 §5 外部操作不是数据库事务）。单一来源：W4 的执行器消费，W2 落 `external_operations`
 * 的 GitHub 分面。
 *
 * 不变量：
 * - `enqueue` 以 businessKey 唯一：同 key 重复入队返回既有记录，不产生第二个 worker 目标；
 * - `leaseNext` 只返回 pending/ambiguous 或已到期 leased、且 `nextAttemptAt <= now` 的记录，
 *   同一 effect 不会有两个有效租约；`settle` 必须校验 leaseToken（迟到结果只用于对账）；
 * - secret 不进 payload：`payloadRef` 只是受控引用。
 */
import type { CloudErrorCode } from "@zcode/shared";

export type GitHubEffectKind = "pull-request" | "check" | "comment" | "token-revoke";

export type GitHubEffectStatus = "pending" | "leased" | "settled" | "failed" | "ambiguous";

export interface GitHubEffectRecord {
  effectId: string;
  /** 业务键唯一：`repositoryId+taskId+taskBranch`（09 §5.2 第 1 条）。 */
  businessKey: string;
  kind: GitHubEffectKind;
  taskId?: string;
  runId?: string;
  runGeneration?: number;
  repositoryId?: number;
  taskBranch?: string;
  baseBranch?: string;
  /** 期望版本：worker 必须确认自己仍在处理最新 desiredRevision（09 §5.2 第 2 条）。 */
  desiredRevision: number;
  /** 发布前置核验的远端 SHA；漂移即冲突，不覆盖（09 §5.3）。 */
  expectedHeadSha?: string;
  /** 受控 payload 引用；secret 不进 payload（09 §5.2 首段）。 */
  payloadRef?: string;
  status: GitHubEffectStatus;
  attempts: number;
  nextAttemptAt: number;
  leaseToken?: string;
  leaseExpiresAt?: number;
  /** GitHub 侧对象 id（PR 号等），用于对账而不是授权。 */
  remoteId?: string;
  /** 结果事实（`no-changes`、`token-not-held` 等）；不含 secret。 */
  resultRef?: string;
  lastErrorCode?: CloudErrorCode;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface GitHubEffectEnqueueRequest {
  effectId: string;
  kind: GitHubEffectKind;
  businessKey: string;
  taskId?: string;
  runId?: string;
  runGeneration?: number;
  repositoryId?: number;
  taskBranch?: string;
  baseBranch?: string;
  desiredRevision: number;
  expectedHeadSha?: string;
  payloadRef?: string;
  now: number;
}

export interface LeasedGitHubEffect {
  effect: GitHubEffectRecord;
  leaseToken: string;
  leaseExpiresAt: number;
}

export type GitHubEffectSettleOutcome = "settled" | "ambiguous" | "failed" | "retry";

export interface GitHubEffectStore {
  enqueue(
    request: GitHubEffectEnqueueRequest,
  ): Promise<{ effect: GitHubEffectRecord; created: boolean }>;
  get(effectId: string): Promise<GitHubEffectRecord | null>;
  /** 领取：pending/ambiguous 或租约到期的记录，且 `nextAttemptAt <= now`。 */
  leaseNext(request: {
    kinds: readonly GitHubEffectKind[];
    workerId: string;
    leaseMs: number;
    now: number;
  }): Promise<LeasedGitHubEffect | null>;
  /** 结算 CAS：leaseToken 不匹配返回 false（迟到 worker 不得改写结果）。 */
  settle(request: {
    effectId: string;
    leaseToken: string;
    outcome: GitHubEffectSettleOutcome;
    remoteId?: string;
    resultRef?: string;
    errorCode?: CloudErrorCode;
    errorMessage?: string;
    nextAttemptAt?: number;
    now: number;
  }): Promise<boolean>;
  /** 启动恢复扫描（09 §8 末段：控制面重启恢复未完成 effect）。 */
  listUnsettled(): Promise<GitHubEffectRecord[]>;
}

/** ensureDraftPr 的业务键：同 Task/分支只允许一个发布 effect（09 §5.2 第 1 条）。 */
export function draftPullRequestBusinessKey(request: {
  repositoryId: number;
  taskId: string;
  taskBranch: string;
}): string {
  return `ensure-draft-pr:${request.repositoryId}:${request.taskId}:${request.taskBranch}`;
}

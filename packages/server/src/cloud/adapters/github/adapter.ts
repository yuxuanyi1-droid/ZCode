/**
 * GitHub adapter 组合（specs/cloud-agent/W4 §4「对 W1：GitHubPort」、09 §2.2/§3 权限、
 * §5.2/§5.3 发布与漂移、08 §8.2 publish-pr）。
 *
 * 组合职责：
 * - 把 transport / appAuth / tokens / catalog / branches / pullRequests 装配成 frozen
 *   `GitHubPort`（W0 冻结，W1 只依赖端口类型）。
 * - `publishDraftPullRequest` 与 effect 执行器共用同一套「先查后建、no-changes 不建空
 *   PR」实现，不保留第二条独立创建逻辑（09 §5.2 末段）；`no-changes` 是正常结论，走
 *   返回值而不是异常（端口判别联合）。
 * - `enqueueEffect` 只接受端口级描述符，effectId/businessKey 由 outbox 适配生成；
 *   未装配 W2 的 store 时返回 not_implemented，不静默丢弃副作用。
 */
import { createServiceLogger } from "@zcode/services/node";
import type {
  BranchHead,
  EnqueueGitHubEffectRequest,
  EnqueuedGitHubEffect,
  GitHubPort,
  MintedToken,
  MintTokenRequest,
  PublishDraftPullRequestResult,
  PullRequestProjection,
  RepositoryRef,
} from "../../app/ports/gitHubPort.js";
import type { GitHubEffectRecord, GitHubEffectStore } from "../../app/ports/gitHubEffectPort.js";
import type { CloudAdapterLogger } from "./logging.js";
import { GitHubApiError, createGitHubTransport, type GitHubTransport } from "./http.js";
import { createGitHubAppAuth } from "./appAuth.js";
import {
  createGitHubTokenService,
  type GitHubTokenPurpose,
  type GitHubTokenService,
} from "./tokens.js";
import { createGitHubRepositoryCatalog, type GitHubRepositoryCatalog } from "./repositories.js";
import { createGitHubBranchService, type GitHubBranchService } from "./branches.js";
import { createGitHubPullRequestService, type GitHubPullRequestService } from "./pullRequests.js";
import { createGitHubEffectEnqueuer, type GitHubEffectEnqueuer } from "./effects/effectStore.js";
import {
  createGitHubEffectExecutor,
  type EffectTargetResolution,
  type GitHubEffectExecutor,
} from "./effects/effectExecutor.js";

export interface GitHubAdapterConfig {
  principalId: string;
  appId: number;
  privateKeyPem: string;
  apiBaseUrl?: string;
  allowedInstallationIds: readonly number[];
  allowedRepositoryIds?: readonly number[];
  cacheTtlMs?: number;
}

export interface GitHubAdapter {
  /** W1 消费的冻结端口。 */
  readonly port: GitHubPort;
  readonly catalog: GitHubRepositoryCatalog;
  readonly branches: GitHubBranchService;
  readonly pullRequests: GitHubPullRequestService;
  readonly tokens: GitHubTokenService;
  /** 需要 W1 注入 Task 归属/desiredRevision 裁决后才有意义（09 §5.2 第 2 条）。 */
  createEffectExecutor(options: {
    store: GitHubEffectStore;
    resolvePullRequestTarget: (effect: GitHubEffectRecord) => Promise<EffectTargetResolution>;
    revokeGrantToken?: (request: {
      grantId: string;
      traceId?: string;
    }) => Promise<{ settled: boolean; detail: string; retryable?: boolean }>;
    workerId: string;
    /** 有界重试与租约参数：默认 60s 租约、5 次尝试、指数退避（09 §5.2 第 6 条）。 */
    leaseMs?: number;
    maxAttempts?: number;
    backoffMs?: (attempt: number) => number;
  }): GitHubEffectExecutor;
}

export function createGitHubAdapter(deps: {
  config: GitHubAdapterConfig;
  transport?: GitHubTransport;
  effectStore?: GitHubEffectStore;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  logger?: CloudAdapterLogger;
}): GitHubAdapter {
  const logger = deps.logger ?? createServiceLogger("cloud-github");
  const transport =
    deps.transport ??
    createGitHubTransport({
      apiBaseUrl: deps.config.apiBaseUrl,
      fetchImpl: deps.fetchImpl,
      logger,
    });
  const appAuth = createGitHubAppAuth({
    transport,
    credentials: { appId: deps.config.appId, privateKeyPem: deps.config.privateKeyPem },
    now: deps.now,
    logger,
  });
  const tokens = createGitHubTokenService({
    transport,
    appJwt: (traceId) => appAuth.jwt(traceId),
    now: deps.now,
    logger,
  });
  const catalog = createGitHubRepositoryCatalog({
    transport,
    appAuth,
    tokens,
    config: {
      principalId: deps.config.principalId,
      allowedInstallationIds: deps.config.allowedInstallationIds,
      allowedRepositoryIds: deps.config.allowedRepositoryIds,
      cacheTtlMs: deps.config.cacheTtlMs,
    },
    now: deps.now,
    logger,
  });
  const branches = createGitHubBranchService({ transport, catalog, logger });
  const pullRequests = createGitHubPullRequestService({
    transport,
    catalog,
    now: deps.now,
    logger,
  });
  // outbox 入队适配：W2 的 store 未装配时为 null，端口返回 not_implemented（不静默丢弃）。
  const enqueuer: GitHubEffectEnqueuer | null = deps.effectStore
    ? createGitHubEffectEnqueuer({ store: deps.effectStore, now: deps.now })
    : null;

  const port: GitHubPort = {
    listRepositories: (request) => catalog.listRepositories(request),

    async getRepository(repositoryId): Promise<RepositoryRef | null> {
      try {
        const facts = await catalog.locate(repositoryId);
        return facts ?? null;
      } catch (error) {
        // 端口语义：网络未知不应伪装成「仓库不存在」（09 §2.2）。
        if (error instanceof GitHubApiError && error.code === "unauthorized") return null;
        throw error;
      }
    },

    getBranchHead: (request): Promise<BranchHead | null> => branches.getBranchHead(request),

    mintToken: (request: MintTokenRequest): Promise<MintedToken> =>
      catalog.mintForPurpose({
        repositoryId: request.repositoryId,
        installationId: request.installationId,
        // 端口的 purpose 枚举与权限矩阵同源（09 §3），不需要映射表或兜底默认值。
        purpose: request.purpose satisfies GitHubTokenPurpose,
      }),

    getPullRequest: (request): Promise<PullRequestProjection | null> =>
      pullRequests.getPullRequest(request),

    async publishDraftPullRequest(request): Promise<PublishDraftPullRequestResult> {
      // base/head 用冻结值；installationId 必须与权威事实一致，否则视为需重新授权
      // （09 §2.1：repo rename/transfer 后 installation 变了不能无声沿用）。
      catalog.assertAuthorized({
        repositoryId: request.repositoryId,
        installationId: request.installationId,
      });
      const facts = await catalog.locate(request.repositoryId);
      if (!facts) {
        throw new GitHubApiError({
          code: "repo_not_found",
          retryable: false,
          message: "repository is not accessible through this app",
        });
      }
      if (facts.installationId !== request.installationId) {
        throw new GitHubApiError({
          code: "installation_revoked",
          retryable: false,
          message: "repository is no longer served by the expected installation",
        });
      }
      // expectedHeadSha 门：远端 taskBranch 必须仍是我们确认过的 SHA，漂移返回冲突而不是
      // 覆盖（09 §5.3：外部 push/改写一律暂停发布）。
      const verification = await branches.verifyTaskBranch({
        repositoryId: request.repositoryId,
        branch: request.head,
        expectedSha: request.expectedHeadSha,
        traceId: request.idempotencyKey,
      });
      if (verification.relation !== "identical") {
        throw new GitHubApiError({
          code:
            verification.relation === "rewound" || verification.relation === "diverged"
              ? "non_fast_forward"
              : "branch_conflict",
          retryable: false,
          message: `task branch ${request.head} diverged: ${verification.relation}`,
        });
      }
      const existing = await pullRequests.findTaskPullRequest({
        repositoryId: request.repositoryId,
        taskId: request.taskId,
        head: request.head,
        base: request.base,
        traceId: request.idempotencyKey,
      });
      if (existing) return { status: "published", pullRequest: existing };
      const created = await pullRequests.createDraftPullRequest({
        repositoryId: request.repositoryId,
        taskId: request.taskId,
        head: request.head,
        base: request.base,
        title: request.title,
        // 端口没有受控段参数：保留调用方给的 body 作为受控段内容（不含 secret）。
        managed: request.body ?? "",
        traceId: request.idempotencyKey,
      });
      // no-changes 是正常结论（09 §5.1）：不建空 PR、不造空 commit，也不当异常抛。
      if (created.kind === "no-changes") return { status: "no-changes" };
      return { status: "published", pullRequest: created.pullRequest };
    },

    async enqueueEffect(request: EnqueueGitHubEffectRequest): Promise<EnqueuedGitHubEffect> {
      if (!enqueuer) {
        // 没有 W2 的持久 outbox 就不能「接单」：宁可不实现，也不在用内存里假装持久。
        throw new GitHubApiError({
          code: "not_implemented",
          retryable: false,
          message: "github effect outbox requires the W2 effect store",
        });
      }
      // 端口级描述符 → store 记录（effectId/businessKey 由适配生成，调用方不构造）。
      return enqueuer.enqueue(request);
    },
  };

  return {
    port,
    catalog,
    branches,
    pullRequests,
    tokens,
    createEffectExecutor: (options) =>
      createGitHubEffectExecutor({
        store: options.store,
        pullRequests,
        branches,
        resolvePullRequestTarget: options.resolvePullRequestTarget,
        revokeGrantToken: options.revokeGrantToken,
        workerId: options.workerId,
        leaseMs: options.leaseMs,
        maxAttempts: options.maxAttempts,
        backoffMs: options.backoffMs,
        now: deps.now,
        logger,
      }),
  };
}

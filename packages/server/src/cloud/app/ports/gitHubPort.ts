/**
 * GitHub 端口草案（specs/cloud-agent 09 §2.2 installation 与 Project、§5.2/§5.3 发布与
 * 漂移、§8 错误归一、01 §7.2 git grant、03 §6 端点）。W4 实现。
 *
 * 边界：
 * - App 私钥、JWT、installation token 只在云服务端；不进沙箱、浏览器或日志（09 §8）。
 * - 客户端提交的 owner/name/installationId 不能自证权限：仓库身份由本端口按
 *   repositoryId 取权威事实（11 §4.3）。
 * - 外部 API 错误按 permission_revoked/repo_not_found/branch_conflict/rate_limited/
 *   network_unknown/validation_failed 归一；raw 404 不区分无权限时不得泄漏私有仓库
 *   存在性（09 §8）。
 * - contents:write 是 repo 级权限：产品路径只推 taskBranch，公开部署前需写代理或
 *   等效 ref 保护（01 §7.2，条件性基线）。
 */
import type { CloudErrorCode } from "@zcode/shared";
import type { GitHubEffectKind } from "./gitHubEffectPort.js";

export interface RepositoryRef {
  repositoryId: number;
  installationId: number;
  owner: string;
  name: string;
  defaultBranch?: string;
  /** 授权投影状态：网络/5xx 不可用是 stale/unknown，不等于仓库已删除（09 §2.2）。 */
  availability: "available" | "stale" | "unavailable";
  lastCheckedAt?: number;
}

export interface BranchHead {
  name: string;
  sha: string;
  /** false 表示分支不存在：重开前必须显式对账，不默认 clone base 分支（08 §9）。 */
  exists: boolean;
}

export interface MintTokenRequest {
  repositoryId: number;
  installationId: number;
  /**
   * 按用途取最小权限矩阵（09 §2/§8）：clone/fetch=contents:read，push=contents:write。
   * 只读 CI 用途（checks:read / statuses:read）属 09 §3 标注的 M4 可选，本次不实现。
   */
  purpose: "clone" | "fetch" | "push" | "pull-request" | "checks";
}

export interface MintedToken {
  token: string;
  expiresAt: number;
  permissions: readonly string[];
}

export interface PullRequestProjection {
  repositoryId: number;
  prNumber: number;
  prUrl: string;
  head: string;
  base: string;
  status: "draft" | "open" | "merged" | "closed";
  publishedSha?: string;
  lastCheckedAt?: number;
}

/**
 * 发布结论：`no-changes` 是**正常结论**而不是异常（09 §5.2）——无差异时不建空提交、
 * 不建空 PR，控制面把产物记成 noChanges（08 §9）。调用方必须处理两个分支。
 */
export type PublishDraftPullRequestResult =
  | { status: "published"; pullRequest: PullRequestProjection }
  | { status: "no-changes" };

/** 入队 effect 的端口级描述符：调用方不构造 store 内部形状（含 effectId/businessKey）。 */
export interface EnqueueGitHubEffectRequest {
  kind: GitHubEffectKind;
  repositoryId: number;
  /** pull-request/check 类必须给出：发布与漂移核验都按任务分支（09 §5.2/§5.3）。 */
  taskBranch?: string;
  baseBranch?: string;
  /** 期望版本：worker 必须确认自己仍处理最新 desiredRevision（09 §5.2 第 2 条）。 */
  desiredRevision: number;
  /** 发布前置核验的远端 SHA；漂移即冲突，不覆盖（09 §5.3）。 */
  expectedHeadSha?: string;
  /** 受控 payload 引用；secret 不进 payload（09 §5.2）。 */
  payloadRef?: string;
  taskId?: string;
  runId?: string;
  runGeneration?: number;
}

export interface EnqueuedGitHubEffect {
  effectId: string;
  businessKey: string;
}

export interface GitHubPort {
  listRepositories(request: {
    principalId: string;
    cursor?: string;
    limit: number;
    query?: string;
  }): Promise<{ items: RepositoryRef[]; nextCursor?: string }>;
  /** 权威 owner/name/defaultBranch；请求展示信息不能覆盖仓库身份（11 §4.3）。 */
  getRepository(repositoryId: number): Promise<RepositoryRef | null>;
  getBranchHead(request: { repositoryId: number; branch: string }): Promise<BranchHead | null>;
  mintToken(request: MintTokenRequest): Promise<MintedToken>;
  /** PR 读取用于对账（创建响应丢失时按 head/base 查询，不重复建 PR）。 */
  getPullRequest(request: {
    repositoryId: number;
    prNumber: number;
  }): Promise<PullRequestProjection | null>;
  /**
   * 发布 draft PR：幂等键 `publish-pr:<runId>:<checkpointId>`（08 §8.2），
   * base/head 使用冻结的 baseBranch/taskBranch；重复请求返回既有 PR。
   * `expectedHeadSha` 是发布前核验的远端 SHA，漂移返回 `branch_conflict` 而不是覆盖。
   * no-changes（含 remoteSha 停在 baseSha 的情形）返回 `{status:"no-changes"}`——是结论
   * 不是异常；无差异不建空 PR（08 §9）。
   */
  publishDraftPullRequest(request: {
    idempotencyKey: string;
    taskId: string;
    runId: string;
    repositoryId: number;
    installationId: number;
    base: string;
    head: string;
    expectedHeadSha: string;
    title: string;
    body?: string;
  }): Promise<PublishDraftPullRequestResult>;
  /**
   * 副作用 outbox 入队（业务键唯一、可重试、可对账，09 §8）。入参是端口级描述符：
   * 调用方不构造 effectId/businessKey 等 store 内部形状（W4 CR-2）。
   */
  enqueueEffect(request: EnqueueGitHubEffectRequest): Promise<EnqueuedGitHubEffect>;
}

/** 归一错误：adapter 返回该结构，调用方不得解析 provider 原始文案（01 §9）。 */
export interface GitHubErrorFacts {
  code: CloudErrorCode;
  retryable: boolean;
  /** 只记状态码/请求 id 等脱敏事实，不含 token 或私有仓库内容。 */
  status?: number;
  requestId?: string;
}

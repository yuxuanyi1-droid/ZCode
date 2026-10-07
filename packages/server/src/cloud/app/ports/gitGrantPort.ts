/**
 * git grant 持久端口（specs/cloud-agent 01 §7.1/§7.2、03 §4 `git_grants` 表、09 §4）。
 * 单一来源：W4 的 broker 消费，W2 落表实现（迁移 0003）。
 *
 * 不变量：
 * - 唯一键 `grantId`；`claimRedemption` 是 CAS，只允许成功兑换一次（单次兑换）；
 * - 过期、run 撤销后不可兑换；
 * - **raw token 不进入本端口任何参数，也不持久**：只存 hash 与生命周期元数据
 *   （01 §7.2「仅持久 grantId/purpose/issuedAt/expiresAt 等元数据，不持久 raw token」）；
 * - 权限矩阵由 `purpose` 经 `GIT_GRANT_SCOPE` 派生（read=contents:read，write=contents:write），
 *   不单独存 permissions 字段，避免与 purpose 两处漂移。
 */
import type { CloudErrorCode } from "@zcode/shared";

/**
 * grant 用途与兑换窗口的**规范定义**在端口层（ports 是模块最底层，不得反向依赖 `app/`）：
 * 调用方与 `app/credentialAuthorization` 都从这里引用，不再各自定义一份。
 */
export type GitGrantPurpose = "clone" | "fetch" | "push";

/** 单次兑换窗口：默认 60s（01 §7.2）。 */
export const GIT_GRANT_TTL_MS = 60_000;

export type GitGrantStatus = "issued" | "redeemed" | "revoked";

export interface GitGrantRecord {
  grantId: string;
  taskId: string;
  runId: string;
  runGeneration: number;
  repositoryId: number;
  installationId: number;
  purpose: GitGrantPurpose;
  status: GitGrantStatus;
  issuedAt: number;
  expiresAt: number;
  /** 可选凭据绑定：只持久摘要，不持久凭据本身（01 §7.2）。 */
  proofHash?: string;
  redeemedAt?: number;
  revokedAt?: number;
  tokenIssuedAt?: number;
  tokenExpiresAt?: number;
  lastErrorCode?: CloudErrorCode;
  revokeOutcome?: { revoked: boolean; reason: string; at: number };
}

export interface GitGrantStore {
  insert(record: GitGrantRecord): Promise<void>;
  get(grantId: string): Promise<GitGrantRecord | null>;
  /**
   * 端点形状为 `GET /api/cloud/runs/:runId/git-grant`（无 grantId 参数），因此兑换入口按
   * (runId, purpose) 取「当前」记录（issuedAt 最新的一条）；状态判定与单次兑换 CAS 都在
   * broker 内完成。
   */
  findCurrentForRun(request: {
    runId: string;
    purpose: GitGrantPurpose;
    now: number;
  }): Promise<GitGrantRecord | null>;
  /** 单次兑换 CAS：仅 `issued` 且未过期、且绑定字段匹配时置为 `redeemed`。 */
  claimRedemption(request: {
    grantId: string;
    taskId: string;
    runId: string;
    runGeneration: number;
    now: number;
  }): Promise<GitGrantRecord | null>;
  /** 只写 token 生命周期元数据，不写 token 本身。 */
  recordIssuedToken(request: {
    grantId: string;
    tokenIssuedAt: number;
    tokenExpiresAt: number;
  }): Promise<void>;
  recordFailure(request: {
    grantId: string;
    code: CloudErrorCode;
    message: string;
    now: number;
  }): Promise<void>;
  recordRevokeOutcome(request: {
    grantId: string;
    revoked: boolean;
    reason: string;
    now: number;
  }): Promise<void>;
  listByRun(runId: string): Promise<GitGrantRecord[]>;
}

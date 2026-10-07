/**
 * git grant token 机制端口（specs/cloud-agent 01 §7.2 Git grant、09 §3 权限矩阵、
 * W1 §4「credentialAuthorization：git grant 元数据」）。
 *
 * 分层：grant 的**授权判定与签发时机**在 app 层（`app/gitGrants.ts`：终态/停止意图/
 * 写能力/generation 与幂等查询）；**token 机制**（mint、单次兑换 CAS、TTL、撤销、
 * 内存持有 token）在 adapter（W4 `createGitGrantBroker`）。因此本端口只暴露 app 需要的
 * 三个动作，实现由 `adapters/secret/gitGrantBroker.ts` 提供、入口装配注入。
 *
 * 形状与 W4 broker 的 `GitGrantBroker` 保持一致：入口装配处做一次结构化赋值
 * （`const broker: GitGrantBrokerPort = w4Broker`），任何字段漂移都会在那里编译失败。
 */
import type { CloudErrorCode } from "@zcode/shared";
import type { GitGrantPurpose } from "./gitGrantPort.js";

export type GitGrantDenyReason =
  | "expired"
  | "already-redeemed"
  | "no-issued-grant"
  | "revoked"
  | "binding-mismatch"
  | "bad-proof"
  | "mint-failed";

export interface GitGrantIssuance {
  grantId: string;
  expiresAt: number;
}

/** 拒绝结论（与 W4 broker 的同名类型逐字一致）。 */
export interface GitGrantDenial {
  ok: false;
  code: CloudErrorCode;
  reason: GitGrantDenyReason;
  message: string;
}

/**
 * 兑换结论：成功时携带 token（只经内存交给调用方，不落库/不落日志，01 §7.2），
 * 失败时给出归一错误码与稳定原因标签。
 */
export type GitGrantRedemption =
  | {
      ok: true;
      grantId: string;
      token: string;
      expiresAt: number;
      repositoryId: number;
      purpose: GitGrantPurpose;
    }
  | GitGrantDenial;

export interface GitGrantBrokerPort {
  /** 签发 grant 记录（TTL/grantId/绑定字段由实现决定；授权判定由调用方完成）。 */
  issue(request: {
    taskId: string;
    runId: string;
    runGeneration: number;
    repositoryId: number;
    installationId: number;
    purpose: GitGrantPurpose;
    proofHash?: string;
    traceId?: string;
  }): Promise<GitGrantIssuance>;
  /** 单次兑换（CAS）：重复/过期/绑定不符一律拒绝，不返回已发出的 token。 */
  redeem(request: {
    taskId: string;
    runId: string;
    runGeneration: number;
    repositoryId: number;
    purpose: GitGrantPurpose;
    proof?: string;
    traceId?: string;
  }): Promise<GitGrantRedemption>;
  /** run 终止/撤销时回收该 run 的全部 grant（08 §4.2 旧 writer 隔离）。 */
  revokeRun(request: {
    runId: string;
    reason: string;
    traceId?: string;
  }): Promise<{ revoked: number; notHeld: number }>;
}

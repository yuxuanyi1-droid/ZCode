/**
 * run-scoped git grant broker（specs/cloud-agent/01 §7.1/§7.2 git grant、
 * 09 §3 权限矩阵、03 §4 `git_grants` 表、W4 §3「单次兑换、60s、绑定
 * task/run/generation/repo/purpose、只持久 hash/元数据」）。
 *
 * 语义：
 * - 默认 TTL 60s 是**兑换窗口**（grant 短效单次）；兑换后拿到的 installation token
 *   仍是 GitHub 原生有效期，grant 不缩短其期限（01 §7.2）。
 * - 单次兑换由 store 的 CAS 承担：`issued → redeemed` 只能成功一次；重放、过期、
 *   旧 run/generation、跨 repo/purpose 领取一律拒绝（默认拒绝，不返回既有 token）。
 * - 只持久 grantId/purpose/issuedAt/expiresAt/状态/可选凭据摘要 hash 等元数据；
 *   raw token 只在内存（供尽力撤销）与兑换响应中出现一次，不落盘、不进日志。
 * - 撤销是尽力的：`DELETE /installation/token` 需要 token 本身，broker 一旦重启或
 *   已忘记内存中的 token，就只能如实回 "token-not-held"，等其最晚到期或确认旧沙箱
 *   死亡，不能伪造撤销完成（01 §7.2）。
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode } from "@zcode/shared";
import type { CloudAdapterLogger } from "../github/logging.js";
import type { MintedToken } from "../../app/ports/gitHubPort.js";
// grant 的形状与端口唯一来源是 app/ports（W0 冻结）；适配层只做能力实现，不再声明端口类型。
import {
  GIT_GRANT_TTL_MS,
  type GitGrantPurpose,
  type GitGrantRecord,
  type GitGrantStore,
} from "../../app/ports/gitGrantPort.js";

export type { GitGrantPurpose, GitGrantRecord, GitGrantStore };
/** 60s 兑换窗口（01 §7.2）；再导出便于装配与测试引用同一常量。 */
export { GIT_GRANT_TTL_MS };

export type GitGrantDenyReason =
  | "expired"
  | "already-redeemed"
  | "no-issued-grant"
  | "revoked"
  | "binding-mismatch"
  | "bad-proof"
  | "mint-failed";

export type GitGrantDenial = {
  ok: false;
  code: CloudErrorCode;
  reason: GitGrantDenyReason;
  message: string;
};

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

export interface GitGrantBroker {
  /** 控制面签发（W1 在授权成立后调用）；返回 grantId 与兑换窗口。 */
  issue(request: {
    taskId: string;
    runId: string;
    runGeneration: number;
    repositoryId: number;
    installationId: number;
    purpose: GitGrantPurpose;
    /** 可选：把 grant 绑到具体凭据摘要（只存 hash）。 */
    proofHash?: string;
    traceId?: string;
  }): Promise<{ grantId: string; expiresAt: number }>;
  /** 沙箱 helper 出站兑换（W5 路由 / W6 helper 调用）：按 (runId, purpose) 领取当前 grant。 */
  redeem(request: {
    taskId: string;
    runId: string;
    runGeneration: number;
    repositoryId: number;
    purpose: GitGrantPurpose;
    /** 入口层已认证的凭据材料；记录绑定了 proofHash 时必须是同一材料。 */
    proof?: string;
    traceId?: string;
  }): Promise<GitGrantRedemption>;
  /** 尽力撤销单个 grant；结果持久化（可查询、可重试）。 */
  revoke(request: {
    grantId: string;
    reason: string;
    traceId?: string;
  }): Promise<{ revoked: boolean; reason: string }>;
  /** run 终止/撤销时回收该 run 的所有 grant（08 §4.2 旧 writer 隔离）。 */
  revokeRun(request: {
    runId: string;
    reason: string;
    traceId?: string;
  }): Promise<{ revoked: number; notHeld: number }>;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** 恒定时间比较（01 §7.2）：长度不同直接判否，长度相同才走 timingSafeEqual。 */
export function constantTimeEqualHex(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function deny(code: CloudErrorCode, reason: GitGrantDenyReason, message: string): GitGrantDenial {
  return { ok: false, code, reason, message };
}

export function createGitGrantBroker(deps: {
  store: GitGrantStore;
  /** 按 purpose 的最小权限矩阵 mint（09 §3）；broker 不自己决定权限。 */
  mint: (request: {
    repositoryId: number;
    installationId: number;
    purpose: GitGrantPurpose;
  }) => Promise<MintedToken>;
  /** 单 token 尽力撤销（`DELETE /installation/token`）。 */
  revokeToken: (token: string) => Promise<{ revoked: boolean; reason: string }>;
  ttlMs?: number;
  now?: () => number;
  newGrantId?: () => string;
  logger?: CloudAdapterLogger;
}): GitGrantBroker {
  const now = deps.now ?? Date.now;
  const ttlMs = deps.ttlMs ?? GIT_GRANT_TTL_MS;
  const newGrantId = deps.newGrantId ?? randomUUID;
  /** 已发出的 token 只在内存保留，用于撤销；重启后不再持有（01 §7.2）。 */
  const heldTokens = new Map<string, { token: string; expiresAt: number }>();

  function sweep(at: number): void {
    for (const [grantId, held] of heldTokens) {
      if (held.expiresAt <= at) heldTokens.delete(grantId);
    }
  }

  async function revokeOne(
    grantId: string,
    reason: string,
  ): Promise<{ revoked: boolean; reason: string }> {
    const record = await deps.store.get(grantId);
    if (!record) return { revoked: false, reason: "not-found" };
    const held = heldTokens.get(grantId);
    if (!held) {
      // broker 不持有 token（未兑换/已过期/已重启）：只能如实记录，等其最晚到期。
      await deps.store.recordRevokeOutcome({
        grantId,
        revoked: false,
        reason: `token-not-held:${reason}`,
        now: now(),
      });
      return { revoked: false, reason: "token-not-held" };
    }
    const outcome = await deps.revokeToken(held.token);
    heldTokens.delete(grantId);
    await deps.store.recordRevokeOutcome({
      grantId,
      revoked: outcome.revoked,
      reason: `${outcome.reason}:${reason}`,
      now: now(),
    });
    return outcome;
  }

  return {
    async issue(request) {
      const at = now();
      sweep(at);
      const record: GitGrantRecord = {
        grantId: newGrantId(),
        taskId: request.taskId,
        runId: request.runId,
        runGeneration: request.runGeneration,
        repositoryId: request.repositoryId,
        installationId: request.installationId,
        purpose: request.purpose,
        status: "issued",
        issuedAt: at,
        expiresAt: at + ttlMs,
        proofHash: request.proofHash,
      };
      await deps.store.insert(record);
      deps.logger?.info(request.traceId, "git grant issued", {
        grantId: record.grantId,
        runId: record.runId,
        runGeneration: record.runGeneration,
        repositoryId: record.repositoryId,
        purpose: record.purpose,
        expiresAt: record.expiresAt,
      });
      return { grantId: record.grantId, expiresAt: record.expiresAt };
    },

    async redeem(request) {
      const at = now();
      sweep(at);
      const record = await deps.store.findCurrentForRun({
        runId: request.runId,
        purpose: request.purpose,
        now: at,
      });
      if (!record) {
        // 没有可兑换的 grant：控制面还没签发（未授权）。默认拒绝，且不因请求而补签（01 §7.2）。
        deps.logger?.warn(request.traceId, "git grant redemption denied", {
          runId: request.runId,
          purpose: request.purpose,
          reason: "no-issued-grant",
        });
        return deny("unauthorized", "no-issued-grant", "no issued grant for this run");
      }
      if (record.status === "revoked")
        return deny("permission_revoked", "revoked", "grant was revoked");
      if (record.status === "redeemed") {
        return deny("unauthorized", "already-redeemed", "grant was already redeemed");
      }
      if (at > record.expiresAt) return deny("stale", "expired", "grant redemption window expired");
      if (
        record.taskId !== request.taskId ||
        record.runId !== request.runId ||
        record.runGeneration !== request.runGeneration
      ) {
        // 旧 run / 旧 generation 不能领取新 grant（01 §7.2、08 §4.2）。
        return deny("stale", "binding-mismatch", "grant is bound to another run generation");
      }
      if (record.repositoryId !== request.repositoryId || record.purpose !== request.purpose) {
        return deny(
          "unauthorized",
          "binding-mismatch",
          "grant is bound to another repository or purpose",
        );
      }
      if (record.proofHash) {
        if (!request.proof || !constantTimeEqualHex(record.proofHash, sha256Hex(request.proof))) {
          return deny(
            "unauthorized",
            "bad-proof",
            "grant proof does not match the bound credential",
          );
        }
      }
      const claimed = await deps.store.claimRedemption({
        grantId: record.grantId,
        taskId: request.taskId,
        runId: request.runId,
        runGeneration: request.runGeneration,
        now: at,
      });
      if (!claimed) {
        // CAS 失败 = 已被并发领取（重放或双 worker）：拒绝，不返回已发出的 token。
        return deny("unauthorized", "already-redeemed", "grant redemption lost the CAS race");
      }
      try {
        const minted = await deps.mint({
          repositoryId: record.repositoryId,
          installationId: record.installationId,
          purpose: record.purpose,
        });
        heldTokens.set(record.grantId, { token: minted.token, expiresAt: minted.expiresAt });
        await deps.store.recordIssuedToken({
          grantId: record.grantId,
          tokenIssuedAt: at,
          tokenExpiresAt: minted.expiresAt,
        });
        deps.logger?.info(request.traceId, "git grant redeemed", {
          grantId: record.grantId,
          runId: record.runId,
          repositoryId: record.repositoryId,
          purpose: record.purpose,
          tokenExpiresAt: minted.expiresAt,
        });
        return {
          ok: true,
          grantId: record.grantId,
          token: minted.token,
          expiresAt: minted.expiresAt,
          repositoryId: record.repositoryId,
          purpose: record.purpose,
        };
      } catch (error) {
        const code: CloudErrorCode =
          error && typeof error === "object" && "code" in error
            ? ((error as { code: CloudErrorCode }).code ?? "network_unknown")
            : "network_unknown";
        // 兑换一旦开始就不可重用：mint 结果未知时也不回退状态（01 §7.2 单次兑换）。
        await deps.store.recordFailure({
          grantId: record.grantId,
          code,
          message: `grant mint failed: ${code}`,
          now: at,
        });
        deps.logger?.warn(request.traceId, "git grant mint failed", {
          grantId: record.grantId,
          runId: record.runId,
          code,
        });
        return deny(code, "mint-failed", `grant mint failed: ${code}`);
      }
    },

    async revoke(request) {
      const outcome = await revokeOne(request.grantId, request.reason);
      deps.logger?.info(request.traceId, "git grant revoke attempted", {
        grantId: request.grantId,
        revoked: outcome.revoked,
        reason: outcome.reason,
      });
      return outcome;
    },

    async revokeRun(request) {
      const records = await deps.store.listByRun(request.runId);
      let revoked = 0;
      let notHeld = 0;
      for (const record of records) {
        const outcome = await revokeOne(record.grantId, request.reason);
        if (outcome.revoked) revoked += 1;
        else notHeld += 1;
      }
      deps.logger?.info(request.traceId, "git grants revoked for run", {
        runId: request.runId,
        revoked,
        notHeld,
      });
      return { revoked, notHeld };
    },
  };
}

/** retryable 提示：调用方（W5 路由）用它填充错误信封（03 §6）。 */
export function gitGrantDenialRetryable(code: CloudErrorCode): boolean {
  return CLOUD_ERROR_RETRYABLE[code];
}

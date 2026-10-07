/**
 * git grant 的签发与兑换（specs/cloud-agent 01 §7.2 Git grant、09 §3 权限矩阵、
 * 08 §4.2 旧 writer 隔离、11 §6 基线固定）。
 *
 * 分工（一条规则一处定义）：
 * - **授权判定与签发时机**在本文件：终态/停止意图/写能力/generation 由
 *   `authorizeGitGrant` 决定；`(runId, purpose)` 幂等复用 `GitGrantStore.findCurrentForRun`。
 * - **token 机制**在 `GitGrantBrokerPort`（W4 broker）：mint、单次兑换 CAS、TTL、撤销、
 *   内存持有 token。本文件不生成 grantId/TTL，避免与 broker 出现第二份元数据定义。
 *
 * 签发时机（"在需要之前"，TTL 60s）：
 * - clone：create 路径 `recordProviderHandle` 成功后、`startSupervisor` 之前
 *   （supervisor 启动 → hello → welcome → bootstrap.config → 兑换实测约 2s，窗口足够；
 *   接纳期不能签，create 可能几十秒）。
 * - push：drain 发 `checkpoint.request` 之前（写入沙箱的 checkpoint push 用）。
 *
 * 失败语义（调用方按 `isRecoverableGitGrantFailure` 分流）：
 * - 可自愈（外部临时不可用：network_unknown / rate_limited / provider_unreachable）→ 记录并继续，
 *   由兑换侧/后续对账兜住；
 * - 不可自愈（终态 run、停止意图、仓库未绑定、权限被撤、未配置）→ 调用方让 run 以可读原因收口
 *   （复用 create/lifecycle 的 `lastError` 口径），避免"悄悄过去再等兑换超时"。
 */
import type { CloudErrorCode } from "@zcode/shared";
import type { CloudCoreDeps } from "./deps.js";
import { authorizeGitGrant } from "./credentialAuthorization/authorization.js";
import type { GitGrantPurpose } from "./ports/gitGrantPort.js";
import type { GitGrantRedemption } from "./ports/gitGrantBrokerPort.js";
import { cloudCoreLogger } from "./logger.js";

export type GitGrantIssueResult =
  | { ok: true; grantId: string; expiresAt: number }
  | { ok: false; code: CloudErrorCode; reason: string };

export interface CloudGitGrantService {
  /**
   * 在**需要之前**为该 run 签发一个短效单次 grant（01 §7.2）。幂等：同一
   * (runId, purpose) 已有未消费未过期的 grant 时返回既有记录，不重复签发。
   * 授权判定（终态/停止意图/写能力/generation）在 app 层决定，token 机制留给 adapter。
   */
  issueForRun(request: { runId: string; purpose: GitGrantPurpose }): Promise<GitGrantIssueResult>;
  /**
   * 执行节点兑换：入口 HTTP 层调用，内部走**同一个 broker 实例**。
   * `proof` 可选：grant 记录绑定 `proofHash` 时必填（broker 做恒定时间比较），否则忽略。
   */
  redeem(request: {
    runId: string;
    purpose: GitGrantPurpose;
    runGeneration: number;
    repositoryId: number;
    proof?: string;
    traceId?: string;
  }): Promise<GitGrantRedemption>;
}

/**
 * 可自愈的签发失败（01 §9）：外部临时不可用，重试/对账即可；其余一律按不可自愈处理，
 * 由调用方让 run 以可读原因收口。
 */
export function isRecoverableGitGrantFailure(code: CloudErrorCode): boolean {
  return code === "network_unknown" || code === "rate_limited" || code === "provider_unreachable";
}

export function createCloudGitGrantService(deps: CloudCoreDeps): CloudGitGrantService {
  const { storage, gitGrantStore, gitGrantBroker, clock } = deps;

  return {
    async issueForRun(request) {
      if (!gitGrantStore || !gitGrantBroker) {
        // 未接线：fail-closed，且不因请求而补签（01 §7.2 的兑换侧同样默认拒绝）。
        return { ok: false, code: "not_configured", reason: "git-grant-not-configured" };
      }
      const run = await storage.runs.get(request.runId);
      if (!run) return { ok: false, code: "not_found", reason: "run-not-found" };
      const task = await storage.tasks.get(run.taskId);
      if (!task) return { ok: false, code: "not_found", reason: "task-not-found" };
      const project = await storage.projects.get(task.projectId);
      if (!project?.repositoryId || !project.installationId) {
        // 仓库授权事实缺失：部署/授权未就绪 → 不可自愈（沙箱拿不到 token 也 clone 不了）。
        return { ok: false, code: "not_configured", reason: "repository-not-bound" };
      }
      const authorization = authorizeGitGrant({ run, task, purpose: request.purpose });
      if (!authorization.ok) {
        return { ok: false, code: authorization.code, reason: authorization.reason };
      }

      const now = clock.now();
      const existing = await gitGrantStore.findCurrentForRun({
        runId: run.runId,
        purpose: request.purpose,
        now,
      });
      if (existing && existing.status === "issued" && existing.expiresAt > now) {
        // 幂等：同一 (runId, purpose) 已有有效 grant 时复用，不重复签发（01 §7.2）。
        return { ok: true, grantId: existing.grantId, expiresAt: existing.expiresAt };
      }

      let issued: { grantId: string; expiresAt: number };
      try {
        issued = await gitGrantBroker.issue({
          taskId: task.taskId,
          runId: run.runId,
          runGeneration: run.runGeneration,
          repositoryId: project.repositoryId,
          installationId: project.installationId,
          purpose: request.purpose,
        });
      } catch (error) {
        // mint 失败（未配置/权限/外部不可用）：归一为签发失败交给调用方分流，不让异常穿透。
        const rawCode = (error as { code?: unknown } | null)?.code;
        const code: CloudErrorCode =
          typeof rawCode === "string" ? (rawCode as CloudErrorCode) : "network_unknown";
        cloudCoreLogger.warn(undefined, "cloud git grant issuance failed", {
          runId: run.runId,
          purpose: request.purpose,
          code,
        });
        return { ok: false, code, reason: "grant-issue-failed" };
      }
      cloudCoreLogger.info(undefined, "cloud git grant issued", {
        taskId: task.taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
        purpose: request.purpose,
        expiresAt: issued.expiresAt,
      });
      return { ok: true, grantId: issued.grantId, expiresAt: issued.expiresAt };
    },

    async redeem(request) {
      if (!gitGrantBroker) {
        return {
          ok: false,
          code: "not_configured",
          reason: "no-issued-grant",
          message: "git grants are not configured",
        };
      }
      const run = await storage.runs.get(request.runId);
      if (!run) {
        return {
          ok: false,
          code: "not_found",
          reason: "no-issued-grant",
          message: "run not found",
        };
      }
      // 兑换的机制面（单次 CAS/TTL/绑定/proof 恒定时间比较）全部由 broker 负责（01 §7.2）。
      return await gitGrantBroker.redeem({
        taskId: run.taskId,
        runId: run.runId,
        runGeneration: request.runGeneration,
        repositoryId: request.repositoryId,
        purpose: request.purpose,
        ...(request.proof ? { proof: request.proof } : {}),
        ...(request.traceId ? { traceId: request.traceId } : {}),
      });
    },
  };
}

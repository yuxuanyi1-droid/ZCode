/**
 * idle / 硬期限 drain 与停止屏障（08 §3.2 ready→draining、§7 到达期限前停止接收新工作、
 * §8.1 停止屏障与操作依赖、01 §8 checkpoint 通路）。
 *
 * 停止通路的依赖顺序（08 §8.1）：
 *   stop intent（持久）→ quiesce → checkpoint 及远端 SHA 确认 → terminate → 配额释放。
 * 本文件负责 **intent 与 drain 入口**：先写持久屏障与 checkpoint/terminate 操作意图，
 * 再通知 attachment；保存结果由 `lifecycle/checkpoints.ts` 落地，终止由 commands 的 stop
 * 编排执行。worker 不能先领 terminate 绕过保存前置。
 *
 * quiesce 边界（08 §8.1 第三批，必须如实标注）：v1 quiesce = 控制面投递屏障 + 沙箱侧
 * 工作区收口提交，**没有可等待的 in-flight 命令面**；不得用 sleep 冒充同步。
 * 见 domain/savePolicy.ts 的 `QUIESCE_BOUNDARY`。
 */
import type { BridgeDrainFrame, CloudRunRecord } from "@zcode/shared";
import { checkpointOperationKey } from "../../domain/idempotency.js";
import {
  isIdleArchiveEligible,
  resolveEffectiveDeadline,
  shouldBeginDrain,
} from "../../domain/savePolicy.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { isRecoverableGitGrantFailure, type CloudGitGrantService } from "../gitGrants.js";
import { fail, ok, type CloudAppResult } from "../result.js";

export interface DrainSweepReport {
  began: number;
  skipped: number;
}

export interface DrainLoop {
  sweep(now?: number): Promise<DrainSweepReport>;
  /** drain 入口：与用户 stop 共用同一屏障与操作意图（08 §8.1）。 */
  beginDrain(input: {
    taskId: string;
    runId: string;
    reason: BridgeDrainFrame["reason"];
    operationId?: string;
  }): Promise<CloudAppResult<CloudRunRecord>>;
}

export function createDrainLoop(deps: CloudCoreDeps, gitGrants: CloudGitGrantService): DrainLoop {
  const { storage, operations, attachments, clock, ids, config } = deps;

  async function beginDrain(input: {
    taskId: string;
    runId: string;
    reason: BridgeDrainFrame["reason"];
    operationId?: string;
  }): Promise<CloudAppResult<CloudRunRecord>> {
    const run = await storage.runs.get(input.runId);
    if (!run || run.taskId !== input.taskId) return fail("not_found", "run-not-found");
    if (run.status === "stopped" || run.status === "expired" || run.status === "failed") {
      return ok(run);
    }
    const operationId = input.operationId ?? ids.newId();
    // 1) 持久停止屏障：先于任何投递/启动（08 §8.1）。
    await storage.runs.requestStop({ taskId: run.taskId, operationId, now: clock.now() });
    // 2) 操作意图先落库（03 §5：外部操作不是数据库事务）。
    await operations.enqueue({
      operationId,
      kind: "checkpoint",
      idempotencyKey: checkpointOperationKey(run.runId, operationId),
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      now: clock.now(),
    });
    // 3) 状态迁移：ready/disconnected → draining；provisioning 保持供给事实（08 §8.1）。
    let updated: CloudRunRecord | null = run;
    if (run.status === "ready" || run.status === "disconnected") {
      updated = await storage.runs.transitionStatus({
        runId: run.runId,
        runGeneration: run.runGeneration,
        from: ["ready", "disconnected"],
        to: "draining",
        endReason: input.reason,
        now: clock.now(),
      });
      if (!updated) return fail("stale", "run-transition-cas-failed");
    }
    // 4) 通知 attachment 进入 quiesce（投递屏障 + 沙箱侧收口提交；无等待面）。
    cloudCoreLogger.debug(undefined, "cloud run drain requested", {
      taskId: run.taskId,
      runId: run.runId,
      reason: input.reason,
    });
    await attachments.requestDrain({
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      operationId,
      reason: input.reason,
    });
    // push/fetch grant 必须在 checkpoint 通路**之前**签发（TTL 60s；01 §7.2、09 §3 矩阵）：
    // - push：`git push origin <taskBranch>`（contents:write）；
    // - fetch：push 之后的 ls-remote 远端 SHA 对账（`pushAndVerify` 用 `withGrant("fetch")`，
    //   不从 push token 借权限），缺它会让保存失败在"远端校验"这一步。
    // 失败分流：可自愈（外部临时不可用）记录后继续；不可自愈（终态/停止/仓库未绑定/权限被撤）
    // 不发新 write grant——**不在此处补兜底**：保存通路会如实用 checkpoint.result=failed +
    // dataAtRisk 记录（08 §8.1/§8.2），配额与 run 终态由 stop 编排按证据收口。
    for (const purpose of ["push", "fetch"] as const) {
      const grant = await gitGrants.issueForRun({ runId: run.runId, purpose });
      if (!grant.ok) {
        cloudCoreLogger.warn(undefined, "cloud git grant issuance failed", {
          taskId: run.taskId,
          runId: run.runId,
          purpose,
          code: grant.code,
          reason: grant.reason,
          recoverable: isRecoverableGitGrantFailure(grant.code),
        });
      }
    }
    await attachments.requestCheckpoint({
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      operationId,
      // purpose 映射：用户停止 → stop；闲置/硬期限 → drain（02 §4 checkpoint.request 帧）。
      purpose: input.reason === "user-stop" ? "stop" : "drain",
    });
    return ok(updated);
  }

  return {
    beginDrain,

    async sweep(now = clock.now()) {
      const report: DrainSweepReport = { began: 0, skipped: 0 };
      const runs = await storage.runs.listNonTerminal();
      for (const run of runs) {
        if (run.status !== "ready" && run.status !== "disconnected") continue;
        if (run.stopRequested) {
          // 已有停止意图但状态未推进（例如上一轮迁移失败）：重试 drain 入口。
          const retried = await beginDrain({
            taskId: run.taskId,
            runId: run.runId,
            reason: "reclaim",
          });
          if (retried.ok) report.began += 1;
          else report.skipped += 1;
          continue;
        }
        const deadline = resolveEffectiveDeadline({
          expiresAt: run.expiresAt,
          deadlineEstimate: run.deadlineEstimate,
          hardDeadlineAt: run.hardDeadlineAt,
        });
        if (shouldBeginDrain({ now, deadline, drainBudgetMs: config.drainBudgetMs })) {
          const started = await beginDrain({
            taskId: run.taskId,
            runId: run.runId,
            reason: "hard-deadline",
          });
          if (started.ok) report.began += 1;
          else report.skipped += 1;
          continue;
        }
        // idle 归档阈值（08 §7）：execution idle、无 pending input/interaction、无 checkpoint。
        const pendingInputs = await storage.inputs.listDeliverable(run.taskId);
        const pendingInputCount = pendingInputs.filter(
          (input) => input.deliveryStatus === "accepted" || input.deliveryStatus === "delivering",
        ).length;
        const checkpoints = await storage.projections.listCheckpoints(run.taskId);
        const idle = isIdleArchiveEligible({
          now,
          lastBusinessActivityAt: run.lastBusinessActivityAt,
          // 执行状态读取端口未冻结（CR-4）：只用持久业务活动时间与 pending 输入做保守判定。
          execution: run.lastBusinessActivityAt === undefined ? "unknown" : "idle",
          pendingInputCount,
          pendingInteractionCount: 0,
          checkpointInFlight: checkpoints.some((checkpoint) => checkpoint.state === "saving"),
          idleArchiveThresholdMs: config.idleArchiveThresholdMs,
        });
        if (idle) {
          const started = await beginDrain({
            taskId: run.taskId,
            runId: run.runId,
            reason: "idle",
          });
          if (started.ok) report.began += 1;
          else report.skipped += 1;
        } else {
          report.skipped += 1;
        }
      }
      return report;
    },
  };
}

/**
 * stop / force-stop 编排（03 §6 stop、force-stop 行；08 §8.1 停止屏障与依赖、
 * §8.2 force stop 是单独显式动作）。
 *
 * 依赖顺序（08 §8.1）：stop intent → quiesce → checkpoint 及远端 SHA 确认 → terminate →
 * 物理终止确认/配额释放。本文件只负责把顺序落地，不能先领 terminate 绕过保存前置。
 *
 * 例外分支（同样来自 08 §8.1/§8.2，必须显式记录风险）：
 * - 无运行时写入且已核验无需保存；用户明确 force-stop；provider 硬期限。
 * 普通 stop 失败**不得**自动升级成 force-stop。
 */
import type { TaskDetailResponse } from "@zcode/shared";
import { FORCE_STOP_END_REASON } from "../../domain/taskRunState.js";
import { drainRetryAllowed, resolveEffectiveDeadline } from "../../domain/savePolicy.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, type CloudAppResult } from "../result.js";
import type { DrainLoop } from "../lifecycle/drain.js";
import type { RunCompensation } from "../provisioning/compensation.js";
import type { RunOrchestrator } from "../runOrchestrator.js";
import type { TaskDetailService } from "../taskDetail.js";

export interface StopSweepReport {
  advanced: number;
  waitingSave: number;
}

export interface StopOperations {
  stopTask(input: {
    principalId: string;
    taskId: string;
  }): Promise<CloudAppResult<TaskDetailResponse>>;
  forceStopTask(input: {
    principalId: string;
    taskId: string;
    operationId: string;
    expectedRevision: number;
    lossAcknowledgement: true;
  }): Promise<CloudAppResult<TaskDetailResponse>>;
  /** 推进已受理的停止：保存完成后终止、保存失败在预算内重试（08 §8.1）。 */
  sweep(now?: number): Promise<StopSweepReport>;
}

export function createStopOperations(
  deps: CloudCoreDeps,
  orchestrator: RunOrchestrator,
  compensation: RunCompensation,
  drain: DrainLoop,
  taskDetail: TaskDetailService,
): StopOperations {
  const { storage, operations, clock } = deps;

  return {
    async stopTask(input) {
      const detail = await taskDetail.getDetail(input);
      if (!detail.ok) return detail;
      const run = detail.value.activeRun;
      if (!run || run.status === "stopped" || run.status === "expired" || run.status === "failed") {
        // 无有效 run：stop 不制造状态（Task active 不表示 Agent 正在 running，08 §3.1）。
        return detail;
      }
      const started = await drain.beginDrain({
        taskId: input.taskId,
        runId: run.runId,
        reason: "user-stop",
      });
      if (!started.ok) return started;
      return await taskDetail.getDetail(input);
    },

    async forceStopTask(input) {
      const task = await storage.tasks.get(input.taskId);
      if (!task || task.ownerPrincipalId !== input.principalId)
        return fail("not_found", "task-not-found");
      if (task.revision !== input.expectedRevision) return fail("stale", "task-revision-mismatch");
      const run = await storage.runs.activeOfTask(input.taskId);
      if (!run || run.status === "stopped" || run.status === "expired" || run.status === "failed") {
        return await taskDetail.getDetail({ principalId: input.principalId, taskId: input.taskId });
      }
      // 持久停止屏障 + 显式 operationId（调用方提供，保证幂等）。
      await storage.runs.requestStop({
        taskId: input.taskId,
        operationId: input.operationId,
        now: clock.now(),
      });
      if (run.status === "ready" || run.status === "disconnected") {
        // stopped 只能从 draining/provisioning 到达（08 §3.2 状态图）；force-stop 直接进入 draining。
        await storage.runs.transitionStatus({
          runId: run.runId,
          runGeneration: run.runGeneration,
          from: ["ready", "disconnected"],
          to: "draining",
          endReason: FORCE_STOP_END_REASON,
          now: clock.now(),
        });
      }
      cloudCoreLogger.warn(undefined, "cloud force stop requested", {
        taskId: input.taskId,
        runId: run.runId,
        operationId: input.operationId,
      });
      // 显式丢失确认：跳过保存前置，但仍要求 provider 确认终止后才释放配额（01 §4.3）。
      await compensation.terminateRun({
        runId: run.runId,
        runGeneration: run.runGeneration,
        reason: FORCE_STOP_END_REASON,
      });
      return await taskDetail.getDetail({ principalId: input.principalId, taskId: input.taskId });
    },

    async sweep(now = clock.now()) {
      const report: StopSweepReport = { advanced: 0, waitingSave: 0 };
      const runs = await storage.runs.listNonTerminal();
      for (const run of runs) {
        if (!run.stopRequested) continue;
        if (run.status === "provisioning") {
          // 创建途中取消：create worker 会按 stopRequested 阻断/清理；已落地资源在此补终止。
          if (run.providerHandle) {
            await compensation.requestTermination({
              runId: run.runId,
              runGeneration: run.runGeneration,
              reason: "stop-during-provisioning",
            });
            await compensation.runCompensationOnce({ workerId: `stop:${run.runId}` });
            report.advanced += 1;
          }
          continue;
        }
        if (run.status !== "draining") continue;
        const stopOperation = run.stopOperationId
          ? await operations.get(run.stopOperationId)
          : null;
        if (!stopOperation) {
          await drain.beginDrain({ taskId: run.taskId, runId: run.runId, reason: "user-stop" });
          report.waitingSave += 1;
          continue;
        }
        if (stopOperation.state === "pending" || stopOperation.state === "leased") {
          report.waitingSave += 1;
          continue;
        }
        const deadline = resolveEffectiveDeadline({
          expiresAt: run.expiresAt,
          deadlineEstimate: run.deadlineEstimate,
          hardDeadlineAt: run.hardDeadlineAt,
        });
        const forced = deadline !== null && now >= deadline.at;
        if (stopOperation.state === "ambiguous" && !forced) {
          // 保存结果未知：不谎称 saved，也不在预算内停机（08 §8.1）。
          report.waitingSave += 1;
          continue;
        }
        if (stopOperation.state === "failed") {
          const retry = drainRetryAllowed({
            now,
            deadline,
            retries: stopOperation.attempt,
          });
          if (retry) {
            // 保存失败允许剩余预算内重试：重发 drain/checkpoint 意图（新 operationId），
            // 屏障保持，不自动解除（08 §8.1）。
            await drain.beginDrain({ taskId: run.taskId, runId: run.runId, reason: "user-stop" });
            report.waitingSave += 1;
            continue;
          }
        }
        // 保存已确认或预算耗尽：核验终止并收口。
        const terminated = await compensation.terminateRun({
          runId: run.runId,
          runGeneration: run.runGeneration,
          reason: forced ? "hard-deadline" : "stop",
        });
        if (!terminated.ok) continue;
        if (terminated.value.verdict !== "terminated") {
          report.waitingSave += 1;
          continue;
        }
        await orchestrator.settleTerminal({
          runId: run.runId,
          runGeneration: run.runGeneration,
          to: "stopped",
          endReason: forced ? "hard-deadline" : "stop",
          termination: "terminated",
          // 保存失败/结果未知时如实暴露风险，不宣称工作全部保住（08 §8.2）。
          dataAtRisk: stopOperation.state !== "settled",
        });
        report.advanced += 1;
      }
      return report;
    },
  };
}

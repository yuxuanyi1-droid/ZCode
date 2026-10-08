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
import type { ExternalOperationRecord } from "../ports/operationOutboxPort.js";
import type { DrainLoop } from "../lifecycle/drain.js";
import type { PauseResumeControl } from "../lifecycle/pauseResume.js";
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

/** 已保存的 checkpoint 记录（C-1/D4-4 最新状态判定用）。 */
interface SavedCheckpointFact {
  confirmedRemoteSha: string;
}

/**
 * D4-4/C-1：读屏障指向 op 的**最新**保存状态。
 * op 行一旦结算 failed/ambiguous 不会再被租约领取结算；而重试（C-1 复用同一 operationId
 * 重发 checkpoint.request）可能在沙箱侧保存成功并回写同一 operationId 的 checkpoint 记录。
 * 因此失败/未知的 op 以记录的最新事实修正结论——重试成功不得再假 dataAtRisk（08 §8.2）。
 */
async function resolveLatestStopOperation(
  stopOperation: ExternalOperationRecord,
  readSavedFact: () => Promise<SavedCheckpointFact | null>,
): Promise<ExternalOperationRecord> {
  if (stopOperation.state !== "failed" && stopOperation.state !== "ambiguous") {
    return stopOperation;
  }
  const saved = await readSavedFact();
  if (!saved) return stopOperation;
  return { ...stopOperation, state: "settled", resultRef: saved.confirmedRemoteSha };
}

export function createStopOperations(
  deps: CloudCoreDeps,
  orchestrator: RunOrchestrator,
  compensation: RunCompensation,
  drain: DrainLoop,
  taskDetail: TaskDetailService,
  pauseResume: Pick<PauseResumeControl, "advancePausedStop">,
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
      if (run.status === "paused") {
        // 暂停中停止（03 §6 修订行为表；第 2 批遗留 1 改即时）：beginDrain 写持久屏障并
        // 推进 paused→draining（不启动保存通路），随后与 pauseResume 拍共用同一推进实现
        // 直接 terminate + 收口——HTTP 响应即反映 draining/stopped，不再等 ≤30s tick。
        const started = await drain.beginDrain({
          taskId: input.taskId,
          runId: run.runId,
          reason: "user-stop",
        });
        if (!started.ok) return started;
        const fresh = await storage.runs.get(run.runId);
        if (fresh && (fresh.status === "paused" || fresh.status === "draining")) {
          await pauseResume.advancePausedStop(fresh, clock.now());
        }
        return await taskDetail.getDetail(input);
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
      if (run.status === "ready" || run.status === "disconnected" || run.status === "paused") {
        // stopped 只能从 draining/provisioning 到达（08 §3.2 状态图）；force-stop 直接进入 draining。
        // paused 同样先推进 draining（行为表：force-stop=屏障+直接 terminate；paused→draining
        // 边 2026-10-09 修订）——否则暂停态直接 terminate 后 settleTerminal(stopped) 会被
        // 迁移表拒绝（无 paused→stopped 边），run 卡死在 paused。
        await storage.runs.transitionStatus({
          runId: run.runId,
          runGeneration: run.runGeneration,
          from: ["ready", "disconnected", "paused"],
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
          // 定稿附录 C-1/D4-4：屏障存在但查不到 op——force-stop 的 operationId 由客户端
          // 提供且从不入队（跳过保存前置是它的语义）。这里**不得**对 stopRequested 的 run
          // 重启保存通路（beginDrain 会给 force-stop 硬塞一次保存）；直接跳过，等待
          // terminate op 由 compensation 循环收口。
          report.waitingSave += 1;
          continue;
        }
        // 最新保存状态（重试成功不再假 dataAtRisk，见 resolveLatestStopOperation）。
        const latestStopOperation = await resolveLatestStopOperation(stopOperation, async () => {
          const checkpoints = await storage.projections.listCheckpoints(run.taskId);
          const record = checkpoints.find((item) => item.operationId === stopOperation.operationId);
          return record?.state === "saved" && record.confirmedRemoteSha
            ? { confirmedRemoteSha: record.confirmedRemoteSha }
            : null;
        });
        if (latestStopOperation.state === "pending" || latestStopOperation.state === "leased") {
          report.waitingSave += 1;
          continue;
        }
        const deadline = resolveEffectiveDeadline({
          expiresAt: run.expiresAt,
          deadlineEstimate: run.deadlineEstimate,
          hardDeadlineAt: run.hardDeadlineAt,
        });
        const forced = deadline !== null && now >= deadline.at;
        if (latestStopOperation.state === "ambiguous" && !forced) {
          // 保存结果未知：不谎称 saved，也不在预算内停机（08 §8.1）。
          report.waitingSave += 1;
          continue;
        }
        if (latestStopOperation.state === "failed") {
          const retry = drainRetryAllowed({
            now,
            deadline,
            retries: latestStopOperation.attempt,
          });
          if (retry) {
            // 保存失败允许剩余预算内重试：C-1 复用同一 op 重发 drain/checkpoint 通知，
            // 屏障与指针不变（08 §8.1）；沙箱成功回写同一 operationId 后按最新状态放行。
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
          // 保存失败/结果未知时如实暴露风险，不宣称工作全部保住（08 §8.2）；
          // 按**最新**状态判定：重试成功（记录已 saved）不再假 dataAtRisk。
          dataAtRisk: latestStopOperation.state !== "settled",
        });
        report.advanced += 1;
      }
      return report;
    },
  };
}

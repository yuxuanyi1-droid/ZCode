/**
 * 暂停中停止推进（03 §6 修订行为表的**共享实现**，2026-10-09 生命周期 v2）。
 *
 * 两个调用方复用同一实现，不写两份（第 2 批遗留 1 去重）：
 * - `pauseResume.sweep`（tick 兜底：stop 受理后进程重启/推进未完成的 paused run）；
 * - `commands/stopOperations.stopTask`（受理即时：HTTP 响应即反映 draining/stopped，
 *   不再等 ≤30s tick）。
 *
 * 前置：停止屏障已由 stop/force-stop 写好（复用 `stopOperationId`，08 §8.1）。顺序：
 * `paused → draining` CAS → 直接 terminate（暂停态无运行时写入、无 checkpoint 前置）→
 * `stopped` 收口并如实标 dataAtRisk。
 */
import type { CloudRunRecord } from "@zcode/shared";
import { isTerminalRunStatus } from "../../domain/taskRunState.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import type { RunCompensation } from "../provisioning/compensation.js";
import type { RunOrchestrator } from "../runOrchestrator.js";

/** 推进结果：false = 状态被并发改变或终止未确认，由调用方按自身节奏重试。 */
export type PausedStopAdvance = (run: CloudRunRecord, now: number) => Promise<boolean>;

export function createPausedStopAdvance(
  deps: CloudCoreDeps,
  orchestrator: RunOrchestrator,
  compensation: RunCompensation,
): PausedStopAdvance {
  const { storage, operations } = deps;
  return async function advancePausedStop(run, now) {
    let draining = run;
    if (run.status === "paused") {
      const transitioned = await storage.runs.transitionStatus({
        runId: run.runId,
        runGeneration: run.runGeneration,
        from: ["paused"],
        to: "draining",
        endReason: "stop",
        now,
      });
      if (!transitioned) {
        // 屏障与状态在两拍之间被其他通路改变：不重试，下一拍按新状态裁决。
        return false;
      }
      draining = transitioned;
    } else if (run.status !== "draining") {
      // 非 paused/draining 的 run 不归本通路（ready 的停止走 drain，终态已收口）。
      return false;
    }
    cloudCoreLogger.info(undefined, "cloud paused run stop advancing", {
      taskId: draining.taskId,
      runId: draining.runId,
      stopOperationId: draining.stopOperationId,
    });
    // 直接 terminate：暂停态无运行时写入、无 checkpoint 前置可执行（03 §6 修订）。
    const terminated = await compensation.terminateRun({
      runId: draining.runId,
      runGeneration: draining.runGeneration,
      reason: "stop",
    });
    if (!terminated.ok || terminated.value.verdict !== "terminated") {
      // 终止未确认：保持 draining（占槽），由 compensation 循环/下一拍按证据收口。
      return false;
    }
    // 与 keepalive liveness 同一判据：stop op 已 settled 才算保存已确认；paused 停止
    // 没有 checkpoint 可执行（op pending 或缺失），如实标 dataAtRisk（08 §8.2）。
    const stopOperation = draining.stopOperationId
      ? await operations.get(draining.stopOperationId)
      : null;
    const dataAtRisk = stopOperation?.state !== "settled";
    await orchestrator.settleTerminal({
      runId: draining.runId,
      runGeneration: draining.runGeneration,
      to: "stopped",
      endReason: "stop",
      termination: "terminated",
      dataAtRisk,
    });
    // settleTerminal 对已终态 run 幂等返回成功（compensation 的 terminateRun 在 draining
    // 状态下可能已先行收口且不带 dataAtRisk）。这里以持久事实为准：终态未落地则失败重试；
    // 已落地则补齐 dataAtRisk 事实（该端口不限制状态，08 §8.2「不得宣称工作全部保住」）。
    const current = await storage.runs.get(draining.runId);
    if (!current || !isTerminalRunStatus(current.status)) {
      cloudCoreLogger.warn(undefined, "cloud paused run stop settlement failed", {
        taskId: draining.taskId,
        runId: draining.runId,
      });
      return false;
    }
    if (dataAtRisk && !current.dataAtRisk) {
      await storage.runs.setRunDataAtRisk({
        runId: draining.runId,
        runGeneration: draining.runGeneration,
        dataAtRisk: true,
        now,
      });
    }
    return true;
  };
}

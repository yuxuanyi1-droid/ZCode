/**
 * 预算耗尽 + 用户显式输入的意图闭环（08 §7 修订 2026-10-09 第二批）。
 *
 * 背景（真实环境实测）：paused run（end_reason=idle-pause）上用户发消息 → append 202
 * accepted → 自驱 resume 被拒（`cloud resume rejected: pause budget exhausted`，预算=
 * 原 run 硬期限）→ 输入永远挂 accepted，UI 假等待。预算耗尽拒绝 resume 的行为是对的，
 * 缺的是「接下来用户怎么办」的闭环：用户显式发消息即继续工作意图——
 *
 *   停止旧 run（复用暂停中停止推进：drain.beginDrain 写屏障 + paused→draining→
 *   terminate→stopped，与用户显式 stop 同一实现）→ 以该消息为 prompt 串联 reopen
 *   （checkpoint 恢复语义：有 lastCheckpointSha 选 checkpoint、否则 restart-from-base；
 *   requestedConfig 随行，重开会话首发模型/模式不丢；走同一 durable gateway，revision
 *   CAS 与 08 §9 重开核验原样生效）。
 *
 * 降级（fail-safe，不重试串联）：任一步失败不自动重试——run 已终态时 UI 以 reopenable
 * 投影 + 用户手动重开接管；仍 paused/draining 时下一拍按新状态裁决。无用户输入的
 * budget-exhausted run 不进本通路（保留期尽后 keepalive liveness 收口 expired）。
 */
import type { CloudRunRecord, CloudTaskInputRecord } from "@zcode/shared";
import type { CloudCoreDeps } from "../deps.js";
import type { InputGateway } from "../inputDelivery/gateway.js";
import { cloudCoreLogger } from "../logger.js";
import type { DrainLoop } from "./drain.js";
import type { PausedStopAdvance } from "./pausedStop.js";

export interface BudgetExhaustedClosureDeps {
  readonly storage: CloudCoreDeps["storage"];
  readonly ids: CloudCoreDeps["ids"];
  readonly clock: CloudCoreDeps["clock"];
  /** durable input gateway：reopen 走同一唯一写入路径（02 §6.1）。 */
  readonly inputs: InputGateway;
  /** drain 入口：闭环停止复用「屏障 + paused→draining」同一实现（08 §8.1）。 */
  readonly drain: Pick<DrainLoop, "beginDrain">;
  /** 暂停中停止推进（pausedStop.ts 共享实现）。 */
  readonly advancePausedStop: PausedStopAdvance;
}

export type BudgetExhaustedClosure = (run: CloudRunRecord) => Promise<boolean>;

export function createBudgetExhaustedClosure(deps: BudgetExhaustedClosureDeps): BudgetExhaustedClosure {
  const { storage, ids, clock } = deps;
  const inFlight = new Set<string>();

  return async function closeBudgetExhaustedRunWithUserInput(run: CloudRunRecord): Promise<boolean> {
    if (inFlight.has(run.runId)) return false;
    if (!run.provider) {
      // provider 未知无法重开：维持现状（保留期尽后 liveness 收口）。
      return false;
    }
    inFlight.add(run.runId);
    try {
      const deliverable = await storage.inputs.listDeliverable(run.taskId);
      // 触发输入 = 用户显式发送的 append（paused→resume 的唯一入口意图；start 不会在
      // paused 到达，未投递的旧 start 行不构成「用户又要继续」的事实）。多条排队输入
      // 只携带首条（acceptanceSeq 序），其余由终态扫口如实收口。
      const trigger = deliverable.find(
        (input: CloudTaskInputRecord) =>
          input.intent === "append" &&
          input.deliveryStatus === "accepted" &&
          (input.targetRunId === undefined || input.targetRunId === run.runId),
      );
      if (!trigger) return false;
      // 先读后停：终态扫尾（settleForEndedRun）会把 accepted 收口为 cancelled。
      const payload = await storage.payloads.readInputPayload({
        taskId: run.taskId,
        commandId: trigger.commandId,
      });
      if (!payload) {
        cloudCoreLogger.warn(undefined, "cloud budget exhausted closure: payload missing", {
          taskId: run.taskId,
          runId: run.runId,
          commandId: trigger.commandId,
        });
        return false;
      }
      // 停止旧 run：屏障 + paused→draining→stopped（与用户显式 stop 同一实现）。
      const barrier = await deps.drain.beginDrain({
        taskId: run.taskId,
        runId: run.runId,
        reason: "user-stop",
      });
      if (!barrier.ok) {
        cloudCoreLogger.warn(undefined, "cloud budget exhausted closure: stop barrier failed", {
          taskId: run.taskId,
          runId: run.runId,
          code: barrier.code,
          reason: barrier.reason,
        });
        return false;
      }
      const fresh = await storage.runs.get(run.runId);
      if (!fresh || (fresh.status !== "paused" && fresh.status !== "draining")) {
        // 状态已被并发改变（用户停止/换代）：下一拍按新状态裁决，不串联重开。
        return false;
      }
      const stopped = await deps.advancePausedStop(fresh, clock.now());
      if (!stopped) {
        // 终止未确认：保持占槽由 stop sweep/compensation 收口；reopen 不串联（旧实例
        // 终止未确认时 precheck 也会拒绝），UI 落到 reopenable 投影后由用户显式重开。
        cloudCoreLogger.warn(
          undefined,
          "cloud budget exhausted closure: stop advance incomplete; reopen deferred to user",
          { taskId: run.taskId, runId: run.runId },
        );
        return false;
      }
      const task = await storage.tasks.get(run.taskId);
      if (!task || task.status === "draft" || task.status === "archived") return false;
      const requestedConfig = trigger.requestedConfig ?? trigger.resolvedExecutionConfig;
      const reopen = await deps.inputs.submit({
        principalId: task.ownerPrincipalId,
        taskId: run.taskId,
        source: "http",
        request: {
          intent: "reopen",
          commandId: ids.newId(),
          prompt: payload.prompt,
          provider: run.provider,
          resume: task.lastCheckpointSha ? { mode: "checkpoint" } : { mode: "restart-from-base" },
          expectedTaskRevision: task.revision,
          ...(requestedConfig !== undefined ? { requestedConfig } : {}),
        },
      });
      if (!reopen.ok) {
        // 串联重开被拒（stale/recovery_required/branch_conflict 等）：如实记录；run 已
        // 终态，UI 以 reopenable 投影 + 手动重开接管（既有终态通路），输入不假等待。
        cloudCoreLogger.warn(undefined, "cloud budget exhausted closure reopen rejected", {
          taskId: run.taskId,
          closedRunId: run.runId,
          code: reopen.code,
          reason: reopen.reason,
        });
        return false;
      }
      cloudCoreLogger.info(undefined, "cloud budget exhausted closure reopened with user input", {
        taskId: run.taskId,
        closedRunId: run.runId,
        reopenCommandId: reopen.value.commandId,
        resumeMode: task.lastCheckpointSha ? "checkpoint" : "restart-from-base",
      });
      return true;
    } catch (error) {
      // 闭环失败不穿透 sweep（单 run 异常隔离，D4-9）：run 状态以上一步实际落地为准。
      cloudCoreLogger.warn(undefined, "cloud budget exhausted closure failed", {
        taskId: run.taskId,
        runId: run.runId,
        message: error instanceof Error ? error.message : String(error),
      });
      return false;
    } finally {
      inFlight.delete(run.runId);
    }
  };
}

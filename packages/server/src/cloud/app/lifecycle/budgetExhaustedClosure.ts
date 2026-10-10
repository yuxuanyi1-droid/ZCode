/**
 * 预算耗尽 + 用户显式输入的意图闭环（08 §7 修订 2026-10-09 第二批；触发输入判定按
 * 03 §6 修订 2026-10-09 用 domain 谓词 `occupiesWorkspaceByInput`，accepted|delivering|
 * uncertain 都构成「用户又要继续」，与 pauseResume.sweep 的自驱 resume 同一口径）。
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
import { occupiesWorkspaceByInput } from "../../domain/deliveryStatus.js";
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

/**
 * 降级路径（terminate 未确认 / reopen 被拒）下触发输入 cancelled 收口的可读原因
 * （03 修订 2026-10-09 审计第二批）：已 202 的消息不允许无反馈地消失——落
 * `task_inputs.last_error`，UI 的 receipt/历史呈现自然可见；成功路径不写该文案
 * （消息已由 reopen 承接，标「未发出」是假话）。
 */
export const BUDGET_EXHAUSTED_INPUT_LAST_ERROR = "运行预算已耗尽，消息未能随重开发出，请重新发送";

export function createBudgetExhaustedClosure(
  deps: BudgetExhaustedClosureDeps,
): BudgetExhaustedClosure {
  const { storage, ids, clock } = deps;
  const inFlight = new Set<string>();

  /**
   * 降级路径的触发输入收口（03 修订审计第二批）：cancelled + 可读 lastError。
   * 两条降级路径各调一次：accepted/uncertain → cancelled 是边表内合法前进（uncertain
   * → cancelled 见 domain/deliveryStatus.ts）；delivering → cancelled 不在边表（对账
   * 语义保留），CAS 被拒只记 warn 不阻断——该行由终态扫尾按 delivering→uncertain 收口。
   * reopen 被拒时终态扫尾已按 run-ended 落账（markDelivery 同态幂等改写，覆盖为可读
   * 文案）。写失败不阻断降级主流程（收口事实已由终态扫尾兜底），只记 warn。
   */
  async function cancelTriggerInput(run: CloudRunRecord, commandId: string): Promise<void> {
    try {
      const marked = await storage.inputs.markDelivery({
        taskId: run.taskId,
        commandId,
        to: "cancelled",
        lastError: BUDGET_EXHAUSTED_INPUT_LAST_ERROR,
        now: clock.now(),
      });
      if (!marked) {
        cloudCoreLogger.warn(
          undefined,
          "cloud budget exhausted closure: trigger input cancel cas failed",
          { taskId: run.taskId, commandId },
        );
      }
    } catch (error) {
      cloudCoreLogger.warn(
        undefined,
        "cloud budget exhausted closure: trigger input cancel failed",
        {
          taskId: run.taskId,
          commandId,
          message: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  return async function closeBudgetExhaustedRunWithUserInput(
    run: CloudRunRecord,
  ): Promise<boolean> {
    if (inFlight.has(run.runId)) return false;
    if (!run.provider) {
      // provider 未知无法重开：维持现状（保留期尽后 liveness 收口）。
      return false;
    }
    inFlight.add(run.runId);
    try {
      const deliverable = await storage.inputs.listDeliverable(run.taskId);
      // 触发输入 = 用户显式发送的 append，投递态用 domain 唯一谓词 occupiesWorkspaceByInput
      // （accepted|delivering|uncertain；03 §6 修订 2026-10-09：idle pause 与投递并发的
      // TOCTOU、控制面重启把 delivering 归 uncertain，都会让输入停在非 accepted 态——
      // 只认 accepted 时本闭环与自驱 resume 一样把 run 留成僵尸。与 pauseResume.sweep
      // 的 resume 触发判定同一实现，不复制第二份口径）。start 不会在 paused 到达，未投递
      // 的旧 start 行不构成「用户又要继续」的事实。多条排队输入只携带首条（acceptanceSeq
      // 序，delivering/uncertain 与 accepted 同规则取 prompt），其余由终态扫口如实收口。
      const trigger = deliverable.find(
        (input: CloudTaskInputRecord) =>
          input.intent === "append" &&
          occupiesWorkspaceByInput(input.deliveryStatus) &&
          (input.targetRunId === undefined || input.targetRunId === run.runId),
      );
      if (!trigger) return false;
      // 先读后停：终态扫尾（settleForEndedRun）按 accepted→cancelled、delivering→uncertain
      // 收口，uncertain 保留对账——payload 必须在停止/扫尾前取出随 reopen 携带。
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
        // 用户反馈（03 修订审计第二批）：run 已不可能再投递（预算耗尽 + 停止屏障），
        // 触发输入此刻未被终态扫尾——按「确定未执行」收口 cancelled 并带上可读原因
        // （accepted/uncertain → cancelled 均为边表内前进；delivering 被边表拒绝时只
        // 记 warn，后续终态扫尾按 delivering→uncertain 收口对账），后续
        // settleForEndedRun 不会覆盖这条文案。
        await cancelTriggerInput(run, trigger.commandId);
        cloudCoreLogger.warn(
          undefined,
          "cloud budget exhausted closure: stop advance incomplete; reopen deferred to user",
          { taskId: run.taskId, runId: run.runId, triggerCommandId: trigger.commandId },
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
        // 用户反馈（03 修订审计第二批）：终态扫尾已把触发输入按 run-ended 落 cancelled，
        // 这里幂等改写（同态 CAS）补注可读原因，让用户知道要重新发送而不是干等。
        await cancelTriggerInput(run, trigger.commandId);
        cloudCoreLogger.warn(undefined, "cloud budget exhausted closure reopen rejected", {
          taskId: run.taskId,
          closedRunId: run.runId,
          triggerCommandId: trigger.commandId,
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

/**
 * 交互（权限/审批）决定的路由、围栏与持久投递（03 §7.2「权限应答/取消命令绑定
 * interactionId/sessionId/logEpoch/currentRun，过时返回 stale；相同审批两端同时提交由
 * runtime 唯一裁决」、02 §6.3「断网时控制面不代替 runtime 完成取消/审批」、
 * 03 §4 `task_input_interaction_decisions` 表）。
 *
 * 唯一 owner：**runtime 裁决审批**。控制面负责：主体/代际围栏 → 持久记录决定
 * （`InteractionDecisionRepo`，与正文输入共用 deliveryStatus 词表）→ 经同一 attachment
 * 传输投递 → 结果由 ACK 通道/投影落地。已 admitted 决定的取消使用独立 `cancelCommandId`
 * 发一条 runtime 取消命令，不删除 runtime 已接受的事实，也不把原决定伪造成 cancelled。
 *
 * 未接线 `interactionDecisions` 时返回结构化 `not_implemented`：不伪造持久 receipt，
 * 也不产生没有持久记录的副作用。
 */
import type { CloudRunRecord, CloudTaskRecord } from "@zcode/shared";
import type { CloudAppFailure, CloudAppResult } from "../result.js";
import type { CloudCoreDeps } from "../deps.js";
import type { CloudTaskInputRecord } from "@zcode/shared";
import { cloudCoreLogger } from "../logger.js";
import { fail, ok } from "../result.js";
import { fenceFrame } from "../../domain/fencing.js";
import { canonicalizeForFingerprint } from "../../domain/idempotency.js";
import { CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS } from "../ports/inputPort.js";
import type { AttachmentRegistry, AttachmentSession } from "../attachments/registry.js";
import { buildInteractionCommandEnvelope } from "../inputDelivery/envelope.js";
import { resolveRuntimeSession } from "../runSession.js";
import {
  currentDecisionReceipt,
  receiptOf,
  type CancelInteractionDecision,
  type GetInteractionDecision,
  type InteractionDecisionReceipt,
  type SubmitInteractionDecision,
} from "./interactionDecisionTypes.js";

export type {
  CancelInteractionDecision,
  GetInteractionDecision,
  InteractionAnswer,
  InteractionDecisionReceipt,
  SubmitInteractionDecision,
} from "./interactionDecisionTypes.js";

export interface InteractionCommands {
  submitDecision(
    input: SubmitInteractionDecision,
  ): Promise<CloudAppResult<InteractionDecisionReceipt>>;
  cancelDecision(
    input: CancelInteractionDecision,
  ): Promise<CloudAppResult<InteractionDecisionReceipt>>;
  /** 只读回执查询（响应丢失/重启恢复）：从既有决定记录读取，不产生状态转移。 */
  getDecision(input: GetInteractionDecision): Promise<CloudAppResult<InteractionDecisionReceipt>>;
}

export function createInteractionCommands(
  deps: CloudCoreDeps,
  registry: AttachmentRegistry,
): InteractionCommands {
  const { storage, attachments, clock, hash } = deps;

  type FencedRunContext =
    | { failure: CloudAppFailure }
    | { task: CloudTaskRecord; run: CloudRunRecord };

  /**
   * 围栏（task 归属 + run/generation + 停止意图）：**不含** attachment/session 前提。
   * 决定的持久接纳先于投递（W0 端口注释：载荷持久保存，dispatcher 崩溃/重启后据此重建），
   * 因此 attachment 未就绪不能让接纳失败，只让投递停在 accepted。
   */
  async function fencedRun(
    principalId: string,
    taskId: string,
    runId: string,
    runGeneration: number,
  ): Promise<FencedRunContext> {
    const task = await storage.tasks.get(taskId);
    if (!task || task.ownerPrincipalId !== principalId) {
      return { failure: fail("not_found", "task-not-found") };
    }
    const run = await storage.runs.get(runId);
    if (!run || run.taskId !== taskId) return { failure: fail("not_found", "run-not-found") };
    const fence = fenceFrame({
      frameGeneration: runGeneration,
      currentGeneration: run.runGeneration,
    });
    if (!fence.accepted) return { failure: fail("stale", fence.reason) };
    if (run.stopRequested) return { failure: fail("stale", "stop-requested") };
    return { task, run };
  }

  /** 投递前提：runtime session 映射 + 当前 ready attachment；任一缺失即不投递（不伪造 sent）。 */
  async function deliveryContext(
    run: CloudRunRecord,
  ): Promise<
    { failure: CloudAppFailure } | { runtimeSessionId: string; session: AttachmentSession }
  > {
    const runtimeSessionId = await resolveRuntimeSession(deps, run);
    if (!runtimeSessionId) return { failure: fail("not_ready", "runtime-session-unknown") };
    const session = registry.current(run.runId);
    if (!session?.ready) return { failure: fail("not_ready", "attachment-not-ready") };
    return { runtimeSessionId, session };
  }

  async function deliver(input: {
    taskId: string;
    commandId: string;
    run: CloudRunRecord;
    connectionEpoch: number;
    envelope: unknown;
  }): Promise<CloudAppResult<{ delivery: "sent" }>> {
    const send = await attachments.sendCommand({
      taskId: input.taskId,
      commandId: input.commandId,
      envelope: input.envelope,
      expectation: {
        runGeneration: input.run.runGeneration,
        connectionEpoch: input.connectionEpoch,
        requireReady: true,
      },
    });
    if (send.status === "sent") return ok({ delivery: "sent" as const });
    switch (send.reason) {
      case "no-attachment":
      case "not-ready":
        return fail("not_ready", send.reason);
      default:
        // stale / closed：过期 interaction 与旧 Run 一律 stale（03 §7.2）。
        return fail("stale", send.reason);
    }
  }

  async function cancelAdmittedDecision(
    decision: {
      taskId: string;
      interactionId: string;
      runId?: string;
      runGeneration?: number;
      deliveryStatus: CloudTaskInputRecord["deliveryStatus"];
    },
    input: CancelInteractionDecision,
  ): Promise<CloudAppResult<InteractionDecisionReceipt>> {
    if (!decision.runId || decision.runGeneration === undefined) {
      return fail("stale", "decision-run-unknown");
    }
    const context = await fencedRun(
      input.principalId,
      input.taskId,
      decision.runId,
      decision.runGeneration,
    );
    if ("failure" in context) return context.failure;
    const delivery = await deliveryContext(context.run);
    if ("failure" in delivery) return delivery.failure;
    const envelope = buildInteractionCommandEnvelope({
      taskId: input.taskId,
      commandId: input.cancelCommandId,
      runtimeSessionId: delivery.runtimeSessionId,
      interactionId: input.interactionId,
      // 取消是独立命令：action=cancel，不覆盖原决定记录（02 §6.3）。
      answer: { action: "cancel" },
      now: clock.now(),
    });
    if (!envelope.ok) return fail("validation_failed", envelope.reason);
    const delivered = await deliver({
      taskId: input.taskId,
      commandId: input.cancelCommandId,
      run: context.run,
      connectionEpoch: delivery.session.connectionEpoch,
      envelope: envelope.envelope,
    });
    if (!delivered.ok) return delivered;
    const decisions = deps.interactionDecisions;
    if (decisions) {
      await decisions.recordCancelIntent({
        taskId: input.taskId,
        commandId: input.commandId,
        cancelCommandId: input.cancelCommandId,
      });
      // 不把原决定伪造成 cancelled（02 §6.3）：receipt 取记录的最新事实，避免原决定的
      // ACK 在投递取消命令期间落地时返回滞后状态（与上面的快速 ACK 兜底同口径）。
      const current = await decisions.getDecision(input.taskId, input.interactionId);
      if (current) {
        return ok(receiptOf(current.taskId, current.interactionId, current.deliveryStatus));
      }
    }
    return ok(receiptOf(decision.taskId, decision.interactionId, decision.deliveryStatus));
  }

  return {
    async submitDecision(input) {
      const decisions = deps.interactionDecisions;
      if (!decisions) {
        return fail("not_implemented", "interaction-decision-persistence-missing");
      }
      const context = await fencedRun(
        input.principalId,
        input.taskId,
        input.runId,
        input.runGeneration,
      );
      if ("failure" in context) return context.failure;

      // 决定载荷的规范 fingerprint：同键不同载荷冲突（02 §6.2 同语义）。
      const payloadJson = JSON.stringify({ answer: input.answer });
      if (payloadJson.length > CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS) {
        return fail("validation_failed", "interaction-payload-too-large");
      }
      const payloadHash = await hash.sha256Hex(
        canonicalizeForFingerprint({
          v: 1,
          kind: input.kind,
          interactionId: input.interactionId,
          answer: input.answer,
        }),
      );

      const existing = await decisions.getDecision(input.taskId, input.interactionId);
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          return fail("idempotency_conflict", "interaction-payload-mismatch");
        }
        if (existing.deliveryStatus !== "accepted") {
          // 合法重放：返回既有 receipt，不重复投递（03 §6.1 同语义）。
          return ok(receiptOf(existing.taskId, existing.interactionId, existing.deliveryStatus));
        }
      } else {
        await decisions.recordDecision({
          taskId: input.taskId,
          interactionId: input.interactionId,
          // 投递给 runtime 用的 commandId：ACK 按它回投，控制面据此把状态写回本记录。
          deliveryCommandId: input.commandId,
          kind: input.kind,
          payloadJson,
          payloadHash,
          runId: context.run.runId,
          runGeneration: context.run.runGeneration,
        });
      }

      // 投递前提（session + ready attachment）：不满足即停在 accepted，等重连/重装后投递。
      const delivery = await deliveryContext(context.run);
      if ("failure" in delivery) {
        const pending = await decisions.setDecisionDeliveryStatus({
          taskId: input.taskId,
          interactionId: input.interactionId,
          status: "accepted",
          lastError: delivery.failure.reason,
        });
        if (!pending) {
          // 写 accepted 也可能被快速 ACK 抢先（记录已推进到 admitted/rejected）：
          // 读回真实状态返回，不把已落地的决定报告成 stale。
          return currentDecisionReceipt(decisions, input.taskId, input.interactionId);
        }
        return ok(receiptOf(pending.taskId, pending.interactionId, pending.deliveryStatus));
      }

      const envelope = buildInteractionCommandEnvelope({
        taskId: input.taskId,
        commandId: input.commandId,
        runtimeSessionId: delivery.runtimeSessionId,
        interactionId: input.interactionId,
        answer: input.answer,
        now: clock.now(),
      });
      if (!envelope.ok) return fail("validation_failed", envelope.reason);

      const delivered = await deliver({
        taskId: input.taskId,
        commandId: input.commandId,
        run: context.run,
        connectionEpoch: delivery.session.connectionEpoch,
        envelope: envelope.envelope,
      });
      const status = delivered.ok
        ? "delivering"
        : delivered.code === "stale"
          ? "uncertain"
          : "accepted";
      const updated = await decisions.setDecisionDeliveryStatus({
        taskId: input.taskId,
        interactionId: input.interactionId,
        status,
        ...(delivered.ok ? {} : { lastError: delivered.reason }),
      });
      // ACK 可能先于本 CAS 到达：`recordRuntimeAck` 已把记录推进到 admitted/rejected，
      // 从 delivering 回写会被状态机拒绝（02 §6.3）。重新读取记录返回真实 receipt，
      // 而不是把已经成功的决定报告成 409 stale。
      if (!updated) return currentDecisionReceipt(decisions, input.taskId, input.interactionId);
      cloudCoreLogger.debug(undefined, "cloud interaction decision delivered", {
        taskId: input.taskId,
        runId: context.run.runId,
        interactionId: input.interactionId,
        deliveryStatus: status,
      });
      return ok(receiptOf(updated.taskId, updated.interactionId, updated.deliveryStatus));
    },

    async cancelDecision(input) {
      const decisions = deps.interactionDecisions;
      if (!decisions) {
        return fail("not_implemented", "interaction-decision-persistence-missing");
      }
      const task = await storage.tasks.get(input.taskId);
      if (!task || task.ownerPrincipalId !== input.principalId) {
        return fail("not_found", "task-not-found");
      }
      // 快速 ACK 可能把 accepted 推进到 admitted，或把 delivering/uncertain 推进到终态，
      // 使下面的 cancelled/uncertain CAS 返回 null（2026-10-17 修复）：这不是取消失败，
      // 而是持久事实已前进（ACK 权威，02 §6.3）。重读记录后按最新状态重新裁决；
      // 仍被并发推进时最多重试一次，最后才报告 cancel-race，不把已落地事实误报成成功/失败。
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const decision = await decisions.getDecision(input.taskId, input.interactionId);
        if (!decision) return fail("not_found", "interaction-decision-not-found");
        if (decision.deliveryStatus === "cancelled" || decision.deliveryStatus === "rejected") {
          return ok(receiptOf(decision.taskId, decision.interactionId, decision.deliveryStatus));
        }
        if (decision.deliveryStatus === "accepted") {
          // 尚未开始投递：直接撤销投递意图（不构成副作用回滚承诺）。
          const cancelled = await decisions.setDecisionDeliveryStatus({
            taskId: input.taskId,
            interactionId: input.interactionId,
            status: "cancelled",
          });
          if (cancelled) {
            return ok(
              receiptOf(cancelled.taskId, cancelled.interactionId, cancelled.deliveryStatus),
            );
          }
          continue;
        }
        if (decision.deliveryStatus === "delivering" || decision.deliveryStatus === "uncertain") {
          // 已投递但 ACK 未知：**先对账**，不能声称 runtime 已停止（02 §6.3、CP-14）。
          if (!decision.runId || decision.runGeneration === undefined) {
            return fail("not_ready", "decision-ack-unknown");
          }
          const query = await deps.runtimeCommands.queryCommand({
            taskId: input.taskId,
            runId: decision.runId,
            runGeneration: decision.runGeneration,
            commandId: decision.deliveryCommandId,
          });
          if (query.status === "unknown") {
            // runtime 明确没有该命令事实：先把对账证据落成 uncertain（delivering 不可直接撤销），
            // 再撤销投递意图——两步都是状态机内的前进（domain/deliveryStatus）。
            if (decision.deliveryStatus === "delivering") {
              await decisions.setDecisionDeliveryStatus({
                taskId: input.taskId,
                interactionId: input.interactionId,
                status: "uncertain",
                lastError: "reconciled-no-runtime-record",
              });
            }
            const cancelled = await decisions.setDecisionDeliveryStatus({
              taskId: input.taskId,
              interactionId: input.interactionId,
              status: "cancelled",
            });
            if (cancelled) {
              return ok(
                receiptOf(cancelled.taskId, cancelled.interactionId, cancelled.deliveryStatus),
              );
            }
            continue;
          }
          if (query.status !== "found") return fail("not_ready", "decision-ack-unknown");
          // runtime 已裁决（admitted 事实）：走下面的独立 cancelCommandId。
        }
        return await cancelAdmittedDecision(decision, input);
      }
      // 两次都被并发推进（ACK/并发取消）：只报告竞态，不伪造终态。
      return fail("stale", "decision-cancel-race");
    },

    async getDecision(input) {
      const decisions = deps.interactionDecisions;
      if (!decisions) {
        return fail("not_implemented", "interaction-decision-persistence-missing");
      }
      // 主体围栏与 submit/cancel 同口径：跨主体统一 not_found，不泄漏任务存在性。
      const task = await storage.tasks.get(input.taskId);
      if (!task || task.ownerPrincipalId !== input.principalId) {
        return fail("not_found", "task-not-found");
      }
      const decision = await decisions.getDecision(input.taskId, input.interactionId);
      if (!decision) return fail("not_found", "interaction-decision-not-found");
      // 只读：不发命令、不改 deliveryStatus（重放/恢复由 submitDecision 的幂等路径负责）。
      return ok(receiptOf(decision.taskId, decision.interactionId, decision.deliveryStatus));
    },
  };
}

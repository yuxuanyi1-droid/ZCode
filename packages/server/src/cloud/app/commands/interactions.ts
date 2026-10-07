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

export interface InteractionAnswer {
  optionId?: string;
  freeText?: string;
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

export interface SubmitInteractionDecision {
  principalId: string;
  taskId: string;
  /** 投递命令键（客户端生成、重试不变）；决定本身按 interactionId 唯一。 */
  commandId: string;
  runId: string;
  runGeneration: number;
  interactionId: string;
  /** 决定类别由入口按权威投影的 pendingInteractions[].kind 给出，不在此猜测。 */
  kind: "permission" | "elicitation";
  answer: InteractionAnswer;
}

export interface InteractionDecisionReceipt {
  taskId: string;
  interactionId: string;
  deliveryStatus: CloudTaskInputRecord["deliveryStatus"];
}

export interface CancelInteractionDecision {
  principalId: string;
  taskId: string;
  interactionId: string;
  /** 原决定的投递命令键（决定记录本身不含它）；用于记录取消意图。 */
  commandId: string;
  /** 独立取消命令键：不删除 runtime 已接受的接受事实（02 §6.3）。 */
  cancelCommandId: string;
}

export interface InteractionCommands {
  submitDecision(
    input: SubmitInteractionDecision,
  ): Promise<CloudAppResult<InteractionDecisionReceipt>>;
  cancelDecision(
    input: CancelInteractionDecision,
  ): Promise<CloudAppResult<InteractionDecisionReceipt>>;
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
    await deps.interactionDecisions?.recordCancelIntent({
      taskId: input.taskId,
      commandId: input.commandId,
      cancelCommandId: input.cancelCommandId,
    });
    // receipt 仍是原决定（deliveryStatus=admitted）：取消命令的落地由 ACK 通道投影，
    // 不把原决定伪造成 cancelled（02 §6.3）。
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
        if (!pending) return fail("stale", "decision-record-missing");
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
      if (!updated) return fail("stale", "decision-record-missing");
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
        if (!cancelled) return fail("stale", "decision-cancel-race");
        return ok(receiptOf(cancelled.taskId, cancelled.interactionId, cancelled.deliveryStatus));
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
        }
        if (query.status !== "found") return fail("not_ready", "decision-ack-unknown");
        // runtime 已裁决（admitted 事实）：走下面的独立 cancelCommandId。
      }
      return await cancelAdmittedDecision(decision, input);
    },
  };
}

function receiptOf(
  taskId: string,
  interactionId: string,
  deliveryStatus: CloudTaskInputRecord["deliveryStatus"],
): InteractionDecisionReceipt {
  return { taskId, interactionId, deliveryStatus };
}

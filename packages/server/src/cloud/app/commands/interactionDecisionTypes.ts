/**
 * 交互决定的命令契约与回执读取（`interactions.ts` 的公开类型面，拆出以保持 app 命令
 * 文件在架构行数上限内）。
 *
 * 回执只从持久记录读取：`currentDecisionReceipt` 是投递/取消 CAS 返回 null 时的唯一
 * 兜底——runtime ACK 可能先于控制面写 `delivering` 到达并推进记录（02 §6.3），
 * 记录仍在就返回其真实状态，只有记录不存在才 stale。
 */
import type { CloudTaskInputRecord } from "@zcode/shared";
import type { InteractionDecisionRepo } from "../ports/inputPort.js";
import type { CloudAppResult } from "../result.js";
import { fail, ok } from "../result.js";
import { cloudCoreLogger } from "../logger.js";

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

export interface GetInteractionDecision {
  principalId: string;
  taskId: string;
  interactionId: string;
}

export function receiptOf(
  taskId: string,
  interactionId: string,
  deliveryStatus: CloudTaskInputRecord["deliveryStatus"],
): InteractionDecisionReceipt {
  return { taskId, interactionId, deliveryStatus };
}

/**
 * 状态 CAS 返回 null 时的兜底（2026-10-17 修复「快速 ACK 被误报 409」）：
 * runtime 的 CommandAck 可能先于控制面写 `delivering`/`accepted` 到达，
 * `recordRuntimeAck` 已把记录推进到 admitted/rejected（ACK 是权威结论，02 §6.3）。
 * 此时 `setDecisionDeliveryStatus` 按状态机拒绝回退并返回 null；记录仍在，就返回它的
 * 当前持久状态（可能是 admitted/rejected/cancelled/delivering），不能伪造状态，
 * 也不能把已成功的决定报告成 stale。只有记录真的不存在才是 stale。
 */
export async function currentDecisionReceipt(
  decisions: InteractionDecisionRepo,
  taskId: string,
  interactionId: string,
): Promise<CloudAppResult<InteractionDecisionReceipt>> {
  const current = await decisions.getDecision(taskId, interactionId);
  if (!current) return fail("stale", "decision-record-missing");
  cloudCoreLogger.debug(undefined, "interaction decision advanced before status write", {
    taskId,
    interactionId,
    deliveryStatus: current.deliveryStatus,
  });
  return ok(receiptOf(current.taskId, current.interactionId, current.deliveryStatus));
}

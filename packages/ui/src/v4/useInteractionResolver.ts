/**
 * 审批/交互决定的提交收口（specs/cloud-agent 03 §7.2、spec 15 §R6）。
 *
 * 单独成 hook 的原因：V4InteractionDialogs 已接近 max-lines 门禁；这里的判定是
 * 「云模式走 durable HTTP，非云模式保持既有 agent transport」，与弹窗渲染无关。
 * 云模式只按 receipt.deliveryStatus 分类：admitted 成功；accepted/delivering/uncertain
 * 仍是提交中；失败走既有错误路径，不合成 CommandAck。
 */
import { useCallback } from "react";
import type { CommandAck, CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  buildCloudInteractionDecisionRequest,
  submitCloudInteractionDecision,
  type CloudInteractionRoute,
} from "@/cloud/cloudInteractionDecision.js";
import { createCloudCommandId } from "@/hooks/cloud/useSubmitCloudInput.js";
import { logger } from "@/logger.js";
import { createCommandEnvelope } from "@/v4/commandFactory.js";
import { pendingCommandRegistry } from "@/v4/pendingCommandRegistry.js";

export interface InteractionAnswer {
  optionId?: string;
  freeText?: string;
  action?: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}

/** 弹窗只需要「是否可收口」三态；云/本地两条通路的 ACK 词表在此归一。 */
export interface InteractionResponseResult {
  readonly status: "success" | "pending" | "failed";
}

export interface UseInteractionResolverParams {
  sessionId: string;
  sendCommand: (envelope: CommandEnvelope) => Promise<CommandAck>;
  onCommandSettled?: ((commandId: string) => void) | undefined;
  /** 由 `resolveCloudInteractionRoute(useCloudWorkspaceContext())` 得到。 */
  cloudRoute: CloudInteractionRoute;
}

export function useInteractionResolver(
  params: UseInteractionResolverParams,
): (
  interactionId: string,
  kind: "permission" | "elicitation",
  answer: InteractionAnswer,
) => Promise<InteractionResponseResult> {
  const { sessionId, sendCommand, onCommandSettled, cloudRoute } = params;

  return useCallback(
    async (interactionId, kind, answer): Promise<InteractionResponseResult> => {
      if (cloudRoute.mode !== "local") {
        if (cloudRoute.mode === "cloud-unavailable") {
          // 云入口已挂载但 Task/Run 不可用：fail-closed，不回落到 agent 写命令
          // （relay 的 client scope 同样会拒绝直发）。
          logger.warn("[v4-interaction] 云模式交互缺少可用 Task/Run", {
            interactionId,
            reason: cloudRoute.reason,
          });
          return { status: "failed" };
        }
        const outcome = await submitCloudInteractionDecision({
          controlPlane: cloudRoute.controlPlane,
          taskId: cloudRoute.taskId,
          interactionId,
          request: buildCloudInteractionDecisionRequest({
            // 客户端生成、本次意图仅用一次；服务端按 interactionId + answer 幂等。
            commandId: createCloudCommandId(),
            runId: cloudRoute.runId,
            runGeneration: cloudRoute.runGeneration,
            kind,
            answer,
          }),
        });
        if (outcome.status === "failed") {
          logger.warn("[v4-interaction] 云交互决定提交失败", {
            interactionId,
            message: outcome.message,
          });
          return { status: "failed" };
        }
        // admitted 才是 runtime 裁决；accepted/delivering/uncertain 只显示提交中。
        return { status: outcome.status === "admitted" ? "success" : "pending" };
      }

      const envelope = createCommandEnvelope({
        type: "resolveInteraction",
        sessionId,
        payload: { interactionId, answer },
      });
      // 权限/freeText/content 不落盘；registry 只持摘要，用于 ACK 丢失后的 query 对账。
      pendingCommandRegistry.record(envelope);
      try {
        const ack = await sendCommand(envelope);
        pendingCommandRegistry.applyAck(envelope, ack);
        const accepted =
          ack.status === "accepted" || ack.status === "duplicate" || ack.status === "noop";
        if (!accepted) {
          logger.warn("[v4-interaction] resolveInteraction 被拒绝", {
            interactionId,
            status: ack.status,
            reasonCode: ack.reasonCode,
          });
        }
        return { status: accepted ? "success" : "failed" };
      } catch (error) {
        logger.error("[v4-interaction] resolveInteraction 失败", { interactionId, error });
        return { status: "failed" };
      } finally {
        onCommandSettled?.(envelope.commandId);
      }
    },
    [cloudRoute, onCommandSettled, sendCommand, sessionId],
  );
}

/**
 * Bridge 入站帧路由（specs/cloud-agent/02 §4 帧表与尾段、§0 RPC 承载、§7.2 投影 ACK）。
 *
 * 方向/版本/尺寸校验在 domain/bridgeFrames.ts（整帧拒绝即作废连接）；本文件只按类型派发。
 * 所有需要代际的操作先取当前 attachment 上下文（未 ready 或旧 epoch 一律不执行）。
 */
import type {
  BootstrapConfigFrame,
  BridgeDrainFrame,
  BridgeWelcomeFrame,
  CheckpointRequestFrame,
  CloudBridgeControlFrame,
  ProjectionAckFrame,
} from "@zcode/shared";
import { CLOUD_BRIDGE_PROTOCOL_VERSION } from "@zcode/shared";
import { decodeBridgeFrame } from "../domain/bridgeFrames.js";
import {
  connectionContext,
  logBridgeState,
  sendFrame,
  type BridgeRuntimeState,
  type BridgeSessionOptions,
} from "./bridgeState.js";
import type { BridgeConnectionPort } from "./ports.js";

/** 仅取判别字段与字段名用于诊断（有界），**不取值、不记正文**：帧正文可能含会话内容。 */
function describeRejectedFrame(text: string): { frameType: string; keys: string } {
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null) return { frameType: "", keys: "" };
    const frameType = typeof raw["type"] === "string" ? String(raw["type"]).slice(0, 64) : "";
    const keys = Object.keys(raw).sort().join(",").slice(0, 200);
    return { frameType, keys };
  } catch {
    return { frameType: "", keys: "" };
  }
}

/** 入站文本帧的总入口：解析失败即关闭连接（不忽略单帧）。 */
export function handleInboundText(
  state: BridgeRuntimeState,
  options: BridgeSessionOptions,
  text: string,
  connection: BridgeConnectionPort,
): void {
  const decoded = decodeBridgeFrame(text, "bridge");
  if (!decoded.ok) {
    // 帧被拒会让本节点主动关连接（控制面只见 4001 + reason）：这里把类型、字段名与字节数一起
    // 记下，否则"哪一帧、为什么"只能靠猜（2026-10-07 真实链路就吃过这一次）。
    const described = describeRejectedFrame(text);
    options.logger.warn(undefined, "bridge inbound frame rejected", {
      reason: decoded.reason,
      bytes: text.length,
      ...described,
    });
    connection.close(`frame-rejected:${decoded.reason}`);
    return;
  }
  if (decoded.value.kind === "rpc") {
    const context = connectionContext(state, options.address);
    // 旧代际或未 ready 的 RPC 帧丢弃：转发必须逐帧校验当前 ready attachment（02 §0）。
    if (context) options.rpcRelay.handle(decoded.value.frame, context);
    return;
  }
  void handleControlFrame(state, options, decoded.value.frame, connection).catch(
    (error: unknown) => {
      options.logger.error(undefined, "bridge control frame handler failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    },
  );
}

export async function handleControlFrame(
  state: BridgeRuntimeState,
  options: BridgeSessionOptions,
  frame: CloudBridgeControlFrame,
  connection: BridgeConnectionPort,
): Promise<void> {
  switch (frame.type) {
    case "bridge.welcome":
      state.welcomeSlot?.resolve(frame as BridgeWelcomeFrame);
      return;
    case "bootstrap.config":
      state.configSlot?.resolve(frame as BootstrapConfigFrame);
      return;
    case "projection.ack": {
      const ack = frame as ProjectionAckFrame;
      // 只清匹配源流的连续水位；不跨缺口、不把 ingestCursor 当本地下标（02 §7.1）。
      await options.projection.onAck({
        topic: ack.topic,
        logEpoch: ack.logEpoch,
        lastContiguousSourceSeq: ack.lastContiguousSourceSeq,
      });
      return;
    }
    case "checkpoint.request": {
      const request = frame as CheckpointRequestFrame;
      const context = connectionContext(state, options.address);
      if (!context || request.connectionEpoch !== context.connectionEpoch) return;
      // operationId 幂等：重放复用已记录结果（01 §8），不产生第二个保存事实。
      const replay = state.seenOperationIds.has(request.operationId);
      state.seenOperationIds.add(request.operationId);
      if (replay) {
        options.logger.info(undefined, "checkpoint replay: reusing recorded result", {
          operationId: request.operationId,
        });
      }
      const result = await options.checkpoint.run(request);
      sendFrame(connection, {
        protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
        type: "checkpoint.result",
        ...result,
      });
      return;
    }
    case "bridge.drain": {
      const drain = frame as BridgeDrainFrame;
      if (state.status !== "draining") {
        logBridgeState(state, options.logger, "draining", { operationId: drain.operationId });
        await options.drain.onDrain({ operationId: drain.operationId, reason: drain.reason });
      }
      connection.close("drained");
      return;
    }
    case "bridge.fault": {
      if (!state.connectionReady) {
        // 控制面拒绝当前凭据：按 02 §5.2 阶梯记录，重连时换下一条恢复路径。
        options.logger.warn(undefined, "bridge fault before ready", {
          faultCode: frame.faultCode,
          retryable: frame.retryable,
        });
        state.rejected = true;
      }
      return;
    }
    default:
      return;
  }
}

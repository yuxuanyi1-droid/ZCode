/**
 * 浏览器 RPC 流的多路复用（specs/cloud-agent 02 §0「原 Web UI 的受控 RPC 承载」、§4 尾段、
 * 03 §7.1 沙箱通道分面）。
 *
 * 分工：浏览器仍是原 ChannelClient（W7/W8），沙箱侧由 W6 的 `rpcRelay` 为每条 streamId 建
 * ChannelServer；**控制面只做受控转发**，不解析业务命令、不复制白名单。本文件是控制面这一半：
 * 分配 streamId、把浏览器字节封成 `rpc.open/request`、把 `rpc.response` 回投浏览器、
 * 每帧按当前 ready attachment 的 run/generation/epoch 围栏（旧代际拒绝，02 §2 不变量 3）。
 */
import {
  CLOUD_RPC_PAYLOAD_MAX_BYTES,
  CLOUD_RPC_PROTOCOL_VERSION,
  type CloudRpcFrame,
} from "@zcode/shared";
import { cloudCoreLogger } from "../../app/logger.js";

export type RpcFrameSender = (frame: CloudRpcFrame) => boolean;

export interface BrowserRpcStream {
  readonly streamId: string;
  /** 浏览器 → 沙箱：把 ChannelClient 字节封成 `rpc.request`。 */
  forwardToSandbox(payload: Buffer): void;
  /** 浏览器断开：终止该流并通知沙箱释放会话（不重放字节，02 §8）。 */
  close(reason: string): void;
}

export interface OpenBrowserRpcStreamInput {
  runId: string;
  runGeneration: number;
  connectionEpoch: number;
  /** 沙箱 → 浏览器：把 `rpc.response` 的 payload 原样交给浏览器 socket。 */
  deliver(payload: Buffer): void;
  /** 流被终止（沙箱主动 close / 连接释放 / 帧不合法）时通知调用方关闭浏览器 socket。 */
  onClosed(reason: string): void;
}

export interface BrowserRpcMultiplexer {
  /** 打开一条流；发送 `rpc.open` 失败（无连接/旧代际）时返回 null，调用方按 4503 关闭。 */
  open(input: OpenBrowserRpcStreamInput): BrowserRpcStream | null;
  /** 沙箱入站的 `rpc.*` 帧：只处理本流请求与 close，且必须与流的代际一致。 */
  handleInbound(frame: CloudRpcFrame): void;
  /** 连接释放/run 终止：终止该 run 的全部浏览器流（不重放、不缓存字节）。 */
  closeRun(runId: string, reason: string): void;
  closeAll(reason: string): void;
}

interface StreamState extends OpenBrowserRpcStreamInput {
  streamId: string;
}

export function createBrowserRpcMultiplexer(input: {
  sendFrame: RpcFrameSender;
  newStreamId: () => string;
}): BrowserRpcMultiplexer {
  const streams = new Map<string, StreamState>();

  function closeStream(state: StreamState, reason: string, notifySandbox: boolean): void {
    streams.delete(state.streamId);
    if (notifySandbox) {
      input.sendFrame({
        protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
        type: "rpc.close",
        runId: state.runId,
        runGeneration: state.runGeneration,
        connectionEpoch: state.connectionEpoch,
        streamId: state.streamId,
      });
    }
    cloudCoreLogger.debug(undefined, "cloud browser rpc stream closed", {
      runId: state.runId,
      streamId: state.streamId,
      reason,
    });
    state.onClosed(reason);
  }

  return {
    open(openInput) {
      const state: StreamState = { ...openInput, streamId: input.newStreamId() };
      // 先登记再发 rpc.open：沙箱的 Initialize 响应可能在同一 tick 内回来，
      // 未登记会把初始化响应当作未知流丢掉（调用方随后永远等不到响应）。
      streams.set(state.streamId, state);
      const sent = input.sendFrame({
        protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
        type: "rpc.open",
        runId: state.runId,
        runGeneration: state.runGeneration,
        connectionEpoch: state.connectionEpoch,
        streamId: state.streamId,
      });
      if (!sent) {
        streams.delete(state.streamId);
        return null;
      }
      return {
        streamId: state.streamId,
        close(reason) {
          const current = streams.get(state.streamId);
          if (current) closeStream(current, reason, true);
        },
        forwardToSandbox(payload) {
          const current = streams.get(state.streamId);
          if (!current) return;
          if (payload.byteLength > CLOUD_RPC_PAYLOAD_MAX_BYTES) {
            // 有界资源：超限即关闭该流（不静默丢字节后继续假装连续，02 §8）。
            cloudCoreLogger.warn(undefined, "cloud browser rpc payload too large", {
              runId: state.runId,
              bytes: payload.byteLength,
            });
            closeStream(current, "payload-too-large", true);
            return;
          }
          const sentRequest = input.sendFrame({
            protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
            type: "rpc.request",
            runId: current.runId,
            runGeneration: current.runGeneration,
            connectionEpoch: current.connectionEpoch,
            streamId: current.streamId,
            payload: payload.toString("base64"),
          });
          if (!sentRequest) closeStream(current, "bridge-unavailable", false);
        },
      };
    },

    handleInbound(frame) {
      const state = streams.get(frame.streamId);
      if (!state) {
        // 有界告警：响应找不到流说明开/关注记失配（或沙箱回发了已关闭流的迟到帧）。
        // 静默丢弃会让浏览器 Initialize 永远超时而无从排查（2026-10-07 真实链路）。
        if (frame.type === "rpc.response") {
          cloudCoreLogger.warn(undefined, "cloud browser rpc response for unknown stream", {
            runId: frame.runId,
            streamId: frame.streamId,
            bytes: frame.payload?.length ?? 0,
          });
        }
        return;
      }
      // 围栏：帧必须与流的 run/generation/epoch 一致，旧代际帧拒绝（02 §2 不变量 3）。
      if (
        frame.runId !== state.runId ||
        frame.runGeneration !== state.runGeneration ||
        frame.connectionEpoch !== state.connectionEpoch
      ) {
        cloudCoreLogger.warn(undefined, "cloud browser rpc frame rejected: stale attachment", {
          runId: state.runId,
          streamId: frame.streamId,
          frameEpoch: frame.connectionEpoch,
          currentEpoch: state.connectionEpoch,
        });
        return;
      }
      switch (frame.type) {
        case "rpc.response": {
          const payload = Buffer.from(frame.payload, "base64");
          if (payload.byteLength > CLOUD_RPC_PAYLOAD_MAX_BYTES) {
            closeStream(state, "payload-too-large", true);
            return;
          }
          state.deliver(payload);
          return;
        }
        case "rpc.close":
          closeStream(state, "sandbox-closed", false);
          return;
        default:
          // open/request 是出站方向：入站即拒绝（03 §7.1 方向校验）。
          closeStream(state, "unexpected-frame-direction", true);
          return;
      }
    },

    closeRun(runId, reason) {
      // 快照迭代：closeStream 会在遍历中删除条目。
      for (const state of Array.from(streams.values())) {
        if (state.runId === runId) closeStream(state, reason, false);
      }
    },

    closeAll(reason) {
      // 快照迭代：closeStream 会在遍历中删除条目。
      for (const state of Array.from(streams.values())) closeStream(state, reason, false);
    },
  };
}

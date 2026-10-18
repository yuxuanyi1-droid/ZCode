/**
 * 控制面 RPC 会话通道（M8 连接期同步；specs/cloud-agent 14 §4.2/§4.6、02 §0/§4）。
 *
 * 与 `commandChannel.ts`（命令投递）的分工：命令走 `zcode-agent` 通道且要求 ACK 语义；
 * 本通道只做「控制面调用沙箱既有 sync 服务」——`rpc.open` 带 `serviceScope: "control-plane"`
 * （14 §4.2 分面），通道白名单由沙箱侧 relay 按 scope 选择（本文件不复制白名单）。
 *
 * 结构：
 * - **每个 Run 一条流**（`streamId` 与浏览器/命令流隔离）：同一 Run 的同步序列串行
 *   （14 §4.2「单流顺序调用」），因此每条流只需一个 ChannelClient；连接代际变化
 *   （重连接管）时旧流作废、按新代际重开；
 * - 调用寻址只认**当前 ready attachment**（registry）：未 ready/旧代际一律 fail-closed
 *   （不回落 host 执行域，03 §2）；
 * - 断连/超时 → `closed`：结论未知，绝不伪装成功（由手动或下次连接自动同步恢复）。
 */
import { ChannelClient, VSBuffer, type IChannel } from "@zcode/rpc";
import { CLOUD_RPC_PROTOCOL_VERSION, type CloudRpcFrame } from "@zcode/shared";
import type { AttachmentRegistry } from "../../app/attachments/registry.js";
import type {
  ControlPlaneRpcCallRequest,
  ControlPlaneRpcCallResult,
  ControlPlaneRpcPort,
} from "../../app/ports/controlPlaneRpcPort.js";
import { cloudCoreLogger } from "../../app/logger.js";

/** 单次调用的超时上限：低于沙箱分块导入会话的空闲窗口（60s，A 批实现），超时即 fail-closed。 */
export const CONTROL_PLANE_RPC_TIMEOUT_MS = 30_000;

export interface ControlPlaneRpcChannel {
  readonly port: ControlPlaneRpcPort;
  /** 沙箱回投的 `rpc.response`：按 streamId 交回对应流的 ChannelClient。 */
  handleResponse(frame: CloudRpcFrame): void;
  /**
   * 沙箱主动释放流（quiesce/releaseAll 回发的 `rpc.close`）：作废本侧流缓存，
   * 下次调用按当前 attachment 重开新流（02 §4）。
   */
  handleClose(frame: CloudRpcFrame): void;
  /**
   * bridge 连接释放：丢弃该连接的流（不重放；同步结论未知由调用方按条目记 failed）。
   * `released` = 关闭的那条连接（run/代际/epoch），只作用于它，不影响其它 Run 的流。
   */
  release(reason: string, released?: { runId: string; connectionEpoch: number }): void;
  dispose(): void;
}

/** 一个 Run 的流：ChannelClient + 出站帧上下文（帧头由本模块按当前协议版本补齐）。 */
interface RunStream {
  streamId: string;
  runId: string;
  runGeneration: number;
  connectionEpoch: number;
  client: ChannelClient;
  inbound: Set<(buffer: VSBuffer) => void>;
}

export function createControlPlaneRpcChannel(input: {
  registry: AttachmentRegistry;
  /** 把 rpc 帧写入当前 bridge 连接；false 表示连接已释放（fail-closed）。 */
  sendFrame: (frame: CloudRpcFrame) => boolean;
  /** 新流的 streamId 分配（与浏览器/命令流空间隔离）。 */
  newStreamId: () => string;
  timeoutMs?: number;
}): ControlPlaneRpcChannel {
  const timeoutMs = input.timeoutMs ?? CONTROL_PLANE_RPC_TIMEOUT_MS;
  const streams = new Map<string, RunStream>();
  let disposed = false;

  function teardown(stream: RunStream, reason: string, notifySandbox: boolean): void {
    if (streams.get(stream.runId) === stream) streams.delete(stream.runId);
    if (notifySandbox) {
      // socket 仍可用时告知沙箱释放该流（断连路径不发：relay 随连接整体释放）。
      input.sendFrame({
        protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
        type: "rpc.close",
        runId: stream.runId,
        runGeneration: stream.runGeneration,
        connectionEpoch: stream.connectionEpoch,
        streamId: stream.streamId,
      });
    }
    stream.client.dispose();
    stream.inbound.clear();
    cloudCoreLogger.debug(undefined, "cloud control-plane rpc stream closed", {
      runId: stream.runId,
      streamId: stream.streamId,
      reason,
    });
  }

  /** 取该 Run 在当前连接代际上的流；代际变化即作废旧流重开（重连接管）。 */
  function streamFor(context: {
    runId: string;
    runGeneration: number;
    connectionEpoch: number;
  }): RunStream | null {
    const existing = streams.get(context.runId);
    if (
      existing &&
      existing.runGeneration === context.runGeneration &&
      existing.connectionEpoch === context.connectionEpoch
    ) {
      return existing;
    }
    if (existing) teardown(existing, "epoch-changed", false);

    const inbound = new Set<(buffer: VSBuffer) => void>();
    const streamId = input.newStreamId();
    const stream: RunStream = {
      streamId,
      runId: context.runId,
      runGeneration: context.runGeneration,
      connectionEpoch: context.connectionEpoch,
      inbound,
      client: new ChannelClient({
        send(buffer) {
          input.sendFrame({
            protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
            type: "rpc.request",
            runId: stream.runId,
            runGeneration: stream.runGeneration,
            connectionEpoch: stream.connectionEpoch,
            streamId: stream.streamId,
            payload: Buffer.from(buffer.buffer).toString("base64"),
          });
        },
        onMessage(listener) {
          const handler = listener as (buffer: VSBuffer) => void;
          inbound.add(handler);
          return { dispose: () => inbound.delete(handler) };
        },
      }),
    };
    // 先登记再发 rpc.open：沙箱的 Initialize 响应可能在同一 tick 内回来，
    // 未登记会把初始化响应当作未知流丢掉（与浏览器流同款，02 §0）。
    streams.set(stream.runId, stream);
    const sent = input.sendFrame({
      protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
      type: "rpc.open",
      // 分面：控制面是信封唯一构造方（14 §4.2）；浏览器字节只作为有界 payload 被包装。
      serviceScope: "control-plane",
      runId: stream.runId,
      runGeneration: stream.runGeneration,
      connectionEpoch: stream.connectionEpoch,
      streamId: stream.streamId,
    });
    if (!sent) {
      teardown(stream, "bridge-unavailable", false);
      return null;
    }
    return stream;
  }

  async function withTimeout<T>(promise: Promise<T>): Promise<T | "timeout"> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
      // 定时器清理与命令传输同款：不遗留真实 setTimeout 拖住事件循环生命周期。
      if (timer !== undefined) clearTimeout(timer);
    }) as Promise<T | "timeout">;
  }

  const port: ControlPlaneRpcPort = {
    async call(request: ControlPlaneRpcCallRequest): Promise<ControlPlaneRpcCallResult> {
      if (disposed) {
        return {
          status: "failed",
          reason: "closed",
          message: "control-plane rpc channel disposed",
        };
      }
      // 只认当前 ready attachment：未 ready/旧代际即 fail-closed（不回落 host 执行域）。
      const session = input.registry.current(request.runId);
      if (!session) {
        return { status: "failed", reason: "no-attachment", message: "no active attachment" };
      }
      if (
        session.runGeneration !== request.runGeneration ||
        session.connectionEpoch !== request.connectionEpoch
      ) {
        return { status: "failed", reason: "stale", message: "attachment epoch mismatch" };
      }
      if (!session.ready) {
        return { status: "failed", reason: "not-ready", message: "attachment not ready" };
      }
      const stream = streamFor({
        runId: session.runId,
        runGeneration: session.runGeneration,
        connectionEpoch: session.connectionEpoch,
      });
      if (!stream) {
        return { status: "failed", reason: "closed", message: "bridge connection unavailable" };
      }
      try {
        const result = (await withTimeout(
          // 通道调用约定：`IChannel.call(command, args)` 的 args 是**参数数组**
          // （`ProxyChannel.fromService` 里 `target.apply(handler, args || [])`）。
          stream.client
            .getChannel<IChannel>(request.channel)
            .call(request.method, [...request.args]),
        )) as unknown | "timeout";
        if (result === "timeout") {
          return {
            status: "failed",
            reason: "closed",
            message: `${request.channel}.${request.method} timed out`,
          };
        }
        return { status: "ok", result };
      } catch (error) {
        // 断连/沙箱拒绝：结论未知或明确失败，都不伪装成功（由手动/下次连接恢复）。
        return {
          status: "failed",
          reason: "closed",
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };

  return {
    port,
    handleResponse(frame) {
      if (frame.type !== "rpc.response") return;
      const stream = [...streams.values()].find((item) => item.streamId === frame.streamId);
      if (!stream) return;
      if (
        frame.runId !== stream.runId ||
        frame.runGeneration !== stream.runGeneration ||
        frame.connectionEpoch !== stream.connectionEpoch
      ) {
        // 旧代际响应不得投给新流（02 §2 不变量 3）。
        cloudCoreLogger.warn(undefined, "cloud control-plane rpc response rejected: stale", {
          runId: stream.runId,
          streamId: frame.streamId,
          frameEpoch: frame.connectionEpoch,
        });
        return;
      }
      const buffer = VSBuffer.wrap(new Uint8Array(Buffer.from(frame.payload, "base64")));
      for (const listener of Array.from(stream.inbound)) listener(buffer);
    },
    handleClose(frame) {
      // 修复依据（2026-10-13 V4r 真机联调）：沙箱 checkpoint quiesce 会静默撕流；本侧
      // 原先把流按 epoch 缓存复用，后续调用全部打在死流上 30s 超时。沙箱回发的
      // rpc.close 必须作废缓存（teardown，不回 close 防回声循环），下次调用重开。
      if (frame.type !== "rpc.close") return;
      const stream = [...streams.values()].find((item) => item.streamId === frame.streamId);
      if (!stream) return;
      if (
        frame.runId !== stream.runId ||
        frame.runGeneration !== stream.runGeneration ||
        frame.connectionEpoch !== stream.connectionEpoch
      ) {
        // 旧代际 close 不得作废当前流（02 §2 不变量 3）。
        cloudCoreLogger.warn(undefined, "cloud control-plane rpc close rejected: stale", {
          runId: stream.runId,
          streamId: frame.streamId,
          frameEpoch: frame.connectionEpoch,
        });
        return;
      }
      teardown(stream, "sandbox-close", false);
    },
    release(reason, released) {
      for (const stream of Array.from(streams.values())) {
        if (
          released &&
          (stream.runId !== released.runId || stream.connectionEpoch !== released.connectionEpoch)
        ) {
          continue;
        }
        teardown(stream, reason, false);
      }
    },
    dispose() {
      disposed = true;
      for (const stream of Array.from(streams.values())) teardown(stream, "disposed", false);
    },
  };
}

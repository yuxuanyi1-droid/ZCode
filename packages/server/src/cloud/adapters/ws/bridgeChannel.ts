/**
 * bridge 通道装配：连接表 + `AttachmentPort`（控制面 → 执行节点控制帧）+
 * `RuntimeCommandQueryPort`（命令事实查询，02 §6.3 对账）+ 浏览器 RPC 转发（03 §7.1）。
 *
 * 帧通路（同一 socket，两个冻结的帧族）：
 * - `bridge.*` / `projection.*` / `checkpoint.*` 控制帧 → `handshake.ts` / `inbound.ts`；
 * - `rpc.*` 帧（02 §0）→ 由 W6 的 rpcRelay（沙箱侧）与会话另一端对接：
 *   控制面这一侧把沙箱回投的 `rpc.response` 分别交给命令传输（W6 的 ChannelClient）
 *   与浏览器流多路复用器（回投给原 ChannelClient）。
 *
 * 命令投递经 W6 的 `CloudCommandTransport`（`rpc.*` 帧 + 本地 workspace target）：
 * 未接线/未 ready 即 fail-closed，输入保持 accepted 等待重投，绝不伪造 sent。
 */
import {
  cloudRpcFrameSchema,
  isCloudErrorCode,
  isCloudRpcFrameInboundAllowed,
  type CloudRpcFrame,
} from "@zcode/shared";
import {
  bridgeLogger,
  parseBridgeFrame,
  reject,
  resolveConnection,
  sendFrame,
  type BridgeSocket,
  type CloudBridgeChannel,
  type CloudBridgeContext,
  type LiveConnection,
} from "./types.js";
import { handleBridgeHandshake } from "./handshake.js";
import { routeInboundFrame } from "./inbound.js";
import { createBrowserRpcMultiplexer, type OpenBrowserRpcStreamInput } from "./browserStreams.js";
import { createControlPlaneCommandChannel } from "./commandChannel.js";

export function createCloudBridgeChannel(context: CloudBridgeContext): CloudBridgeChannel {
  const { registry, storage, clock, ids } = context;
  const logger = bridgeLogger(context);
  const connections = new Map<string, LiveConnection>();

  /** 出站：把 rpc 帧写进该 run 的当前连接，并逐帧校验代际（旧代际拒绝）。 */
  function sendRpcFrame(frame: CloudRpcFrame): boolean {
    const connection = connections.get(frame.runId);
    if (!connection) return false;
    if (
      connection.runGeneration !== frame.runGeneration ||
      connection.connectionEpoch !== frame.connectionEpoch
    ) {
      // 旧代际帧不得投递（02 §2 不变量 3）。
      return false;
    }
    connection.socket.send(JSON.stringify(frame));
    return true;
  }

  const browserRpc = createBrowserRpcMultiplexer({
    sendFrame: sendRpcFrame,
    newStreamId: () => ids.newId(),
  });
  const commandChannel = createControlPlaneCommandChannel({
    services: context.services,
    registry,
    sendFrame: sendRpcFrame,
    streamId: ids.newId(),
  });

  async function handleInbound(connection: LiveConnection, data: string): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(data);
    } catch {
      logger.warn(undefined, "bridge frame rejected", {
        runId: connection.runId,
        reason: "invalid-frame",
        bytes: data.length,
      });
      connection.socket.close(1008, "invalid-frame");
      return;
    }
    const control = parseBridgeFrame(value);
    if (control) {
      const handshake = await handleBridgeHandshake(context, connection, control);
      if (handshake.handled) return;
      await routeInboundFrame(context, connection, control);
      return;
    }
    const rpc = cloudRpcFrameSchema.safeParse(value);
    if (rpc.success) {
      if (!isCloudRpcFrameInboundAllowed(rpc.data.type, "control-plane")) {
        // 反向帧入站即拒绝并作废该连接（03 §7.1 方向校验）。
        logger.warn(undefined, "bridge frame rejected", {
          runId: connection.runId,
          reason: "unexpected-frame-direction",
          frameType: rpc.data.type,
        });
        connection.socket.close(1008, "unexpected-frame-direction");
        return;
      }
      if (rpc.data.runId !== connection.runId) {
        logger.warn(undefined, "bridge frame rejected", {
          runId: connection.runId,
          reason: "rpc-address-mismatch",
          frameRunId: rpc.data.runId,
          frameType: rpc.data.type,
        });
        connection.socket.close(1008, "rpc-address-mismatch");
        return;
      }
      // 排障（2026-10-07）：真实链路浏览器 Initialize 只收到 6B（协议头 13B 都不齐）；
      // 在入站口记载荷字节数，定位截断跳。量级=请求数，info 有界。
      if (rpc.data.type === "rpc.response") {
        logger.info(undefined, "bridge rpc response inbound", {
          runId: connection.runId,
          streamId: rpc.data.streamId,
          payloadChars: rpc.data.payload?.length ?? 0,
        });
      }
      // 命令传输（控制面自发的命令）与浏览器流各自按 streamId 取用同一帧。
      commandChannel.handleResponse(rpc.data);
      browserRpc.handleInbound(rpc.data);
      return;
    }
    // 未知版本/未知字段：整帧拒绝并断开（fail-closed，02 §4 尾段）。
    logger.warn(undefined, "bridge frame rejected", {
      runId: connection.runId,
      reason: "invalid-frame",
      bytes: data.length,
    });
    connection.socket.close(1008, "invalid-frame");
  }

  return {
    port: {
      async sendCommand(request) {
        const run = await storage.runs.activeOfTask(request.taskId);
        if (!run) return reject("no-attachment", "not_ready");
        const resolved = resolveConnection(connections, {
          runId: run.runId,
          runGeneration: run.runGeneration,
          connectionEpoch: request.expectation?.connectionEpoch ?? run.connectionEpoch,
        });
        if ("rejected" in resolved) return resolved.rejected;
        if (request.expectation?.requireReady && !registry.current(run.runId)?.ready) {
          return reject("not-ready", "not_ready");
        }
        // 命令经 W6 的传输（rpc.* → 沙箱 ChannelServer）；失败语义由传输给出（sent 不是 admission）。
        const result = await commandChannel.transport.sendCommand({
          taskId: request.taskId,
          runId: resolved.connection.runId,
          runGeneration: resolved.connection.runGeneration,
          commandId: request.commandId,
          envelope: request.envelope,
        });
        if (result.status === "sent") return { status: "sent" };
        const reason =
          result.reason === "no-attachment" ||
          result.reason === "stale" ||
          result.reason === "closed"
            ? result.reason
            : "not-ready";
        // 归一错误码目录是唯一事实源：传输回传的未知 code 收敛为 network_unknown（不伪造新码）。
        return {
          status: "rejected",
          code: isCloudErrorCode(result.code) ? result.code : "network_unknown",
          reason,
        };
      },

      async sendBootstrapConfig(request) {
        const connection = connections.get(request.runId);
        if (!connection) return reject("no-attachment", "not_ready");
        if (connection.runGeneration !== request.runGeneration) return reject("stale", "stale");
        sendFrame(connection, {
          protocolVersion: 1,
          type: "bootstrap.config",
          ...request.config,
        });
        return { status: "sent" };
      },

      async requestCheckpoint(request) {
        const connection = connections.get(request.runId);
        if (!connection) return reject("no-attachment", "not_ready");
        if (connection.runGeneration !== request.runGeneration) return reject("stale", "stale");
        if (
          !registry.bootstrapConfigSent({
            runId: request.runId,
            runGeneration: request.runGeneration,
            connectionEpoch: connection.connectionEpoch,
          })
        ) {
          // ready 前置未完成：不发起保存（02 §5.3）。
          return reject("not-ready", "not_ready");
        }
        sendFrame(connection, {
          protocolVersion: 1,
          type: "checkpoint.request",
          operationId: request.operationId,
          runId: request.runId,
          runGeneration: request.runGeneration,
          connectionEpoch: connection.connectionEpoch,
          purpose: request.purpose,
        });
        return { status: "sent" };
      },

      async requestDrain(request) {
        const connection = connections.get(request.runId);
        if (!connection) return reject("no-attachment", "not_ready");
        if (connection.runGeneration !== request.runGeneration) return reject("stale", "stale");
        sendFrame(connection, {
          protocolVersion: 1,
          type: "bridge.drain",
          operationId: request.operationId,
          reason: request.reason,
          connectionEpoch: connection.connectionEpoch,
        });
        return { status: "sent" };
      },

      async currentAddress(runId) {
        return registry.current(runId)?.address ?? null;
      },
    },

    runtimeCommands: {
      async queryCommand(request) {
        // runtime 命令事实经同一传输查询（02 §6.3：查到才落地，查不到保持 uncertain）。
        const result = await commandChannel.transport.queryCommand({
          taskId: request.taskId,
          runId: request.runId,
          runGeneration: request.runGeneration,
          commandId: request.commandId,
          ...(request.runtimeSessionId ? { runtimeSessionId: request.runtimeSessionId } : {}),
        });
        return result;
      },
    },

    openBrowserRpcStream(input: OpenBrowserRpcStreamInput) {
      // 仅当前连接存在时才能转发；否则调用方按 4503 结构化关闭（不静默假装可用）。
      const connection = connections.get(input.runId);
      if (!connection) return null;
      if (
        connection.runGeneration !== input.runGeneration ||
        connection.connectionEpoch !== input.connectionEpoch
      ) {
        return null;
      }
      return browserRpc.open(input);
    },

    async acceptConnection({ runId, socket }) {
      const run = await storage.runs.get(runId);
      if (!run) {
        // 未登记的 run：不接受 socket（不建替代沙箱，03 §8）。
        logger.warn(undefined, "bridge connection rejected", { runId, reason: "run-not-found" });
        socket.close(1008, "run-not-found");
        return;
      }
      const connection: LiveConnection = {
        socket,
        taskId: run.taskId,
        runId,
        runGeneration: run.runGeneration,
        connectionEpoch: run.connectionEpoch,
        runtimeIncarnation: "unknown",
      };
      connections.set(runId, connection);
      // 连接建立：只记路由/代际事实与 provider 标识，不记凭据/帧正文（02 §9）。
      logger.info(undefined, "bridge attachment opened", {
        taskId: run.taskId,
        runId,
        runGeneration: run.runGeneration,
        connectionEpoch: run.connectionEpoch,
        provider: run.provider ?? "unknown",
        providerHandle: run.providerHandle ?? "unknown",
      });
      socket.onMessage((data) => {
        void (async () => {
          try {
            await handleInbound(connection, data);
          } catch (error) {
            // 单帧处理失败不断开旧连接语义：记录并继续（02 §8 只记录，不静默丢事实）。
            logger.error(undefined, "cloud bridge frame handling failed", {
              runId,
              error: error instanceof Error ? error.message : "unknown",
            });
          }
        })();
      });
      socket.onClose((closeInfo) => {
        if (connections.get(runId) === connection) connections.delete(runId);
        // 关闭原因区分：正常断开 / 1008 具体 reason / socket error（不记帧正文）。
        logger.info(undefined, "bridge attachment closed", {
          taskId: connection.taskId,
          runId,
          runGeneration: connection.runGeneration,
          connectionEpoch: connection.connectionEpoch,
          reason: closeInfo?.reason ?? "socket-closed",
          code: closeInfo?.code ?? 0,
          ...(closeInfo?.error ? { error: closeInfo.error } : {}),
        });
        registry.detach({ runId, at: clock.now(), reason: "socket-closed" });
        // 连接释放：丢弃在途 RPC 与浏览器流（不重放；命令事实留待对账，02 §6.3）。
        // 释放按「关闭的这条连接」记账：单例命令传输不能被任意一条连接的关闭永久毒化
        // （2026-10-07 真实链路：首条连接关闭后所有 run 的输入投递全部 closed）。
        commandChannel.release("bridge-socket-closed", {
          runId,
          runGeneration: connection.runGeneration,
          connectionEpoch: connection.connectionEpoch,
        });
        browserRpc.closeRun(runId, "bridge-socket-closed");
        // 悬浮 Promise 必须自兜（2026-10-07 实测崩溃：进程关闭期 storage worker 先关，
        // 迟到的 socket close 事件走到这里抛 CloudStorageError，无人接的 rejection
        // 直接把进程带崩 exit 1——关闭路径的失败只记日志，不再有可恢复动作）。
        context.services().runs
          .markDisconnected({
            runId,
            runGeneration: connection.runGeneration,
            connectionEpoch: connection.connectionEpoch,
            reason: "bridge-socket-closed",
          })
          .catch((error: unknown) => {
            logger.warn(undefined, "bridge mark disconnected failed", {
              runId,
              error: error instanceof Error ? error.message : String(error),
            });
          });
      });
    },

    async close() {
      browserRpc.closeAll("control-plane-shutdown");
      commandChannel.dispose();
      for (const connection of connections.values()) {
        connection.socket.close(1001, "control-plane-shutdown");
      }
      connections.clear();
    },
  };
}

export type { BridgeSocket, CloudBridgeChannel, CloudCommandTransport } from "./types.js";

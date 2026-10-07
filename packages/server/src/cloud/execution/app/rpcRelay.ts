/**
 * `rpc.*` 帧 ↔ 本地常驻 stdio client 的受控转接（specs/cloud-agent/02 §0「原 Web UI 的
 * 受控 RPC 承载」、§4 尾段，W6 §3「rpcRelay」）。
 *
 * 做法：浏览器仍是原 ChannelClient，沙箱侧为每条浏览器 streamId 建一个 ChannelServer，
 * 通道实现是**本地 stdio client 上同名 channel 的转发**——复用既有 Channel RPC 的序列化、
 * 事件与取消，不另造文件/Git/终端业务协议，也不把网络字节直通唯一 stdio 管道。
 *
 * 边界：
 * - 通道白名单是 shared 冻结的 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`，禁止任何一端硬编码；
 * - 明确拒绝账号域/host 本体能力（`CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS`）；
 * - 每帧都按当前 ready attachment 校验 runId/runGeneration/connectionEpoch，旧代际帧拒绝；
 * - 连接释放只清网络侧 ChannelServer 与会话，保留 stdio/runtime（02 §3）。
 */
import {
  ChannelServer,
  Emitter,
  Event,
  VSBuffer,
  type IChannel,
  type IMessagePassingProtocol,
  type IServerChannel,
} from "@zcode/rpc";
import {
  CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS,
  CLOUD_ATTACHMENT_SERVICE_ALLOWLIST,
  CLOUD_RPC_PROTOCOL_VERSION,
  type CloudRpcFrame,
} from "@zcode/shared";
import type { AttachmentContext, ExecutionLogger, RpcRelayPort } from "./ports.js";

/** 单 attachment 允许同时存在的浏览器 RPC 会话上限（有界资源，02 §8）。 */
export const MAX_RELAY_STREAMS = 32;

export type LocalChannelAccessor = (channelName: string) => IChannel | null;

export interface RpcRelayOptions {
  /** 本地常驻 stdio client 的受控通道访问器（白名单外的名字不会被调用）。 */
  channel(name: string): IChannel | null;
  /** 把 `rpc.response` 交回当前连接（旧连接已释放时调用方自行丢弃）。 */
  send(frame: CloudRpcFrame): void;
  logger: ExecutionLogger;
  maxStreams?: number;
}

/** 出站帧的联合分支去掉协议版本：帧头由本模块按当前版本补齐。 */
type OutboundRpcFrame = CloudRpcFrame extends infer T
  ? T extends CloudRpcFrame
    ? Omit<T, "protocolVersion">
    : never
  : never;

interface RelaySession {
  streamId: string;
  context: AttachmentContext;
  protocol: RelayProtocol;
  server: ChannelServer;
}

class RelayProtocol implements IMessagePassingProtocol {
  readonly onMessage: Emitter<VSBuffer>["event"];
  private readonly emitter = new Emitter<VSBuffer>();
  /** 一次性钩子：首个出站字节（Initialize 响应）到达时触发，用于排障日志。 */
  onFirstSend: ((byteLength: number) => void) | null = null;

  constructor(private readonly sink: (payload: VSBuffer) => void) {
    this.onMessage = this.emitter.event;
  }

  send(buffer: VSBuffer): void {
    if (this.onFirstSend !== null) {
      const hook = this.onFirstSend;
      this.onFirstSend = null;
      hook(buffer.byteLength);
    }
    this.sink(buffer);
  }

  deliver(buffer: VSBuffer): void {
    this.emitter.fire(buffer);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** 把本地 client 的同名 channel 暴露成 ServerChannel：call/listen 原样转发。 */
function adaptLocalChannel(channel: IChannel): IServerChannel {
  return {
    call: (_context, command, arg, token) => channel.call(command, arg, token),
    listen: (_context, event, arg) => channel.listen(event, arg),
  };
}

/** 明确拒绝的白名单外通道：结构化错误而不是挂起等注册。 */
function denyChannel(reason: string): IServerChannel {
  return {
    call: (_context, command) =>
      Promise.reject(
        Object.assign(new Error(`${reason} (command: ${command})`), {
          code: "unauthorized",
          details: { reason },
        }),
      ),
    listen: () => Event.None,
  };
}

export function createRpcRelay(options: RpcRelayOptions): RpcRelayPort {
  const sessions = new Map<string, RelaySession>();
  const maxStreams = options.maxStreams ?? MAX_RELAY_STREAMS;

  function send(frame: OutboundRpcFrame): void {
    options.send({ protocolVersion: CLOUD_RPC_PROTOCOL_VERSION, ...frame } as CloudRpcFrame);
  }

  function disposeSession(session: RelaySession, reason: string, notify: boolean): void {
    sessions.delete(session.streamId);
    session.protocol.dispose();
    session.server.dispose();
    options.logger.debug(undefined, "rpc relay session closed", {
      streamId: session.streamId,
      reason,
    });
    if (notify) {
      send({
        type: "rpc.close",
        runId: session.context.address.runId,
        runGeneration: session.context.runGeneration,
        connectionEpoch: session.context.connectionEpoch,
        streamId: session.streamId,
      });
    }
  }

  function openSession(
    frame: Extract<CloudRpcFrame, { type: "rpc.open" }>,
    context: AttachmentContext,
  ): void {
    if (sessions.size >= maxStreams) {
      options.logger.warn(undefined, "rpc relay stream limit reached", { limit: maxStreams });
      send({
        type: "rpc.close",
        runId: frame.runId,
        runGeneration: frame.runGeneration,
        connectionEpoch: frame.connectionEpoch,
        streamId: frame.streamId,
      });
      return;
    }
    const protocol = new RelayProtocol((payload) => {
      send({
        type: "rpc.response",
        runId: frame.runId,
        runGeneration: frame.runGeneration,
        connectionEpoch: frame.connectionEpoch,
        streamId: frame.streamId,
        payload: Buffer.from(payload.buffer).toString("base64"),
      });
    });
    // 可观测性（2026-10-07 真实链路排障）：浏览器流一经建立就要能从沙箱日志确认
    // "开了几个通道"；否则 Initialize 卡死时无法区分「open 没到」与「响应没回」。
    protocol.onFirstSend = (byteLength) => {
      // 排障（2026-10-07）：首发字节数必须 ≥13（协议头）；真实链路浏览器端只收到 6B，
      // 在两端各记一次字节数即可定位截断发生在哪一跳。
      options.logger.info(undefined, "rpc relay stream first response sent", {
        streamId: frame.streamId,
        bytes: byteLength,
      });
    };
    const server = new ChannelServer(protocol, "cloud-attachment");
    for (const channelName of CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS) {
      server.registerChannel(channelName, denyChannel(`channel ${channelName} is not available`));
    }
    // 白名单作为唯一注册面：未列出的名字既不注册也不代理（不回落 host 执行域）。
    let registered = 0;
    for (const channelName of CLOUD_ATTACHMENT_SERVICE_ALLOWLIST) {
      const local = options.channel(channelName);
      if (!local) continue;
      server.registerChannel(channelName, adaptLocalChannel(local));
      registered += 1;
    }
    sessions.set(frame.streamId, { streamId: frame.streamId, context, protocol, server });
    // info（2026-10-07 排障）：浏览器流生命周期是生产可用事件（AGENTS 日志分级）；
    // debug 在生产不落盘，让 Initialize 排障失去一半证据。
    options.logger.info(undefined, "rpc relay session opened", {
      streamId: frame.streamId,
      channels: registered,
    });
  }

  return {
    handle(rawFrame, context) {
      const frame = rawFrame as CloudRpcFrame;
      // 逐帧校验当前 ready attachment：runId/generation/epoch 任一不符即拒绝转发。
      if (
        frame.runId !== context.address.runId ||
        frame.runGeneration !== context.runGeneration ||
        frame.connectionEpoch !== context.connectionEpoch
      ) {
        options.logger.warn(undefined, "rpc frame rejected: stale attachment", {
          type: frame.type,
          frameEpoch: frame.connectionEpoch,
          currentEpoch: context.connectionEpoch,
        });
        return;
      }
      switch (frame.type) {
        case "rpc.open":
          openSession(frame, context);
          return;
        case "rpc.request": {
          const session = sessions.get(frame.streamId);
          if (!session) return;
          // 只把已鉴权 streamId 的有界字节交给本地 ChannelServer 解析（不直通 stdio）。
          session.protocol.deliver(
            VSBuffer.wrap(new Uint8Array(Buffer.from(frame.payload, "base64"))),
          );
          return;
        }
        case "rpc.close": {
          const session = sessions.get(frame.streamId);
          if (session) disposeSession(session, "browser-close", false);
          return;
        }
        case "rpc.response":
        default:
          // response 方向是沙箱 → 控制面；沙箱侧收到即越权（02 §0/§4 尾段）。
          return;
      }
    },

    releaseAll(reason) {
      for (const session of Array.from(sessions.values())) {
        disposeSession(session, reason, false);
      }
    },
  };
}

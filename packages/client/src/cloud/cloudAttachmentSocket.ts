/**
 * attachment 通道的 WebSocket 承载（specs/cloud-agent/03 §7.1 沙箱 attachment 通道、
 * 02 §4 地址与网络帧、04 §4「显式 origin」）。
 *
 * 默认 connector 面向浏览器同源场景：cookie 主体认证（03 §7.1「浏览器主体认证后绑定
 * Task 当前 Run」），URL 只有显式 origin + 冻结升级路径，token 不进 query。浏览器
 * WebSocket 无法设置请求头，因此 bearer 模式必须注入 `CloudWebSocketFactory`
 * （例如 Node `ws` 的 headers）；SDK 宁可 fail-closed 也不把凭据塞进 URL。
 */
import {
  Emitter,
  VSBuffer,
  type Event,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import { cloudAttachmentUnavailableError, cloudConfigurationError } from "./cloudApiError.js";
import type { CloudHttpAuth } from "./cloudHttpTransport.js";
import type { CloudAttachConnector, CloudAttachSocket } from "./cloudAttachClient.js";

export type CloudWebSocketFactory = (input: {
  readonly url: string;
  readonly auth: CloudHttpAuth;
}) => WebSocket;

/** 浏览器 WebSocket 的最小生命期包装：数据流 + 关闭事实。 */
interface BrowserSocketHandle {
  readonly protocol: IMessagePassingProtocol;
  readonly onDidClose: Event<void>;
  readonly dispose: (reason?: Error) => void;
}

function wrapBrowserWebSocket(ws: WebSocket): BrowserSocketHandle {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.binaryType = "arraybuffer";
  ws.addEventListener("message", (event) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(event.data as ArrayBuffer)));
  });
  ws.addEventListener("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.addEventListener("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  const socket: ISocket = {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer as Uint8Array<ArrayBuffer>);
      }
    },
    end() {
      ws.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      ws.close();
    },
  };

  // **不包 SocketProtocol**（修复依据 2026-10-07 真实链路）：任务通道是字节直通沙箱的
  // rpcRelay——rpc.* 帧的 payload 就是**完整的序列化消息**（ChannelServer 构造即发的
  // Initialize 是 6 字节裸序列化 `[200]`，不是 13 字节传输头帧）。包了 SocketProtocol 后
  // 6 字节连协议头都不齐，永远不出 onMessage → 浏览器 Initialize 死锁（实测 15s 超时、
  // 客户端零发送）。命令通道（commandTransport）本来就是裸 protocol，两端约定一致；
  // 这里与其对齐成裸字节，而不是让沙箱侧再加一层传输分帧。
  const protocol: IMessagePassingProtocol = {
    send: (buffer) => socket.write(buffer),
    onMessage: socket.onData,
    ...(socket.drain ? { drain: () => socket.drain!() } : {}),
  };
  return {
    protocol,
    onDidClose: onClose.event,
    dispose: () => socket.dispose(),
  };
}

function defaultWebSocketFactory(input: { url: string; auth: CloudHttpAuth }): WebSocket {
  if (input.auth.mode === "bearer") {
    // 浏览器 WebSocket 不能带 Authorization 头；凭据不能落到 URL query（04 §7）。
    throw cloudConfigurationError(
      `bearer auth on the cloud attachment requires an injected CloudWebSocketFactory`,
    );
  }
  return new WebSocket(input.url);
}

/**
 * 默认 connector：连接后等 open 才返回，连接阶段失败归一成连接类错误（可重连）。
 * `onDidClose` 让 attachment 客户端区分「对端断开」与「本地主动 close」。
 */
export function createBrowserCloudAttachConnector(options?: {
  readonly webSocketFactory?: CloudWebSocketFactory;
}): CloudAttachConnector {
  const factory = options?.webSocketFactory ?? defaultWebSocketFactory;

  return async (input): Promise<CloudAttachSocket> => {
    const ws = factory({ url: input.url, auth: input.auth });

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        cleanup();
        resolve();
      };
      const onFailure = () => {
        cleanup();
        reject(cloudAttachmentUnavailableError(`cloud attachment socket did not open`));
      };
      const cleanup = () => {
        ws.removeEventListener("open", onOpen);
        ws.removeEventListener("error", onFailure);
        ws.removeEventListener("close", onFailure);
      };
      ws.addEventListener("open", onOpen);
      ws.addEventListener("error", onFailure);
      ws.addEventListener("close", onFailure);
    });

    const handle = wrapBrowserWebSocket(ws);
    return {
      protocol: handle.protocol,
      onDidClose: handle.onDidClose,
      dispose: (reason?: Error) => {
        void reason;
        handle.dispose();
      },
    };
  };
}

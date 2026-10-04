import { Duplex } from "node:stream";
import WebSocket from "ws";

/**
 * 把 WebSocket 适配成 ssh2 能直接消费的 duplex 流。
 *
 * 存在的理由：E2B 的沙箱端口只以 HTTPS/WSS 暴露，没有裸 TCP，而 ssh2 只会建
 * TCP 连接。与其让 provisioner 起一个公网 TCP 中继（多一跳、多一个公网端口），
 * 不如在客户端这一侧把 WS 当作传输层喂给 ssh2。
 */
export interface WebSocketDuplexOptions {
  url: string;
  headers?: Record<string, string>;
  /** 隧道握手超时。缺省只定义一次，避免各处再写一遍字面量。 */
  openTimeoutMs?: number;
}

export const DEFAULT_WEBSOCKET_OPEN_TIMEOUT_MS = 30_000;

function waitForOpen(socket: WebSocket, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      clearTimeout(timer);
      socket.terminate();
      reject(error);
    };
    const timer = setTimeout(() => {
      socket.off("error", onError);
      socket.terminate();
      reject(new Error(`sandbox websocket handshake timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    socket.once("open", () => {
      clearTimeout(timer);
      // 握手结束后必须摘掉这个监听器：否则后续任何一个 socket error 都会走这里，
      // 绕开 duplex.destroy 直接把流吞掉，ssh2 只会看到一个无声的死连接。
      socket.off("error", onError);
      resolve();
    });
    socket.once("error", onError);
  });
}

function createDuplex(socket: WebSocket): Duplex {
  const duplex = new Duplex({
    read() {
      // ws 没有内建背压。下游缓冲排空后恢复接收，让内核对 TCP 窗口施压。
      if (socket.readyState === WebSocket.OPEN) {
        socket.resume();
      }
    },
    write(chunk: Buffer, _encoding, callback) {
      if (socket.readyState !== WebSocket.OPEN) {
        callback(new Error("sandbox websocket is not open"));
        return;
      }
      // ws 的 send 回调在数据交给内核后触发，对应 Node stream 的 flush 语义。
      socket.send(chunk, (error?: Error) => callback(error ?? undefined));
    },
    final(callback) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.close();
      }
      callback();
    },
    destroy(error, callback) {
      socket.removeAllListeners();
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.terminate();
      }
      callback(error);
    },
  });

  socket.on("message", (data: WebSocket.RawData) => {
    const chunk =
      typeof data === "string" ? Buffer.from(data, "utf8") : Buffer.from(data as Buffer);
    if (!duplex.push(chunk)) {
      socket.pause();
    }
  });
  socket.on("close", () => {
    duplex.push(null);
  });
  socket.on("error", (error: Error) => {
    duplex.destroy(error);
  });

  return duplex;
}

export async function openWebSocketDuplex(options: WebSocketDuplexOptions): Promise<Duplex> {
  const socket = new WebSocket(options.url, { headers: options.headers });
  socket.binaryType = "nodebuffer";
  await waitForOpen(socket, options.openTimeoutMs ?? DEFAULT_WEBSOCKET_OPEN_TIMEOUT_MS);
  return createDuplex(socket);
}

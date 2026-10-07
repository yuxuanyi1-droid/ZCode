/**
 * 出站 WSS 传输（specs/cloud-agent/02 §4 地址与网络帧、§8 故障表；W6 §3「bridge/」）。
 *
 * 只做三件事：连上 `/ws/cloud/bridge/:runId`、投递/接收文本帧、报告关闭。
 * 帧解析与方向校验在 app 层（domain/bridgeFrames.ts），这样适配层不复制协议规则。
 *
 * 关键：**连接关闭只关闭这一个 socket**。本适配层不持有、也不触碰本地 stdio/runtime
 * （02 §2 不变量 7、§3）；它甚至不知道 runtime 存在。
 */
import { WebSocket } from "ws";
import type { BridgeConnectionPort, BridgeTransportPort } from "../app/ports.js";
import type { ExecutionLogger } from "../app/ports.js";

export interface BridgeTransportOptions {
  logger: ExecutionLogger;
  /** 连接建立超时；超时按 socket-error 分类退避重连（不升级为终态）。 */
  openTimeoutMs?: number;
  /** 单帧发送上限（与 shared 的 RPC 帧上界同量级；超限直接拒发而不是截断）。 */
  maxSendChars?: number;
  /** 关闭码保留字：异常关闭统一用 4001，便于控制面区分节点侧主动释放。 */
  closeCode?: number;
}

const DEFAULT_OPEN_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_SEND_CHARS = 8 * 1024 * 1024;

export function createBridgeTransport(options: BridgeTransportOptions): BridgeTransportPort {
  const openTimeoutMs = options.openTimeoutMs ?? DEFAULT_OPEN_TIMEOUT_MS;
  const maxSendChars = options.maxSendChars ?? DEFAULT_MAX_SEND_CHARS;

  return {
    connect(url) {
      return new Promise<BridgeConnectionPort>((resolve, reject) => {
        const socket = new WebSocket(url, {
          // bridge 专用端点只接受执行节点出站连接，不复用浏览器 cookie 或 host capability
          // （02 §4）：不携带任何浏览器凭据，认证材料只经 bridge.hello 帧。
          headers: { "user-agent": "zcode-cloud-bridge/1" },
        });
        let opened = false;
        const timer = setTimeout(() => {
          if (opened) return;
          socket.terminate();
          reject(new Error(`bridge connect timeout after ${openTimeoutMs}ms`));
        }, openTimeoutMs);

        socket.once("open", () => {
          opened = true;
          clearTimeout(timer);
          resolve(createConnection(socket, options.logger, maxSendChars));
        });
        socket.once("error", (error: Error) => {
          if (opened) return;
          clearTimeout(timer);
          reject(error);
        });
        socket.once("close", (code: number) => {
          if (opened) return;
          clearTimeout(timer);
          reject(new Error(`bridge socket closed before open (code ${code})`));
        });
      });
    },
  };
}

function createConnection(
  socket: WebSocket,
  logger: ExecutionLogger,
  maxSendChars: number,
): BridgeConnectionPort {
  const textListeners = new Set<(text: string) => void>();
  const closeListeners = new Set<(info: { reason: string; code?: number }) => void>();
  let closed = false;

  const notifyClose = (reason: string, code?: number) => {
    if (closed) return;
    closed = true;
    for (const listener of Array.from(closeListeners)) listener({ reason, code });
  };

  socket.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    if (closed) return;
    const text = Buffer.isBuffer(raw)
      ? raw.toString("utf8")
      : Array.isArray(raw)
        ? Buffer.concat(raw).toString("utf8")
        : Buffer.from(raw).toString("utf8");
    for (const listener of Array.from(textListeners)) listener(text);
  });
  socket.on("close", (code: number, reason: Buffer) => {
    notifyClose(reason?.length ? reason.toString("utf8") : `socket-close:${code}`, code);
  });
  socket.on("error", (error: Error) => {
    logger.warn(undefined, "bridge socket error", { error: error.message });
    notifyClose("socket-error");
  });

  return {
    send(text) {
      if (closed || socket.readyState !== socket.OPEN) return;
      if (text.length > maxSendChars) {
        // 有界投递：超限帧直接丢弃并记录，绝不截断后发出（半帧会污染协议流）。
        logger.warn(undefined, "bridge outbound frame exceeds limit; dropped", {
          chars: text.length,
        });
        return;
      }
      socket.send(text);
    },
    onText(listener) {
      textListeners.add(listener);
      return { dispose: () => textListeners.delete(listener) };
    },
    onClose(listener) {
      closeListeners.add(listener);
      return { dispose: () => closeListeners.delete(listener) };
    },
    close(reason) {
      notifyClose(reason);
      if (socket.readyState === socket.OPEN || socket.readyState === socket.CONNECTING) {
        socket.close(4001, reason.slice(0, 100));
      }
    },
  };
}

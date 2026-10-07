/**
 * 云入口的 HTTP 监听、错误信封与关闭（含连接回收）——`entry-cloud-server.ts` 的传输侧。
 *
 * 关闭语义（W5 §6「server close（含连接回收）」）：先停止接收新连接，再回收 keep-alive
 * 与已升级的 WebSocket，最后等 `close` 完成；不用超时掩盖未收尾的连接（AGENTS 约束）。
 */
import { randomUUID } from "node:crypto";
import { serve, type ServerType } from "@hono/node-server";
import type { Hono } from "hono";
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode, type CloudErrorEnvelope } from "@zcode/shared";

export function errorEnvelope(code: CloudErrorCode, message: string): CloudErrorEnvelope {
  return {
    code,
    message,
    retryable: CLOUD_ERROR_RETRYABLE[code],
    traceId: `cloud-entry-${randomUUID()}`,
  };
}

/**
 * 监听并等待真正可服务（不用 sleep 猜时序）：`serve` 的 listening 回调就是「已监听」
 * 的事实；端口冲突等失败经 `error` 事件归一为 reject，不会留下半监听进程。
 */
export function listenCloudApp(
  app: Hono,
  port: number,
  hostnameOption: string | undefined,
): Promise<{ server: ReturnType<typeof serve>; port: number }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const server: ServerType = serve(
      {
        fetch: app.fetch,
        ...(hostnameOption ? { hostname: hostnameOption } : {}),
        port,
      },
      (info) => {
        settled = true;
        resolve({ server, port: info.port });
      },
    );
    server.once("error", (error: Error) => {
      if (!settled) {
        reject(error);
      }
    });
  });
}

/** `closeIdleConnections`/`closeAllConnections` 只有 http 形态有，http2 形态按需降级。 */
interface RecyclableServer {
  close(callback: (error?: Error) => void): void;
  closeIdleConnections?(): void;
  closeAllConnections?(): void;
}

/**
 * 服务端关闭含连接回收：先停止接收，再回收 keep-alive 与已升级的 WebSocket，
 * 最后等待 `close` 完成（不靠超时掩盖未收尾的连接）。
 */
export async function closeServerWithConnections(server: ServerType): Promise<void> {
  const recyclable = server as RecyclableServer;
  const closed = new Promise<void>((resolve) => {
    recyclable.close(() => resolve());
  });
  recyclable.closeIdleConnections?.();
  recyclable.closeAllConnections?.();
  await closed;
}

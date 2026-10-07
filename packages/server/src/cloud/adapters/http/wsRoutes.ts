/**
 * cloud WS 通道注册（03 §7.1 两个通道分面）：`/ws/cloud/bridge/:runId`（执行节点出站）与
 * `/ws/cloud/tasks/:taskId`（浏览器 → 沙箱执行域代理）。
 *
 * - bridge 通道：socket 路径即 run 归属，帧级校验（版本/代际/凭据）在 ws 层完成；
 * - 任务通道：浏览器必须已认证（入口中间件）+ 该 Task 有有效 ready attachment，
 *   否则结构化关闭；**绝不回落 host 本机执行域**（03 §2、CP-11）。
 *   rpc 帧到沙箱的转接由 W6 的 rpcRelay 承担，未接线前连接不可用（不静默假装可用）。
 */
import type { Context, Hono } from "hono";
import { notImplemented, type CloudHttpRouteDeps, type CloudUpgradeWebSocket } from "./support.js";

/** hono `WSContext` 的结构子集：只用到 send/close（浏览器通道要能发二进制字节）。 */
interface WsLike {
  send(data: string | Uint8Array | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
}

export function registerCloudWsRoutes(
  app: Hono,
  deps: CloudHttpRouteDeps,
  upgrade: CloudUpgradeWebSocket | undefined,
): void {
  const { router, bridge, principalId } = deps;
  if (!upgrade) {
    // 未接线 WS：明确 501，不把执行请求回落本机执行域（03 §2 边界）。
    app.get("/ws/cloud/bridge/:runId", (c) => notImplemented(c, "cloud-ws-not-wired"));
    app.get("/ws/cloud/tasks/:taskId", (c) => notImplemented(c, "cloud-ws-not-wired"));
    return;
  }
  const bind = upgrade as unknown as (createEvents: (c: Context) => unknown) => never;
  app.get(
    "/ws/cloud/bridge/:runId",
    bind((c: Context) => {
      const runId = c.req.param("runId") ?? "";
      // hono 的 createEvents 回调与我的 BridgeSocket 抽象之间做一层适配：帧可能在
      // acceptConnection（含一次 storage 读）完成前到达，先缓冲再交付（不丢帧）。
      const pendingFrames: string[] = [];
      let messageHandler: ((data: string) => void) | undefined;
      let closeHandler:
        | ((info?: { code?: number; reason?: string; error?: string }) => void)
        | undefined;
      let accepted = false;
      return {
        onOpen: (_event: unknown, ws: WsLike) => {
          const socket = {
            send: (data: string) => ws.send(data),
            close: (code?: number, reason?: string) => ws.close(code, reason),
            onMessage: (handler: (data: string) => void) => {
              messageHandler = handler;
            },
            onClose: (
              handler: (info?: { code?: number; reason?: string; error?: string }) => void,
            ) => {
              closeHandler = handler;
            },
          };
          void bridge.acceptConnection({ runId, socket }).then(() => {
            accepted = true;
            for (const frame of pendingFrames.splice(0)) messageHandler?.(frame);
          });
        },
        onMessage: (event: { data: unknown }, _ws: WsLike) => {
          const data = typeof event.data === "string" ? event.data : null;
          if (data === null) return;
          if (!accepted || !messageHandler) {
            pendingFrames.push(data);
            return;
          }
          messageHandler(data);
        },
        onClose: (event?: { code?: number; reason?: string }) => {
          // 关闭码/原因透传给通道日志（正常断开 / 1008 拒绝 / socket error）。
          closeHandler?.({
            ...(typeof event?.code === "number" ? { code: event.code } : {}),
            ...(typeof event?.reason === "string" ? { reason: event.reason } : {}),
          });
        },
        onError: (event?: { error?: unknown }) => {
          const error = event?.error instanceof Error ? event.error.message : undefined;
          closeHandler?.({ code: 1011, reason: "socket-error", ...(error ? { error } : {}) });
        },
      };
    }),
  );
  app.get(
    "/ws/cloud/tasks/:taskId",
    bind((c: Context) => {
      const taskId = c.req.param("taskId") ?? "";
      const expectedRunGeneration = c.req.query("generation");
      // 帧可能在 resolveExecutionTarget（含 storage 读）完成前到达：先缓冲再交付（不丢帧）。
      const pendingFrames: Buffer[] = [];
      let stream: { forwardToSandbox(payload: Buffer): void; close(reason: string): void } | null =
        null;
      let browserClosed = false;
      return {
        onOpen: (_event: unknown, ws: WsLike) => {
          void (async () => {
            const target = await router.resolveExecutionTarget({
              principalId,
              taskId,
              ...(expectedRunGeneration
                ? { expectedRunGeneration: Number(expectedRunGeneration) }
                : {}),
            });
            if (!target.ok) {
              // 无有效 attachment / 未 ready：结构化关闭，不给本机 fallback（CP-11）。
              ws.close(4404, target.reason.slice(0, 120));
              return;
            }
            // 浏览器仍用原 ChannelClient；控制面只把字节封成 rpc.* 帧转发给沙箱（03 §7.1）。
            const opened = bridge.openBrowserRpcStream({
              runId: target.value.runId,
              runGeneration: target.value.runGeneration,
              connectionEpoch: target.value.connectionEpoch,
              deliver: (payload) => ws.send(payload),
              onClosed: (reason) => {
                if (browserClosed) return;
                browserClosed = true;
                ws.close(4501, reason.slice(0, 120));
              },
            });
            if (!opened) {
              // 该 run 没有活着的 bridge 连接（例如沙箱已断开）：明确拒绝，不静默假装可用。
              ws.close(4503, "bridge-not-connected");
              return;
            }
            stream = opened;
            for (const frame of pendingFrames.splice(0)) stream.forwardToSandbox(frame);
          })();
        },
        onMessage: (event: { data: unknown }, _ws: WsLike) => {
          const payload = toBuffer(event.data);
          if (!payload) return;
          if (!stream) {
            pendingFrames.push(payload);
            return;
          }
          stream.forwardToSandbox(payload);
        },
        onClose: () => {
          browserClosed = true;
          stream?.close("browser-closed");
        },
      };
    }),
  );
}

/** 浏览器 ChannelClient 的字节：二进制原样转发，文本按 UTF-8 编码（不让帧静默丢失）。 */
function toBuffer(data: unknown): Buffer | null {
  if (typeof data === "string") return Buffer.from(data, "utf8");
  if (Buffer.isBuffer(data)) return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

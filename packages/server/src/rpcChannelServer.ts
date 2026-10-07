/* eslint-disable max-lines -- RPC 通道装配、lite-token 鉴权与静态资源判定同为「入口共用原语」，集中一处才能保证本地与云入口语义一致。 */
/**
 * 入口共用原语：RPC 通道装配（setupChannelServer / wrapWebSocket）、lite-token 校验，
 * 以及与之绑定的静态资源判定。
 *
 * 本文件是 `http.ts` 的**纯搬移**（specs/cloud-agent/modules/W5-cloud-entry.md §3）：
 * 本地 `entry-http.ts` 与云入口 `cloud/adapters/entry-cloud-server.ts` 必须复用同一份
 * `/ws` 暴露逻辑与同一套「哪些路径受 token 保护」判定，否则云入口的静态层会吞掉
 * `/api/*` 与 `/ws/*`（§5 硬性约束）。此处不引入任何新行为。
 */
import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import {
  ChannelServer,
  Emitter,
  Event,
  LoggingChannelServer,
  SocketProtocol,
  VSBuffer,
  type IServerChannel,
  type ISocket,
} from "@zcode/rpc";
import {
  IProviderProvisioningTargetService,
  IZCodeAgentService,
  ServiceCollection,
  createZCodeAgentConnectionScope,
} from "@zcode/services";
import { formatLogPrefix } from "@zcode/shared";
import type { Context, MiddlewareHandler } from "hono";
import type { WebSocket } from "ws";

/** `/ws` 的两个既有语义（specs/cloud-agent/04 §2）：云客户端一律 `web-remote-replayable`。 */
export type ServerChannelClientMode = "desktop-continuous" | "web-remote-replayable";

export function wrapWebSocket(ws: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  ws.on("message", (raw: Buffer | ArrayBuffer | Buffer[]) => {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
    onData.fire(VSBuffer.wrap(new Uint8Array(buf)));
  });
  ws.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  ws.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (ws.readyState === ws.OPEN) {
        ws.send(buffer.buffer);
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
}

const log = (...args: unknown[]) =>
  console.log(formatLogPrefix("zcode-server:http", process.pid), ...args);

/**
 * 显式拒绝的频道：RPC 立即失败并带结构化错误，而不是落进 ChannelServer 的
 * 「等待频道注册」挂起路径（`collectPendingRequest` 会一直等到 socket 关闭）。
 * 云入口用它把本机执行域频道钉死为拒绝（03 §2、CP-01）；本地入口不传该项，
 * 行为与抽取前完全一致。
 */
export interface SetupChannelServerOptions {
  readonly denyChannels?: readonly string[];
}

function createDenyChannel(reason: string): IServerChannel {
  return {
    call: (_ctx, command) =>
      Promise.reject(
        Object.assign(new Error(`${reason} (command: ${command})`), {
          code: "unauthorized",
          details: { reason },
        }),
      ),
    listen: () => Event.None,
  };
}

export function setupChannelServer(
  ws: WebSocket,
  services: ServiceCollection,
  clientMode: ServerChannelClientMode,
  options: SetupChannelServerOptions = {},
) {
  const socket = wrapWebSocket(ws);
  const protocol = new SocketProtocol(socket);
  const rawServer = new ChannelServer(protocol, "server");
  // 用日志中间件包装，统一记录所有 RPC 调用
  const server = new LoggingChannelServer(rawServer, log);
  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `server-ws-${randomUUID()}`,
        clientMode,
        role: clientMode === "desktop-continuous" ? "trusted-host-relay" : "terminal-client",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  // Provisioning 携带跨 Environment 凭据，只允许 Desktop trusted host 使用；普通 Web
  // remote/replayable 客户端即使知道频道名，也不能获得 target 写入接口。
  if (
    clientMode !== "desktop-continuous" &&
    services.getOptional(IProviderProvisioningTargetService)
  ) {
    overrides.set(IProviderProvisioningTargetService.channelName, {
      apply: async () => {
        throw new Error("Provider Provisioning 仅支持受信 Desktop Host");
      },
    });
  }
  services.exposeOnChannelServer(server, overrides);
  for (const channelName of options.denyChannels ?? []) {
    // 拒绝名单优先于服务图：即使 host 本体注册了该服务也不外露（云入口的边界保证）。
    server.registerChannel(
      channelName,
      createDenyChannel(`channel ${channelName} is not available in cloud mode`),
    );
  }
  socket.onClose(() => {
    void connectionScope?.dispose();
    rawServer.dispose();
  });
}

export const zcodeLiteTokenCookieName = "zcode_lite_token";

const staticMimeTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseCookieHeader(header: string | undefined): Map<string, string> {
  const cookies = new Map<string, string>();
  if (!header) {
    return cookies;
  }
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) {
      cookies.set(name, value);
    }
  }
  return cookies;
}

export function hasValidLiteToken(c: Context, token: string): boolean {
  const url = new URL(c.req.url);
  if (url.searchParams.get("token") === token) {
    c.header(
      "Set-Cookie",
      `${zcodeLiteTokenCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax`,
    );
    return true;
  }
  return parseCookieHeader(c.req.header("cookie")).get(zcodeLiteTokenCookieName) === token;
}

/**
 * 入口的 API / 服务通道命名空间：静态层**永不**接管这些路径（哪怕其中某条豁免了
 * lite-token），未命中路由时按 404/426 语义回答，不返回 index.html。
 */
export function isChannelOrApiPath(pathname: string): boolean {
  return pathname === "/ws" || pathname.startsWith("/ws/") || pathname.startsWith("/api/");
}

/**
 * 执行节点 bridge 通道（`/ws/cloud/bridge/:runId`）：**豁免** lite-token。
 *
 * 判据：它有自己的 run-scoped 鉴权——hello 帧携带的自举 ticket 只存 hash、单次消费，
 * 并与 run/generation/epoch 绑定（02 §4「只接受执行节点出站连接，不复用浏览器 cookie
 * 或 /ws/host capability」、02 §5.1）。沙箱按设计拿不到、也不该有 lite token（那是
 * 浏览器凭据）；把浏览器凭据当成执行节点的准入条件会直接挡死所有沙箱。
 *
 * 豁免 ≠ 放弃鉴权：ticket 校验仍在 hello 阶段执行，无票/错票/旧代际一律 fault + 关闭。
 */
export function isRunScopedBridgePath(pathname: string): boolean {
  return pathname.startsWith("/ws/cloud/bridge/");
}

/**
 * 执行节点 HTTP 端点：`GET /api/cloud/runs/:runId/git-grant`（01 §7.2）。
 *
 * 与 bridge 同类：**自带 run-scoped 鉴权**——请求头 `Authorization: Bearer <当前 run 凭据>`，
 * 服务端只比较 sha256 且绑定 task/run/runGeneration/repo/purpose，**不把 Bearer 放 query**
 * （01 §7.2、W5 §4）。沙箱拿不到浏览器 lite token，用浏览器凭据守它会挡死 bootstrap。
 *
 * **精确匹配单条路径**：不放开 `/api/cloud/runs/*`，更不放开 `/api/*`——其余 cloud API
 * 仍是浏览器面，必须继续要求 lite token。
 */
export function isExecutionNodeHttpPath(pathname: string): boolean {
  return /^\/api\/cloud\/runs\/[^/]+\/git-grant$/.test(pathname);
}

/**
 * 需要 lite-token 的路径：API 与其他服务通道。两处豁免都属执行节点面，各自带
 * run-scoped 鉴权（bridge 走 hello 帧票据，git-grant 走 Bearer）。
 */
export function isTokenProtectedPath(pathname: string): boolean {
  return (
    isChannelOrApiPath(pathname) &&
    !isRunScopedBridgePath(pathname) &&
    !isExecutionNodeHttpPath(pathname)
  );
}

/** 拒绝响应由入口决定（本地入口回 `{error}`，云入口回云错误信封 `{code,…}`）。 */
export type LiteTokenRejection = (c: Context) => Response | Promise<Response>;

/**
 * lite-token 保护中间件。本地入口与云入口共用同一判定：`/ws`、`/ws/*`、`/api/*` 需要
 * token（执行节点面 see `isRunScopedBridgePath`/`isExecutionNodeHttpPath` 两处豁免）；
 * `?token=` 命中即下发 cookie 并放行（浏览器首次带 token 访问 SPA 时就能把 cookie
 * 落下来，后续 `/api`、`/ws` 靠 cookie 通过）。
 */
export function createLiteTokenGuard(
  token: string,
  onReject: LiteTokenRejection = (c) => c.json({ error: "Unauthorized" }, 401),
): MiddlewareHandler {
  return async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    const validToken = hasValidLiteToken(c, token);
    if (!isTokenProtectedPath(pathname) || validToken) {
      await next();
      return;
    }
    return onReject(c);
  };
}

/**
 * SPA fallback 白名单：按「是否为入口 API/通道命名空间」判定，**不**按是否需要 token
 * 判定——否则豁免了 lite-token 的 bridge 路径会掉进 fallback 返回 index.html。
 */
export function isStaticFallbackAllowed(pathname: string): boolean {
  return !isChannelOrApiPath(pathname);
}

function isInsideDirectory(root: string, candidate: string): boolean {
  const diff = relative(root, candidate);
  return diff === "" || (!diff.startsWith("..") && !diff.includes(`..${sep}`));
}

export async function resolveStaticFile(
  staticRoot: string,
  pathname: string,
  spaFallback: boolean,
): Promise<string | null> {
  const root = resolve(staticRoot);
  const normalizedPathname = pathname === "/" ? "/index.html" : pathname;
  const relativePath = decodeURIComponent(normalizedPathname).replace(/^\/+/, "");
  let candidate = resolve(root, relativePath);
  if (!isInsideDirectory(root, candidate)) {
    return null;
  }

  try {
    const candidateStat = await stat(candidate);
    if (candidateStat.isDirectory()) {
      candidate = resolve(candidate, "index.html");
      if (!isInsideDirectory(root, candidate)) {
        return null;
      }
      const indexStat = await stat(candidate);
      return indexStat.isFile() ? candidate : null;
    }
    if (candidateStat.isFile()) {
      return candidate;
    }
  } catch {
    // 静态资源未命中时再进入 SPA fallback，保留真实文件错误的 404 语义。
  }

  if (!spaFallback || !isStaticFallbackAllowed(pathname)) {
    return null;
  }
  const indexFile = resolve(root, "index.html");
  try {
    const indexStat = await stat(indexFile);
    return indexStat.isFile() ? indexFile : null;
  } catch {
    return null;
  }
}

export function staticContentType(filePath: string): string {
  return staticMimeTypes[extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

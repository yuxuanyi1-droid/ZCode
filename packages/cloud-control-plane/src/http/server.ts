import { randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import type { Duplex } from "node:stream";

import { ChannelServer, Emitter, SocketProtocol, VSBuffer, type ISocket } from "@zcode/rpc";
import { WebSocketServer, type WebSocket } from "ws";

import {
  ACCOUNT_PROXY_CHANNELS,
  TASK_ATTACHMENT_CHANNELS,
  createProjectRequestSchema,
  createTaskRequestSchema,
  reopenTaskRequestSchema,
  submitInputRequestSchema,
  toCloudErrorBody,
} from "@zcode/cloud-protocol";

import type { EventHub } from "../app/events.js";
import type { Orchestrator } from "../app/orchestrator.js";
import type { RunRecord } from "../domain/types.js";
import type { BridgeServer } from "../adapters/tunnel/server.js";
import { connectWebSocketOverDuplex, requestOverDuplex } from "../adapters/tunnel/client.js";
import { proxyChannel } from "../channels/proxy.js";

const MAX_BODY_BYTES = 1024 * 1024;
const SESSION_COOKIE = "cloud_session";
const TASK_COOKIE = "cloud_task";
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
  ".pdf": "application/pdf",
};

function wrapSocket(socket: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  socket.on("message", (data, isBinary) => {
    if (!isBinary) return;
    const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
    onData.fire(VSBuffer.wrap(buffer));
  });
  socket.on("close", () => {
    onClose.fire();
    onEnd.fire();
  });
  socket.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });
  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      if (socket.readyState === socket.OPEN) socket.send(buffer.buffer);
    },
    end() {
      socket.close();
    },
    drain() {
      return Promise.resolve();
    },
    dispose() {
      socket.close();
    },
  };
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
  });
  response.end(payload);
}

function sendHtml(response: ServerResponse, status: number, html: string): void {
  const payload = Buffer.from(html, "utf8");
  response.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "content-length": payload.byteLength,
    "cache-control": "no-store",
  });
  response.end(payload);
}

async function readBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > limit) {
      throw new Error("request body too large");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const body = await readBody(request);
  if (body.byteLength === 0) {
    return {};
  }
  return JSON.parse(body.toString("utf8")) as unknown;
}

function parseCookies(request: IncomingMessage): Record<string, string> {
  const header = request.headers.cookie;
  if (!header) {
    return {};
  }
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const AUTH_PAGE_CSS = `
  :root { color-scheme: dark; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center;
    background: #0f1115; color: #e7eaf0; font-family: -apple-system, "Segoe UI", Roboto, sans-serif; }
  form { width: min(400px, 90vw); background: #161a21; border: 1px solid #262d38;
    border-radius: 14px; padding: 26px; display: flex; flex-direction: column; gap: 14px; }
  h1 { font-size: 18px; margin: 0; }
  p { margin: 0; color: #939bab; font-size: 13px; }
  input { background: #1c2129; border: 1px solid #262d38; border-radius: 8px;
    padding: 10px 12px; color: inherit; font: inherit; outline: none; }
  input:focus { border-color: #5b8cff; }
  button { background: #5b8cff; color: #0b0e13; border: none; border-radius: 8px;
    padding: 10px 14px; font: inherit; font-weight: 600; cursor: pointer; }
  ul { width: min(720px, 92vw); padding: 0; list-style: none; margin: 0; display: flex;
    flex-direction: column; gap: 10px; }
  li { background: #161a21; border: 1px solid #262d38; border-radius: 10px; padding: 14px 16px; }
  li a { color: #5b8cff; text-decoration: none; font-weight: 600; }
  .meta { color: #939bab; font-size: 12px; margin-top: 4px; }
  .shell { padding: 32px 16px; display: flex; flex-direction: column; gap: 18px; align-items: center; }
  .badge { display: inline-block; border: 1px solid #262d38; border-radius: 999px;
    padding: 1px 8px; font-size: 11px; color: #939bab; margin-left: 8px; }
  .empty { color: #939bab; }
`;

export interface CloudHttpServerOptions {
  host: string;
  port: number;
  accessToken: string;
  /** 原始 Web 应用（packages/web）的构建目录。 */
  webDistDir: string | null;
  orchestrator: Orchestrator;
  bridgeServer: BridgeServer;
  events: EventHub;
  providers: Array<{
    id: string;
    label: string;
    pause: boolean;
    maxLifetimeSeconds: number;
    verified: boolean;
  }>;
  accountLink: { getChannel(name: string): import("@zcode/rpc").IChannel } | null;
}

export class CloudHttpServer {
  private readonly server: http.Server;
  private readonly eventWss = new WebSocketServer({ noServer: true });
  private readonly rpcWss = new WebSocketServer({ noServer: true });
  private readonly proxyWss = new WebSocketServer({ noServer: true });
  private readonly sessions = new Map<string, number>();

  public constructor(private readonly options: CloudHttpServerOptions) {
    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response).catch((error: unknown) => {
        const { status, body } = toCloudErrorBody(error);
        sendJson(response, status, body);
      });
    });
    this.server.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
  }

  public async start(): Promise<void> {
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolvePromise();
      });
    });
  }

  public close(): void {
    this.eventWss.close();
    this.rpcWss.close();
    this.proxyWss.close();
    this.server.close();
  }

  public address(): { host: string; port: number } {
    const address = this.server.address();
    if (typeof address === "object" && address) {
      return { host: address.address, port: address.port };
    }
    return { host: this.options.host, port: this.options.port };
  }

  // ── auth ────────────────────────────────────────────────────

  private isBearerAuthorized(request: IncomingMessage): boolean {
    const header = request.headers.authorization;
    if (header?.startsWith("Bearer ") && header.slice(7).trim() === this.options.accessToken) {
      return true;
    }
    const url = new URL(request.url ?? "/", "http://localhost");
    return url.searchParams.get("token") === this.options.accessToken;
  }

  private createSession(): string {
    const id = randomBytes(24).toString("base64url");
    this.sessions.set(id, Date.now() + SESSION_TTL_MS);
    return id;
  }

  private hasSession(request: IncomingMessage): boolean {
    const id = parseCookies(request)[SESSION_COOKIE];
    if (!id) return false;
    const expires = this.sessions.get(id);
    if (!expires || expires < Date.now()) {
      this.sessions.delete(id);
      return false;
    }
    return true;
  }

  private setSessionCookie(id: string): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(id)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`;
  }

  // ── task selection ──────────────────────────────────────────

  private selectedRun(request: IncomingMessage): RunRecord | null {
    const taskId = parseCookies(request)[TASK_COOKIE];
    if (taskId) {
      const run = this.options.orchestrator.getActiveRun(taskId);
      if (run?.status === "ready") {
        return run;
      }
    }
    for (const task of this.options.orchestrator.listTasks()) {
      const run = this.options.orchestrator.getActiveRun(task.id);
      if (run?.status === "ready") {
        return run;
      }
    }
    return null;
  }

  // ── request routing ─────────────────────────────────────────

  private async handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = request.method ?? "GET";

    if (path === "/api/cloud/health") {
      sendJson(response, 200, {
        ok: true,
        providers: this.options.providers.map((provider) => provider.id),
      });
      return;
    }

    if (path.startsWith("/api/cloud/")) {
      if (!this.isBearerAuthorized(request)) {
        sendJson(response, 401, { error: { code: "unauthorized", message: "invalid token" } });
        return;
      }
      await this.handleCloudApi(method, path, request, response);
      return;
    }

    // 原始 ZCode Web 的登录门：token → session cookie。
    if (path === "/login") {
      await this.handleLogin(method, request, response);
      return;
    }
    if (path === "/logout") {
      response.writeHead(302, {
        "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0`,
        location: "/login",
      });
      response.end();
      return;
    }

    // 任务选择页：极简导航（不是应用 UI 的替代），选择后回到原始 Web。
    if (path === "/tasks") {
      if (!this.hasSession(request)) {
        response.writeHead(302, { location: "/login" });
        response.end();
        return;
      }
      this.renderTaskList(response);
      return;
    }
    const selectMatch = /^\/tasks\/([^/]+)\/select$/u.exec(path);
    if (selectMatch && method === "GET") {
      if (!this.hasSession(request)) {
        response.writeHead(302, { location: "/login" });
        response.end();
        return;
      }
      response.writeHead(302, {
        "set-cookie": `${TASK_COOKIE}=${encodeURIComponent(decodeURIComponent(selectMatch[1]!))}; SameSite=Lax; Path=/`,
        location: "/",
      });
      response.end();
      return;
    }

    // 原始 Web 的 /api/*（server-info、oauth 等）代理到当前任务的 daemon。
    if (path.startsWith("/api/")) {
      if (!this.hasSession(request)) {
        sendJson(response, 401, { error: { code: "unauthorized", message: "login required" } });
        return;
      }
      await this.proxyHttpToDaemon(request, response, path);
      return;
    }

    // 静态资源无需会话；SPA 入口需要。
    if (path === "/" || path === "/index.html") {
      if (!this.hasSession(request)) {
        response.writeHead(302, { location: "/login" });
        response.end();
        return;
      }
    }
    await this.serveStatic(path, response);
  }

  private async handleLogin(
    method: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (method === "GET") {
      if (this.hasSession(request)) {
        response.writeHead(302, { location: "/" });
        response.end();
        return;
      }
      sendHtml(
        response,
        200,
        `<!doctype html><html><head><meta charset="utf-8"><title>ZCode Cloud</title><style>${AUTH_PAGE_CSS}</style></head>
<body><form method="post" action="/login">
<h1>ZCode Cloud</h1><p>Sign in with your deployment token.</p>
<input type="password" name="token" placeholder="CLOUD_ACCESS_TOKEN" autofocus required>
<button type="submit">Continue</button></form></body></html>`,
      );
      return;
    }
    if (method !== "POST") {
      response.writeHead(405);
      response.end();
      return;
    }
    const body = (await readBody(request)).toString("utf8");
    const params = new URLSearchParams(body);
    const token = params.get("token")?.trim() ?? "";
    if (token !== this.options.accessToken) {
      sendHtml(
        response,
        401,
        `<!doctype html><html><head><meta charset="utf-8"><style>${AUTH_PAGE_CSS}</style></head>
<body><form method="post" action="/login"><h1>ZCode Cloud</h1><p>Invalid token.</p>
<input type="password" name="token" autofocus required><button type="submit">Continue</button></form></body></html>`,
      );
      return;
    }
    response.writeHead(302, {
      "set-cookie": this.setSessionCookie(this.createSession()),
      location: "/tasks",
    });
    response.end();
  }

  private renderTaskList(response: ServerResponse): void {
    const tasks = this.options.orchestrator.listTasks();
    const items = tasks
      .map((task) => {
        const run = this.options.orchestrator.getActiveRun(task.id);
        const status = run ? `${run.status} · gen ${run.generation}` : task.status;
        return `<li><a href="/tasks/${encodeURIComponent(task.id)}/select">${escapeHtml(task.title)}</a>
<span class="badge">${escapeHtml(status)}</span><div class="meta">${escapeHtml(task.taskStableId)}</div></li>`;
      })
      .join("\n");
    sendHtml(
      response,
      200,
      `<!doctype html><html><head><meta charset="utf-8"><title>Cloud tasks</title><style>${AUTH_PAGE_CSS}</style></head>
<body><div class="shell"><h1>Cloud tasks</h1>
${tasks.length === 0 ? '<p class="empty">No tasks yet. Create one through the cloud API.</p>' : `<ul>${items}</ul>`}
</div></body></html>`,
    );
  }

  private async handleCloudApi(
    method: string,
    path: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const orchestrator = this.options.orchestrator;

    if (method === "GET" && path === "/api/cloud/providers") {
      sendJson(response, 200, { providers: this.options.providers });
      return;
    }

    if (path === "/api/cloud/projects") {
      if (method === "GET") {
        sendJson(response, 200, { projects: orchestrator.listProjects() });
        return;
      }
      if (method === "POST") {
        const body = createProjectRequestSchema.parse(await readJsonBody(request));
        sendJson(response, 201, orchestrator.createProject(body));
        return;
      }
    }

    const projectMatch = /^\/api\/cloud\/projects\/([^/]+)$/u.exec(path);
    if (projectMatch && method === "DELETE") {
      orchestrator.deleteProject(decodeURIComponent(projectMatch[1]!));
      sendJson(response, 200, { ok: true });
      return;
    }

    if (path === "/api/cloud/tasks") {
      if (method === "GET") {
        const projectId = new URL(request.url ?? "/", "http://localhost").searchParams.get(
          "projectId",
        );
        sendJson(response, 200, {
          tasks: orchestrator.listTasks(projectId ?? undefined),
          nextCursor: null,
        });
        return;
      }
      if (method === "POST") {
        const body = createTaskRequestSchema.parse(await readJsonBody(request));
        sendJson(response, 201, orchestrator.createTask(body));
        return;
      }
    }

    const taskMatch = /^\/api\/cloud\/tasks\/([^/]+)$/u.exec(path);
    if (taskMatch && method === "GET") {
      sendJson(response, 200, orchestrator.getTask(decodeURIComponent(taskMatch[1]!)));
      return;
    }

    const inputMatch = /^\/api\/cloud\/tasks\/([^/]+)\/inputs$/u.exec(path);
    if (inputMatch && method === "POST") {
      const body = submitInputRequestSchema.parse(await readJsonBody(request));
      const taskId = decodeURIComponent(inputMatch[1]!);
      sendJson(response, 202, await orchestrator.submitInput(taskId, body));
      return;
    }

    const inputStatusMatch = /^\/api\/cloud\/tasks\/([^/]+)\/inputs\/([^/]+)$/u.exec(path);
    if (inputStatusMatch && method === "GET") {
      sendJson(
        response,
        200,
        orchestrator.getInput(
          decodeURIComponent(inputStatusMatch[1]!),
          decodeURIComponent(inputStatusMatch[2]!),
        ),
      );
      return;
    }

    const stopMatch = /^\/api\/cloud\/tasks\/([^/]+)\/stop$/u.exec(path);
    if (stopMatch && method === "POST") {
      sendJson(response, 200, await orchestrator.stopTask(decodeURIComponent(stopMatch[1]!)));
      return;
    }

    const reopenMatch = /^\/api\/cloud\/tasks\/([^/]+)\/reopen$/u.exec(path);
    if (reopenMatch && method === "POST") {
      reopenTaskRequestSchema.parse(await readJsonBody(request));
      sendJson(response, 200, orchestrator.reopenTask(decodeURIComponent(reopenMatch[1]!)));
      return;
    }

    const archiveMatch = /^\/api\/cloud\/tasks\/([^/]+)\/archive$/u.exec(path);
    if (archiveMatch && method === "POST") {
      sendJson(response, 200, orchestrator.archiveTask(decodeURIComponent(archiveMatch[1]!)));
      return;
    }

    const historyMatch = /^\/api\/cloud\/tasks\/([^/]+)\/history$/u.exec(path);
    if (historyMatch && method === "GET") {
      const url = new URL(request.url ?? "/", "http://localhost");
      const cursor = url.searchParams.get("cursor");
      const limit = Number(url.searchParams.get("limit") ?? "100");
      sendJson(
        response,
        200,
        orchestrator.getHistory(
          decodeURIComponent(historyMatch[1]!),
          cursor,
          Number.isFinite(limit) ? limit : 100,
        ),
      );
      return;
    }

    sendJson(response, 404, { error: { code: "not_found", message: "unknown endpoint" } });
  }

  private async proxyHttpToDaemon(
    request: IncomingMessage,
    response: ServerResponse,
    path: string,
  ): Promise<void> {
    const run = this.selectedRun(request);
    if (!run) {
      sendJson(response, 503, {
        error: { code: "attachment_unavailable", message: "no ready task selected" },
      });
      return;
    }
    const token = this.options.orchestrator.getIngressToken(run.id);
    const stream = await this.options.orchestrator.openRunStream(run.id, "daemon");
    if (!token || !stream) {
      sendJson(response, 503, {
        error: { code: "attachment_unavailable", message: "task attachment unavailable" },
      });
      return;
    }
    try {
      const body = await readBody(request);
      const result = await requestOverDuplex(stream, {
        method: request.method === "POST" ? "POST" : "GET",
        path: `${path}${new URL(request.url ?? "/", "http://localhost").search}`,
        headers: {
          authorization: `Bearer ${token}`,
          ...(request.headers["content-type"]
            ? { "content-type": String(request.headers["content-type"]) }
            : {}),
          ...(request.headers.accept ? { accept: String(request.headers.accept) } : {}),
        },
        ...(body.byteLength > 0 ? { body } : {}),
      });
      response.writeHead(result.status, {
        "content-type": "application/json; charset=utf-8",
      });
      response.end(result.body);
    } finally {
      stream.destroy();
    }
  }

  private async serveStatic(path: string, response: ServerResponse): Promise<void> {
    const root = this.options.webDistDir;
    if (!root) {
      response.writeHead(404);
      response.end("cloud web assets are not configured");
      return;
    }
    const resolvedRoot = resolve(root);
    const requested = path === "/" ? "/index.html" : path;
    const candidate = normalize(join(resolvedRoot, requested));
    const target = candidate.startsWith(resolvedRoot)
      ? candidate
      : join(resolvedRoot, "index.html");
    const selected = (await this.isFile(target)) ? target : join(resolvedRoot, "index.html");
    if (!(await this.isFile(selected))) {
      response.writeHead(404);
      response.end("not found");
      return;
    }
    const contentType =
      CONTENT_TYPES[extname(selected).toLowerCase()] ?? "application/octet-stream";
    response.writeHead(200, { "content-type": contentType });
    createReadStream(selected).pipe(response);
  }

  private async isFile(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isFile();
    } catch {
      return false;
    }
  }

  // ── websocket routing ───────────────────────────────────────

  private async handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (path === "/api/cloud/bridge/attach") {
      if (this.options.bridgeServer.handleUpgrade(request, socket, head)) {
        return;
      }
      socket.destroy();
      return;
    }

    if (path === "/ws/cloud") {
      if (!this.isBearerAuthorized(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      this.eventWss.handleUpgrade(request, socket, head, (ws) => {
        const unsubscribe = this.options.events.subscribe((event) => {
          if (ws.readyState === ws.OPEN) {
            ws.send(JSON.stringify(event));
          }
        });
        ws.on("close", unsubscribe);
        ws.on("error", unsubscribe);
        ws.send(JSON.stringify({ type: "hello" }));
      });
      return;
    }

    if (path === "/ws/cloud/account") {
      if (!this.isBearerAuthorized(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const accountLink = this.options.accountLink;
      if (!accountLink) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      this.rpcWss.handleUpgrade(request, socket, head, (ws) => {
        const channelServer = new ChannelServer(new SocketProtocol(wrapSocket(ws)), "account");
        for (const name of ACCOUNT_PROXY_CHANNELS) {
          try {
            channelServer.registerChannel(name, proxyChannel(accountLink.getChannel(name)));
          } catch {
            // 上游未注册该通道。
          }
        }
      });
      return;
    }

    const taskWsMatch = /^\/ws\/cloud\/tasks\/([^/]+)$/u.exec(path);
    if (taskWsMatch) {
      if (!this.isBearerAuthorized(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const taskId = decodeURIComponent(taskWsMatch[1]!);
      const run = this.options.orchestrator.getActiveRun(taskId);
      const link =
        run && run.status === "ready" ? this.options.orchestrator.getRuntimeLink(run.id) : null;
      if (!run || !link) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      this.rpcWss.handleUpgrade(request, socket, head, (ws) => {
        const channelServer = new ChannelServer(new SocketProtocol(wrapSocket(ws)), taskId);
        for (const name of TASK_ATTACHMENT_CHANNELS) {
          try {
            channelServer.registerChannel(name, proxyChannel(link.getChannel(name)));
          } catch {
            // 上游未提供该通道。
          }
        }
      });
      return;
    }

    // 原始 Web 应用：/ws（以及 /ws/host）透明代理到当前任务 daemon。
    if (path === "/ws" || path === "/ws/host") {
      if (!this.hasSession(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      const run = this.selectedRun(request);
      const token = run ? this.options.orchestrator.getIngressToken(run.id) : null;
      const stream = run ? await this.options.orchestrator.openRunStream(run.id, "daemon") : null;
      if (!run || !token || !stream) {
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      let upstream: WebSocket;
      try {
        upstream = await connectWebSocketOverDuplex(stream, `ws://127.0.0.1${path}`, {
          authorization: `Bearer ${token}`,
        });
      } catch {
        socket.destroy();
        return;
      }
      this.proxyWss.handleUpgrade(request, socket, head, (browser) => {
        browser.on("message", (data, isBinary) => {
          if (upstream.readyState === upstream.OPEN) {
            upstream.send(data, { binary: isBinary });
          }
        });
        upstream.on("message", (data, isBinary) => {
          if (browser.readyState === browser.OPEN) {
            browser.send(data, { binary: isBinary });
          }
        });
        browser.on("close", () => upstream.close());
        upstream.on("close", () => browser.close());
        browser.on("error", () => upstream.close());
        upstream.on("error", () => browser.close());
      });
      return;
    }

    socket.destroy();
  }
}

/**
 * fake provider 使用的替身 daemon：完整实现 control-plane 依赖的最小协议面
 * （server-info + /ws ChannelServer），用于无模型凭据时的端到端验收。
 * 它不是产品代码路径，只在 CLOUD_PROVIDERS 包含 fake 时被拉起。
 */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import { join } from "node:path";

import {
  ChannelServer,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type ISocket,
  type IServerChannel,
} from "@zcode/rpc";
import { WebSocketServer, type WebSocket } from "ws";

interface FakeSession {
  id: string;
  messages: Array<Record<string, unknown>>;
}

const sessions = new Map<string, FakeSession>();

function wrapServerSocket(socket: WebSocket): ISocket {
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

function noopChannel(): IServerChannel {
  return {
    async call<T>(): Promise<T> {
      return {} as T;
    },
    listen() {
      return () => ({ dispose() {} });
    },
  };
}

function agentChannel(): IServerChannel {
  return {
    async call<T>(_ctx: string, command: string, args?: unknown): Promise<T> {
      const raw = Array.isArray(args) ? args[0] : args;
      const params = (raw ?? {}) as Record<string, unknown>;
      switch (command) {
        case "initialize":
          return { available: true, workspaceKey: String(params["workspacePath"] ?? "") } as T;
        case "createSession": {
          const id = randomUUID();
          sessions.set(id, { id, messages: [] });
          return { sessionId: id, id, status: "ready" } as T;
        }
        case "sendPrompt": {
          const session = sessions.get(String(params["sessionId"] ?? ""));
          if (!session) throw new Error("unknown session");
          const content = String(params["content"] ?? "");
          session.messages.push({
            id: randomUUID(),
            role: "user",
            parts: [{ type: "text", text: content }],
            createdAt: Date.now(),
          });
          setTimeout(() => {
            session.messages.push({
              id: randomUUID(),
              role: "assistant",
              parts: [{ type: "text", text: `echo: ${content}` }],
              createdAt: Date.now(),
            });
          }, 150);
          return { ok: true } as T;
        }
        case "readSessionMessages": {
          const session = sessions.get(String(params["sessionId"] ?? ""));
          return (session ? [...session.messages] : []) as T;
        }
        case "conversationRowsRangeV4": {
          const session = sessions.get(String(params["sessionId"] ?? ""));
          const messages = session?.messages ?? [];
          const limit = Number(params["limit"] ?? 50);
          const rows = messages
            .slice(-limit)
            .map((message, index) => ({ rowId: index + 1, ...message }));
          return {
            rows,
            atSeq: messages.length,
            atRevision: messages.length,
            atLogEpoch: "1",
            hasMore: false,
          } as T;
        }
        case "listSessions":
          return [...sessions.values()]
            .map((session) => ({
              sessionId: session.id,
              createdAt: 0,
              updatedAt: 0,
              title: "",
              workspace: { workspacePath: String(params["workspacePath"] ?? "") },
              sessionKind: "task",
              mode: "default",
              status: "idle",
            }))
            .sort((left, right) => left.sessionId.localeCompare(right.sessionId)) as T;
        case "closeSession": {
          sessions.delete(String(params["sessionId"] ?? ""));
          return true as T;
        }
        default:
          return {} as T;
      }
    },
    listen() {
      return () => ({ dispose() {} });
    },
  };
}

function parseServerRoot(argv: string[]): string {
  const index = argv.indexOf("--server-root");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) throw new Error("--server-root is required");
  return value;
}

async function stopDaemon(serverRoot: string): Promise<void> {
  const status = JSON.parse(await readFile(join(serverRoot, "run", "status.json"), "utf8")) as {
    pid?: number;
  };
  if (status.pid) {
    try {
      process.kill(status.pid, "SIGTERM");
    } catch {
      // 已退出。
    }
  }
}

async function startDaemon(serverRoot: string): Promise<void> {
  const runDir = join(serverRoot, "run");
  await mkdir(runDir, { recursive: true });
  const ingressToken = randomBytes(24).toString("hex");
  await writeFile(join(runDir, "ingress-token"), ingressToken, { mode: 0o600 });

  const server = http.createServer((req, res) => {
    if (req.url === "/api/server-info") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          serverId: "fake-cloud-daemon",
          version: "0.0.0-fake",
          protocolVersion: 1,
          authRequired: true,
          workspaces: [],
          capabilities: {
            desktopContinuous: true,
            websocketRpc: true,
            virtualProjects: true,
          },
        }),
      );
      return;
    }
    if (req.url === "/api/rpc-host-capability") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ capability: "fake-host-capability" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (!req.url?.startsWith("/ws")) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const channelServer = new ChannelServer(new SocketProtocol(wrapServerSocket(ws)), "fake");
      channelServer.registerChannel("zcode-agent", agentChannel());
      for (const name of [
        "zcode-session",
        "zcode-task",
        "file",
        "file-watcher",
        "git",
        "git-checkpoint",
        "terminal",
        "system",
        "media-preview",
        "prompt-attachment-transfer",
        "provider-provisioning-target",
      ]) {
        channelServer.registerChannel(name, noopChannel());
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const status = {
    protocolVersion: 1,
    state: "ready",
    pid: process.pid,
    port,
    host: "127.0.0.1",
    version: "0.0.0-fake",
    generation: 1,
    serviceRegistered: false,
    runningTaskCount: 0,
  };
  await writeFile(join(runDir, "status.json"), JSON.stringify(status));
  process.stdout.write(`${JSON.stringify(status)}\n`);

  const shutdown = (): void => {
    void writeFile(
      join(runDir, "status.json"),
      JSON.stringify({ ...status, state: "stopped", pid: null, port: null }),
    ).finally(() => {
      server.close();
      wss.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const argv = process.argv.slice(2);
if (argv[0] === "stop") {
  await stopDaemon(parseServerRoot(argv));
  process.exit(0);
}
await startDaemon(parseServerRoot(argv));

import http from "node:http";

import {
  ChannelClient,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type IChannel,
  type ISocket,
} from "@zcode/rpc";
import { serverRemoteInfoSchema, type ServerRemoteInfo } from "@zcode/shared";
import { WebSocket } from "ws";

export interface LocalDaemonConnection {
  readonly serverInfo: ServerRemoteInfo;
  getChannel(name: string): IChannel;
  dispose(): void;
}

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

function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }),
      );
    });
    request.on("error", reject);
  });
}

/** 直连本机 account daemon（loopback），不经过反向通道。 */
export async function connectLocalDaemon(
  baseUrl: string,
  ingressToken: string,
): Promise<LocalDaemonConnection> {
  const authorization = `Bearer ${ingressToken}`;
  const infoResponse = await getJson(`${baseUrl}/api/server-info`, { authorization });
  if (infoResponse.status !== 200) {
    throw new Error(`account daemon server-info failed: ${infoResponse.status}`);
  }
  const serverInfo = serverRemoteInfoSchema.parse(JSON.parse(infoResponse.body));
  const wsUrl = baseUrl.replace(/^http/u, "ws") + "/ws";
  const socket = await new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { authorization } });
    ws.once("open", () => resolve(ws));
    ws.once("error", reject);
  });
  const client = new ChannelClient(new SocketProtocol(wrapSocket(socket)));
  return {
    serverInfo,
    getChannel: (name: string) => client.getChannel(name),
    dispose: () => socket.close(),
  };
}

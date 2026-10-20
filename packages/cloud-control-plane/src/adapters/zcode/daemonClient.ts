import { Emitter, SocketProtocol, VSBuffer, type IChannel, type ISocket } from "@zcode/rpc";
import type { ChannelClient } from "@zcode/rpc";
import { ChannelClient as ChannelClientClass } from "@zcode/rpc";
import { serverRemoteInfoSchema, type ServerRemoteInfo } from "@zcode/shared";
import type { WebSocket } from "ws";

import type { RunAttachment } from "../tunnel/server.js";
import { connectWebSocketOverDuplex, requestOverDuplex } from "../tunnel/client.js";

export interface DaemonConnection {
  readonly serverInfo: ServerRemoteInfo;
  readonly client: ChannelClient;
  getChannel(name: string): IChannel;
  callAgent<T>(command: string, arg?: unknown): Promise<T>;
  applyProvisioning<T>(envelope: unknown): Promise<T>;
  dispose(): void;
}

function wrapNodeSocket(socket: WebSocket): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  socket.on("message", (data, isBinary) => {
    if (!isBinary) {
      return;
    }
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
      if (socket.readyState === socket.OPEN) {
        socket.send(buffer.buffer);
      }
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

export async function connectDaemon(
  attachment: RunAttachment,
  ingressToken: string,
): Promise<DaemonConnection> {
  const authorization = `Bearer ${ingressToken}`;
  const infoDuplex = await attachment.openStream("daemon");
  const response = await requestOverDuplex(infoDuplex, {
    path: "/api/server-info",
    headers: { authorization },
  });
  if (response.status !== 200) {
    throw new Error(`server-info failed with status ${response.status}`);
  }
  const serverInfo = serverRemoteInfoSchema.parse(JSON.parse(response.body.toString("utf8")));

  const wsDuplex = await attachment.openStream("daemon");
  const socket = await connectWebSocketOverDuplex(wsDuplex, "ws://127.0.0.1/ws", {
    authorization,
  });
  const protocol = new SocketProtocol(wrapNodeSocket(socket));
  const client = new ChannelClientClass(protocol);

  return {
    serverInfo,
    client,
    getChannel(name: string): IChannel {
      return client.getChannel(name);
    },
    async callAgent<T>(command: string, arg?: unknown): Promise<T> {
      // Channel 参数约定为数组：server 侧 ProxyChannel 使用 apply(handler, args)。
      return (await client.getChannel("zcode-agent").call(command, [arg])) as T;
    },
    async applyProvisioning<T>(envelope: unknown): Promise<T> {
      return (await client
        .getChannel("provider-provisioning-target")
        .call("apply", [envelope])) as T;
    },
    dispose(): void {
      client.dispose?.();
      socket.close();
    },
  };
}

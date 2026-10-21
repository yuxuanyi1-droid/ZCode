import {
  ChannelServer,
  Emitter,
  SocketProtocol,
  VSBuffer,
  type IChannel,
  type ISocket,
} from "@zcode/rpc";
import { ChannelClient as ChannelClientClass, type ChannelClient } from "@zcode/rpc";
import {
  serverRemoteHostCapabilitySchema,
  serverRemoteInfoSchema,
  TOPIC_RESOURCE_RELAY_CHANNEL,
  ZCODE_RPC_HOST_CAPABILITY_HEADER,
  type ServerRemoteInfo,
} from "@zcode/shared";
import type { WebSocket } from "ws";

import type { RunAttachment } from "../tunnel/server.js";
import { connectWebSocketOverDuplex, requestOverDuplex } from "../tunnel/client.js";

export interface DaemonConnection {
  readonly serverInfo: ServerRemoteInfo;
  readonly client: import("@zcode/rpc").ChannelClient;
  /** 普通 replayable 通道（与浏览器 /ws 同语义）。 */
  getChannel(name: string): IChannel;
  /** 受信 Host 通道（/ws/host）：provisioning 等仅宿主可用的服务。 */
  getHostChannel(name: string): IChannel;
  callAgent<T>(command: string, arg?: unknown): Promise<T>;
  applyProvisioning<T>(envelope: unknown): Promise<T>;
  dispose(): void;
}

function wrapNodeSocket(socket: WebSocket, _label = "ws"): ISocket {
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
  const client = new ChannelClientClass(new SocketProtocol(wrapNodeSocket(socket, "replay")));

  // 受信 Host 连接：provisioning envelope 只允许 desktop-continuous 客户端下发。
  // 该通道不可用（旧 daemon / 隧道异常）时降级为 replayable，provisioning 由上层忽略。
  let hostClient: ChannelClient = client;
  let hostSocket: WebSocket | null = null;
  let reverseServer: ChannelServer | null = null;
  try {
    const capabilityDuplex = await attachment.openStream("daemon");
    const capabilityResponse = await requestOverDuplex(capabilityDuplex, {
      path: "/api/rpc-host-capability",
      method: "POST",
      headers: { authorization },
      body: "{}",
    });
    if (capabilityResponse.status !== 200) {
      throw new Error(`host capability failed with status ${capabilityResponse.status}`);
    }
    const capability = serverRemoteHostCapabilitySchema.parse(
      JSON.parse(capabilityResponse.body.toString("utf8")),
    );
    const hostWsDuplex = await attachment.openStream("daemon");
    hostSocket = await connectWebSocketOverDuplex(hostWsDuplex, "ws://127.0.0.1/ws/host", {
      authorization,
      [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability.capability,
    });
    const hostProtocol = new SocketProtocol(wrapNodeSocket(hostSocket, "host"));
    hostClient = new ChannelClientClass(hostProtocol);
    // Host 连接是双向的：服务端会用反向 client 请求 topic resource relay。
    reverseServer = new ChannelServer(hostProtocol, "cloud-resource");
    reverseServer.registerChannel(TOPIC_RESOURCE_RELAY_CHANNEL, {
      async call<T>(): Promise<T> {
        return {} as T;
      },
      listen() {
        return () => ({ dispose() {} });
      },
    });
  } catch {
    hostClient = client;
  }
  return {
    serverInfo,
    client,
    getChannel(name: string): IChannel {
      return client.getChannel(name);
    },
    getHostChannel(name: string): IChannel {
      return hostClient.getChannel(name);
    },
    async callAgent<T>(command: string, arg?: unknown): Promise<T> {
      // Channel 参数约定为数组：server 侧 ProxyChannel 使用 apply(handler, args)。
      return (await client.getChannel("zcode-agent").call(command, [arg])) as T;
    },
    async applyProvisioning<T>(envelope: unknown): Promise<T> {
      return (await hostClient
        .getChannel("provider-provisioning-target")
        .call("apply", [envelope])) as T;
    },
    dispose(): void {
      client.dispose?.();
      if (hostClient !== client) {
        hostClient.dispose?.();
      }
      reverseServer?.dispose();
      socket.close();
      hostSocket?.close();
    },
  };
}

/**
 * 常驻本地 RPC owner（specs/cloud-agent/02 §3 连接结构、§0 受控 RPC 承载；W6 §3「localRpcOwner」）。
 *
 * 复用既有远端连接原语，与 SSH 模式同一实现、同一语义（07 §2.7 交互同构）：
 *   `remote/handshake.ts` 的 performHandshake → `remote/stdio-socket.ts` 的 wrapStdioStream
 *   → SocketProtocol → ChannelClient。
 *
 * **生命周期与网络解耦**（02 §2 不变量 7）：本对象只在进程退出/显式停止时 dispose；
 * 外网 WSS 断开永远不触发它，也永远不向 zcode-server 写 stdin EOF。
 */
import { ChannelClient, SocketProtocol, type IChannel } from "@zcode/rpc";
import { performHandshake } from "../../../remote/handshake.js";
import { wrapStdioStream } from "../../../remote/stdio-socket.js";
import type { ExecutionLogger, LocalRpcOwnerPort, RuntimeStdioStream } from "../app/ports.js";

export interface LocalRpcOwnerOptions {
  logger: ExecutionLogger;
  clientId?: string;
  handshakeTimeoutMs?: number;
}

export interface LocalRpcOwner extends LocalRpcOwnerPort {
  /** 已建立的 ChannelClient（未连接为 null）；只读用途，调用方不得 dispose。 */
  client(): ChannelClient | null;
}

export function createLocalRpcOwner(options: LocalRpcOwnerOptions): LocalRpcOwner {
  let client: ChannelClient | null = null;
  let protocol: SocketProtocol | null = null;
  let socket: ReturnType<typeof wrapStdioStream> | null = null;

  return {
    async connect(stream: RuntimeStdioStream) {
      const clientId = options.clientId ?? `cloud-bridge-${process.pid}`;
      const { hello, remaining } = await performHandshake(
        stream,
        clientId,
        options.handshakeTimeoutMs ?? 10_000,
      );
      if (remaining && remaining.length > 0) {
        (stream.stdout as NodeJS.ReadableStream & { unshift(chunk: Buffer): void }).unshift(
          remaining,
        );
      }
      socket = wrapStdioStream(stream);
      protocol = new SocketProtocol(socket);
      client = new ChannelClient(protocol);
      options.logger.info(undefined, "local runtime handshake completed", {
        runtimeVersion: hello.version,
        platform: hello.platform,
      });
      return { runtimeVersion: hello.version, capabilitiesVersion: hello.version };
    },

    channel(name) {
      if (!client) return null;
      // **不在这里套浏览器面白名单**（修复依据：真实链路 bootstrap 报
      // `provider provisioning target channel provider-provisioning-target is unavailable`，
      // 而 supervisor 正是要经此通道把 envelope 装进本地 runtime；12 §6 A-08、01 §7.1）。
      // 这条 stdio 连接是执行节点**自己的** runtime，不是浏览器可达面：浏览器面的收窄由
      // `app/rpcRelay.ts` 两道判定完成（先注册 `CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS`
      // 拒绝频道，再只暴露 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`），在那里过滤不会漏，也不会
      // 误伤本地安装器。
      return client.getChannel<IChannel>(name);
    },

    dispose() {
      // 只有显式停止才走到这里：发出 stdio EOF 结束对端是「停止 runtime」的一部分，
      // 不是网络断开的一部分（02 §2 不变量 7）。
      client?.dispose();
      protocol?.dispose();
      socket?.dispose();
      client = null;
      protocol = null;
      socket = null;
    },

    client: () => client,
  };
}

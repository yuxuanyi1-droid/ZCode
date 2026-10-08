/**
 * 控制面 ↔ 沙箱的命令传输缝（specs/cloud-agent 02 §6 唯一写入路径与 §6.2 保留 V4 语义、
 * §6.3 ACK 丢失处理；W1 的 `CloudCommandTransport` / `RuntimeCommandQueryPort`）。
 *
 * 与浏览器路径同一条通路：命令经 `rpc.*` 帧进入沙箱的同一 ChannelServer（W6 的 rpcRelay），
 * 由 relay 用**本地** workspace target 调既有 `sendConversationCommandV4` /
 * `queryConversationCommandsV4`，不另建第二套命令协议、不复制 admission。
 *
 * 语义纪律（禁止互相冒充的四类 ACK，02 §2 不变量 6）：
 * - `{status:"sent"}` 只表示 RPC 调用完成（命令已交给 runtime 服务面），不是 admission，
 *   也不表示任务完成；runtime 的 `CommandAck` 经 `onRuntimeAck` 交给控制面落库。
 * - 超时/断连一律 fail-closed 返回 `closed`（retryable），绝不伪造 sent；
 *   未接线（无当前连接）返回 `no-attachment`。
 */
import { ChannelClient, VSBuffer, type IChannel } from "@zcode/rpc";
import { CLOUD_RPC_PROTOCOL_VERSION, ServiceChannels, type CloudRpcFrame } from "@zcode/shared";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { ExecutionLogger } from "./ports.js";

/** 投递结论（与父模块 `AttachmentSendResult` 结构一致；不深导入其实现文件）。 */
export type CommandSendResult =
  | { status: "sent" }
  | {
      status: "rejected";
      code: string;
      reason: "no-attachment" | "stale" | "not-ready" | "closed";
    };

export type CommandQueryResult =
  | { status: "found"; ack: CommandAck }
  | { status: "unknown" }
  | { status: "unavailable"; retryable: boolean };

/** 当前 Run 的本地 workspace target（沙箱侧事实，由控制面从 run 元数据解析）。 */
export interface CommandRunContext {
  runId: string;
  runGeneration: number;
  connectionEpoch: number;
  workspacePath: string;
  workspaceIdentity: string;
  remoteSessionId?: string;
}

/** 连接的身份三元组：释放/比对只需要它，不需要 workspace 字段。 */
export type CommandConnectionKey = Pick<
  CommandRunContext,
  "runId" | "runGeneration" | "connectionEpoch"
>;

export interface CloudCommandTransportOptions {
  logger: ExecutionLogger;
  /** bridge 专用 streamId：与浏览器 streamId 空间隔离（每条 attach 一个命令会话）。 */
  streamId: string;
  /** 把 rpc.* 帧写入当前 bridge 连接；返回 false 表示连接已释放（fail-closed）。 */
  send(frame: CloudRpcFrame): boolean;
  /** 解析当前有效 attachment 与 workspace target；无有效 attachment 返回 null。 */
  resolveContext(runId: string): CommandRunContext | null;
  /** 调用超时（超过即按 §6.3 置不确定，不重造 commandId）。 */
  timeoutMs?: number;
  /** runtime ACK 落地钩子（W5 接 `AttachmentIngestPort.recordRuntimeAck`）。 */
  onRuntimeAck?(input: {
    taskId: string;
    commandId: string;
    runId: string;
    runGeneration: number;
    ack: CommandAck;
  }): Promise<void>;
  onFault?(fault: { code: string; message: string; retryable: boolean }): void;
}

export interface CloudCommandTransport {
  sendCommand(request: {
    taskId: string;
    runId: string;
    runGeneration: number;
    commandId: string;
    envelope: unknown;
  }): Promise<CommandSendResult>;
  queryCommand(request: {
    taskId: string;
    runId: string;
    runGeneration: number;
    commandId: string;
    runtimeSessionId?: string;
  }): Promise<CommandQueryResult>;
  /** 由 bridge 连接侧调用：把沙箱回投的 rpc.response 交回本传输的 ChannelClient。 */
  handleResponse(frame: CloudRpcFrame): void;
  /**
   * 连接释放：丢弃在途请求（不重放），保留命令事实由控制面对账。
   * `releasedContext` 是**关闭的那条连接**的上下文（run/代际/epoch）；释放只作用于它，
   * 不影响其它 run 或后续新连接（单例传输，见 ensureSession 的修复说明）。
   */
  release(reason: string, releasedContext?: CommandConnectionKey): void;
  dispose(): void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export function createCloudCommandTransport(
  options: CloudCommandTransportOptions,
): CloudCommandTransport {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const inbound = new Map<(buffer: VSBuffer) => void, true>();
  const client = new ChannelClient({
    send(buffer) {
      // 只走 rpc.request；连接未绑定时不发送（返回 false → 调用方 fail-closed）。
      options.send({
        protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
        type: "rpc.request",
        runId: current?.runId ?? "",
        runGeneration: current?.runGeneration ?? 0,
        connectionEpoch: current?.connectionEpoch ?? 0,
        streamId: options.streamId,
        payload: Buffer.from(buffer.buffer).toString("base64"),
      });
    },
    onMessage: (listener) => {
      inbound.set(listener as (buffer: VSBuffer) => void, true);
      return { dispose: () => inbound.delete(listener as (buffer: VSBuffer) => void) };
    },
  });
  let current: CommandRunContext | null = null;
  let openedFor: CommandRunContext | null = null;
  /**
   * 释放只作用于「当时那条连接」的上下文（run/代际/epoch），不是全局标志。
   * 修复依据（2026-10-07 真实链路）：本 transport 在服务端是**单例**，原来的 `released`
   * 一位置 true 永不复位——第一条 bridge 连接关闭（60s 命令超时 / 旧 run 重连被拒）之后，
   * 之后**所有 run** 的投递一律 `attachment_unavailable:closed`，输入永远停在 accepted
   * （run ready 后 0.1s 的投递尝试即失败，沙箱与连接均健在）。新 epoch 即新连接
   * （每次 attach 都 bump epoch），同上下文被拒、新上下文重新开流才是正确语义。
   */
  let releasedFor: CommandConnectionKey | null = null;

  function sameContext(a: CommandConnectionKey, b: CommandConnectionKey): boolean {
    return (
      a.runId === b.runId &&
      a.runGeneration === b.runGeneration &&
      a.connectionEpoch === b.connectionEpoch
    );
  }

  function ensureSession(context: CommandRunContext): boolean {
    if (releasedFor && sameContext(releasedFor, context)) return false;
    // 新上下文 = 新连接：旧连接的释放不适用，且必须对新连接重发 rpc.open
    // （沙箱侧 relay 的流注册在旧 socket 上，不会自动迁移）。
    releasedFor = null;
    current = context;
    if (openedFor && sameContext(openedFor, context)) return true;
    const accepted = options.send({
      protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
      type: "rpc.open",
      runId: context.runId,
      runGeneration: context.runGeneration,
      connectionEpoch: context.connectionEpoch,
      streamId: options.streamId,
    });
    if (!accepted) return false;
    openedFor = context;
    return true;
  }

  function target(context: CommandRunContext) {
    return {
      workspacePath: context.workspacePath,
      workspaceIdentity: context.workspaceIdentity,
      ...(context.remoteSessionId ? { remoteSessionId: context.remoteSessionId } : {}),
    };
  }

  function agentChannel(): IChannel {
    return client.getChannel<IChannel>(ServiceChannels.ZCodeAgent);
  }

  function withTimeout<T>(promise: Promise<T>): Promise<T | "timeout"> {
    // 02 §6.3：超时只裁决「放弃等待、置不确定」，不改变其余语义；race 落定后必须清理
    // 定时器。修复依据（2026-10-07 relay 测试族 flake 排查）：原实现每次调用都遗留一个
    // 30s 真实 setTimeout 且不清除——生产侧控制面高频发令时定时器按调用量累积、拖住事件
    // 循环生命周期；测试侧每个走命令通道的进程要等最后一个 timer 到期才能退出（实测
    // 50ms 的用例集拖到 ~31.5s），多套件并行验证时成倍放大并发进程重叠，正是压垮其它
    // 实时时敏断言的高负载工况。清理 timer 不影响超时语义（输掉的一方本来就不生效）。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    }) as Promise<T | "timeout">;
  }

  return {
    async sendCommand(request) {
      const context = options.resolveContext(request.runId);
      if (!context)
        return { status: "rejected", code: "attachment_unavailable", reason: "no-attachment" };
      if (context.runGeneration !== request.runGeneration) {
        return { status: "rejected", code: "stale", reason: "stale" };
      }
      if (!ensureSession(context)) {
        return { status: "rejected", code: "attachment_unavailable", reason: "closed" };
      }
      try {
        const ack = (await withTimeout(
          // 通道调用约定：`IChannel.call(command, args)` 的 args 是**参数数组**
          // （`ProxyChannel.fromService` 里 `target.apply(handler, args || [])`）。
          // 传裸对象会被当成零参数调用，服务端收到的是 undefined。
          agentChannel().call("sendConversationCommandV4", [
            {
              ...target(context),
              envelope: request.envelope,
            },
          ]),
        )) as CommandAck | "timeout";
        if (ack === "timeout") {
          // 02 §6.3：超时不是 runtime rejected，保持不确定交给控制面对账，绝不伪造 sent。
          options.logger.warn(undefined, "command delivery timed out", {
            commandId: request.commandId,
          });
          return { status: "rejected", code: "network_unknown", reason: "closed" };
        }
        await options.onRuntimeAck?.({
          taskId: request.taskId,
          commandId: request.commandId,
          runId: request.runId,
          runGeneration: context.runGeneration,
          ack,
        });
        return { status: "sent" };
      } catch (error) {
        options.logger.warn(undefined, "command delivery failed", {
          commandId: request.commandId,
          error: error instanceof Error ? error.message : String(error),
        });
        options.onFault?.({
          code: "attachment_unavailable",
          message: "command delivery failed",
          retryable: true,
        });
        return { status: "rejected", code: "attachment_unavailable", reason: "closed" };
      }
    },

    async queryCommand(request) {
      const context = options.resolveContext(request.runId);
      if (!context || context.runGeneration !== request.runGeneration) {
        // 旧代际一律 unavailable：不跨 Run 重放（02 §6.3）。
        return { status: "unavailable", retryable: false };
      }
      if (!ensureSession(context)) return { status: "unavailable", retryable: true };
      try {
        const result = (await withTimeout(
          // 同 `sendConversationCommandV4`：args 必须是参数数组。
          agentChannel().call("queryConversationCommandsV4", [
            {
              ...target(context),
              commands: [
                {
                  commandId: request.commandId,
                  ...(request.runtimeSessionId ? { sessionId: request.runtimeSessionId } : {}),
                },
              ],
            },
          ]),
        )) as { commands?: { commandId: string; ack?: CommandAck }[] } | "timeout";
        if (result === "timeout") return { status: "unavailable", retryable: true };
        const match = result.commands?.find((entry) => entry.commandId === request.commandId);
        if (!match?.ack) return { status: "unknown" };
        return { status: "found", ack: match.ack };
      } catch {
        return { status: "unavailable", retryable: true };
      }
    },

    handleResponse(frame) {
      if (frame.type !== "rpc.response") return;
      if (frame.streamId !== options.streamId) return;
      const buffer = VSBuffer.wrap(new Uint8Array(Buffer.from(frame.payload, "base64")));
      for (const listener of Array.from(inbound.keys())) listener(buffer);
    },

    release(reason, releasedContext) {
      // 连接释放：不发 rpc.close（socket 已断），只把在途请求留给控制面对账。
      // 只毒化「关闭的那条连接」的上下文（见 ensureSession 的修复说明）；
      // 调用方（bridge 关闭路径）知道是哪条连接，未提供时保守按当前开流上下文处理。
      releasedFor = releasedContext ?? current;
      openedFor = null;
      current = null;
      options.logger.debug(undefined, "command transport released", {
        reason,
        ...(releasedFor
          ? {
              runId: releasedFor.runId,
              runGeneration: releasedFor.runGeneration,
              connectionEpoch: releasedFor.connectionEpoch,
            }
          : {}),
      });
    },

    dispose() {
      releasedFor = current;
      openedFor = null;
      current = null;
      client.dispose();
      inbound.clear();
    },
  };
}

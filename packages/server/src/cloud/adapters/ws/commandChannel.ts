/**
 * 控制面命令通道：把 W6 的 `CloudCommandTransport` 接到控制面的 bridge 出站口（W6 CR：
 * 「`handleResponse`/`release` 需在 W5 的 bridge socket 侧接线」，归 W1）。
 *
 * 职责边界：
 * - 命令经 `rpc.*` 帧到沙箱的同一 ChannelServer（W6 的 rpcRelay），由 relay 用本地 workspace
 *   target 调既有 `sendConversationCommandV4`/`queryConversationCommandsV4`；控制面不解析业务
 *   命令、不复制 admission（02 §6.1）。
 * - `{status:"sent"}` 只表示 RPC 调用完成（不是 admission）；runtime 的 `CommandAck` 经
 *   `onRuntimeAck` 交回控制面的 ingest 落库（02 §2 不变量 6 四类 ACK 不互相冒充）。
 * - 断连/超时一律 fail-closed（`closed`/`no-attachment`），永不伪造 sent；未接线即
 *   `no-attachment`，输入停在 accepted、对账保持 uncertain。
 */
import type { CloudRpcFrame } from "@zcode/shared";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import {
  createCloudCommandTransport,
  type CloudCommandTransport,
  type CommandConnectionKey,
  type CommandRunContext,
} from "../../execution/contract.js";
import type { AttachmentRegistry } from "../../app/attachments/registry.js";
import type { CloudControlPlane } from "../../app/assembleCloudControlPlane.js";
import { cloudCoreLogger } from "../../app/logger.js";

export interface ControlPlaneCommandChannel {
  readonly transport: CloudCommandTransport;
  /** 把沙箱回投的 `rpc.response` 交回传输的 ChannelClient。 */
  handleResponse(frame: CloudRpcFrame): void;
  /**
   * bridge 连接释放：丢弃在途 RPC（命令事实留待对账，不重放）。
   * `releasedContext` = 关闭的那条连接（run/代际/epoch）；释放只作用于它，不毒化其它 run
   * 或后续新连接（单例 transport，见 commandTransport 的修复说明）。
   */
  release(reason: string, releasedContext?: CommandConnectionKey): void;
  dispose(): void;
}

export function createControlPlaneCommandChannel(input: {
  services: () => CloudControlPlane;
  registry: AttachmentRegistry;
  /** 把 rpc 帧写入当前 bridge 连接；false 表示连接已释放（fail-closed）。 */
  sendFrame: (frame: CloudRpcFrame) => boolean;
  /** bridge 专用 streamId（与浏览器 streamId 空间隔离）。 */
  streamId: string;
  timeoutMs?: number;
}): ControlPlaneCommandChannel {
  const logger = { ...cloudCoreLogger, scope: "cloud-control-plane" };

  const transport = createCloudCommandTransport({
    logger,
    streamId: input.streamId,
    send: (frame) => input.sendFrame(frame),
    resolveContext(runId): CommandRunContext | null {
      // 只认当前 ready attachment：未 ready/已释放即 null（fail-closed，不回落 host 执行域）。
      const session = input.registry.current(runId);
      if (!session?.ready) return null;
      return {
        runId: session.runId,
        runGeneration: session.runGeneration,
        connectionEpoch: session.connectionEpoch,
        workspacePath: session.address.workspacePath,
        workspaceIdentity: session.address.workspaceIdentity,
        remoteSessionId: session.address.remoteSessionId,
      };
    },
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    async onRuntimeAck({
      taskId,
      commandId,
      runId,
      runGeneration,
      ack,
    }: {
      taskId: string;
      commandId: string;
      runId: string;
      runGeneration: number;
      ack: CommandAck;
    }) {
      // runtime 唯一裁决的 ACK 落到 ingest 通道（receipt delivering → admitted/rejected）。
      await input.services().projections.ingest.recordRuntimeAck({
        taskId,
        commandId,
        runId,
        runGeneration,
        deliveryStatus:
          ack.status === "accepted" || ack.status === "duplicate" ? "admitted" : "rejected",
        runtimeAck: ack,
      });
    },
    onFault(fault) {
      cloudCoreLogger.warn(undefined, "cloud command transport fault", {
        code: fault.code,
        retryable: fault.retryable,
      });
    },
  });

  return {
    transport,
    handleResponse(frame) {
      transport.handleResponse(frame);
    },
    release(reason, releasedContext) {
      transport.release(reason, releasedContext);
    },
    dispose() {
      transport.dispose();
    },
  };
}

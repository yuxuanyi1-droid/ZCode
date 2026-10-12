/**
 * `AttachmentPort` 的 bridge 实现（specs/cloud-agent 02 §4/§6.1；W5 §3）。
 *
 * 独立成文件的原因：`bridgeChannel.ts` 承担帧路由/握手/连接表，已贴近文件行数预算；
 * 控制面 → 执行节点的单帧投递（命令、bootstrap.config、checkpoint、drain）是同一族语义
 * （逐帧代际校验 + sent/rejected），集中在这里，一个实现多处复用。
 *
 * 不变量（与旧实现逐字一致，只是搬家）：
 * - 每次投递按当前连接与 runGeneration 校验，旧代际拒绝（02 §2 不变量 3）；
 * - `checkpoint.request` 前置 `bootstrap.config` 已发（02 §5.3）；
 * - 用户资源同步不经本端口：连接期同步走 `rpc.*` 帧（`controlPlaneRpcChannel.ts`），
 *   `bootstrap.resources` 自举下发已随简化定调整体退役（14 §4.8）。
 */
import { isCloudErrorCode } from "@zcode/shared";
import type { AttachmentPort } from "../../app/ports/attachmentPort.js";
import type { AttachmentRegistry } from "../../app/attachments/registry.js";
import type { StoragePort } from "../../app/ports/storagePort.js";
// 命令传输的类型归属 cloud-execution 公开契约（W6 实现）；本文件只消费其结构。
import type { CloudCommandTransport } from "../../execution/contract.js";
import {
  reject,
  resolveConnection,
  sendFrame,
  type LiveConnection,
  type SendRejection,
} from "./types.js";

export interface BridgeAttachmentPortDeps {
  readonly connections: ReadonlyMap<string, LiveConnection>;
  readonly registry: AttachmentRegistry;
  readonly storage: StoragePort;
  /** W6 命令传输（rpc.* → 沙箱 ChannelServer）；命令投递与事实查询共用同一实例。 */
  readonly commandChannel: { readonly transport: CloudCommandTransport };
}

export function createBridgeAttachmentPort(deps: BridgeAttachmentPortDeps): AttachmentPort {
  const { connections, registry, storage, commandChannel } = deps;

  /** 单帧投递的公共寻址：无连接 → no-attachment；旧代际 → stale（不静默改写目标）。 */
  function connectionFor(input: {
    runId: string;
    runGeneration: number;
  }): { connection: LiveConnection } | { rejected: SendRejection } {
    const connection = connections.get(input.runId);
    if (!connection) return { rejected: reject("no-attachment", "not_ready") };
    if (connection.runGeneration !== input.runGeneration) {
      return { rejected: reject("stale", "stale") };
    }
    return { connection };
  }

  return {
    async sendCommand(request) {
      const run = await storage.runs.activeOfTask(request.taskId);
      if (!run) return reject("no-attachment", "not_ready");
      const resolved = resolveConnection(connections, {
        runId: run.runId,
        runGeneration: run.runGeneration,
        connectionEpoch: request.expectation?.connectionEpoch ?? run.connectionEpoch,
      });
      if ("rejected" in resolved) return resolved.rejected;
      if (request.expectation?.requireReady && !registry.current(run.runId)?.ready) {
        return reject("not-ready", "not_ready");
      }
      // 命令经 W6 的传输（rpc.* → 沙箱 ChannelServer）；失败语义由传输给出（sent 不是 admission）。
      const result = await commandChannel.transport.sendCommand({
        taskId: request.taskId,
        runId: resolved.connection.runId,
        runGeneration: resolved.connection.runGeneration,
        commandId: request.commandId,
        envelope: request.envelope,
      });
      if (result.status === "sent") return { status: "sent" };
      const reason =
        result.reason === "no-attachment" || result.reason === "stale" || result.reason === "closed"
          ? result.reason
          : "not-ready";
      // 归一错误码目录是唯一事实源：传输回传的未知 code 收敛为 network_unknown（不伪造新码）。
      return {
        status: "rejected",
        code: isCloudErrorCode(result.code) ? result.code : "network_unknown",
        reason,
      };
    },

    async sendBootstrapConfig(request) {
      const resolved = connectionFor(request);
      if ("rejected" in resolved) return resolved.rejected;
      sendFrame(resolved.connection, {
        protocolVersion: 1,
        type: "bootstrap.config",
        ...request.config,
      });
      return { status: "sent" };
    },

    async requestCheckpoint(request) {
      const resolved = connectionFor(request);
      if ("rejected" in resolved) return resolved.rejected;
      const connection = resolved.connection;
      if (
        !registry.bootstrapConfigSent({
          runId: request.runId,
          runGeneration: request.runGeneration,
          connectionEpoch: connection.connectionEpoch,
        })
      ) {
        // ready 前置未完成：不发起保存（02 §5.3）。
        return reject("not-ready", "not_ready");
      }
      sendFrame(connection, {
        protocolVersion: 1,
        type: "checkpoint.request",
        operationId: request.operationId,
        runId: request.runId,
        runGeneration: request.runGeneration,
        connectionEpoch: connection.connectionEpoch,
        purpose: request.purpose,
      });
      return { status: "sent" };
    },

    async requestDrain(request) {
      const resolved = connectionFor(request);
      if ("rejected" in resolved) return resolved.rejected;
      sendFrame(resolved.connection, {
        protocolVersion: 1,
        type: "bridge.drain",
        operationId: request.operationId,
        reason: request.reason,
        connectionEpoch: resolved.connection.connectionEpoch,
      });
      return { status: "sent" };
    },

    async currentAddress(runId) {
      return registry.current(runId)?.address ?? null;
    },
  };
}

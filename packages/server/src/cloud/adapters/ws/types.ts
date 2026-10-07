/**
 * bridge 通道的共享类型与帧编解码（specs/cloud-agent 02 §4 地址与网络帧、§5 握手、
 * §7 投影 ingest）。控制面这一侧与执行节点（W6）共用 frozen 的 shared 帧 schema。
 */
import { cloudBridgeControlFrameSchema, type CloudBridgeControlFrame } from "@zcode/shared";
import type { AttachmentPort, AttachmentSendResult } from "../../app/ports/attachmentPort.js";
import type { RuntimeCommandQueryPort } from "../../app/ports/runtimeCommandQueryPort.js";
import type { ClockPort } from "../../app/ports/clockPort.js";
import type { IdGeneratorPort } from "../../app/ports/idGeneratorPort.js";
import type { HashPort } from "../../app/ports/hashPort.js";
import type { StoragePort } from "../../app/ports/storagePort.js";
import type { AttachmentRegistry } from "../../app/attachments/registry.js";
import type { CloudControlPlane as CloudControlPlaneServices } from "../../app/assembleCloudControlPlane.js";
import { cloudCoreLogger, type CloudCoreLogger } from "../../app/logger.js";
import type { BrowserRpcStream, OpenBrowserRpcStreamInput } from "./browserStreams.js";

/** 控制面声明的执行节点能力清单（welcome.capabilities，≤64 项）。 */
export const CLOUD_BRIDGE_CAPABILITIES = [
  "durable-input",
  "replayable-history",
  "projection-ingest",
  "checkpoint-v1",
  "bootstrap.config",
] as const;

/**
 * 命令投递传输缝：把 V4 命令信封送到沙箱内 runtime（经 `rpc.*` 转接，W6 的 rpcRelay 实现，
 * W5 装配注入）。未接线时 `sendCommand` fail-closed：不静默丢弃、不伪造 sent。
 */
export interface CloudCommandTransport {
  sendCommand(request: {
    taskId: string;
    runId: string;
    runGeneration: number;
    commandId: string;
    envelope: unknown;
  }): Promise<AttachmentSendResult>;
}

/** 最小 socket 抽象：具体 WS 库由入口层决定（hono/node-ws 在 HTTP 路由侧适配）。 */
export interface BridgeSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onMessage(handler: (data: string) => void): void;
  /** 关闭回调带关闭码/原因（用于日志区分「正常断开 / 1008 拒绝 / socket error」）。 */
  onClose(handler: (closeInfo?: { code?: number; reason?: string; error?: string }) => void): void;
}

export interface LiveConnection {
  socket: BridgeSocket;
  taskId: string;
  runId: string;
  runGeneration: number;
  connectionEpoch: number;
  runtimeIncarnation: string;
}

export interface CloudBridgeChannel {
  readonly port: AttachmentPort;
  readonly runtimeCommands: RuntimeCommandQueryPort;
  /**
   * 浏览器任务通道（`/ws/cloud/tasks/:taskId`）：打开一条转发到沙箱的 RPC 流。
   * 无当前连接/代际不符返回 null，调用方按 4503 结构化关闭（03 §7.1、CP-11）。
   */
  openBrowserRpcStream(input: OpenBrowserRpcStreamInput): BrowserRpcStream | null;
  /** `/ws/cloud/bridge/:runId` 建连后调用（await 完成 run 绑定后再收帧）。 */
  acceptConnection(input: { runId: string; socket: BridgeSocket }): Promise<void>;
  /** 关闭所有连接（进程关停）。 */
  close(): Promise<void>;
}

export interface CloudBridgeContext {
  /**
   * 惰性取用 app 服务：装配顺序是「先建通道（提供 AttachmentPort）→ 再建 app 平面」，
   * 因此这里用访问器而不是实例。
   */
  services: () => CloudControlPlaneServices;
  /** 日志注入缝（测试捕获；缺省用模块级 cloudCoreLogger）。 */
  logger?: CloudCoreLogger;
  registry: AttachmentRegistry;
  storage: StoragePort;
  clock: ClockPort;
  hash: HashPort;
  ids: IdGeneratorPort;
}

/** 通道日志器：注入优先，缺省模块级（范围限定在 cloud-control-plane）。 */
export function bridgeLogger(context: { logger?: CloudCoreLogger }): CloudCoreLogger {
  return context.logger ?? cloudCoreLogger;
}

export type SendRejection = AttachmentSendResult & { status: "rejected" };

export type ConnectionResolution = { connection: LiveConnection } | { rejected: SendRejection };

export function reject(
  reason: SendRejection["reason"],
  code: SendRejection["code"],
): SendRejection {
  return { status: "rejected", code, reason };
}

export function sendFrame(connection: LiveConnection, frame: CloudBridgeControlFrame): void {
  connection.socket.send(JSON.stringify(frame));
}

export function resolveConnection(
  connections: ReadonlyMap<string, LiveConnection>,
  run: { runId: string; runGeneration: number; connectionEpoch: number },
): ConnectionResolution {
  const connection = connections.get(run.runId);
  if (!connection) return { rejected: reject("no-attachment", "not_ready") };
  if (connection.runGeneration !== run.runGeneration) {
    return { rejected: reject("stale", "stale") };
  }
  if (connection.connectionEpoch !== run.connectionEpoch) {
    return { rejected: reject("stale", "stale") };
  }
  return { connection };
}

/** 未知版本/未知字段：整帧拒绝（fail-closed，02 §4 尾段）。 */
export function parseBridgeFrame(value: unknown): CloudBridgeControlFrame | null {
  const parsed = cloudBridgeControlFrameSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

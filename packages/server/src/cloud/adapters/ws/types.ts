/**
 * bridge 通道的共享类型与帧编解码（specs/cloud-agent 02 §4 地址与网络帧、§5 握手、
 * §7 投影 ingest）。控制面这一侧与执行节点（W6）共用 frozen 的 shared 帧 schema。
 */
import {
  cloudBridgeControlFrameSchema,
  type CloudBridgeControlFrame,
  type CloudRunAddress,
  type CloudStreamCursor,
} from "@zcode/shared";
import type { AttachmentPort, AttachmentSendResult } from "../../app/ports/attachmentPort.js";
import type { ControlPlaneRpcPort } from "../../app/ports/controlPlaneRpcPort.js";
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
  /**
   * hello 凭据校验是否已完成（02 §5.1）。
   *
   * 修复依据（2026-10-07 review P0）：此前 socket 在 accept 时即进入连接表并挂
   * detach/markDisconnected 副作用，而 `/ws/cloud/bridge/*` 在 HTTP 升级层豁免
   * lite-token——知道 runId 的未鉴权方可占据路由槽、截获 bootstrap.config 并把真实桥
   * 挤下线。修复后：未完成 hello 的连接不得进入路由表、不得处理任何非 hello 帧、
   * 关闭也不触发 registry/run 状态副作用。
   */
  authenticated: boolean;
  /**
   * 本连接已完成的 hello 事实（02 §5.1 第 5 条）：同 socket 重复 hello 必须返回原
   * connectionEpoch/rotationId/ingestCursors，且不再消费凭据、不递增 epoch。
   * 修复依据（2026-10-17 review R5）：此前重复 hello 会再次 consumeForHello——凭据已被
   * 上一次 hello 切到候选 hash，重放同一 hello 会被误判为未认证并关闭连接。
   */
  hello?: {
    attemptId: string;
    rotationId: string;
    /** 首次 hello 的地址事实（已用 run 持久事实校验/归一）。 */
    address: CloudRunAddress;
    ingestCursors: CloudStreamCursor[];
  };
  /**
   * D4-2 中间步：bridge.heartbeat 的连续 `processAlive=false` 计数（连接级、可重建的
   * 事实，不是元数据事实源）。达到 RUNTIME_EXIT_DEAD_STREAK_LIMIT 即确认 runtime 退出。
   */
  runtimeDeadStreak?: number;
  /** 连接生命周期内确认过 runtime 退出：关闭时按 runtime-exit 语义标注 run。 */
  runtimeExitConfirmed?: boolean;
}

export interface CloudBridgeChannel {
  readonly port: AttachmentPort;
  readonly runtimeCommands: RuntimeCommandQueryPort;
  /**
   * 控制面 RPC 会话端口（M8 连接期同步；14 §4.2）：app 层的用户资源同步只经它调沙箱
   * 既有 sync 服务（`rpc.*` 帧 + `serviceScope: "control-plane"`）。
   */
  readonly controlPlaneRpc: ControlPlaneRpcPort;
  /**
   * 浏览器任务通道（`/ws/cloud/tasks/:taskId`）：打开一条转发到沙箱的 RPC 流。
   * 无当前连接/代际不符返回 null，调用方按 4503 结构化关闭（03 §7.1、CP-11）。
   */
  openBrowserRpcStream(input: OpenBrowserRpcStreamInput): BrowserRpcStream | null;
  /**
   * 该 run 是否有打开的浏览器观看流（08 §7 空闲 pause 的连接事实源；注入 app 的
   * `BrowserWatchPort` 由本方法承载）。关闭即清，不持久。
   */
  hasOpenBrowserStreams(runId: string): boolean;
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

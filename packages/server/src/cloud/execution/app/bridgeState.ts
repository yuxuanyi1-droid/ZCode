/**
 * Bridge 会话的共享运行状态与帧编解码工具（W6 内部；拆自 bridgeSession.ts）。
 *
 * 会话被拆成三块以保持单文件规模与职责清晰：
 * - `bridgeState.ts`（本文件）：跨连接的可变状态 + 出站编码/日志；
 * - `bridgeHandshake.ts`：hello/welcome 与凭据旋转阶梯；
 * - `bridgeInbound.ts`：入站帧路由（控制帧与 rpc 帧）；
 * - `bridgeSession.ts`：连接循环与对外 API。
 */
import type { BootstrapConfigFrame, BridgeWelcomeFrame, CloudRunAddress } from "@zcode/shared";
import { encodeBridgeFrame } from "../domain/bridgeFrames.js";
import { HEARTBEAT_INTERVAL_MS, type DisconnectReason } from "../domain/supervision.js";
import type { Deferred } from "./deferred.js";
import type { CredentialStateSnapshot } from "../domain/credentialRotation.js";
import type {
  AttachmentContext,
  BootstrapPort,
  BridgeConnectionPort,
  BridgeTransportPort,
  CheckpointPort,
  CredentialStatePort,
  DrainPort,
  ExecutionClock,
  ExecutionLogger,
  ProjectionPort,
  RpcRelayPort,
} from "./ports.js";

export type BridgeSessionState =
  | "idle"
  | "connecting"
  | "authenticating"
  | "bootstrapping"
  | "ready"
  | "draining"
  | "stopped"
  | "failed-closed";

export interface BridgeTimings {
  heartbeatIntervalMs: number;
  welcomeTimeoutMs: number;
  bootstrapConfigTimeoutMs: number;
  projectionBatchSize: number;
}

export interface BridgeSessionOptions {
  address: CloudRunAddress;
  /** 出站 WSS 地址（`/ws/cloud/bridge/:runId` 的完整 wss 形式）。 */
  bridgeUrl: string;
  /** hello 地址里的路径形状；真实 checkout 路径以 `bootstrap.config.workspacePath` 为准。 */
  workspacePathHint: string;
  transport: BridgeTransportPort;
  credentials: CredentialStatePort;
  projection: ProjectionPort;
  rpcRelay: RpcRelayPort;
  bootstrap: BootstrapPort;
  checkpoint: CheckpointPort;
  drain: DrainPort;
  clock: ExecutionClock;
  logger: ExecutionLogger;
  newAttemptId(): string;
  newResumeToken(): string;
  jitter(): number;
  /**
   * 不可恢复的本地错误（如状态目录不可写）：装配层据此退出进程并留下可诊断证据，
   * 而不是继续退避重连到控制面超时（02 §5.1 的持久化前提失效）。
   */
  onFatal?(reason: string): void;
  /**
   * 连接建立/释放钩子：装配层用它把「当前可写连接」交给 rpcRelay 等出站通道。
   * 返回的 disposable 在连接关闭时调用（关闭路径只释放网络 facade）。
   */
  onConnection?(connection: BridgeConnectionPort): { dispose(): void } | void;
  timings?: Partial<BridgeTimings>;
}

export interface BridgeSession {
  start(): void;
  stop(reason: string): Promise<void>;
  state(): BridgeSessionState;
  /** 当前 attachment 代际（未接管时为 null）；用于本地诊断与测试断言。 */
  connectionEpoch(): number | null;
  /** 已 ready 的 attachment 上下文（relay/checkpoint 用它校验帧代际）。 */
  context(): AttachmentContext | null;
}

/** 本地 pre-welcome 协议错误（epoch 倒退等）：按 protocol-error 分类重连。 */
export class ProtocolError extends Error {}

/**
 * 不可重试的本地错误（例如凭据状态文件写不进去）。
 *
 * 为什么是终态而不是退避重连：02 §5.1 要求「候选先持久化，再发 hello」——本地写失败时
 * 旋转与恢复阶梯都失去事实源，重试只会在同一个坏环境里无限打转，而且会掩盖真实故障
 * （2026-10-05 真实沙箱的 EACCES 就是这样被吞成「一直不 ready」的）。
 */
export class FatalBridgeError extends Error {}

/** 持久化凭据状态；失败即终态（见 FatalBridgeError 注释）。 */
export async function persistCredentials(
  options: BridgeSessionOptions,
  next: CredentialStateSnapshot,
): Promise<void> {
  try {
    await options.credentials.save(next);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new FatalBridgeError(`credential state is not persistable: ${message}`);
  }
}

/** 跨连接共享的可变状态；每个连接只写自己的 epoch/ready 位。 */
export interface BridgeRuntimeState {
  status: BridgeSessionState;
  stopped: boolean;
  epoch: number | null;
  /** 当前连接的 ready 位：网络断开即清除（02 §5.3 判定按当前 attachment 生效）。 */
  connectionReady: boolean;
  /** 节点自身 bootstrap 结论：跨网络连接保留（重连不重新 clone，B-02）。 */
  bootstrapped: boolean;
  config: BootstrapConfigFrame | null;
  credentials: CredentialStateSnapshot | null;
  /** 本连接是否收到过显式拒绝（`bridge.fault` 鉴权类）。 */
  rejected: boolean;
  /** 本连接的 hello 是否始终没有 welcome（超时/关闭，无拒绝证据）。 */
  unconfirmed: boolean;
  closeReason: DisconnectReason;
  connection: BridgeConnectionPort | null;
  readonly seenOperationIds: Set<string>;
  welcomeSlot: Deferred<BridgeWelcomeFrame> | null;
  configSlot: Deferred<BootstrapConfigFrame> | null;
}

export function createBridgeRuntimeState(): BridgeRuntimeState {
  return {
    status: "idle",
    stopped: false,
    epoch: null,
    connectionReady: false,
    bootstrapped: false,
    config: null,
    credentials: null,
    rejected: false,
    unconfirmed: false,
    closeReason: "socket-close",
    connection: null,
    seenOperationIds: new Set<string>(),
    welcomeSlot: null,
    configSlot: null,
  };
}

export function logBridgeState(
  state: BridgeRuntimeState,
  logger: ExecutionLogger,
  next: BridgeSessionState,
  detail: Record<string, unknown> = {},
): void {
  state.status = next;
  logger.info(undefined, `bridge state: ${next}`, detail);
}

export function sendFrame(connection: BridgeConnectionPort, frame: unknown): void {
  connection.send(encodeBridgeFrame(frame as never));
}

/** 每个连接单独捕获 epoch；旧代际连接不再发送任何业务帧（02 §2 不变量 3）。 */
export function connectionContext(
  state: BridgeRuntimeState,
  address: CloudRunAddress,
): AttachmentContext | null {
  if (state.epoch === null || !state.connectionReady) return null;
  return {
    address,
    connectionEpoch: state.epoch,
    runGeneration: address.runGeneration,
  };
}

export const DEFAULT_BRIDGE_TIMINGS: BridgeTimings = {
  heartbeatIntervalMs: HEARTBEAT_INTERVAL_MS,
  welcomeTimeoutMs: 15_000,
  bootstrapConfigTimeoutMs: 60_000,
  projectionBatchSize: 128,
};

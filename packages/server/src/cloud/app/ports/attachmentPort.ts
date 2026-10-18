/**
 * 沙箱 attachment 端口草案（specs/cloud-agent/02 §4 地址与网络帧、§6 输入通路、
 * §7 投影 ingest；W1 §4「attachment/dispatcher 端口」）。
 *
 * 控制面 app 只依赖本端口，实现由 attachment 传输侧（cloud-execution 的 WSS
 * bridge 传输 + W5 装配）提供：控制面不 import 传输实现，传输侧不复制 fencing。
 * 两个方向都在本文件冻结：
 * - `AttachmentPort`：控制面 → attachment（命令投递、checkpoint、drain）；
 * - `AttachmentIngestPort`：attachment → 控制面（投影 batch、run fault）。
 *
 * 每次投递都必须按当前 ready attachment 与 runGeneration/connectionEpoch 校验，
 * 旧代际帧拒绝（02 §2 不变量 3）；网络断开只释放网络 facade，不关闭 stdio/runtime
 * （02 §3）。
 */
import type {
  BootstrapConfigFrame,
  BridgeDrainFrame,
  CheckpointPurpose,
  CloudAttachmentAddress,
  CloudErrorCode,
  CloudStreamCursor,
  ProjectionBatchFrame,
} from "@zcode/shared";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

/** 投递期望：调用方声明的代际；实现发现不匹配时返回 stale，不静默改写目标。 */
export interface AttachmentSendExpectation {
  runGeneration: number;
  connectionEpoch: number;
  /** true 时要求 attachment 已 ready（02 §5.3 ready 门控后才允许首命令）。 */
  requireReady: boolean;
}

export type AttachmentSendResult =
  | { status: "sent" }
  | {
      status: "rejected";
      code: CloudErrorCode;
      reason: "no-attachment" | "stale" | "not-ready" | "closed";
    };

export interface AttachmentCommandRequest {
  taskId: string;
  commandId: string;
  /** V4 命令原信封（复用既有 command/createSession 语义，不另建业务协议）。 */
  envelope: unknown;
  expectation?: AttachmentSendExpectation;
}

export interface AttachmentCheckpointRequest {
  taskId: string;
  runId: string;
  runGeneration: number;
  /** 与 outbox operation 同键：重放必须复用结果（01 §8）。 */
  operationId: string;
  /** 取值集合来自 shared 的 `checkpointPurposeSchema`，不在此复制第二份规则。 */
  purpose: CheckpointPurpose;
}

export interface AttachmentDrainRequest {
  taskId: string;
  runId: string;
  runGeneration: number;
  operationId: string;
  reason: BridgeDrainFrame["reason"];
}

export interface AttachmentBootstrapRequest {
  taskId: string;
  runId: string;
  runGeneration: number;
  /**
   * `bootstrap.config` 的载荷（不含 protocolVersion/type：帧头由传输层按当前协议版本补齐）。
   * 运行配置、clone 事实与 provisioning envelope 只经认证通道下发，不走 provider env/元数据
   * （01 §6.2、12 §6）。
   */
  config: Omit<BootstrapConfigFrame, "protocolVersion" | "type">;
}

export interface AttachmentPort {
  /** 单条投递路径：HTTP `/inputs` 与 RPC 发送共用同一 gateway 的出口（02 §6.1）。 */
  sendCommand(request: AttachmentCommandRequest): Promise<AttachmentSendResult>;
  /**
   * 下发运行配置、clone 事实与 provisioning envelope：传输编码是 `bootstrap.config`
   * 控制帧，必须在 welcome 之后、ready 之前到达（02 §4、01 §6.2）。凭据正文不进日志。
   */
  sendBootstrapConfig(request: AttachmentBootstrapRequest): Promise<AttachmentSendResult>;
  /**
   * 触发一次 checkpoint（08 §8 统一保存/停止通路）：传输编码是 bridge 控制帧
   * `checkpoint.request`，结果以 `checkpoint.result` 回投（02 §4，CR-1 冻结）。
   * operationId 与 outbox operation 同键：重放复用结果，不产生第二个保存事实（01 §8）。
   */
  requestCheckpoint(request: AttachmentCheckpointRequest): Promise<AttachmentSendResult>;
  /** 受控回收（08 §8.1 停止屏障）；传输编码是 `bridge.drain` 控制帧。 */
  requestDrain(request: AttachmentDrainRequest): Promise<AttachmentSendResult>;
  /** 当前有效 attachment 地址；无有效 attachment 返回 null，不回落 host 执行域（03 §2）。 */
  currentAddress(runId: string): Promise<CloudAttachmentAddress | null>;
  /**
   * 当前 run 是否有 ready attachment。
   *
   * 这是瞬态**连接事实**（内存注册表），不是持久 run 状态：pause/重连窗口内 run 可能
   * 已是 ready 而 attachment 尚未回连。调用方不得据此改写 run 状态，只用于呈现/门控
   * 客户端是否绑定实时会话。
   */
  isReady(runId: string): Promise<boolean>;
  /**
   * 主动关闭当前 bridge 连接（受控暂停用）。
   *
   * 修复依据（2026-10-18 恢复慢）：provider pause 只冻结沙箱，控制面 detach 注册表但
   * 不关 socket；执行节点侧可能把半开连接当网络故障，按 1s→2s→…→60s 指数退避重连。
   * 暂停后主动关闭连接，执行节点在恢复时直接从退避起点重连，避免恢复后还要等一次
   * 最长 60s 的退避。无连接时是 no-op；不得据此改写 run 状态。
   */
  closeConnection(runId: string, reason: string): Promise<void>;
}

/** 投影 ingest 结论：只有事务提交成功才算 durable ingest（02 §7.2 第 3 步）。 */
export interface ProjectionIngestResult {
  accepted: number;
  /** 缺口时的期望 sourceSeq：返回而不跳跃确认（02 §7.1）。 */
  expectedSourceSeq?: { topic: string; logEpoch: string; expectedSourceSeq: number };
  /** 已连续持久水位，用于回投影 ACK。 */
  cursors: CloudStreamCursor[];
  conflicts: { topic: string; logEpoch: string; sourceSeq: number }[];
}

export interface AttachmentIngestPort {
  ingestProjectionBatch(frame: ProjectionBatchFrame): Promise<ProjectionIngestResult>;
  /** run fault 上报：不回滚已持久事实，只记录错误与恢复入口（02 §8 故障表）。 */
  reportRunFault(request: {
    taskId: string;
    runId: string;
    runGeneration: number;
    errorCode: CloudErrorCode;
    message: string;
    retryable: boolean;
  }): Promise<void>;
  /** runtime ACK 落地：receipt 从 delivering → admitted/rejected（02 §6.2）。 */
  recordRuntimeAck(request: {
    taskId: string;
    commandId: string;
    runId: string;
    runGeneration: number;
    deliveryStatus: "admitted" | "rejected";
    runtimeAck: CommandAck;
  }): Promise<void>;
}

/**
 * 投影与只读投影端口（specs/cloud-agent 03 §4 projection_events/snapshots/checkpoints
 * 表、02 §7.1/§7.2、08 §3.3）。W2 实现。
 */
import type {
  CloudCheckpointRecord,
  CloudExecutionProjection,
  CloudProjectionRecord,
  CloudStreamCursor,
  CloudTaskArtifactRecord,
} from "@zcode/shared";

export interface ProjectionAppendResult {
  /** 已连续持久水位（用于 projection.ack）。 */
  cursors: CloudStreamCursor[];
  /** 同键不同 contentHash：一致性 fault，必须告警而不是覆盖（02 §7.1）。 */
  conflicts: { topic: string; logEpoch: string; sourceSeq: number }[];
  appended: number;
  /**
   * 本批次**实际新增**记录所属的 runId（去重后）。08 §7 业务活动事实源收窄：
   * WAL 重投/补发（0 新增）不得推进 lastBusinessActivityAt，调用方据此分流。
   */
  appendedRunIds: string[];
}

export interface ProjectionRepo {
  /** 幂等追加：去重键 (runId, runtimeIncarnation, topic, logEpoch, sourceSeq)（02 §7.1）。 */
  appendBatch(records: readonly CloudProjectionRecord[]): Promise<ProjectionAppendResult>;
  readHistory(request: {
    taskId: string;
    topic?: string;
    cursor?: string;
    limit: number;
  }): Promise<{ items: CloudProjectionRecord[]; nextCursor?: string; resyncRequired?: boolean }>;
  readSnapshot(request: {
    taskId: string;
    topic: string;
    logEpoch?: string;
  }): Promise<{ logEpoch: string; coveredSourceSeq: number; snapshot: unknown } | null>;
  /** 快照必须声明所覆盖的 sourceSeq 范围（03 §4 projection_snapshots 约束）。 */
  writeSnapshot(request: {
    taskId: string;
    runId: string;
    topic: string;
    logEpoch: string;
    coveredSourceSeq: number;
    snapshot: unknown;
    now: number;
  }): Promise<void>;
  /** bridge.welcome 用：各源流的持久 ingest 水位（02 §5.1/§7.1）。 */
  ingestCursors(request: { runId: string }): Promise<CloudStreamCursor[]>;
  listCheckpoints(taskId: string): Promise<CloudCheckpointRecord[]>;
  /** 写 checkpoint 事实（W2 口径确认）：**不接受 `now`**，审计时间用 worker 真实时钟。 */
  recordCheckpoint(checkpoint: CloudCheckpointRecord): Promise<void>;
}

// ── 只读投影（W1 CR-4：task detail 的 execution/artifact 面）──

/**
 * Execution 投影只读面：只返回**已有 runtime 事实**。没有事实时返回 null——task detail
 * 留空，不得用控制面猜测填 `idle`（08 §3.3：runtime 失联时保留 last-known 并标过期）。
 */
export interface ExecutionProjectionRead {
  readTaskExecution(taskId: string): Promise<CloudExecutionProjection | null>;
  readRunExecution(runId: string): Promise<CloudExecutionProjection | null>;
}

/**
 * 产物投影只读面：PR/分支状态的事实来源。没有事实时返回 null——`reactivate` 在
 * PR merged 未知时必须返回 `not_implemented` 语义，不默认按未 merged 放行（03 §6）。
 */
export interface ArtifactRead {
  read(taskId: string): Promise<CloudTaskArtifactRecord | null>;
}

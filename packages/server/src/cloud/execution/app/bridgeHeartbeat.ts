/**
 * heartbeat 与投影批次发送循环（specs/cloud-agent/02 §4 帧表、§7.2 写入与确认顺序、§8 背压）。
 *
 * 一个定时器承担两件事，不引入第二队列：
 * 1. `bridge.heartbeat`：epoch、进程存活、脱敏活动摘要、WAL 高水位；**不是**轮次/权限裁决；
 * 2. `projection.batch`：从 WAL 取有界批次投递（ACK 到达前不清理）。
 *
 * 容量耗尽时发 `bridge.fault`（不可重试）并停投递，不静默丢记录（02 §8）。
 */
import { CLOUD_BRIDGE_PROTOCOL_VERSION, cloudStreamCursorSchema } from "@zcode/shared";
import type {
  BridgeConnectionPort,
  ExecutionClock,
  ExecutionLogger,
  ProjectionPort,
} from "./ports.js";

export interface HeartbeatOptions {
  connection: BridgeConnectionPort;
  clock: ExecutionClock;
  logger: ExecutionLogger;
  projection: ProjectionPort;
  intervalMs: number;
  batchSize: number;
  epoch(): number | null;
  isReady(): boolean;
  runtimeFacts(): { pid: number | null; incarnation: string | null };
}

export interface HeartbeatHandle {
  /** 立即发一轮（bootstrap 完成后尽快送出首帧）。 */
  flush(): Promise<void>;
  dispose(): void;
}

export function startBridgeHeartbeat(options: HeartbeatOptions): HeartbeatHandle {
  let disposed = false;
  let timer: Promise<void> | null = null;

  async function tick(): Promise<void> {
    if (disposed) return;
    const epoch = options.epoch();
    if (epoch === null) {
      // 未被接管的连接不发业务帧（旧 epoch 无写权，02 §2 不变量 3）。
      timer = options.clock.wait(options.intervalMs).then(tick, () => undefined);
      return;
    }
    const facts = options.runtimeFacts();
    options.connection.send(
      JSON.stringify({
        protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
        type: "bridge.heartbeat",
        connectionEpoch: epoch,
        processAlive: facts.pid !== null,
        activitySummary: options.isReady() ? "ready" : "bootstrapping",
        walHighWatermarks: options.projection
          .highWatermarks()
          .map((cursor) => cloudStreamCursorSchema.parse(cursor)),
        sentAt: options.clock.now(),
      }),
    );

    const pending = await options.projection.drain(options.batchSize);
    if ("capacityExceeded" in pending) {
      options.logger.warn(undefined, "projection WAL capacity exceeded; delivery paused", {
        epoch,
      });
      options.connection.send(
        JSON.stringify({
          protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
          type: "bridge.fault",
          faultCode: "quota_exceeded",
          message: "projection WAL capacity exceeded",
          retryable: false,
          connectionEpoch: epoch,
        }),
      );
    } else if (pending.records.length > 0) {
      options.connection.send(
        JSON.stringify({
          protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
          type: "projection.batch",
          connectionEpoch: epoch,
          records: pending.records,
        }),
      );
    }
    timer = options.clock.wait(options.intervalMs).then(tick, () => undefined);
  }

  void tick();

  return {
    flush: () => tick(),
    dispose() {
      disposed = true;
      void timer;
    },
  };
}

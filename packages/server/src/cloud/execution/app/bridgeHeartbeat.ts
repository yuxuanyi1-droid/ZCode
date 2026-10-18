/**
 * heartbeat 与投影批次发送循环（specs/cloud-agent/02 §4 帧表、§7.2 写入与确认顺序、§8 背压）。
 *
 * 一个定时器承担两件事，不引入第二队列：
 * 1. `bridge.heartbeat`：epoch、进程存活、脱敏活动摘要、WAL 高水位；**不是**轮次/权限裁决；
 * 2. `projection.batch`：从 WAL 取有界批次投递（ACK 到达前不清理）。
 *
 * 修复依据（2026-10-17 review R5 P2）：此前一次只按记录数（batchSize）组一个帧，多条大
 * payload 会让编码后的整帧超过 bridgeTransport 的 8MiB 上限并被直接 drop——记录仍留在
 * WAL，下一拍又组出同一个超限帧，形成投递活锁且控制面永远收不到数据。现在按**编码后
 * UTF-8 字节数**（安全阈值 6MiB，低于 transport 上限）与记录数切分，一个 tick 可发送多个
 * `projection.batch`；单条记录自身超限时发不可重试 `bridge.fault` 并停止本连接的投影
 * 投递（不静默 drop，WAL 仍只由 ACK 清理）。
 *
 * 容量耗尽时发 `bridge.fault`（不可重试）并停投递，不静默丢记录（02 §8）。
 */
import {
  CLOUD_BRIDGE_PROTOCOL_VERSION,
  CLOUD_PROJECTION_BATCH_MAX_RECORDS,
  cloudStreamCursorSchema,
  type CloudErrorCode,
} from "@zcode/shared";
import type {
  BridgeConnectionPort,
  ExecutionClock,
  ExecutionLogger,
  ProjectionPort,
} from "./ports.js";

/**
 * 单个 projection.batch 帧编码后的安全字节上限：低于 bridgeTransport 的 8MiB 整帧上限，
 * 为 ws 库/代理留出余量（02 §8；2026-10-17 review R5）。
 */
export const PROJECTION_BATCH_MAX_BYTES = 6 * 1024 * 1024;

export interface HeartbeatOptions {
  connection: BridgeConnectionPort;
  clock: ExecutionClock;
  logger: ExecutionLogger;
  projection: ProjectionPort;
  intervalMs: number;
  batchSize: number;
  /** 单个 projection.batch 帧的编码后 UTF-8 字节上限（默认 6MiB；测试可调小）。 */
  projectionMaxBytes?: number;
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
  const maxBatchBytes = options.projectionMaxBytes ?? PROJECTION_BATCH_MAX_BYTES;
  // 协议单帧记录数上限（shared 冻结）；batchSize 大于它时按协议上限取。
  const batchRecords = Math.max(1, Math.min(options.batchSize, CLOUD_PROJECTION_BATCH_MAX_RECORDS));
  let disposed = false;
  let projectionHalted = false;
  let timer: Promise<void> | null = null;

  function sendFault(
    epoch: number,
    faultCode: CloudErrorCode,
    message: string,
    retryable: boolean,
  ): void {
    options.connection.send(
      JSON.stringify({
        protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
        type: "bridge.fault",
        faultCode,
        message: message.slice(0, 512),
        retryable,
        connectionEpoch: epoch,
      }),
    );
  }

  /**
   * 用一个 tick 内 drain 出的记录组装多个 projection.batch 帧。
   *
   * 返回 false 表示存在单条记录编码后仍超过阈值：已发不可重试 fault，调用方停止该连接的
   * 投影投递（记录保留在 WAL，等下一次连接/人工处理；绝不静默丢弃）。
   */
  function sendProjectionBatches(epoch: number, records: readonly unknown[]): boolean {
    const baseBytes = projectionBatchBytes(epoch, []);
    let parts: string[] = [];
    let bytes = baseBytes;
    const flush = (): void => {
      if (parts.length === 0) return;
      options.connection.send(projectionBatchText(epoch, parts));
      parts = [];
      bytes = baseBytes;
    };
    for (const record of records) {
      const part = JSON.stringify(record);
      const partBytes = Buffer.byteLength(part, "utf8");
      if (baseBytes + partBytes > maxBatchBytes) {
        options.logger.warn(undefined, "projection record exceeds bridge send budget", {
          epoch,
          recordBytes: partBytes,
          maxBatchBytes,
        });
        sendFault(
          epoch,
          "payload_too_large",
          "projection record exceeds bridge send budget",
          false,
        );
        return false;
      }
      // 逗号也算进帧字节：先判断追加后是否超限，超限则先发当前批次。
      if (parts.length > 0 && bytes + 1 + partBytes > maxBatchBytes) flush();
      parts.push(part);
      bytes += (parts.length > 1 ? 1 : 0) + partBytes;
    }
    flush();
    return true;
  }

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

    if (projectionHalted) {
      timer = options.clock.wait(options.intervalMs).then(tick, () => undefined);
      return;
    }
    const pending = await options.projection.drain(batchRecords);
    if (disposed) return;
    if ("capacityExceeded" in pending) {
      options.logger.warn(undefined, "projection WAL capacity exceeded; delivery paused", {
        epoch,
      });
      sendFault(epoch, "quota_exceeded", "projection WAL capacity exceeded", false);
    } else if (pending.records.length > 0) {
      if (!sendProjectionBatches(epoch, pending.records)) {
        // 单条超限：停止本连接的投影投递，避免每拍重复发同一个不可发送的帧。
        projectionHalted = true;
      }
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

/** 空批次的编码字节数（含帧字段与 `records:[]` 骨架），用于精确计算分帧上限。 */
function projectionBatchBytes(epoch: number, parts: readonly string[]): number {
  return Buffer.byteLength(projectionBatchText(epoch, parts), "utf8");
}

/**
 * 手工拼装帧文本：parts 均为 `JSON.stringify(record)` 的合法 JSON 值，直接拼接与
 * `JSON.stringify({records})` 字节一致，避免对大 payload 二次序列化。
 */
function projectionBatchText(epoch: number, parts: readonly string[]): string {
  return `{"protocolVersion":${CLOUD_BRIDGE_PROTOCOL_VERSION},"type":"projection.batch","connectionEpoch":${epoch},"records":[${parts.join(",")}]}`;
}

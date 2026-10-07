/**
 * 投影 WAL 水位与去重决策（specs/cloud-agent/02 §7.1/§7.2/§8，W6 §3「WAL」）。
 *
 * 纯状态机：只回答「这条记录收不收、能不能清、ACK 覆盖到哪」，不做 IO。
 * 文件形态的 WAL 由 adapters/projectionWalStore.ts 承担（NDJSON + 原子替换）。
 *
 * 不变量：
 * 1. 去重键 `(runId, runtimeIncarnation, topic, logEpoch, sourceSeq)`；同键同 hash 幂等，
 *    同键不同 hash 是一致性 fault（02 §7.1）。
 * 2. 每个源流先 snapshot 再接连续 delta；出现缺口返回 expectedSourceSeq，**不跳跃确认**。
 * 3. ACK 只按匹配源流的 sourceSeq 清 WAL：控制面全局 ingestCursor 不作为本地数组下标
 *    （02 §7.1 尾段）。
 * 4. 容量耗尽不静默丢记录：标记 exceeded，由上层停新投递（02 §8）。
 */
import {
  cloudProjectionDedupKey,
  type CloudProjectionRecord,
  type CloudStreamCursor,
} from "@zcode/shared";

export interface WalEntry {
  record: CloudProjectionRecord;
  dedupKey: string;
}

export interface ProjectionWalCapacity {
  maxRecords: number;
  maxBytes: number;
}

export const DEFAULT_WAL_CAPACITY: ProjectionWalCapacity = {
  maxRecords: 8192,
  maxBytes: 32 * 1024 * 1024,
};

export type WalAcceptResult =
  | { kind: "accepted"; entry: WalEntry }
  | { kind: "duplicate" }
  | { kind: "conflict"; entry: WalEntry }
  /** 区间不连续（缺帧或新流未先给 snapshot）；expectedSeq 是要求的下一段起点。 */
  | { kind: "gap"; expectedNextSeq: number }
  /** 容量耗尽：上层停新投递并发 fault，不丢已有记录。 */
  | { kind: "capacity" };

export interface WalAckResult {
  cleared: number;
  /** ACK 来自未知源流或与本地流水位无关时的说明（不接受伪造水位）。 */
  ignored?: "unknown-stream" | "below-watermark";
}

interface StreamState {
  /** 已追加的连续水位（最后一条已收记录的 sourceSeq）；undefined = 尚未开流。 */
  lastAcceptedSeq?: number;
  /** 已被持久 ACK 覆盖的连续水位；-1 表示尚未有 ACK。 */
  ackedSeq: number;
  /** 已见的 dedupKey → contentHash（含已 ACK 的，用于同键不同 hash 的一致性判定）。 */
  hashes: Map<string, string>;
}

export interface ProjectionWalState {
  accept(record: CloudProjectionRecord, fromSeq: number): WalAcceptResult;
  ack(cursor: CloudStreamCursor): WalAckResult;
  /** 未获得持久 ACK 的待投递记录（按流、按 sourceSeq 升序，跨流按追加顺序）。 */
  pending(limit: number): WalEntry[];
  /** heartbeat 的 WAL 高水位：各流尚未获得 ACK 的最大 sourceSeq（02 §4）。 */
  highWatermarks(): CloudStreamCursor[];
  /**
   * 某个源流已接受（已导出）的连续水位；未知源流返回 null。
   * 重订订阅的 base 必须用它而不是 ACK 水位，否则会把已导出区间重新算成缺口（02 §7.1）。
   */
  acceptedSeq(topic: string, logEpoch: string): number | null;
  /**
   * 该 topic 已导出的最高水位（跨 logEpoch 取最大值）。
   * 重启后 exporter 用它拼续传 base：logEpoch 必须来自持久 WAL，而不是内存记忆（02 §7.3）。
   */
  acceptedCursor(topic: string): CloudStreamCursor | null;
  capacity(): { exceeded: boolean; records: number; bytes: number };
  /** 启动恢复：用持久化的记录重建状态（保留 ACK 水位）。 */
  restore(entries: readonly WalEntry[], cursors: readonly CloudStreamCursor[]): void;
  /** 导出为可持久形态（adapters 写文件用）。 */
  exportEntries(): WalEntry[];
  exportCursors(): CloudStreamCursor[];
}

function streamKey(record: { topic: string; logEpoch: string }): string {
  return `${record.topic}\u0000${record.logEpoch}`;
}

export function createProjectionWalState(
  capacity: ProjectionWalCapacity = DEFAULT_WAL_CAPACITY,
): ProjectionWalState {
  const streams = new Map<string, StreamState>();
  /** 追加顺序的待投递队列；ack 与 barrier 只从前端清理。 */
  let queue: WalEntry[] = [];
  let queueBytes = 0;

  function stream(key: string): StreamState {
    const existing = streams.get(key);
    if (existing) return existing;
    const created: StreamState = { ackedSeq: -1, hashes: new Map() };
    streams.set(key, created);
    return created;
  }

  function recordBytes(record: CloudProjectionRecord): number {
    return Buffer.byteLength(JSON.stringify(record), "utf8");
  }

  function drop(entry: WalEntry): void {
    queueBytes -= recordBytes(entry.record);
  }

  return {
    accept(record, fromSeq) {
      const key = streamKey(record);
      const state = stream(key);
      const dedupKey = cloudProjectionDedupKey(record);
      // 完整屏障（fromSeq=0 的 snapshot）：以该快照为新的一致起点重开该流。
      // 这样「重连先 snapshot 再 delta」与「重开屏障」共用同一条连续规则（02 §7.1）。
      const isBarrier = record.kind === "snapshot" && fromSeq === 0;
      const knownHash = state.hashes.get(dedupKey);
      if (knownHash !== undefined) {
        // 同键同 hash 幂等（ACK 丢失后的重投，**不得**因取代逻辑丢掉未 ACK 的记录）；
        // 同键不同内容是一致性 fault。
        if (knownHash !== record.contentHash) {
          return { kind: "conflict", entry: { record, dedupKey } };
        }
        if (isBarrier) state.lastAcceptedSeq = record.sourceSeq;
        return { kind: "duplicate" };
      }
      if (isBarrier) {
        const barrierSeq = record.sourceSeq;
        // 新屏障已含 toSeq 之前的全部状态：同流中这些未 ACK 记录被屏障取代（不是丢弃内容）。
        const superseded = queue.filter(
          (entry) =>
            entry.record.topic === record.topic &&
            entry.record.logEpoch === record.logEpoch &&
            entry.record.sourceSeq <= barrierSeq,
        );
        if (superseded.length > 0) {
          const supersededKeys = new Set(superseded.map((entry) => entry.dedupKey));
          queue = queue.filter((entry) => !supersededKeys.has(entry.dedupKey));
          for (const entry of superseded) drop(entry);
        }
        state.lastAcceptedSeq = barrierSeq;
      }
      if (state.lastAcceptedSeq === undefined) {
        // 新流必须先给 snapshot（完整屏障）；否则是缺口，返回期望起点。
        return { kind: "gap", expectedNextSeq: 0 };
      }
      if (!isBarrier && fromSeq !== state.lastAcceptedSeq) {
        // 区间不连续：可能丢帧或被压平的 coalesced 区间，一律不跳 cursor。
        return { kind: "gap", expectedNextSeq: state.lastAcceptedSeq + 1 };
      }
      if (queue.length >= capacity.maxRecords || queueBytes >= capacity.maxBytes) {
        return { kind: "capacity" };
      }
      const entry: WalEntry = { record, dedupKey };
      state.hashes.set(dedupKey, record.contentHash);
      state.lastAcceptedSeq = record.sourceSeq;
      queue.push(entry);
      queueBytes += recordBytes(record);
      return { kind: "accepted", entry };
    },

    ack(cursor) {
      const key = `${cursor.topic}\u0000${cursor.logEpoch}`;
      const state = streams.get(key);
      if (!state) return { cleared: 0, ignored: "unknown-stream" };
      if (cursor.sourceSeq <= state.ackedSeq) return { cleared: 0, ignored: "below-watermark" };
      state.ackedSeq = cursor.sourceSeq;
      // 只清匹配源流且不超过连续持久水位的记录（不跳缺口、不按 ingestCursor 下标）。
      const before = queue.length;
      queue = queue.filter((entry) => {
        const matches =
          entry.record.topic === cursor.topic && entry.record.logEpoch === cursor.logEpoch;
        if (matches && entry.record.sourceSeq <= cursor.sourceSeq) {
          drop(entry);
          return false;
        }
        return true;
      });
      return { cleared: before - queue.length };
    },

    pending(limit) {
      return queue.slice(0, Math.max(1, limit));
    },

    highWatermarks() {
      const cursors: CloudStreamCursor[] = [];
      for (const entry of queue) {
        const existing = cursors.find(
          (cursor) =>
            cursor.topic === entry.record.topic && cursor.logEpoch === entry.record.logEpoch,
        );
        if (!existing) {
          cursors.push({
            topic: entry.record.topic,
            logEpoch: entry.record.logEpoch,
            sourceSeq: entry.record.sourceSeq,
          });
        } else if (entry.record.sourceSeq > existing.sourceSeq) {
          existing.sourceSeq = entry.record.sourceSeq;
        }
      }
      return cursors;
    },

    acceptedSeq(topic, logEpoch) {
      const state = streams.get(`${topic}\u0000${logEpoch}`);
      if (!state) return null;
      if (state.lastAcceptedSeq !== undefined) return state.lastAcceptedSeq;
      // 已全部被 ACK 清空时，ACK 水位就是已接受水位（两者同一测量单位）。
      return state.ackedSeq >= 0 ? state.ackedSeq : null;
    },

    acceptedCursor(topic) {
      let best: CloudStreamCursor | null = null;
      for (const [key, state] of streams) {
        const separator = key.indexOf("\u0000");
        if (key.slice(0, separator) !== topic) continue;
        const seq = state.lastAcceptedSeq ?? (state.ackedSeq >= 0 ? state.ackedSeq : null);
        if (seq === null) continue;
        if (!best || seq > best.sourceSeq) {
          best = { topic, logEpoch: key.slice(separator + 1), sourceSeq: seq };
        }
      }
      return best;
    },

    capacity() {
      return {
        exceeded: queue.length >= capacity.maxRecords || queueBytes >= capacity.maxBytes,
        records: queue.length,
        bytes: queueBytes,
      };
    },

    restore(entries, cursors) {
      streams.clear();
      queue = [];
      queueBytes = 0;
      for (const cursor of cursors) {
        const state = stream(`${cursor.topic}\u0000${cursor.logEpoch}`);
        state.ackedSeq = Math.max(state.ackedSeq, cursor.sourceSeq);
      }
      for (const entry of entries) {
        const state = stream(streamKey(entry.record));
        state.hashes.set(entry.dedupKey, entry.record.contentHash);
        state.lastAcceptedSeq = entry.record.sourceSeq;
        queue.push(entry);
        queueBytes += recordBytes(entry.record);
      }
    },

    exportEntries() {
      return [...queue];
    },

    exportCursors() {
      const cursors: CloudStreamCursor[] = [];
      for (const [key, state] of streams) {
        if (state.ackedSeq < 0) continue;
        const separator = key.indexOf("\u0000");
        cursors.push({
          topic: key.slice(0, separator),
          logEpoch: key.slice(separator + 1),
          sourceSeq: state.ackedSeq,
        });
      }
      return cursors;
    },
  };
}

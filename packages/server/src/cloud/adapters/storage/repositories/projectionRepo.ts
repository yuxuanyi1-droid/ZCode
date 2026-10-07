/**
 * Projection / checkpoint repository（02 §7.1/§7.2 持久 ingest、03 §4 projection_* 与
 * checkpoints 表、§9 留存与 resync）。
 *
 * 幂等与水位都由约束承担：去重键 (runId, runtimeIncarnation, topic, logEpoch,
 * sourceSeq) 唯一；同键不同 contentHash 是一致性 fault，必须报告而不是覆盖；
 * ingest 水位单调且只在连续时才前进（缺口不跳跃确认）。快照必须声明覆盖范围。
 */
import { randomUUID } from "node:crypto";
import { cloudCheckpointRecordSchema, cloudProjectionRecordSchema } from "@zcode/shared";
import type { CloudCheckpointRecord, CloudStreamCursor } from "@zcode/shared";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { decodeCursor, encodeCursor, normalizeLimit } from "../sqlite/cursor.js";
import { mapCheckpointRow, mapProjectionRow, readText } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import type { ProjectionAppendResult } from "../../../app/ports/storagePort.js";
import { CloudStorageError } from "../cloudStorageError.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

const PAGE_LIMIT_MAX = 500;

function streamKey(runId: string, topic: string, logEpoch: string): string {
  return `${runId}\u0000${topic}\u0000${logEpoch}`;
}

/**
 * 连续水位：从 0 起逐条前进，遇到缺口即停。只有连续前缀才算「已 durable ingest」，
 * 缺口不跳跃确认（02 §7.1）——否则 control plane 会丢弃中间事件。
 */
function contiguousSeq(
  context: StorageContext,
  runId: string,
  topic: string,
  logEpoch: string,
): number {
  const rows = context.db
    .prepare(
      `SELECT source_seq FROM projection_events
       WHERE run_id = ? AND topic = ? AND log_epoch = ? ORDER BY source_seq`,
    )
    .all(runId, topic, logEpoch);
  let watermark = -1;
  for (const row of rows) {
    const seq = Number(row["source_seq"]);
    if (seq === watermark + 1) watermark = seq;
    else if (seq > watermark + 1) break;
  }
  return watermark;
}

function readCursor(
  context: StorageContext,
  runId: string,
  topic: string,
  logEpoch: string,
): number {
  const row = context.db
    .prepare(
      "SELECT source_seq FROM projection_ingest_cursors WHERE run_id = ? AND topic = ? AND log_epoch = ?",
    )
    .get(runId, topic, logEpoch);
  return row ? Number(row["source_seq"]) : -1;
}

export const projectionRepoHandlers = {
  /**
   * 幂等追加：同键同 hash 跳过，同键不同 hash 记为冲突（不覆盖既有记录，02 §7.1）。
   * 返回受影响源流的连续水位，供 projection.ack 使用。
   */
  "projections.appendBatch": (context, params): ProjectionAppendResult => {
    const records = params.records.map((record) => cloudProjectionRecordSchema.parse(record));
    // 端口签名不带时间戳（W0 冻结），ingest 时间取 worker 内的真实时钟：
    // 该列只用于留存/诊断，不参与任何幂等或顺序判定。
    const ingestedAt = Date.now();
    return withWriteTransaction(context, () => {
      const conflicts: { topic: string; logEpoch: string; sourceSeq: number }[] = [];
      let appended = 0;
      const touched = new Map<string, { runId: string; topic: string; logEpoch: string }>();
      const runTaskIds = new Map<string, string>();

      for (const record of records) {
        const ownerTaskId = runTaskIds.get(record.runId) ?? readRunTaskId(context, record.runId);
        runTaskIds.set(record.runId, ownerTaskId);
        if (ownerTaskId !== record.taskId) {
          throw new CloudStorageError({
            code: "validation_failed",
            reason: "invalid-record",
            message: "投影记录的 taskId 与 run 归属不一致（02 §7.1 归属校验）",
          });
        }
        const existing = context.db
          .prepare(
            `SELECT content_hash FROM projection_events
             WHERE run_id = ? AND runtime_incarnation = ? AND topic = ? AND log_epoch = ? AND source_seq = ?`,
          )
          .get(
            record.runId,
            record.runtimeIncarnation,
            record.topic,
            record.logEpoch,
            record.sourceSeq,
          );
        if (existing) {
          if (String(existing["content_hash"]) !== record.contentHash) {
            conflicts.push({
              topic: record.topic,
              logEpoch: record.logEpoch,
              sourceSeq: record.sourceSeq,
            });
          }
          continue;
        }
        context.db
          .prepare(
            `INSERT INTO projection_events (
               schema_version, task_id, run_id, run_generation, runtime_incarnation, topic,
               log_epoch, source_seq, kind, payload_json, content_hash, ingested_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            record.schemaVersion,
            record.taskId,
            record.runId,
            record.runGeneration,
            record.runtimeIncarnation,
            record.topic,
            record.logEpoch,
            record.sourceSeq,
            record.kind,
            JSON.stringify(record.payload),
            record.contentHash,
            ingestedAt,
          );
        appended += 1;
        touched.set(streamKey(record.runId, record.topic, record.logEpoch), {
          runId: record.runId,
          topic: record.topic,
          logEpoch: record.logEpoch,
        });
      }

      const cursors: CloudStreamCursor[] = [];
      for (const stream of touched.values()) {
        const watermark = contiguousSeq(context, stream.runId, stream.topic, stream.logEpoch);
        const stored = readCursor(context, stream.runId, stream.topic, stream.logEpoch);
        const next = Math.max(watermark, stored);
        if (next > stored) {
          context.db
            .prepare(
              `INSERT INTO projection_ingest_cursors (run_id, topic, log_epoch, source_seq, updated_at)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT (run_id, topic, log_epoch) DO UPDATE SET
                 source_seq = MAX(projection_ingest_cursors.source_seq, excluded.source_seq),
                 updated_at = excluded.updated_at`,
            )
            .run(stream.runId, stream.topic, stream.logEpoch, next, ingestedAt);
        }
        cursors.push({ topic: stream.topic, logEpoch: stream.logEpoch, sourceSeq: next });
      }
      return { cursors, conflicts, appended };
    });
  },

  /** 只读控制面副本分页；cursor 低于保留下限或超出已存范围时要求 resync（03 §9）。 */
  "projections.readHistory": (context, params) => {
    const limit = normalizeLimit(params.limit, PAGE_LIMIT_MAX);
    const filter = params.topic === undefined ? "task_id = ?" : "task_id = ? AND topic = ?";
    const filterArgs = params.topic === undefined ? [params.taskId] : [params.taskId, params.topic];
    const after = params.cursor ? decodeCursor(params.cursor)[0] : 0;
    const afterSeq = typeof after === "number" ? after : 0;
    const rows = context.db
      .prepare(
        `SELECT * FROM projection_events WHERE ${filter} AND event_seq > ?
         ORDER BY event_seq LIMIT ?`,
      )
      .all(...filterArgs, afterSeq, limit + 1);
    const bounds = context.db
      .prepare(
        `SELECT MIN(event_seq) AS low, MAX(event_seq) AS high FROM projection_events WHERE ${filter}`,
      )
      .get(...filterArgs);
    const low =
      bounds?.["low"] === null || bounds?.["low"] === undefined ? 0 : Number(bounds["low"]);
    const high =
      bounds?.["high"] === null || bounds?.["high"] === undefined ? 0 : Number(bounds["high"]);
    const gapBelow = params.cursor !== undefined && afterSeq > 0 && low > afterSeq + 1;
    const aheadOfData = params.cursor !== undefined && high < afterSeq;
    const items = rows.slice(0, limit).map(mapProjectionRow);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return {
      items,
      ...(last ? { nextCursor: encodeCursor([Number(last["event_seq"])]) } : {}),
      ...(gapBelow || aheadOfData ? { resyncRequired: true } : {}),
    };
  },

  "projections.readSnapshot": (context, params) => {
    const conditions = ["task_id = ?", "topic = ?"];
    const args: (string | number)[] = [params.taskId, params.topic];
    if (params.logEpoch !== undefined) {
      conditions.push("log_epoch = ?");
      args.push(params.logEpoch);
    }
    const row = context.db
      .prepare(
        `SELECT * FROM projection_snapshots WHERE ${conditions.join(" AND ")}
         ORDER BY covered_source_seq DESC, updated_at DESC LIMIT 1`,
      )
      .get(...args);
    if (!row) return null;
    return {
      logEpoch: readText(row, "log_epoch"),
      coveredSourceSeq: Number(row["covered_source_seq"]),
      snapshot: JSON.parse(readText(row, "snapshot_json")) as unknown,
    };
  },

  /** 写快照：覆盖范围只增不减，旧快照不得覆盖新快照（03 §4 快照声明覆盖范围）。 */
  "projections.writeSnapshot": (context, params): void => {
    withWriteTransaction(context, () => {
      context.db
        .prepare(
          `INSERT INTO projection_snapshots (
             snapshot_id, task_id, run_id, topic, log_epoch, covered_source_seq,
             schema_version, snapshot_json, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
           ON CONFLICT (task_id, topic, log_epoch) DO UPDATE SET
             run_id = excluded.run_id,
             covered_source_seq = excluded.covered_source_seq,
             snapshot_json = excluded.snapshot_json,
             updated_at = excluded.updated_at
           WHERE excluded.covered_source_seq >= projection_snapshots.covered_source_seq`,
        )
        .run(
          randomUUID(),
          params.taskId,
          params.runId,
          params.topic,
          params.logEpoch,
          params.coveredSourceSeq,
          JSON.stringify(params.snapshot),
          params.now,
          params.now,
        );
    });
  },

  "projections.ingestCursors": (context, params): CloudStreamCursor[] =>
    context.db
      .prepare("SELECT * FROM projection_ingest_cursors WHERE run_id = ? ORDER BY topic, log_epoch")
      .all(params.runId)
      .map((row) => ({
        topic: readText(row, "topic"),
        logEpoch: readText(row, "log_epoch"),
        sourceSeq: Number(row["source_seq"]),
      })),

  "projections.listCheckpoints": (context, params): CloudCheckpointRecord[] =>
    context.db
      .prepare("SELECT * FROM checkpoints WHERE task_id = ? ORDER BY created_at, operation_id")
      .all(params.taskId)
      .map(mapCheckpointRow),

  "projections.recordCheckpoint": (context, params): void => {
    const checkpoint = cloudCheckpointRecordSchema.parse(params.checkpoint);
    withWriteTransaction(context, () => {
      context.db
        .prepare(
          `INSERT INTO checkpoints (
             operation_id, task_id, run_id, run_generation, state, included_files_json,
             local_sha, confirmed_remote_sha, risk_summary, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (operation_id) DO UPDATE SET
             state = excluded.state,
             included_files_json = excluded.included_files_json,
             local_sha = excluded.local_sha,
             confirmed_remote_sha = excluded.confirmed_remote_sha,
             risk_summary = excluded.risk_summary,
             updated_at = excluded.updated_at`,
        )
        .run(
          checkpoint.operationId,
          checkpoint.taskId,
          checkpoint.runId,
          checkpoint.runGeneration,
          checkpoint.state,
          JSON.stringify(checkpoint.includedFiles),
          checkpoint.localSha ?? null,
          checkpoint.confirmedRemoteSha ?? null,
          checkpoint.riskSummary ?? null,
          checkpoint.createdAt,
          checkpoint.updatedAt,
        );
    });
  },
} satisfies Pick<
  StorageHandlerTable,
  | "projections.appendBatch"
  | "projections.readHistory"
  | "projections.readSnapshot"
  | "projections.writeSnapshot"
  | "projections.ingestCursors"
  | "projections.listCheckpoints"
  | "projections.recordCheckpoint"
>;

function readRunTaskId(context: StorageContext, runId: string): string {
  const row: SqlRow | undefined = context.db
    .prepare("SELECT task_id FROM runs WHERE run_id = ?")
    .get(runId);
  if (!row) {
    throw new CloudStorageError({
      code: "not_found",
      reason: "not-found",
      message: `投影记录的 run ${runId} 不存在`,
    });
  }
  return readText(row, "task_id");
}

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
import { decodeHistoryCursor, encodeHistoryCursor, normalizeLimit } from "../sqlite/cursor.js";
import { mapCheckpointRow, mapProjectionRow, readText } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import type { ProjectionAppendResult } from "../../../app/ports/storagePort.js";
import {
  advanceContiguousWatermark,
  projectionCoveredInterval,
} from "../../../domain/projectionSequence.js";
import { CloudStorageError } from "../cloudStorageError.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

const PAGE_LIMIT_MAX = 500;

function streamKey(runId: string, topic: string, logEpoch: string): string {
  return `${runId}\u0000${topic}\u0000${logEpoch}`;
}

/**
 * 连续水位：按**交付区间链**推进（02 §7.1「连续持久水位」）。
 *
 * 修复依据（2026-10-07 复核缺陷 2）：导出记录的 sourceSeq 取交付帧 toSeq——首帧
 * snapshot 合并 0..N 时第一条记录的 sourceSeq 就是 N。旧的「从 0 起数字前缀」算法把
 * 这种流的水位算成 -1，回出的 `projection.ack.lastContiguousSourceSeq: -1` 违反
 * shared schema 非负约束，执行节点按 invalid-frame 整连接作废（4001，每 run 首次
 * WAL 排空固定触发）。区间语义见 domain/projectionSequence.ts。
 */
function contiguousSeq(
  context: StorageContext,
  runId: string,
  topic: string,
  logEpoch: string,
  persistedThrough: number,
): number {
  const rows = context.db
    .prepare(
      `SELECT source_seq, payload_json FROM projection_events
       WHERE run_id = ? AND topic = ? AND log_epoch = ? ORDER BY source_seq`,
    )
    .all(runId, topic, logEpoch);
  const intervals = rows.map((row) => {
    const seq = Number(row["source_seq"]);
    return projectionCoveredInterval(parsePayloadJson(row["payload_json"]), seq);
  });
  return advanceContiguousWatermark(intervals, persistedThrough);
}

function parsePayloadJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
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
      const appendedRunIds = new Set<string>();
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
        appendedRunIds.add(record.runId);
        touched.set(streamKey(record.runId, record.topic, record.logEpoch), {
          runId: record.runId,
          topic: record.topic,
          logEpoch: record.logEpoch,
        });
      }

      const cursors: CloudStreamCursor[] = [];
      for (const stream of touched.values()) {
        const stored = readCursor(context, stream.runId, stream.topic, stream.logEpoch);
        const watermark = contiguousSeq(
          context,
          stream.runId,
          stream.topic,
          stream.logEpoch,
          stored,
        );
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
        // 修复依据（2026-10-07 复核缺陷 2）：链头缺失（真缺口）时 next=-1，回 ack 会
        // 违反 shared schema 的非负水位并在执行节点侧作废整条连接——此时**不回 ack**，
        // 让执行节点重投缺口之前的记录（WAL 未清，下一拍自然补齐链头）。
        if (next >= 0) {
          cursors.push({ topic: stream.topic, logEpoch: stream.logEpoch, sourceSeq: next });
        }
      }
      return { cursors, conflicts, appended, appendedRunIds: [...appendedRunIds] };
    });
  },

  /** 只读控制面副本分页；cursor 低于保留下限或超出已存范围时要求 resync（03 §9）。 */
  "projections.readHistory": (context, params) => {
    const limit = normalizeLimit(params.limit, PAGE_LIMIT_MAX);
    // 族名匹配（2026-10-09 终验缺陷 D 修订）：导出记录的 topic 是 `conversation/<sessionId>`
    // （projectionExporter 按 sessions-index 发现的具体话题），而 history 端点的缺省 topic
    // 是族名 `conversation`（CANONICAL_TOPIC，02 §7.4「v1 canonical 流」）。精确等值过滤
    // 会把跨 run 的全部会话记录滤成空页，归档/重开视图因此拿不到任何历史。
    // 族名（不含 "/"）按前缀匹配该族全部话题；完整话题仍精确匹配。
    // `instr(topic, ? || '/') = 1` 是前缀判定，不引入 LIKE 通配符转义问题。
    const filter =
      params.topic === undefined
        ? "task_id = ?"
        : params.topic.includes("/")
          ? "task_id = ? AND topic = ?"
          : "task_id = ? AND (topic = ? OR instr(topic, ? || '/') = 1)";
    const filterArgs: (string | number)[] =
      params.topic === undefined
        ? [params.taskId]
        : params.topic.includes("/")
          ? [params.taskId, params.topic]
          : [params.taskId, params.topic, params.topic];
    // 修复依据（2026-10-09 实测缺陷）：history 的查询/响应游标在 shared 是冻结 wire
    // 格式 `<logEpoch>:<seq>`（cloudHistoryCursorSchema），不是通用 base64url 游标。
    // seq 槽位是控制面 ingest 位置 event_seq（族名前缀跨流分页的唯一全序，见 cursor.ts）。
    const afterSeq = params.cursor === undefined ? 0 : decodeHistoryCursor(params.cursor);
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
    // 复核缺陷 4：nextCursor 的语义是「下一页必有数据」（hasMore=true 当且仅当本次
    // 探测到了 limit+1 行）。空页（游标越界/越过保留范围）绝不携带 cursor，否则客户端
    // 会拿一个永远取不到数据的 hasMore 反复空翻页。
    const last = rows.length > limit && items.length > 0 ? rows[limit - 1] : undefined;
    return {
      items,
      // nextCursor 用 wire 冻结格式：末行 logEpoch + 末行 event_seq（02 §7.4/03 §6）。
      // 通用 base64url 游标会被客户端 strict schema 整页拒绝（protocol_incompatible）。
      ...(last
        ? {
            nextCursor: encodeHistoryCursor(readText(last, "log_epoch"), Number(last["event_seq"])),
          }
        : {}),
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

/**
 * 审批等待事实的只读投影查询（08 §7「审批等待不是业务空闲」，2026-10-17 修复）。
 *
 * 单独成文件：`projectionRepo` 已到文件行数预算，且本查询只读、不参与 ingest 幂等
 * 与水位记账。生命周期（空闲 pause / idle drain / 续期）统一经端口读取本事实。
 */
import { pendingInteractionCountFromProjectionPayload } from "../../../domain/projectionInteractions.js";
import type { StorageContext } from "../sqlite/database.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

function parsePayloadJson(raw: unknown): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return undefined;
  }
}

export const projectionInteractionRepoHandlers = {
  /**
   * 该 run 最新一条包含 `pendingInteractions` 的持久投影里的数组长度。
   *
   * 查询口径：只按 run_id 过滤（不跨 run），`event_seq DESC LIMIT 1` 取最新事实。
   * 两种落库形态都要命中：导出记录 `payload.payload.snapshot.pendingInteractions`
   * 与 `payload.payload.deltas[].{op:state.updated, patch.pendingInteractions}`。
   * `CASE` 先挡 malformed JSON（json_* 对坏 JSON 直接报错），解析交给 domain 唯一
   * 解析器；任何读取/解析失败都返回 0——不猜、不抛，也不让损坏事件穿透 sweep。
   */
  "projections.readLatestPendingInteractionCount": (
    context: StorageContext,
    params: {
      runId: string;
    },
  ): number => {
    try {
      const row = context.db
        .prepare(
          `SELECT payload_json FROM projection_events
           WHERE run_id = ?
             AND CASE
               WHEN json_valid(payload_json) = 0 THEN 0
               WHEN json_type(payload_json, '$.payload.pendingInteractions') = 'array' THEN 1
               WHEN json_type(payload_json, '$.payload.snapshot.pendingInteractions') = 'array'
                 THEN 1
               WHEN EXISTS (
                 SELECT 1 FROM json_each(payload_json, '$.payload.deltas') AS delta
                 WHERE json_extract(delta.value, '$.op') = 'state.updated'
                   AND json_type(delta.value, '$.patch.pendingInteractions') = 'array'
               ) THEN 1
               ELSE 0
             END = 1
           ORDER BY event_seq DESC
           LIMIT 1`,
        )
        .get(params.runId);
      if (!row) return 0;
      const count = pendingInteractionCountFromProjectionPayload(
        parsePayloadJson(row["payload_json"]),
      );
      return count ?? 0;
    } catch {
      return 0;
    }
  },
} satisfies Pick<StorageHandlerTable, "projections.readLatestPendingInteractionCount">;

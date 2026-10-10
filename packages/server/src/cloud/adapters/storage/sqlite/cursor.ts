/**
 * 不透明分页游标编解码（03 §6 分页信封 `{items, nextCursor?}`、W2 §4）。
 *
 * 游标是 adapter 内部状态，调用方不得解析或拼接：只按本文件重新导出回传。
 * 编码为 base64url(JSON)，解码失败一律当成非法游标（validation_failed），
 * 不静默从头开始分页——静默重置会让客户端重复消费同一页。
 */
import { CloudStorageError } from "../cloudStorageError.js";

export function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): (string | number)[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (cause) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-cursor",
      message: "分页游标不可解析",
      cause,
    });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((part) => typeof part === "string" || typeof part === "number")
  ) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-cursor",
      message: "分页游标形状非法",
    });
  }
  return parsed;
}

/**
 * history 端点专用 wire 游标（shared `cloudHistoryCursorSchema` 冻结 `<logEpoch>:<seq>`）。
 *
 * 修复依据（2026-10-09 实测缺陷：历史时间线 protocol_incompatible）：history 响应的
 * `nextCursor` 与查询 `cursor` 在 shared 侧是冻结格式 `<logEpoch>:<seq>`（00 §8 wire 纪律），
 * 通用 `encodeCursor` 的 base64url 形状（如 `WzU5N10`）不匹配 `^[^\s:]+:\d+$`，客户端
 * `cloudHistoryPageSchema` strict 校验直接把整页拒绝成 `protocol_incompatible`。
 * 因此 history 的游标必须在存储层出口/入口就转换成 wire 格式，不能沿用通用编解码。
 *
 * seq 槽位取 `projection_events.event_seq`（控制面 ingest 全局单调位置，AUTOINCREMENT
 * 保证不复用）：族名 topic 前缀会跨 run/logEpoch 流，只有全局 event_seq 能表达「下一页」
 * 的全序位置；客户端把游标当不透明串回传（http-contracts「客户端只回传不解析」），
 * logEpoch 槽位只如实携带末行 epoch，供人读与诊断。
 */
export function encodeHistoryCursor(logEpoch: string, eventSeq: number): string {
  return `${logEpoch}:${eventSeq}`;
}

/**
 * 解析 wire 游标的 seq 槽位。按最后一个 ':' 切分（epoch 侧保证无冒号，lastIndexOf
 * 对病态数据也稳健）；形状非法按既有约定抛 validation_failed——不静默从头分页，
 * 静默重置会让客户端重复消费同一页（见本文件头注）。
 */
export function decodeHistoryCursor(cursor: string): number {
  const seq = cursor.slice(cursor.lastIndexOf(":") + 1);
  if (!/^\d+$/u.test(seq)) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-cursor",
      message: "history 分页游标形状非法（期望 <logEpoch>:<seq>）",
    });
  }
  return Number(seq);
}

/** 分页 limit 归一：必须为正整数且不超过上界（03 §6 拒绝无限拉取）。 */
export function normalizeLimit(limit: number, max: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-limit",
      message: "分页 limit 必须是正整数",
    });
  }
  return Math.min(limit, max);
}

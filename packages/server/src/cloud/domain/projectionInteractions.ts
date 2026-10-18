/**
 * 持久投影中的 pendingInteractions 只读解析（08 §7「审批等待不是业务空闲」）。
 *
 * 唯一解析口径：生命周期（空闲 pause / idle drain / 续期）与存储读取共用本文件，
 * 不各自解析 JSON。支持两种真实落库形态：
 * - 导出记录外层 payload = `{ topic, fromSeq, toSeq, sentAt, payload }`，其中内层
 *   `payload.kind === "snapshot" | "deltas"`（projectionExporter 原样透传 V4 帧）；
 * - 直接把帧作为 payload（测试/旧数据）：`{ kind, snapshot?, deltas? }`。
 *
 * 语义：只看**帧内最后一个声明 pendingInteractions 的 state.updated patch**（键级整体
 * 替换）或 snapshot 携带的数组；没有声明该键的帧返回 null——「没有新事实」不是
 * 「有 0 条交互」，调用方不得把 null 当成 0 来推断空闲。
 */

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

/** 从一帧 projection payload 中读出 pendingInteractions 数量；不属于两种形态时 null。 */
export function pendingInteractionCountFromProjectionPayload(payload: unknown): number | null {
  const outer = asRecord(payload);
  if (!outer) return null;
  // 外层包装（真实落库）：内层帧在 `payload.payload`；否则把自身当帧（测试/旧数据）。
  const frame = asRecord(outer["payload"]) ?? outer;

  // snapshot 形态：帧直接携带 pendingInteractions，或快照对象携带该字段。
  const direct = frame["pendingInteractions"];
  if (Array.isArray(direct)) return direct.length;
  const snapshot = asRecord(frame["snapshot"]);
  const snapshotPending = snapshot?.["pendingInteractions"];
  if (Array.isArray(snapshotPending)) return snapshotPending.length;

  // deltas 形态：同一帧里多个 state.updated 按顺序整体替换，最后一个声明的值生效。
  const deltas = frame["deltas"];
  if (!Array.isArray(deltas)) return null;
  let count: number | null = null;
  for (const delta of deltas) {
    const record = asRecord(delta);
    if (!record || record["op"] !== "state.updated") continue;
    const patch = asRecord(record["patch"]);
    const pending = patch?.["pendingInteractions"];
    if (Array.isArray(pending)) count = pending.length;
  }
  return count;
}

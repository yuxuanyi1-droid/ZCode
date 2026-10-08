/**
 * 投影源流的水位推进规则（02 §7.1「连续持久水位」的唯一算法定义）。
 *
 * 背景（2026-10-07 复核缺陷 2 诊断结论）：导出记录的 `sourceSeq` 取交付帧的
 * `toSeq`（projectionExporter.recordFor），首帧 snapshot 合并区间 0..N 时第一条记录的
 * sourceSeq 就是 N——「从 0 起每条 +1」的数字前缀算法会把水位算成 -1，控制面据此回出
 * `lastContiguousSourceSeq: -1` 的 `projection.ack`，违反 shared schema 的非负整数约束，
 * 执行节点按 invalid-frame 整连接作废（真实链路每 run 固定一次 4001）。
 *
 * 正确口径：记录 payload 携带交付区间（fromSeq/toSeq）；「连续」指**区间链**从
 * `已持久水位+1` 起无缝推进，而不是 sourceSeq 的算术连续。payload 缺区间（测试与
 * 既有记录）按「单条记录覆盖自身」解释，与旧 0-based 用例兼容。
 */

/** 一条投影记录覆盖的交付区间；payload 无 fromSeq/toSeq 时按记录自身解释。 */
export function projectionCoveredInterval(
  payload: unknown,
  fallbackSeq: number,
): { from: number; to: number } {
  if (typeof payload === "object" && payload !== null) {
    const from = (payload as { fromSeq?: unknown }).fromSeq;
    const to = (payload as { toSeq?: unknown }).toSeq;
    if (
      typeof from === "number" &&
      Number.isFinite(from) &&
      typeof to === "number" &&
      Number.isFinite(to)
    ) {
      return { from, to };
    }
  }
  return { from: fallbackSeq, to: fallbackSeq };
}

/**
 * 按区间链推进连续水位：`expected` 从 `persistedThrough + 1` 起，逐条吸收
 * `from <= expected` 的区间（重投/乱序行只可能不推进，不会回退）；首个断层即停。
 * 返回值 ≥ persistedThrough；链头缺失时返回 -1（调用方不得回 ack，等执行节点重投链头）。
 */
export function advanceContiguousWatermark(
  intervals: readonly { from: number; to: number }[],
  persistedThrough: number,
): number {
  let expected = persistedThrough + 1;
  for (const { from, to } of intervals) {
    if (from <= expected) {
      expected = Math.max(expected, to + 1);
    } else {
      break;
    }
  }
  return expected - 1;
}

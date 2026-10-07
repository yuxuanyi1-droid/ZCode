/**
 * Cloud 对话投影折叠（specs/cloud-agent/02 §7.3/§7.4、03 §9、04 §3.3）。
 *
 * 控制面持久投影是唯一恢复来源：`history` 是可靠快读，`events`/delta 只是增量提示
 * （03 §7「SSE 仅承载 metadata 投影…对话通过持久 history/snapshot+delta 恢复」）。
 * 这里把两路合流折叠成**有序、去重、可判缺口**的客户端视图：
 *
 * - 键 `(topic, logEpoch, seq)`：同一 `logEpoch` 内按 `seq` 升序，重复帧不是新内容。
 * - `logEpoch` 换代（runtime 重启）：旧 epoch 的 items 全部丢弃，不冒充连续流。
 * - 缺口（`seq` 不连续）不拼凑：标 `gap=true` 并要求 resync，绝不静默从零猜测
 *   （03 §9「retention 越界返回 resync-required…不静默从零猜测」）。
 *
 * 折叠是纯函数：不做 IO、不持有权威事实，只产出可直接渲染的序列。
 */
import type { CloudHistoryItem } from "@zcode/shared";

/** 与 SDK `CloudSubscriptionWatermark` 同形的客户端水位（UI 不 import SDK）。 */
export interface CloudConversationWatermark {
  readonly logEpoch: string;
  readonly seq: number;
}

export interface CloudConversationFold {
  /** v1 canonical 流是 conversation；这里记录当前折叠的 topic。 */
  readonly topic: string;
  readonly logEpoch: string | null;
  readonly items: readonly CloudHistoryItem[];
  readonly watermark: CloudConversationWatermark | null;
  /** true 表示检测到 `seq` 缺口或 epoch 换代：调用方必须重新读权威快照，不得继续追加。 */
  readonly gap: boolean;
}

export const CLOUD_CONVERSATION_TOPIC = "conversation";

export function createEmptyCloudConversationFold(
  topic: string = CLOUD_CONVERSATION_TOPIC,
): CloudConversationFold {
  return { topic, logEpoch: null, items: [], watermark: null, gap: false };
}

function compareHistoryItems(a: CloudHistoryItem, b: CloudHistoryItem): number {
  if (a.seq !== b.seq) {
    return a.seq - b.seq;
  }
  return a.ts - b.ts;
}

/**
 * 折叠一批历史/增量记录。
 *
 * `incoming` 可以来自 history 分页或 events 增量——两者形状相同（都是
 * `cloudHistoryItemSchema`），语义差异由调用方在参数上表达：
 * - `mode: "replace"`（读快照/首页）：以这批记录为基线重建；
 * - `mode: "append"`（增量/翻页）：与现有内容合流，检测缺口。
 */
export function foldCloudConversationItems(
  fold: CloudConversationFold,
  incoming: readonly CloudHistoryItem[],
  mode: "replace" | "append",
): CloudConversationFold {
  const topic = fold.topic;
  // topic 之外的记录（其它投影流）不混进对话序列。
  const scoped = incoming.filter((item) => item.topic === topic);

  if (scoped.length === 0) {
    return mode === "replace" ? { ...fold, gap: false } : fold;
  }

  const incomingEpoch = scoped[0]?.logEpoch;
  if (incomingEpoch === undefined) {
    return mode === "replace" ? { ...fold, gap: false } : fold;
  }
  const mixedEpochs = scoped.some((item) => item.logEpoch !== incomingEpoch);
  if (mixedEpochs) {
    // 同一批里出现两个 logEpoch：既不连续也不可判定先后，交给 resync。
    return { ...fold, gap: true };
  }

  const epochChanged = fold.logEpoch !== null && fold.logEpoch !== incomingEpoch;
  if (mode === "replace" || epochChanged) {
    // replace / 换代：旧 epoch 的内容不能与新的合流（02 §7.3）。
    const items = dedupeSorted(scoped);
    return {
      topic,
      logEpoch: incomingEpoch,
      items,
      watermark: watermarkOfLast(items),
      gap: false,
    };
  }

  const previousWatermark = fold.watermark;
  const merged = dedupeSorted([...fold.items, ...scoped]);
  const gap = detectGap(merged, previousWatermark, scoped);
  return {
    topic,
    logEpoch: incomingEpoch,
    items: merged,
    watermark: watermarkOfLast(merged) ?? previousWatermark,
    gap: fold.gap || gap,
  };
}

function watermarkOfLast(items: readonly CloudHistoryItem[]): CloudConversationWatermark | null {
  const last = items.at(-1);
  return last ? watermarkOf(last) : null;
}

function watermarkOf(item: CloudHistoryItem): CloudConversationWatermark {
  return { logEpoch: item.logEpoch, seq: item.seq };
}

/** 按 `(logEpoch, seq)` 去重并按 seq 升序；重复帧保留先到的那条。 */
function dedupeSorted(items: readonly CloudHistoryItem[]): readonly CloudHistoryItem[] {
  const bySeq = new Map<number, CloudHistoryItem>();
  for (const item of items) {
    if (!bySeq.has(item.seq)) {
      bySeq.set(item.seq, item);
    }
  }
  return [...bySeq.values()].sort(compareHistoryItems);
}

/**
 * 缺口检测：新到的一批里，只要出现「比现有水位大 1 以上」的 seq，
 * 就说明中间有未取到的帧。**不补齐、不重排**，只标 gap。
 */
function detectGap(
  merged: readonly CloudHistoryItem[],
  previousWatermark: CloudConversationWatermark | null,
  incoming: readonly CloudHistoryItem[],
): boolean {
  if (merged.length < 2) {
    return false;
  }
  const fromSeq = previousWatermark?.seq ?? Math.min(...merged.map((item) => item.seq));
  const hasNewBeyondWatermark =
    previousWatermark === null || incoming.some((item) => item.seq > previousWatermark.seq);
  if (!hasNewBeyondWatermark) {
    return false;
  }
  for (let index = 1; index < merged.length; index += 1) {
    const previous = merged[index - 1];
    const current = merged[index];
    if (!previous || !current) {
      continue;
    }
    if (current.seq > previous.seq + 1 && current.seq > fromSeq) {
      return true;
    }
  }
  return false;
}

/**
 * 快照与折叠结果的对账：快照的 `coveredSourceSeq` 必须能覆盖当前水位，
 * 否则读到的快照已经落后于本地序列，正确动作是再读一次而不是把两者缝起来。
 */
export function canApplyCloudConversationSnapshot(
  fold: CloudConversationFold,
  snapshot: {
    readonly topic: string;
    readonly logEpoch: string;
    readonly coveredSourceSeq: number;
  },
): boolean {
  if (snapshot.topic !== fold.topic) {
    return false;
  }
  if (fold.logEpoch === null || fold.watermark === null) {
    return true;
  }
  if (snapshot.logEpoch !== fold.logEpoch) {
    // 换代快照是新的权威基线，可以应用。
    return true;
  }
  return snapshot.coveredSourceSeq >= fold.watermark.seq;
}

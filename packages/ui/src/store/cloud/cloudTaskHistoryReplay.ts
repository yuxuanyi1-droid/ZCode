/**
 * Cloud 任务跨 run 历史回放（specs/cloud-agent/04 §3.3 只读历史、02 §7.3、03 §9；
 * 2026-10-09 终验缺陷 D 修复的数据层纯函数）。
 *
 * 背景：pane 的实时订阅绑定当前 activeRun 的 runtime 会话（`conversation/<sess_…>`），
 * 归档任务无 run 不订阅、重开后的新 run 只投递自己的流——旧 run 的已投影回合从时间线
 * 消失。控制面持久投影按 task 全量保留（projection_events），`GET /tasks/:id/history`
 * 以族名 `conversation` 返回**跨 run 全部会话话题**的交付帧；本模块把帧解折叠成
 * 按 run 时间先后合并的只读行序列。
 *
 * 折叠规则（与 02 §7.3 一致，不猜）：
 * - 每个话题（= 一个 runtime 会话流）独立回放：snapshot 整体替换；delta 仅在
 *   `fromSeq === 当前水位` 时应用，断档丢弃后续 delta 直到下一个 snapshot（缺口不缝合）。
 * - 话题之间按首帧控制面 ingest 时间（`ts`）排序：run 之间时间不重叠，run 序即时间序。
 * - 形状不合/解析失败的记录跳过计数，不静默当作空历史。
 */
import type { CloudHistoryItem } from "@zcode/shared";
import {
  applyConversationDeltas,
  parseConversationTopic,
  type ConversationDelta,
  type ConversationRow,
  type ConversationSnapshot,
} from "@zcode/shared/zcode-protocol-v4";

/**
 * 执行节点导出的持久帧（projectionExporter.recordFor 的 payload 形状）：
 * `{ topic, fromSeq, toSeq, sentAt, payload: <V4 帧负载> }`。这里的解码只做
 * 结构收窄——内容形状在 supervisor 订阅路径上已经过 conversationTopicFrameSchema
 * 校验，持久副本不改写负载；UI 不重复引入 zod 依赖。
 */
interface PersistedSnapshotFrame {
  readonly kind: "snapshot";
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly snapshot: ConversationSnapshot;
}

interface PersistedDeltasFrame {
  readonly kind: "deltas";
  readonly fromSeq: number;
  readonly toSeq: number;
  readonly deltas: readonly ConversationDelta[];
}

type PersistedFrame = PersistedSnapshotFrame | PersistedDeltasFrame;

function decodePersistedFrame(payload: unknown): PersistedFrame | null {
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const envelope = payload as {
    fromSeq?: unknown;
    toSeq?: unknown;
    payload?: { kind?: unknown; snapshot?: unknown; deltas?: unknown };
  };
  const fromSeq = envelope.fromSeq;
  const toSeq = envelope.toSeq;
  const inner = envelope.payload;
  if (
    typeof fromSeq !== "number" ||
    typeof toSeq !== "number" ||
    typeof inner !== "object" ||
    inner === null
  ) {
    return null;
  }
  if (inner.kind === "snapshot" && typeof inner.snapshot === "object" && inner.snapshot !== null) {
    return { kind: "snapshot", fromSeq, toSeq, snapshot: inner.snapshot as ConversationSnapshot };
  }
  if (inner.kind === "deltas" && Array.isArray(inner.deltas)) {
    return {
      kind: "deltas",
      fromSeq,
      toSeq,
      deltas: inner.deltas as readonly ConversationDelta[],
    };
  }
  return null;
}

export interface CloudTaskHistoryStream {
  /** `conversation/<sessionId>`：一个 runtime 会话流（通常对应一个 run）。 */
  readonly topic: string;
  readonly sessionId: string;
  /** 该流回放出的已投影行（rowId 升序，与权威投影同序）。 */
  readonly rows: readonly ConversationRow[];
  readonly startedAt: number | null;
  readonly endedAt: number | null;
  /** 流内出现无法续接的缺口（保留窗/缺帧）：如实标注，不静默截断。 */
  readonly incomplete: boolean;
}

export interface CloudTaskHistoryReplay {
  readonly streams: readonly CloudTaskHistoryStream[];
  /** 跨 run 合并后的只读行（按流时间先后拼接，流内 rowId 升序）。 */
  readonly rows: readonly ConversationRow[];
  /** 解析失败/跳过的记录数（诊断用，>0 表示持久投影里有读不懂的帧）。 */
  readonly skipped: number;
}

export function createEmptyCloudTaskHistoryReplay(): CloudTaskHistoryReplay {
  return { streams: [], rows: [], skipped: 0 };
}

interface ReplayAccumulator {
  snapshot: ConversationSnapshot | null;
  skippedInStream: number;
  gap: boolean;
}

/** 单流回放：snapshot 权威替换，delta 仅在水位衔接时应用（缺口不猜）。 */
function replayStream(items: readonly CloudHistoryItem[]): ReplayAccumulator {
  let snapshot: ConversationSnapshot | null = null;
  let skippedInStream = 0;
  let gap = false;
  for (const item of items) {
    const frame = decodePersistedFrame(item.payload);
    if (frame === null) {
      skippedInStream += 1;
      continue;
    }
    if (frame.kind === "snapshot") {
      snapshot = frame.snapshot;
      gap = false;
      continue;
    }
    if (snapshot === null || frame.fromSeq !== snapshot.seq) {
      // 无 base 或断档：丢弃这批 delta，等下一个 snapshot 重建基线（02 §7.3）。
      gap = true;
      continue;
    }
    snapshot = { ...applyConversationDeltas(snapshot, frame.deltas), seq: frame.toSeq };
  }
  return { snapshot, skippedInStream, gap };
}

/**
 * 把跨 run 的 history 记录折叠成只读行序列。
 * 输入预期为 history 分页的全量 accumulation（按 event_seq 升序）；同 `(topic, seq)`
 * 重复记录保留先到的一条。
 */
export function replayCloudTaskConversationHistory(
  items: readonly CloudHistoryItem[],
): CloudTaskHistoryReplay {
  const byTopic = new Map<string, Map<number, CloudHistoryItem>>();
  let skipped = 0;
  for (const item of items) {
    const sessionId = parseConversationTopic(item.topic);
    if (sessionId === null) {
      // 非会话话题（如 sessions-index）与族名占位记录不进时间线。
      skipped += 1;
      continue;
    }
    let bySeq = byTopic.get(item.topic);
    if (bySeq === undefined) {
      bySeq = new Map<number, CloudHistoryItem>();
      byTopic.set(item.topic, bySeq);
    }
    if (!bySeq.has(item.seq)) {
      bySeq.set(item.seq, item);
    }
  }

  const streams: CloudTaskHistoryStream[] = [];
  for (const [topic, bySeq] of byTopic) {
    const ordered = [...bySeq.values()].sort((a, b) => a.seq - b.seq);
    if (ordered.length === 0) {
      continue;
    }
    const sessionId = parseConversationTopic(topic);
    if (sessionId === null) {
      continue;
    }
    const replayed = replayStream(ordered);
    const rows = replayed.snapshot?.rows.window ?? [];
    skipped += replayed.skippedInStream;
    // 完全空且无异常的流（例如只有空 snapshot）：对只读视图没有呈现价值，跳过。
    if (rows.length === 0 && !replayed.gap) {
      continue;
    }
    streams.push({
      topic,
      sessionId,
      rows,
      startedAt: ordered[0]?.ts ?? null,
      endedAt: ordered.at(-1)?.ts ?? null,
      incomplete: replayed.gap,
    });
  }

  // run 之间时间不重叠（重开才有新 run）：按流首帧时间升序即跨 run 时间序。
  streams.sort((a, b) => (a.startedAt ?? 0) - (b.startedAt ?? 0));
  const rows: ConversationRow[] = [];
  for (const stream of streams) {
    rows.push(...stream.rows);
  }
  return { streams, rows, skipped };
}

/** 回放读取的呈现状态（与 history 端点状态同轴）。 */
export type CloudTaskHistoryViewStatus = "idle" | "loading" | "ready" | "error";

export interface CloudTaskHistoryViewPlan {
  /** 是否渲染区块：无流且未失败 → false（不抢草稿问候/实时时间线）。 */
  readonly visible: boolean;
  /** 排除当前实时 run 流后仍要呈现的流（保持时间序）。 */
  readonly streams: readonly CloudTaskHistoryStream[];
  /** 呈现行数合计（DOM 打点 `data-row-count` 的值）。 */
  readonly rowCount: number;
}

/**
 * 归档/重开视图的呈现判定（纯函数，node:test 直接覆盖；组件渲染依赖
 * ConversationShareReadonlyTimeline 的资产导入链，无法在此环境加载）。
 * - 全部 run 呈现（excludeTopic 缺省）：归档 / 无在线 run；
 * - 排除当前实时 run 的流（excludeTopic = `conversation/<sessionId>`）：
 *   重开后的在线视图只补旧 run，当前流由实时订阅呈现。
 */
export function resolveCloudTaskHistoryViewPlan(input: {
  readonly status: CloudTaskHistoryViewStatus;
  readonly streams: readonly CloudTaskHistoryStream[];
  readonly excludeTopic?: string | null;
}): CloudTaskHistoryViewPlan {
  const streams = input.streams.filter(
    (stream) =>
      input.excludeTopic === undefined ||
      input.excludeTopic === null ||
      stream.topic !== input.excludeTopic,
  );
  const rowCount = streams.reduce((total, stream) => total + stream.rows.length, 0);
  return {
    visible: streams.length > 0 || input.status === "error",
    streams,
    rowCount,
  };
}

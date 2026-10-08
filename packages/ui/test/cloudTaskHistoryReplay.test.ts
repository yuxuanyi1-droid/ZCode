/**
 * 云任务跨 run 历史回放用例（specs/cloud-agent/04 §3.3 archived 行、02 §7.3、03 §9；
 * 2026-10-09 终验缺陷 D）。
 *
 * 回归背景：归档任务横幅写「History stays viewable」，但 pane 的订阅绑定当前 run 的
 * runtimeSessionId——归档态无 run 根本不订阅（时间线空），重开新 run 后也只见新 run
 * 回合。修复链路：控制面权威历史（`GET /tasks/:id/history` 族名 topic）→
 * `replayCloudTaskConversationHistory` 跨 run 折叠 → `cloudTaskHistoryStore.replayByTask`
 * → `CloudTaskHistoryTimeline` 只读时间线（SessionPane headerSlot 槽位）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudHistoryItem } from "@zcode/shared";
import type { ConversationRow, ConversationSnapshot } from "@zcode/shared/zcode-protocol-v4";
import {
  replayCloudTaskConversationHistory,
  resolveCloudTaskHistoryViewPlan,
} from "../src/store/cloud/cloudTaskHistoryReplay.js";
import {
  CLOUD_TASK_HISTORY_REPLAY_MAX_ITEMS,
  useCloudTaskHistoryStore,
} from "../src/store/cloud/cloudTaskHistoryStore.js";

const PRINCIPAL = "principal-1";

function historyItem(input: {
  topic: string;
  seq: number;
  ts: number;
  payload: unknown;
  logEpoch?: string;
}): CloudHistoryItem {
  return {
    topic: input.topic,
    logEpoch: input.logEpoch ?? "epoch-1",
    seq: input.seq,
    kind: "delta",
    payload: input.payload as CloudHistoryItem["payload"],
    ts: input.ts,
  };
}

function snapshotFrame(input: {
  topic: string;
  rows: readonly ConversationRow[];
  seq: number;
  ts: number;
}): CloudHistoryItem {
  const snapshot = {
    seq: input.seq,
    rows: {
      window: [...input.rows],
      firstRowId: input.rows[0]?.rowId ?? null,
      totalCount: input.rows.length,
    },
  } as unknown as ConversationSnapshot;
  return historyItem({
    topic: input.topic,
    seq: input.seq,
    ts: input.ts,
    payload: {
      topic: input.topic,
      fromSeq: 0,
      toSeq: input.seq,
      sentAt: input.ts,
      payload: { kind: "snapshot", snapshot },
    },
  });
}

function deltasFrame(input: {
  topic: string;
  fromSeq: number;
  toSeq: number;
  ts: number;
  rows: readonly ConversationRow[];
}): CloudHistoryItem {
  return historyItem({
    topic: input.topic,
    seq: input.toSeq,
    ts: input.ts,
    payload: {
      topic: input.topic,
      fromSeq: input.fromSeq,
      toSeq: input.toSeq,
      sentAt: input.ts,
      payload: {
        kind: "deltas",
        deltas: input.rows.map((row) => ({ op: "row.appended", row })),
      },
    },
  });
}

function row(input: { rowId: number; text: string; turnId?: string }): ConversationRow {
  return {
    rowId: input.rowId,
    turnId: input.turnId ?? `turn-${input.rowId}`,
    kind: "assistantText",
    text: input.text,
    state: "complete",
    createdAt: 1_700_000_000_000,
    createdAtSeq: input.rowId,
  } as unknown as ConversationRow;
}

test("跨 run 折叠：全部 run 的已投影回合按 run 时间合并（缺陷 D 主断言）", () => {
  const runA = "conversation/sess-a";
  const runB = "conversation/sess-b";
  const replay = replayCloudTaskConversationHistory([
    // run A（更早）：snapshot 2 行 + delta 追加 1 行。
    snapshotFrame({
      topic: runA,
      rows: [row({ rowId: 1, text: "a1" }), row({ rowId: 2, text: "a2" })],
      seq: 2,
      ts: 1000,
    }),
    deltasFrame({
      topic: runA,
      fromSeq: 2,
      toSeq: 3,
      ts: 1100,
      rows: [row({ rowId: 3, text: "a3" })],
    }),
    // run B（重开）：独立流，snapshot 2 行。
    snapshotFrame({
      topic: runB,
      rows: [row({ rowId: 1, text: "b1" }), row({ rowId: 2, text: "b2" })],
      seq: 2,
      ts: 5000,
    }),
    // 非会话话题不进时间线。
    historyItem({
      topic: "sessions-index/identity",
      seq: 0,
      ts: 6000,
      payload: { kind: "snapshot" },
    }),
  ]);

  assert.equal(replay.streams.length, 2, "两个 run 各一条流");
  assert.equal(replay.streams[0]?.topic, runA, "按 run 首帧时间排序：早 run 在前");
  assert.equal(replay.streams[0]?.rows.length, 3, "delta 续接 snapshot：3 行");
  assert.equal(replay.streams[1]?.topic, runB);
  assert.equal(replay.streams[1]?.rows.length, 2);
  assert.equal(replay.rows.length, 5, "跨 run 合并行序 = 流序拼接");
  assert.equal(replay.skipped, 1, "sessions-index 记录跳过并计数");
  assert.equal(replay.streams[0]?.incomplete, false);
});

test("缺口不猜：无 base / 断档的 delta 丢弃并标注 incomplete（02 §7.3）", () => {
  const topic = "conversation/sess-gap";
  const replay = replayCloudTaskConversationHistory([
    // 无 base 的 delta（保留窗外）：即使排在流首也被丢弃，直到 snapshot 重建基线。
    deltasFrame({
      topic,
      fromSeq: 9,
      toSeq: 10,
      ts: 900,
      rows: [row({ rowId: 10, text: "lost-no-base" })],
    }),
    snapshotFrame({ topic, rows: [row({ rowId: 1, text: "base" })], seq: 1, ts: 1000 }),
    // 水位衔接（fromSeq 1 = snapshot 水位）：应用。
    deltasFrame({ topic, fromSeq: 1, toSeq: 2, ts: 1001, rows: [row({ rowId: 2, text: "kept" })] }),
    // 断档（fromSeq 4 ≠ 水位 2）：丢弃，流标注 incomplete。
    deltasFrame({
      topic,
      fromSeq: 4,
      toSeq: 5,
      ts: 1002,
      rows: [row({ rowId: 5, text: "lost-gap" })],
    }),
  ]);
  const stream = replay.streams[0];
  assert.ok(stream);
  assert.equal(stream.rows.length, 2, "snapshot 1 行 + 衔接的 delta 1 行");
  assert.ok(
    stream.rows.some((item) => (item as { text?: string }).text === "kept"),
    "水位衔接后的 delta 应用",
  );
  assert.equal(stream.incomplete, true, "丢弃过 delta 的流如实标注缺口");
});

test("形状不合的 payload 跳过计数，不当作空历史", () => {
  const topic = "conversation/sess-bad";
  const replay = replayCloudTaskConversationHistory([
    historyItem({ topic, seq: 0, ts: 1000, payload: "not-a-frame" }),
    historyItem({ topic, seq: 1, ts: 1001, payload: { topic, payload: { kind: "snapshot" } } }),
    snapshotFrame({ topic, rows: [row({ rowId: 1, text: "ok" })], seq: 2, ts: 1002 }),
  ]);
  assert.equal(replay.streams.length, 1);
  assert.equal(replay.streams[0]?.rows.length, 1);
  assert.equal(replay.skipped, 2);
});

test("同 (topic, seq) 重复记录只保留先到一条", () => {
  const topic = "conversation/sess-dup";
  const frame = snapshotFrame({ topic, rows: [row({ rowId: 1, text: "once" })], seq: 1, ts: 1000 });
  const replay = replayCloudTaskConversationHistory([frame, { ...frame, ts: 2000 }]);
  assert.equal(replay.streams[0]?.rows.length, 1);
});

test("store 接线：replayByTask 分页 accumulation、主体守卫与上限截断", () => {
  const store = useCloudTaskHistoryStore.getState();
  store.reset();
  useCloudTaskHistoryStore.getState().setPrincipal(PRINCIPAL);

  useCloudTaskHistoryStore.getState().beginReplayLoad(PRINCIPAL, "task-1", { reset: true });
  useCloudTaskHistoryStore.getState().applyReplayPage(PRINCIPAL, "task-1", {
    items: [
      snapshotFrame({
        topic: "conversation/s1",
        rows: [row({ rowId: 1, text: "p1" })],
        seq: 1,
        ts: 1000,
      }),
    ],
    nextCursor: "cursor-2",
  });
  let entry = useCloudTaskHistoryStore.getState().replayByTask["task-1"];
  assert.equal(entry?.status, "ready");
  assert.equal(entry.items.length, 1);
  assert.equal(entry.replay.rows.length, 1);
  assert.equal(entry.nextCursor, "cursor-2");
  assert.equal(entry.truncated, false);

  // 翻页：append accumulation，重放覆盖两页。
  useCloudTaskHistoryStore.getState().applyReplayPage(PRINCIPAL, "task-1", {
    items: [
      snapshotFrame({
        topic: "conversation/s2",
        rows: [row({ rowId: 1, text: "p2" })],
        seq: 1,
        ts: 2000,
      }),
    ],
  });
  entry = useCloudTaskHistoryStore.getState().replayByTask["task-1"];
  assert.equal(entry.items.length, 2);
  assert.equal(entry.replay.streams.length, 2, "第二页的新 run 流进入同一回放");

  // 主体切换（04 §3.4.1「登出切主体清投影」）：缓存的回放整体清空，旧主体的
  // 迟到分页写入被拒（守卫同一处：principalId 不匹配不落地）。
  useCloudTaskHistoryStore.getState().setPrincipal("principal-2");
  useCloudTaskHistoryStore.getState().applyReplayPage(PRINCIPAL, "task-1", {
    items: [
      snapshotFrame({
        topic: "conversation/s3",
        rows: [row({ rowId: 1, text: "p3" })],
        seq: 1,
        ts: 3000,
      }),
    ],
  });
  assert.equal(
    useCloudTaskHistoryStore.getState().replayByTask["task-1"],
    undefined,
    "切主体清缓存，且旧主体分页不落地",
  );

  useCloudTaskHistoryStore.getState().reset();
});

test("store 上限截断：超出条目上限的页被裁剪并如实标注 truncated", () => {
  const store = useCloudTaskHistoryStore.getState();
  store.reset();
  useCloudTaskHistoryStore.getState().setPrincipal(PRINCIPAL);
  useCloudTaskHistoryStore.getState().beginReplayLoad(PRINCIPAL, "task-cap", { reset: true });

  const firstPage = Array.from({ length: CLOUD_TASK_HISTORY_REPLAY_MAX_ITEMS - 1 }, (_, index) =>
    snapshotFrame({
      topic: `conversation/s${index}`,
      rows: [row({ rowId: 1, text: `r${index}` })],
      seq: 1,
      ts: index,
    }),
  );
  useCloudTaskHistoryStore.getState().applyReplayPage(PRINCIPAL, "task-cap", { items: firstPage });
  // 只剩 1 个空位，这页 2 条 → 收 1 条、标 truncated。
  useCloudTaskHistoryStore.getState().applyReplayPage(PRINCIPAL, "task-cap", {
    items: [
      snapshotFrame({
        topic: "conversation/s-x",
        rows: [row({ rowId: 1, text: "x" })],
        seq: 1,
        ts: 9000,
      }),
      snapshotFrame({
        topic: "conversation/s-y",
        rows: [row({ rowId: 1, text: "y" })],
        seq: 1,
        ts: 9001,
      }),
    ],
    nextCursor: "more",
  });
  const entry = useCloudTaskHistoryStore.getState().replayByTask["task-cap"];
  assert.equal(entry?.items.length, CLOUD_TASK_HISTORY_REPLAY_MAX_ITEMS);
  assert.equal(entry?.truncated, true, "截断必须显式暴露，不得伪装成历史结束");

  useCloudTaskHistoryStore.getState().reset();
});

// 呈现判定抽成纯函数（resolveCloudTaskHistoryViewPlan）的原因与 cloudWorkspaceSidebar
// 相同：组件渲染链（ConversationShareReadonlyTimeline → plugin icon 资产导入）无法在
// `node --import tsx` 下加载；DOM 打点（data-testid 等）由组件按本判定的结果直接落,
// 真实链路的 DOM 断言由无头复核执行。

test("呈现判定：归档视图呈现全部 run，空历史不占位", () => {
  const replay = replayCloudTaskConversationHistory([
    snapshotFrame({
      topic: "conversation/s1",
      rows: [row({ rowId: 1, text: "第一轮" })],
      seq: 1,
      ts: 1000,
    }),
  ]);

  // 空历史（含加载中）：visible=false，不抢草稿问候/实时时间线。
  assert.equal(resolveCloudTaskHistoryViewPlan({ status: "loading", streams: [] }).visible, false);
  assert.equal(resolveCloudTaskHistoryViewPlan({ status: "ready", streams: [] }).visible, false);

  const plan = resolveCloudTaskHistoryViewPlan({ status: "ready", streams: replay.streams });
  assert.equal(plan.visible, true);
  assert.equal(plan.streams.length, 1, "流计数打点（data-stream-count 的值）");
  assert.equal(plan.rowCount, 1, "行数打点（data-row-count 的值）");
  assert.equal(plan.streams[0]?.topic, "conversation/s1");
});

test("呈现判定：excludeTopic 排除当前实时 run 的流（重开视图只补旧 run）", () => {
  const replay = replayCloudTaskConversationHistory([
    snapshotFrame({
      topic: "conversation/old-run",
      rows: [row({ rowId: 1, text: "旧 run" })],
      seq: 1,
      ts: 1000,
    }),
    snapshotFrame({
      topic: "conversation/current-run",
      rows: [row({ rowId: 1, text: "当前 run" })],
      seq: 1,
      ts: 2000,
    }),
  ]);

  const plan = resolveCloudTaskHistoryViewPlan({
    status: "ready",
    streams: replay.streams,
    excludeTopic: "conversation/current-run",
  });
  assert.deepEqual(
    plan.streams.map((stream) => stream.topic),
    ["conversation/old-run"],
    "当前实时流不重复渲染，旧 run 呈现",
  );
  assert.equal(plan.rowCount, 1);

  // 当前 run 是唯一的 run（首个 run 在线）：排除后无流 → 不渲染。
  const onlyCurrent = resolveCloudTaskHistoryViewPlan({
    status: "ready",
    streams: replay.streams.filter((stream) => stream.topic === "conversation/current-run"),
    excludeTopic: "conversation/current-run",
  });
  assert.equal(onlyCurrent.visible, false);
});

test("呈现判定：失败态必须可见（加载失败不给静默空态）", () => {
  const plan = resolveCloudTaskHistoryViewPlan({ status: "error", streams: [] });
  assert.equal(plan.visible, true, "error 态即使无流也渲染（错误行 + 重试入口）");
});

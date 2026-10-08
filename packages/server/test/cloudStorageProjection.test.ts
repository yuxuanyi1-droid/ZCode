/**
 * 投影 ingest 验收（02 §7.1/§7.2、03 §4 projection_* 表、§9 留存与 resync）。
 *
 * 断言：去重键幂等；同键不同 contentHash 报一致性 fault 而不覆盖；ingest 水位只在
 * 连续时前进（缺口不跳跃确认）；历史分页与 resync 结论明确；快照声明覆盖范围且只增
 * 不减。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudProjectionRecord } from "@zcode/shared";
import { cloudBridgeControlFrameSchema } from "@zcode/shared";
import {
  newUuid,
  nextNow,
  openTestStorage,
  removeTestRoot,
  seedActiveRun,
  seedDraftTask,
  type TestStorageHandle,
} from "./cloudStorageHarness.js";
import { isCloudStorageError } from "../src/cloud/adapters/storage/cloudStorageError.js";

async function withSeededRun(
  body: (context: { handle: TestStorageHandle; taskId: string; runId: string }) => Promise<void>,
): Promise<void> {
  const handle = await openTestStorage();
  try {
    const seeded = await seedDraftTask(handle.storage);
    const seededRun = await seedActiveRun(handle.storage, seeded);
    await body({ handle, taskId: seeded.taskId, runId: seededRun.runId });
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
}

function projectionRecord(input: {
  taskId: string;
  runId: string;
  sourceSeq: number;
  contentHash: string;
  payload?: unknown;
}): CloudProjectionRecord {
  return {
    schemaVersion: 1,
    taskId: input.taskId,
    runId: input.runId,
    runGeneration: 1,
    runtimeIncarnation: "inc-1",
    topic: "conversation",
    logEpoch: "epoch-1",
    sourceSeq: input.sourceSeq,
    kind: "delta",
    payload: input.payload ?? { text: `片段 ${input.sourceSeq}` },
    contentHash: input.contentHash,
  } as CloudProjectionRecord;
}

test("重复投递幂等，同键不同 contentHash 报冲突而不覆盖", async () => {
  await withSeededRun(async ({ handle, taskId, runId }) => {
    const first = await handle.storage.storage.projections.appendBatch([
      projectionRecord({ taskId, runId, sourceSeq: 0, contentHash: "a".repeat(64) }),
    ]);
    assert.equal(first.appended, 1);
    assert.deepEqual(first.conflicts, []);
    assert.deepEqual(first.cursors, [{ topic: "conversation", logEpoch: "epoch-1", sourceSeq: 0 }]);

    const replay = await handle.storage.storage.projections.appendBatch([
      projectionRecord({ taskId, runId, sourceSeq: 0, contentHash: "a".repeat(64) }),
      projectionRecord({ taskId, runId, sourceSeq: 1, contentHash: "b".repeat(64) }),
    ]);
    assert.equal(replay.appended, 1, "已存在且 hash 一致的事件不重复写入");

    const conflict = await handle.storage.storage.projections.appendBatch([
      projectionRecord({
        taskId,
        runId,
        sourceSeq: 0,
        contentHash: "c".repeat(64),
        payload: { text: "篡改" },
      }),
    ]);
    assert.equal(conflict.appended, 0);
    assert.deepEqual(conflict.conflicts, [
      { topic: "conversation", logEpoch: "epoch-1", sourceSeq: 0 },
    ]);

    const history = await handle.storage.storage.projections.readHistory({ taskId, limit: 10 });
    assert.equal(history.items.length, 2);
    const firstItem = history.items[0];
    assert.ok(firstItem);
    assert.equal(
      (firstItem.payload as { text: string }).text,
      "片段 0",
      "既有事件不被覆盖（02 §7.1）",
    );
  });
});

// 2026-10-07 复核缺陷 2 回归：导出记录 sourceSeq 取交付帧 toSeq（snapshot 合并 0..N 时
// 第一条记录就是 N）。旧的「从 0 起数字前缀」水位把它算成 -1，控制面回出
// `projection.ack.lastContiguousSourceSeq: -1`，执行节点按 invalid-frame 断链（4001，
// 每 run 首次 WAL 排空固定触发一次）。水位必须按区间链（domain/projectionSequence）推进，
// 且任何回 ack 的水位都必须满足 shared schema 的非负整数约束。
test("snapshot 领头的导出批次：水位按 toSeq 区间链推进，ack 水位合法非负", async () => {
  await withSeededRun(async ({ handle, taskId, runId }) => {
    const exported = (input: {
      fromSeq: number;
      toSeq: number;
      contentHash: string;
    }): CloudProjectionRecord =>
      projectionRecord({
        taskId,
        runId,
        sourceSeq: input.toSeq,
        contentHash: input.contentHash,
        payload: {
          topic: "conversation/sess-1",
          fromSeq: input.fromSeq,
          toSeq: input.toSeq,
          sentAt: 0,
          payload: { kind: "snapshot", text: `${input.fromSeq}-${input.toSeq}` },
        },
      });

    const first = await handle.storage.storage.projections.appendBatch([
      exported({ fromSeq: 0, toSeq: 5, contentHash: "1".repeat(64) }),
      exported({ fromSeq: 6, toSeq: 6, contentHash: "2".repeat(64) }),
    ]);
    assert.equal(first.appended, 2);
    assert.deepEqual(
      first.cursors,
      [{ topic: "conversation", logEpoch: "epoch-1", sourceSeq: 6 }],
      "区间链水位=6（旧算法此处为 -1）",
    );

    // 控制面用该水位回 projection.ack：逐字段按 inbound.ts 的构造，schema 必须接受。
    const cursor = first.cursors[0];
    assert.ok(cursor);
    const ackFrame = {
      protocolVersion: 1,
      type: "projection.ack" as const,
      connectionEpoch: 1,
      topic: cursor.topic,
      logEpoch: cursor.logEpoch,
      lastContiguousSourceSeq: cursor.sourceSeq,
      ingestCursor: `${cursor.topic}:${cursor.logEpoch}:${cursor.sourceSeq}`,
    };
    const parsed = cloudBridgeControlFrameSchema.safeParse(ackFrame);
    assert.equal(parsed.success, true, "ack 帧必须过 shared schema（4001 回归）");

    // 链中断开（缺 7..7）水位停在 6，补齐后前进到 9。
    const gapped = await handle.storage.storage.projections.appendBatch([
      exported({ fromSeq: 8, toSeq: 9, contentHash: "4".repeat(64) }),
    ]);
    assert.deepEqual(gapped.cursors, [
      { topic: "conversation", logEpoch: "epoch-1", sourceSeq: 6 },
    ]);
    const filled = await handle.storage.storage.projections.appendBatch([
      exported({ fromSeq: 7, toSeq: 7, contentHash: "3".repeat(64) }),
    ]);
    assert.deepEqual(filled.cursors, [
      { topic: "conversation", logEpoch: "epoch-1", sourceSeq: 9 },
    ]);
  });
});

test("链头缺失（首条记录不从已持久水位之后开始）不回 ack，等执行节点重投", async () => {
  await withSeededRun(async ({ handle, taskId, runId }) => {
    const headless = await handle.storage.storage.projections.appendBatch([
      projectionRecord({
        taskId,
        runId,
        sourceSeq: 7,
        contentHash: "7".repeat(64),
        payload: { topic: "conversation", fromSeq: 7, toSeq: 7 },
      }),
    ]);
    assert.equal(headless.appended, 1);
    assert.deepEqual(headless.cursors, [], "链头缺失不回 ack（旧算法回 -1 直接断链）");
  });
});

test("缺口不推进 ingest 水位，补齐后前进", async () => {
  await withSeededRun(async ({ handle, taskId, runId }) => {
    const gap = await handle.storage.storage.projections.appendBatch([
      projectionRecord({ taskId, runId, sourceSeq: 0, contentHash: "1".repeat(64) }),
      projectionRecord({ taskId, runId, sourceSeq: 2, contentHash: "2".repeat(64) }),
    ]);
    assert.equal(gap.appended, 2);
    assert.deepEqual(gap.cursors, [{ topic: "conversation", logEpoch: "epoch-1", sourceSeq: 0 }]);
    assert.deepEqual(await handle.storage.storage.projections.ingestCursors({ runId }), [
      { topic: "conversation", logEpoch: "epoch-1", sourceSeq: 0 },
    ]);

    const filled = await handle.storage.storage.projections.appendBatch([
      projectionRecord({ taskId, runId, sourceSeq: 1, contentHash: "3".repeat(64) }),
    ]);
    assert.deepEqual(filled.cursors, [
      { topic: "conversation", logEpoch: "epoch-1", sourceSeq: 2 },
    ]);
  });
});

// 复核缺陷 4：nextCursor 语义 = 「下一页必有数据」。游标越过已存范围（客户端持旧
// 状态/数据被清理）时返回空页：items 为空、**不带 nextCursor**、resyncRequired=true，
// 客户端据此重读快照而不是拿 hasMore 反复空翻页。
test("游标越过已存范围：空页不带 nextCursor，且要求 resync", async () => {
  await withSeededRun(async ({ handle, taskId, runId }) => {
    await handle.storage.storage.projections.appendBatch(
      [0, 1, 2].map((sourceSeq) =>
        projectionRecord({ taskId, runId, sourceSeq, contentHash: String(sourceSeq).repeat(64) }),
      ),
    );
    // 合法末页之后：cursor 指向最后一条已读 event_seq（由分页游标推进模拟越界前的边界）。
    const page1 = await handle.storage.storage.projections.readHistory({
      taskId,
      limit: 2,
    });
    assert.ok(page1.nextCursor);
    // 构造越界游标：指向超出当前最大 event_seq 的位置（比末条 event_seq 大 1）。
    const beyond = Buffer.from(JSON.stringify([10_000]), "utf8").toString("base64url");
    const empty = await handle.storage.storage.projections.readHistory({
      taskId,
      cursor: beyond,
      limit: 2,
    });
    assert.deepEqual(empty.items, [], "越界游标取到空页");
    assert.equal(empty.nextCursor, undefined, "空页绝不携带 hasMore cursor（缺陷 4）");
    assert.equal(empty.resyncRequired, true, "越界要求 resync（03 §9）");

    // 正常末页（恰好读满到尽头）不带 cursor：hasMore=false 当且仅当没有下一页。
    const tail = await handle.storage.storage.projections.readHistory({
      taskId,
      cursor: page1.nextCursor,
      limit: 2,
    });
    assert.equal(tail.items.length, 1);
    assert.equal(tail.nextCursor, undefined, "数据读尽后 hasMore=false");
  });
});

test("readHistory 分页与 retention 越界返回 resync", async () => {
  await withSeededRun(async ({ handle, taskId, runId }) => {
    const records = [0, 1, 2, 3].map((sourceSeq) =>
      projectionRecord({
        taskId,
        runId,
        sourceSeq,
        contentHash: String(sourceSeq).repeat(64),
      }),
    );
    await handle.storage.storage.projections.appendBatch(records);

    const page1 = await handle.storage.storage.projections.readHistory({ taskId, limit: 2 });
    assert.equal(page1.items.length, 2);
    assert.ok(page1.nextCursor);
    assert.equal(page1.resyncRequired, undefined);

    const page2 = await handle.storage.storage.projections.readHistory({
      taskId,
      cursor: page1.nextCursor,
      limit: 2,
    });
    assert.deepEqual(
      page2.items.map((item) => item.sourceSeq),
      [2, 3],
    );
    assert.equal(page2.nextCursor, undefined);

    const filtered = await handle.storage.storage.projections.readHistory({
      taskId,
      topic: "missing-topic",
      limit: 10,
    });
    assert.deepEqual(filtered.items, []);

    // 游标超前于已有数据（例如从备份恢复后客户端仍持有旧游标）：要求 resync。
    const ahead = await handle.storage.storage.projections.readHistory({
      taskId,
      cursor: Buffer.from(JSON.stringify([9999]), "utf8").toString("base64url"),
      limit: 10,
    });
    assert.equal(ahead.resyncRequired, true);
  });
});

test("快照声明覆盖范围，且旧快照不覆盖新快照", async () => {
  await withSeededRun(async ({ handle, taskId, runId }) => {
    await handle.storage.storage.projections.writeSnapshot({
      taskId,
      runId,
      topic: "conversation",
      logEpoch: "epoch-1",
      coveredSourceSeq: 5,
      snapshot: { messages: ["m1"] },
      now: nextNow(20),
    });
    const stored = await handle.storage.storage.projections.readSnapshot({
      taskId,
      topic: "conversation",
    });
    assert.equal(stored?.logEpoch, "epoch-1");
    assert.equal(stored?.coveredSourceSeq, 5);
    assert.deepEqual(stored?.snapshot, { messages: ["m1"] });

    // 覆盖范围回退的写入必须被忽略。
    await handle.storage.storage.projections.writeSnapshot({
      taskId,
      runId,
      topic: "conversation",
      logEpoch: "epoch-1",
      coveredSourceSeq: 3,
      snapshot: { messages: [] },
      now: nextNow(21),
    });
    const after = await handle.storage.storage.projections.readSnapshot({
      taskId,
      topic: "conversation",
    });
    assert.equal(after?.coveredSourceSeq, 5);

    await handle.storage.storage.projections.writeSnapshot({
      taskId,
      runId,
      topic: "conversation",
      logEpoch: "epoch-1",
      coveredSourceSeq: 9,
      snapshot: { messages: ["m1", "m2"] },
      now: nextNow(22),
    });
    const advanced = await handle.storage.storage.projections.readSnapshot({
      taskId,
      topic: "conversation",
    });
    assert.equal(advanced?.coveredSourceSeq, 9);
    assert.deepEqual(advanced?.snapshot, { messages: ["m1", "m2"] });
  });
});

test("投影记录归属校验：taskId 必须与 run 一致", async () => {
  await withSeededRun(async ({ handle, runId }) => {
    await assert.rejects(
      handle.storage.storage.projections.appendBatch([
        projectionRecord({ taskId: newUuid(), runId, sourceSeq: 0, contentHash: "f".repeat(64) }),
      ]),
      (error: unknown) => isCloudStorageError(error) && error.reason === "invalid-record",
    );
    await assert.rejects(
      handle.storage.storage.projections.appendBatch([
        projectionRecord({
          taskId: newUuid(),
          runId: newUuid(),
          sourceSeq: 0,
          contentHash: "f".repeat(64),
        }),
      ]),
      (error: unknown) => isCloudStorageError(error) && error.code === "not_found",
    );
  });
});

// 2026-10-09 终验缺陷 D 修订：导出记录的 topic 是 `conversation/<sessionId>`
// （projectionExporter 按 sessions-index 发现），history 端点缺省 topic 是族名
// `conversation`。族名必须按前缀命中该族全部话题（跨 run/跨 epoch），否则归档与
// 重开视图读历史永远是空页。
test("readHistory 族名 topic 返回该族全部话题，完整话题仍精确匹配", async () => {
  await withSeededRun(async ({ handle, taskId, runId }) => {
    const record = (topic: string, sourceSeq: number): CloudProjectionRecord => ({
      ...projectionRecord({
        taskId,
        runId,
        sourceSeq,
        contentHash: String(sourceSeq).repeat(64),
      }),
      topic,
      payload: { topic, text: `${topic}#${sourceSeq}` },
    });
    await handle.storage.storage.projections.appendBatch([
      record("conversation/sess-a", 0),
      record("conversation/sess-a", 1),
      record("conversation/sess-b", 0),
      record("sessions-index/identity", 0),
    ]);

    const family = await handle.storage.storage.projections.readHistory({
      taskId,
      topic: "conversation",
      limit: 10,
    });
    assert.equal(family.items.length, 3, "族名命中 conversation 族下全部会话话题");
    assert.ok(
      family.items.every((item) => item.topic.startsWith("conversation")),
      "不混入其它族（sessions-index）的记录",
    );

    const exact = await handle.storage.storage.projections.readHistory({
      taskId,
      topic: "conversation/sess-a",
      limit: 10,
    });
    assert.equal(exact.items.length, 2, "完整话题仍精确匹配本话题");
    assert.ok(exact.items.every((item) => item.topic === "conversation/sess-a"));

    const missing = await handle.storage.storage.projections.readHistory({
      taskId,
      topic: "conversation/sess-zzz",
      limit: 10,
    });
    assert.deepEqual(missing.items, []);
  });
});

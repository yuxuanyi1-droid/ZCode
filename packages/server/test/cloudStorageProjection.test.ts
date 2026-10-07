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

/**
 * external operation outbox 验收（03 §5、01 §5.3、CP-04 持久侧）。
 *
 * 断言：operationId 是幂等键、同 key 不产生第二个 operation；租约同一时刻只有一个
 * 有效持有者；迟到结果因 token 不匹配无法覆盖新结算；ambiguous 保留在 unsettled
 * 集合里等对账，而不是被当成 failed。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  newUuid,
  nextNow,
  openTestStorage,
  removeTestRoot,
  TEST_NOW,
} from "./cloudStorageHarness.js";
import { isCloudStorageError } from "../src/cloud/adapters/storage/cloudStorageError.js";

test("enqueue 幂等：同 idempotencyKey 返回同一 operation", async () => {
  const handle = await openTestStorage();
  try {
    const first = await handle.storage.operations.enqueue({
      operationId: newUuid(),
      kind: "create",
      idempotencyKey: "create:run-1",
      taskId: newUuid(),
      runId: newUuid(),
      runGeneration: 1,
      now: TEST_NOW,
    });
    const replay = await handle.storage.operations.enqueue({
      operationId: newUuid(),
      kind: "create",
      idempotencyKey: "create:run-1",
      now: nextNow(1),
    });
    assert.equal(replay.operationId, first.operationId, "同业务键不得产生第二条 create 意图");
    assert.equal(replay.state, "pending");

    const byKey = await handle.storage.operations.findByKey("create:run-1");
    assert.equal(byKey?.operationId, first.operationId);
    assert.equal((await handle.storage.operations.get(first.operationId))?.attempt, 0);

    await assert.rejects(
      handle.storage.operations.enqueue({
        operationId: first.operationId,
        kind: "terminate",
        idempotencyKey: "terminate:run-1",
        now: nextNow(2),
      }),
      (error: unknown) => isCloudStorageError(error) && error.reason === "invalid-record",
    );
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("租约独占、迟到结算被拒、到期后可重新领取", async () => {
  const handle = await openTestStorage();
  try {
    const enqueued = await handle.storage.operations.enqueue({
      operationId: newUuid(),
      kind: "create",
      idempotencyKey: "create:run-2",
      now: TEST_NOW,
    });

    const lease = await handle.storage.operations.leaseNext({
      kinds: ["create"],
      workerId: "worker-a",
      leaseMs: 10_000,
      now: nextNow(1),
    });
    assert.equal(lease?.operation.operationId, enqueued.operationId);
    assert.equal(lease?.operation.state, "leased");
    assert.equal(lease?.operation.attempt, 1);

    const second = await handle.storage.operations.leaseNext({
      kinds: ["create"],
      workerId: "worker-b",
      leaseMs: 10_000,
      now: nextNow(2),
    });
    assert.equal(second, null, "租约未到期时不得有第二个持有者");

    const late = await handle.storage.operations.settle({
      operationId: enqueued.operationId,
      leaseToken: "stale-token",
      outcome: "settled",
      now: nextNow(3),
    });
    assert.equal(late, false, "token 不匹配的迟到结果不得覆盖结算");
    assert.equal((await handle.storage.operations.get(enqueued.operationId))?.state, "leased");

    const settled = await handle.storage.operations.settle({
      operationId: enqueued.operationId,
      leaseToken: lease?.leaseToken as string,
      outcome: "settled",
      resultRef: "daytona:sandbox-1",
      now: nextNow(4),
    });
    assert.equal(settled, true);
    const record = await handle.storage.operations.get(enqueued.operationId);
    assert.equal(record?.state, "settled");
    assert.equal(record?.resultRef, "daytona:sandbox-1");
    assert.deepEqual(await handle.storage.operations.listUnsettled(), []);
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("租约到期后重领同一个 operation，attempt 递增且 id 不变", async () => {
  const handle = await openTestStorage();
  try {
    const enqueued = await handle.storage.operations.enqueue({
      operationId: newUuid(),
      kind: "create",
      idempotencyKey: "create:run-3",
      now: TEST_NOW,
    });
    const firstLease = await handle.storage.operations.leaseNext({
      kinds: ["create"],
      workerId: "worker-a",
      leaseMs: 1_000,
      now: nextNow(1),
    });
    // worker 崩溃：租约到期，另一个 worker 用同一 operationId 重试（03 §5）。
    const secondLease = await handle.storage.operations.leaseNext({
      kinds: ["create"],
      workerId: "worker-b",
      leaseMs: 1_000,
      now: nextNow(5_000),
    });
    assert.equal(secondLease?.operation.operationId, enqueued.operationId);
    assert.equal(secondLease?.operation.attempt, 2);
    assert.notEqual(secondLease?.leaseToken, firstLease?.leaseToken);
    assert.equal(
      await handle.storage.operations.settle({
        operationId: enqueued.operationId,
        leaseToken: firstLease?.leaseToken as string,
        outcome: "settled",
        now: nextNow(5_001),
      }),
      false,
    );
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("ambiguous 保留待对账，可重新领取后定案", async () => {
  const handle = await openTestStorage();
  try {
    const enqueued = await handle.storage.operations.enqueue({
      operationId: newUuid(),
      kind: "create",
      idempotencyKey: "create:run-4",
      now: TEST_NOW,
    });
    const lease = await handle.storage.operations.leaseNext({
      kinds: ["create"],
      workerId: "worker-a",
      leaseMs: 1_000,
      now: nextNow(1),
    });
    const marked = await handle.storage.operations.settle({
      operationId: enqueued.operationId,
      leaseToken: lease?.leaseToken as string,
      outcome: "ambiguous",
      errorCode: "provider_create_unknown",
      now: nextNow(2),
    });
    assert.equal(marked, true);
    const ambiguous = await handle.storage.operations.get(enqueued.operationId);
    assert.equal(ambiguous?.state, "ambiguous", "网络超时不得写成 failed（03 §5）");
    const unsettled = await handle.storage.operations.listUnsettled();
    assert.equal(unsettled.length, 1);

    // 启动对账（03 §8）：租约到期后重新领取同一 operation 并查 provider 事实定案。
    const recoveryLease = await handle.storage.operations.leaseNext({
      kinds: ["create"],
      workerId: "reconciler",
      leaseMs: 1_000,
      now: nextNow(10_000),
    });
    assert.equal(recoveryLease?.operation.operationId, enqueued.operationId);
    assert.equal(recoveryLease?.operation.attempt, 2);
    assert.equal(
      await handle.storage.operations.settle({
        operationId: enqueued.operationId,
        leaseToken: recoveryLease?.leaseToken as string,
        outcome: "settled",
        resultRef: "daytona:sandbox-4",
        now: nextNow(10_001),
      }),
      true,
    );
    assert.equal((await handle.storage.operations.get(enqueued.operationId))?.state, "settled");
    assert.deepEqual(await handle.storage.operations.listUnsettled(), []);
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

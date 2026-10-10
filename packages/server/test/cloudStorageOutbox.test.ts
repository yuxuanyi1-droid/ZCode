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

test("renewLease：持有人 CAS 续租，续期窗口内不产生第二个租约（C-3）", async () => {
  const handle = await openTestStorage();
  try {
    const enqueued = await handle.storage.operations.enqueue({
      operationId: newUuid(),
      kind: "create",
      idempotencyKey: "create:renew-1",
      now: TEST_NOW,
    });
    const lease = await handle.storage.operations.leaseNext({
      kinds: ["create"],
      workerId: "worker-a",
      leaseMs: 1_000,
      now: nextNow(1),
    });
    assert.ok(lease);
    // 错误令牌不得续租（迟到 worker 不能接管持有人的租约）。
    assert.equal(
      await handle.storage.operations.renewLease({
        operationId: enqueued.operationId,
        leaseToken: "stale-token",
        leaseMs: 1_000,
        now: nextNow(500),
      }),
      false,
    );
    // 持有人续租：到期时间被推走（create 60s+ 不被二次租约的关键语义）。
    assert.equal(
      await handle.storage.operations.renewLease({
        operationId: enqueued.operationId,
        leaseToken: lease?.leaseToken ?? "",
        leaseMs: 1_000,
        now: nextNow(500),
      }),
      true,
    );
    // 原到期点 nextNow(1)+1000 已过，但租约被续到 nextNow(1500)：第二个 worker 领不到。
    const second = await handle.storage.operations.leaseNext({
      kinds: ["create"],
      workerId: "worker-b",
      leaseMs: 1_000,
      now: nextNow(1_100),
    });
    assert.equal(second, null, "续期后的租约窗口内不得有第二个持有者");
    // 已结算的 operation 不可续租。
    await handle.storage.operations.settle({
      operationId: enqueued.operationId,
      leaseToken: lease?.leaseToken ?? "",
      outcome: "settled",
      now: nextNow(1_200),
    });
    assert.equal(
      await handle.storage.operations.renewLease({
        operationId: enqueued.operationId,
        leaseToken: lease?.leaseToken ?? "",
        leaseMs: 1_000,
        now: nextNow(1_300),
      }),
      false,
      "已结算的 operation 不可续租",
    );
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("leaseNext 分相过滤：operationIds 白名单与 excludeOperationIds 排除（C-4）", async () => {
  const handle = await openTestStorage();
  try {
    // a 更早创建（FIFO 头部），b 更晚；白名单应能越过 FIFO 直取 b。
    const a = await handle.storage.operations.enqueue({
      operationId: newUuid(),
      kind: "checkpoint",
      idempotencyKey: "checkpoint:phase-a",
      now: TEST_NOW,
    });
    const b = await handle.storage.operations.enqueue({
      operationId: newUuid(),
      kind: "checkpoint",
      idempotencyKey: "checkpoint:phase-b",
      now: nextNow(1),
    });
    const onlyB = await handle.storage.operations.leaseNext({
      kinds: ["checkpoint"],
      workerId: "stop-sweep",
      leaseMs: 1_000,
      now: nextNow(2),
      operationIds: [b.operationId],
    });
    assert.equal(onlyB?.operation.operationId, b.operationId, "白名单越过 FIFO 取到目标 op");

    // 空白名单：无候选。
    assert.equal(
      await handle.storage.operations.leaseNext({
        kinds: ["checkpoint"],
        workerId: "stop-sweep",
        leaseMs: 1_000,
        now: nextNow(3),
        operationIds: [],
      }),
      null,
    );

    // 排除被停止关联的 op：b 已被租约持有，剩余候选只有 a；排除 a 后无候选。
    const excluded = await handle.storage.operations.leaseNext({
      kinds: ["checkpoint"],
      workerId: "periodic-sweep",
      leaseMs: 1_000,
      now: nextNow(4),
      excludeOperationIds: [a.operationId, b.operationId],
    });
    assert.equal(excluded, null, "排除后不得领取被停止关联的 op");
    const afterA = await handle.storage.operations.leaseNext({
      kinds: ["checkpoint"],
      workerId: "periodic-sweep",
      leaseMs: 1_000,
      now: nextNow(5),
      excludeOperationIds: [b.operationId],
    });
    assert.equal(afterA?.operation.operationId, a.operationId, "排除 b 后正常领取 a");
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

test("requeueFailed：仅 failed → pending 的 CAS，attempt/错误码保持（08 §8.1 修订）", async () => {
  const handle = await openTestStorage();
  try {
    const enqueued = await handle.storage.operations.enqueue({
      operationId: newUuid(),
      kind: "terminate",
      idempotencyKey: "terminate:run-5",
      now: TEST_NOW,
    });

    // 非 failed 状态不可重排队：pending。
    assert.equal(
      await handle.storage.operations.requeueFailed({
        operationId: enqueued.operationId,
        now: nextNow(1),
      }),
      false,
      "pending 不是重排队对象",
    );

    // failed → pending：重排队成功，attempt 保持（退避与封顶按 attempt 判定）。
    const lease = await handle.storage.operations.leaseNext({
      kinds: ["terminate"],
      workerId: "worker-a",
      leaseMs: 1_000,
      now: nextNow(1),
    });
    assert.equal(lease?.operation.attempt, 1);
    assert.equal(
      await handle.storage.operations.settle({
        operationId: enqueued.operationId,
        leaseToken: lease?.leaseToken as string,
        outcome: "failed",
        errorCode: "provider_unreachable",
        now: nextNow(2),
      }),
      true,
    );
    assert.equal(
      await handle.storage.operations.requeueFailed({
        operationId: enqueued.operationId,
        now: nextNow(3),
      }),
      true,
    );
    const requeued = await handle.storage.operations.get(enqueued.operationId);
    assert.equal(requeued?.state, "pending");
    assert.equal(requeued?.attempt, 1, "attempt 不清零");
    assert.equal(requeued?.errorCode, "provider_unreachable", "最后一次失败证据保留可查");
    assert.equal(requeued?.leaseExpiresAt, undefined, "租约字段清空");

    // ambiguous/settled 不可重排队（ambiguous 归对账、settled 是已确认事实）。
    const secondLease = await handle.storage.operations.leaseNext({
      kinds: ["terminate"],
      workerId: "worker-b",
      leaseMs: 1_000,
      now: nextNow(4),
    });
    assert.equal(secondLease?.operation.attempt, 2, "重排队后由租约重领（attempt 递增）");
    assert.equal(
      await handle.storage.operations.settle({
        operationId: enqueued.operationId,
        leaseToken: secondLease?.leaseToken as string,
        outcome: "ambiguous",
        now: nextNow(5),
      }),
      true,
    );
    assert.equal(
      await handle.storage.operations.requeueFailed({
        operationId: enqueued.operationId,
        now: nextNow(6),
      }),
      false,
      "ambiguous 归对账通路，不走失败重排队",
    );
    assert.equal((await handle.storage.operations.get(enqueued.operationId))?.state, "ambiguous");
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

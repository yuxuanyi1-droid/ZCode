/**
 * GitHub effect 分面验收（09 §5.2 外部幂等 effect、§8 行、03 §5；`GitHubEffectStore` 端口）。
 *
 * 断言：业务键唯一（重复入队返回既有 effect）、desiredRevision 单调推进、租约独占、
 * 结算必须带 leaseToken、retry 退避与 ambiguous 对账都在同一条 pending/leased/
 * ambiguous 状态机上；provider 操作与 effect 两个分面的恢复扫描互不串台。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { GitHubEffectEnqueueRequest } from "../src/cloud/app/ports/gitHubEffectPort.js";
import { draftPullRequestBusinessKey } from "../src/cloud/app/ports/gitHubEffectPort.js";
import { isCloudStorageError } from "../src/cloud/adapters/storage/cloudStorageError.js";
import {
  fakeGitSha,
  newUuid,
  nextNow,
  openTestStorage,
  removeTestRoot,
  seedActiveRun,
  seedDraftTask,
  TEST_NOW,
  type TestStorageHandle,
} from "./cloudStorageHarness.js";

async function withRun(
  body: (context: { handle: TestStorageHandle; taskId: string; runId: string }) => Promise<void>,
): Promise<void> {
  const handle = await openTestStorage();
  try {
    const seeded = await seedDraftTask(handle.storage);
    const run = await seedActiveRun(handle.storage, seeded);
    await body({ handle, taskId: seeded.taskId, runId: run.runId });
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
}

function pullRequestRequest(
  context: { taskId: string; runId: string },
  overrides: Partial<GitHubEffectEnqueueRequest> = {},
): GitHubEffectEnqueueRequest {
  const taskBranch = "cloud/work-1";
  return {
    effectId: newUuid(),
    kind: "pull-request",
    businessKey: draftPullRequestBusinessKey({
      repositoryId: 42,
      taskId: context.taskId,
      taskBranch,
    }),
    taskId: context.taskId,
    runId: context.runId,
    runGeneration: 1,
    repositoryId: 42,
    taskBranch,
    baseBranch: "main",
    desiredRevision: 1,
    expectedHeadSha: fakeGitSha("head"),
    payloadRef: "checkpoint:1",
    now: TEST_NOW,
    ...overrides,
  };
}

test("业务键唯一：重复入队返回既有 effect，不产生第二个 worker 目标", async () => {
  await withRun(async (context) => {
    const request = pullRequestRequest(context);
    const first = await context.handle.storage.effects.enqueue(request);
    assert.equal(first.created, true);
    assert.equal(first.effect.status, "pending");
    assert.equal(first.effect.desiredRevision, 1);
    assert.equal(first.effect.expectedHeadSha, fakeGitSha("head"));

    const replay = await context.handle.storage.effects.enqueue({
      ...pullRequestRequest(context, { effectId: newUuid(), desiredRevision: 4 }),
      businessKey: request.businessKey,
    });
    assert.equal(replay.created, false);
    assert.equal(replay.effect.effectId, first.effect.effectId);
    assert.equal(replay.effect.desiredRevision, 4, "desiredRevision 单调推进");

    const regression = await context.handle.storage.effects.enqueue({
      ...pullRequestRequest(context, { desiredRevision: 2 }),
      businessKey: request.businessKey,
    });
    assert.equal(regression.effect.desiredRevision, 4, "低版本不得回退期望版本");

    await assert.rejects(
      context.handle.storage.effects.enqueue({
        ...pullRequestRequest(context, { kind: "comment" }),
        businessKey: request.businessKey,
      }),
      (error: unknown) => isCloudStorageError(error) && error.code === "validation_failed",
    );
    assert.equal(await context.handle.storage.effects.get(newUuid()), null);
  });
});

test("租约独占、settle 必须带 token、retry 退避后才可再领", async () => {
  await withRun(async (context) => {
    const { effect } = await context.handle.storage.effects.enqueue(pullRequestRequest(context));
    const kinds = ["pull-request", "check", "comment", "token-revoke"] as const;

    assert.equal(
      await context.handle.storage.effects.leaseNext({
        kinds,
        workerId: "w-a",
        leaseMs: 5_000,
        now: nextNow(-60_000),
      }),
      null,
      "nextAttemptAt 未到不得领取",
    );

    const lease = await context.handle.storage.effects.leaseNext({
      kinds,
      workerId: "w-a",
      leaseMs: 5_000,
      now: nextNow(1),
    });
    assert.equal(lease?.effect.effectId, effect.effectId);
    assert.equal(lease?.effect.status, "leased");
    assert.equal(lease?.effect.attempts, 1);
    assert.equal(
      await context.handle.storage.effects.leaseNext({
        kinds,
        workerId: "w-b",
        leaseMs: 5_000,
        now: nextNow(2),
      }),
      null,
      "同一 effect 不会有两个有效租约",
    );
    assert.equal(
      await context.handle.storage.effects.settle({
        effectId: effect.effectId,
        leaseToken: "stale",
        outcome: "settled",
        now: nextNow(3),
      }),
      false,
      "迟到 worker 的结算不得覆盖",
    );
    assert.equal(
      await context.handle.storage.effects.settle({
        effectId: effect.effectId,
        leaseToken: lease?.leaseToken as string,
        outcome: "retry",
        errorCode: "rate_limited",
        errorMessage: "github 限流",
        nextAttemptAt: nextNow(10_000),
        now: nextNow(4),
      }),
      true,
    );
    const retried = await context.handle.storage.effects.get(effect.effectId);
    assert.equal(retried?.status, "pending");
    assert.equal(retried?.nextAttemptAt, nextNow(10_000));
    assert.equal(retried?.lastErrorCode, "rate_limited");
    assert.equal(
      await context.handle.storage.effects.leaseNext({
        kinds,
        workerId: "w-b",
        leaseMs: 5_000,
        now: nextNow(5),
      }),
      null,
      "退避窗口内不得领取",
    );
    assert.ok(
      await context.handle.storage.effects.leaseNext({
        kinds,
        workerId: "w-b",
        leaseMs: 5_000,
        now: nextNow(10_001),
      }),
    );
  });
});

test("ambiguous 保留待对账，租约到期后可重新领取并定案", async () => {
  await withRun(async (context) => {
    const { effect } = await context.handle.storage.effects.enqueue(pullRequestRequest(context));
    const kinds = ["pull-request"] as const;
    const lease = await context.handle.storage.effects.leaseNext({
      kinds,
      workerId: "w-a",
      leaseMs: 1_000,
      now: nextNow(1),
    });
    await context.handle.storage.effects.settle({
      effectId: effect.effectId,
      leaseToken: lease?.leaseToken as string,
      outcome: "ambiguous",
      errorCode: "network_unknown",
      now: nextNow(2),
    });
    const unsettled = await context.handle.storage.effects.listUnsettled();
    assert.equal(unsettled.length, 1);
    assert.equal(unsettled[0]?.status, "ambiguous", "结果未知不得写成 failed");

    // 端口约定（gitHubEffectPort.leaseNext）：`ambiguous` 是**立刻可重领**的对账入口，
    // 只受 nextAttemptAt 约束——与 provider 分面（要求租约到期）不同，这里按冻结文本实现，
    // 避免结果未知的 effect 被搁置到租约过期。并发安全仍由「单租约 CAS」保证。
    const recovery = await context.handle.storage.effects.leaseNext({
      kinds,
      workerId: "reconciler",
      leaseMs: 1_000,
      now: nextNow(3),
    });
    assert.equal(recovery?.effect.effectId, effect.effectId);
    assert.equal(recovery?.effect.attempts, 2);
    assert.equal(
      await context.handle.storage.effects.leaseNext({
        kinds,
        workerId: "w-c",
        leaseMs: 1_000,
        now: nextNow(4),
      }),
      null,
      "重领后仍然只有一个有效租约",
    );
    assert.equal(
      await context.handle.storage.effects.settle({
        effectId: effect.effectId,
        leaseToken: recovery?.leaseToken as string,
        outcome: "settled",
        remoteId: "pr-77",
        resultRef: "draft-pr",
        now: nextNow(5),
      }),
      true,
    );
    const settled = await context.handle.storage.effects.get(effect.effectId);
    assert.equal(settled?.status, "settled");
    assert.equal(settled?.remoteId, "pr-77");
    assert.deepEqual(await context.handle.storage.effects.listUnsettled(), []);
  });
});

test("provider 操作与 effect 两个分面互不串台", async () => {
  await withRun(async (context) => {
    await context.handle.storage.operations.enqueue({
      operationId: newUuid(),
      kind: "create",
      idempotencyKey: `create:${context.runId}`,
      taskId: context.taskId,
      runId: context.runId,
      runGeneration: 1,
      now: TEST_NOW,
    });
    await context.handle.storage.effects.enqueue(pullRequestRequest(context));

    const effects = await context.handle.storage.effects.listUnsettled();
    assert.equal(effects.length, 1);
    assert.equal(effects[0]?.kind, "pull-request");

    const operations = await context.handle.storage.operations.listUnsettled();
    assert.equal(operations.length, 1, "provider 恢复扫描不得领走 GitHub effect");
    assert.equal(operations[0]?.kind, "create");

    // 领取入口按 kind 白名单收窄：provider 的 create 意图不会被 effect 领取。
    const leased = await context.handle.storage.effects.leaseNext({
      kinds: ["pull-request"],
      workerId: "w",
      leaseMs: 1_000,
      now: nextNow(1),
    });
    assert.equal(leased?.effect.kind, "pull-request");
  });
});

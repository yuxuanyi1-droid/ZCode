/**
 * 接纳事务验收（W2 §6、03 §5/§6.1、08 §5、CP-03）。
 *
 * 断言：一个 commandId 只产生一个输入/一个 run 意图；合法重放返回原 receipt；同 key
 * 不同 payload 冲突；start/append/reopen 的前置条件各自显式失败；附件引用必须同事务
 * 校验；失败路径不留下半个事实。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  fakeGitSha,
  fakeSha256,
  newUuid,
  nextNow,
  openTestStorage,
  removeTestRoot,
  seedDraftTask,
  TEST_NOW,
  type SeededTask,
  type TestStorageHandle,
} from "./cloudStorageHarness.js";
import type { InputReceipt } from "@zcode/shared";
import { isCloudStorageError } from "../src/cloud/adapters/storage/cloudStorageError.js";
import type { AcceptInputRequest } from "../src/cloud/app/ports/storagePort.js";

async function withStorage(run: (handle: TestStorageHandle) => Promise<void>): Promise<void> {
  const handle = await openTestStorage();
  try {
    await run(handle);
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
}

function startRequest(
  taskId: string,
  overrides: Partial<AcceptInputRequest> = {},
): AcceptInputRequest {
  return {
    taskId,
    commandId: newUuid(),
    intent: "start",
    payloadHash: fakeSha256("p1"),
    prompt: "实现功能 A",
    expectedTaskRevision: 0,
    start: { baseBranch: "main", provider: "daytona" },
    runRecipe: {
      provider: "daytona",
      resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
      firstCommandConfig: {},
      baseSha: fakeGitSha("base1"),
    },
    taskBranch: "cloud/work-1",
    createOperationId: newUuid(),
    quota: { maxConcurrentRuns: 3 },
    now: nextNow(1),
    ...overrides,
  };
}

interface AcceptedResult {
  receipt: InputReceipt;
  runId?: string;
  runGeneration?: number;
}

async function startFirstRun(
  handle: TestStorageHandle,
  seeded: SeededTask,
  overrides: Partial<AcceptInputRequest> = {},
): Promise<AcceptedResult> {
  const result = await handle.storage.storage.acceptInput(startRequest(seeded.taskId, overrides));
  assert.equal(result.status, "accepted");
  if (result.status !== "accepted") throw new Error("unreachable");
  return result;
}

test("start 在单事务内固定输入、run、create 意图与冻结基线", async () => {
  await withStorage(async (handle) => {
    const seeded = await seedDraftTask(handle.storage);
    const request = startRequest(seeded.taskId);
    const accepted = await startFirstRun(handle, seeded, request);

    assert.equal(accepted.receipt.taskId, seeded.taskId);
    assert.equal(accepted.receipt.commandId, request.commandId);
    assert.equal(accepted.receipt.deliveryStatus, "accepted");
    assert.equal(accepted.runGeneration, 1);
    assert.equal(accepted.receipt.runId, accepted.runId);

    const task = await handle.storage.storage.tasks.get(seeded.taskId);
    assert.equal(task?.status, "active");
    assert.equal(task?.activeRunId, accepted.runId);
    assert.equal(task?.baseSha, fakeGitSha("base1"));
    assert.equal(task?.baseBranch, "main", "baseBranch 取自草稿配置（11 §6）");
    assert.equal(task?.taskBranch, "cloud/work-1");

    const inputs = await handle.storage.storage.inputs.list(seeded.taskId, { limit: 10 });
    assert.equal(inputs.items.length, 1);
    assert.equal(inputs.items[0]?.acceptanceSeq, 1);
    assert.equal(inputs.items[0]?.deliveryStatus, "accepted");
    assert.equal(inputs.items[0]?.targetRunId, accepted.runId);

    const unsettled = await handle.storage.operations.listUnsettled();
    assert.equal(unsettled.length, 1);
    assert.equal(unsettled[0]?.state, "pending");

    const payload = await handle.storage.storage.payloads.readInputPayload({
      taskId: seeded.taskId,
      commandId: request.commandId,
    });
    assert.equal(payload?.prompt, "实现功能 A");
  });
});

test("合法重放返回原 receipt，同 key 不同 payload 冲突（CP-03）", async () => {
  await withStorage(async (handle) => {
    const seeded = await seedDraftTask(handle.storage);
    const request = startRequest(seeded.taskId);
    const accepted = await startFirstRun(handle, seeded, request);

    const replay = await handle.storage.storage.acceptInput({ ...request, now: nextNow(10) });
    assert.equal(replay.status, "duplicate");
    if (replay.status !== "duplicate") throw new Error("unreachable");
    assert.deepEqual(replay.receipt, accepted.receipt);

    // 重放不得新增行或第二个 create 意图。
    const inputs = await handle.storage.storage.inputs.list(seeded.taskId, { limit: 10 });
    assert.equal(inputs.items.length, 1);
    assert.equal((await handle.storage.operations.listUnsettled()).length, 1);

    const mismatch = await handle.storage.storage.acceptInput({
      ...request,
      payloadHash: fakeSha256("p2"),
      now: nextNow(11),
    });
    assert.equal(mismatch.status, "conflict");
    if (mismatch.status !== "conflict") throw new Error("unreachable");
    assert.equal(mismatch.code, "idempotency_conflict");
    assert.equal(mismatch.reason, "payload-mismatch");

    // 已接受输入的重放不受任务 revision 增长影响（03 §6.1 尾段）。
    await handle.storage.storage.tasks.patchMetadata({
      taskId: seeded.taskId,
      expectedRevision: 1,
      title: "改名",
      now: nextNow(12),
    });
    const replayAfterPatch = await handle.storage.storage.acceptInput({
      ...request,
      now: nextNow(13),
    });
    assert.equal(replayAfterPatch.status, "duplicate");
  });
});

test("start 的前置条件冲突各自显式失败", async () => {
  await withStorage(async (handle) => {
    const seeded = await seedDraftTask(handle.storage);
    await startFirstRun(handle, seeded);

    const startOnActive = await handle.storage.storage.acceptInput(startRequest(seeded.taskId));
    assert.equal(startOnActive.status, "conflict");
    if (startOnActive.status !== "conflict") throw new Error("unreachable");
    assert.equal(startOnActive.reason, "start-on-active");

    const other = await seedDraftTask(handle.storage, { repositoryId: 7 });
    const revisionMismatch = await handle.storage.storage.acceptInput(
      startRequest(other.taskId, { expectedTaskRevision: 5 }),
    );
    assert.equal(revisionMismatch.status, "conflict");
    if (revisionMismatch.status !== "conflict") throw new Error("unreachable");
    assert.equal(revisionMismatch.reason, "revision-mismatch");
    assert.equal(revisionMismatch.code, "stale");

    await assert.rejects(
      handle.storage.storage.acceptInput({
        taskId: newUuid(),
        commandId: newUuid(),
        intent: "start",
        payloadHash: fakeSha256("p3"),
        prompt: "x",
        runRecipe: {
          provider: "daytona",
          resources: { cpu: 1, memoryMiB: 512, diskGiB: 1 },
          firstCommandConfig: {},
          baseSha: fakeGitSha("b"),
        },
        createOperationId: newUuid(),
        quota: { maxConcurrentRuns: 3 },
        now: TEST_NOW,
      }),
      (error: unknown) => isCloudStorageError(error) && error.code === "not_found",
    );
  });
});

test("append 绑定当前 ready run 与 generation，不产生第二个 create 意图", async () => {
  await withStorage(async (handle) => {
    const seeded = await seedDraftTask(handle.storage);
    const accepted = await startFirstRun(handle, seeded);
    const runId = accepted.runId as string;

    const notReady = await handle.storage.storage.acceptInput({
      taskId: seeded.taskId,
      commandId: newUuid(),
      intent: "append",
      payloadHash: fakeSha256("a1"),
      prompt: "继续",
      expectedRunGeneration: 1,
      quota: { maxConcurrentRuns: 3 },
      now: nextNow(20),
    });
    assert.equal(notReady.status, "conflict");
    if (notReady.status !== "conflict") throw new Error("unreachable");
    assert.equal(notReady.reason, "not-ready");
    assert.equal(notReady.code, "not_ready");

    await handle.storage.storage.runs.transitionStatus({
      runId,
      runGeneration: 1,
      from: ["provisioning"],
      to: "ready",
      now: nextNow(21),
    });

    const staleGeneration = await handle.storage.storage.acceptInput({
      taskId: seeded.taskId,
      commandId: newUuid(),
      intent: "append",
      payloadHash: fakeSha256("a2"),
      prompt: "继续",
      expectedRunGeneration: 9,
      quota: { maxConcurrentRuns: 3 },
      now: nextNow(22),
    });
    assert.equal(staleGeneration.status, "conflict");
    if (staleGeneration.status !== "conflict") throw new Error("unreachable");
    assert.equal(staleGeneration.reason, "generation-stale");

    const stopOperationId = newUuid();
    await handle.storage.storage.runs.requestStop({
      taskId: seeded.taskId,
      operationId: stopOperationId,
      now: nextNow(23),
    });
    const stopped = await handle.storage.storage.acceptInput({
      taskId: seeded.taskId,
      commandId: newUuid(),
      intent: "append",
      payloadHash: fakeSha256("a3"),
      prompt: "继续",
      expectedRunGeneration: 1,
      quota: { maxConcurrentRuns: 3 },
      now: nextNow(24),
    });
    assert.equal(stopped.status, "conflict");
    if (stopped.status !== "conflict") throw new Error("unreachable");
    assert.equal(stopped.reason, "stop-requested");

    await handle.storage.storage.runs.clearStopRequest({
      taskId: seeded.taskId,
      expectedOperationId: stopOperationId,
    });
    const append = await handle.storage.storage.acceptInput({
      taskId: seeded.taskId,
      commandId: newUuid(),
      intent: "append",
      payloadHash: fakeSha256("a4"),
      prompt: "继续工作",
      expectedRunGeneration: 1,
      resolvedExecutionConfig: { planEnabled: true },
      quota: { maxConcurrentRuns: 3 },
      now: nextNow(25),
    });
    assert.equal(append.status, "accepted");
    if (append.status !== "accepted") throw new Error("unreachable");
    assert.equal(append.runId, runId);
    assert.equal(append.runGeneration, 1);
    assert.equal(append.receipt.runId, runId, "append 的 receipt 必须给出同一 run 关联（03 §6.2）");

    const inputs = await handle.storage.storage.inputs.list(seeded.taskId, { limit: 10 });
    assert.equal(inputs.items.length, 2);
    assert.equal(inputs.items[1]?.acceptanceSeq, 2);
    assert.equal(inputs.items[1]?.targetRunId, runId);
    assert.equal(inputs.items[1]?.resolvedExecutionConfig?.planEnabled, true);
    // append 不新增 create 意图：全局仍然只有一个 operation。
    assert.equal((await handle.storage.operations.listUnsettled()).length, 1);
  });
});

test("reopen 要求旧 run 已终态，新 run 代际递增", async () => {
  await withStorage(async (handle) => {
    const seeded = await seedDraftTask(handle.storage);
    const accepted = await startFirstRun(handle, seeded);
    const firstRunId = accepted.runId as string;

    const blocked = await handle.storage.storage.acceptInput({
      taskId: seeded.taskId,
      commandId: newUuid(),
      intent: "reopen",
      payloadHash: fakeSha256("r1"),
      prompt: "重开",
      runRecipe: {
        provider: "daytona",
        resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
        firstCommandConfig: {},
        baseSha: fakeGitSha("base1"),
        resumeSha: fakeGitSha("resume"),
      },
      createOperationId: newUuid(),
      quota: { maxConcurrentRuns: 3 },
      now: nextNow(30),
    });
    assert.equal(blocked.status, "conflict");
    if (blocked.status !== "conflict") throw new Error("unreachable");
    assert.equal(blocked.reason, "start-on-active");
    assert.equal(
      blocked.code,
      "recovery_required",
      "旧写权处置未确认时必须拒绝自动重开（02 §2 不变量 5）",
    );

    await handle.storage.storage.runs.transitionStatus({
      runId: firstRunId,
      runGeneration: 1,
      from: ["provisioning"],
      to: "stopped",
      endReason: "user-stop",
      now: nextNow(31),
    });
    await handle.storage.storage.runs.releaseQuota({
      runId: firstRunId,
      reason: "provider-terminated",
      now: nextNow(32),
    });

    const reopened = await handle.storage.storage.acceptInput({
      taskId: seeded.taskId,
      commandId: newUuid(),
      intent: "reopen",
      payloadHash: fakeSha256("r2"),
      prompt: "重开",
      runRecipe: {
        provider: "daytona",
        resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
        firstCommandConfig: {},
        baseSha: fakeGitSha("base1"),
        resumeSha: fakeGitSha("resume"),
      },
      createOperationId: newUuid(),
      quota: { maxConcurrentRuns: 3 },
      now: nextNow(33),
    });
    assert.equal(reopened.status, "accepted");
    if (reopened.status !== "accepted") throw new Error("unreachable");
    assert.notEqual(reopened.runId, firstRunId);
    assert.equal(reopened.runGeneration, 2);
    const secondRun = await handle.storage.storage.runs.get(reopened.runId as string);
    assert.equal(secondRun?.executionRecipe?.resumeSha, fakeGitSha("resume"));
  });
});

test("附件引用必须同事务校验为已发布的 owner 对象", async () => {
  await withStorage(async (handle) => {
    const seeded = await seedDraftTask(handle.storage);
    const uploaded = await handle.storage.attachments.upload({
      ownerPrincipalId: seeded.principalId,
      fileName: "notes.txt",
      mime: "text/plain",
      body: new TextEncoder().encode("附件正文"),
      now: nextNow(40),
    });
    assert.equal(uploaded.state, "published");

    await assert.rejects(
      handle.storage.storage.acceptInput(
        startRequest(seeded.taskId, { attachmentIds: [fakeSha256("missing")] }),
      ),
      (error: unknown) => isCloudStorageError(error) && error.reason === "attachment-not-published",
    );

    const accepted = await startFirstRun(handle, seeded, {
      attachmentIds: [uploaded.attachmentId],
    });
    assert.ok(accepted.runId, "引用附件后必须建立 run");
    const stored = await handle.storage.attachments.get(seeded.principalId, uploaded.attachmentId);
    assert.equal(stored?.referencedAt, nextNow(1));
    assert.equal(stored?.lastReferencedTaskId, seeded.taskId);
  });
});

test("start 启动选择必须与持久草稿一致；无草稿时由首个 start 固定", async () => {
  await withStorage(async (handle) => {
    const seeded = await seedDraftTask(handle.storage);
    const mismatch = await handle.storage.storage.acceptInput(
      startRequest(seeded.taskId, { start: { baseBranch: "dev", provider: "daytona" } }),
    );
    assert.equal(mismatch.status, "conflict");
    if (mismatch.status !== "conflict") throw new Error("unreachable");
    assert.equal(mismatch.reason, "start-config-mismatch");
    assert.equal(mismatch.code, "stale");

    await assert.rejects(
      handle.storage.storage.acceptInput({
        ...startRequest(seeded.taskId),
        start: undefined,
      }),
      (error: unknown) => isCloudStorageError(error) && error.code === "validation_failed",
      "start 必须携带启动选择（迁移事务内校验，03 §6）",
    );

    // 无持久草稿配置的 draft：首个 start 的选择成为唯一冻结事实。
    const withoutDraft = await seedDraftTask(handle.storage, {
      repositoryId: 11,
      draftStartConfig: null,
    });
    const accepted = await handle.storage.storage.acceptInput(
      startRequest(withoutDraft.taskId, {
        start: { baseBranch: "release", provider: "daytona" },
      }),
    );
    assert.equal(accepted.status, "accepted");
    const task = await handle.storage.storage.tasks.get(withoutDraft.taskId);
    assert.equal(task?.draftStartConfig?.baseBranch, "release");
    assert.equal(task?.baseBranch, "release", "基线取自被采纳的启动选择（11 §6）");
  });
});

test("append 不得携带 create 意图（占位 id 会产生永不结算的假操作）", async () => {
  await withStorage(async (handle) => {
    const seeded = await seedDraftTask(handle.storage);
    const accepted = await startFirstRun(handle, seeded);
    const runId = accepted.runId as string;
    await handle.storage.storage.runs.transitionStatus({
      runId,
      runGeneration: 1,
      from: ["provisioning"],
      to: "ready",
      now: nextNow(70),
    });
    await assert.rejects(
      handle.storage.storage.acceptInput({
        taskId: seeded.taskId,
        commandId: newUuid(),
        intent: "append",
        payloadHash: fakeSha256("ap"),
        prompt: "继续",
        expectedRunGeneration: 1,
        createOperationId: newUuid(),
        quota: { maxConcurrentRuns: 3 },
        now: nextNow(71),
      }),
      (error: unknown) => isCloudStorageError(error) && error.code === "validation_failed",
    );
    assert.equal(
      (await handle.storage.storage.inputs.list(seeded.taskId, { limit: 10 })).items.length,
      1,
      "非法 append 不得写入第二份输入",
    );
  });
});

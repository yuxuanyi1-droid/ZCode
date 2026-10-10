/**
 * repository 集成验收（W2 §6）：事务、唯一约束与 CAS。
 *
 * 覆盖 03 §4 的关键约束：单有效写 run、task+acceptanceSeq、owner+commandId、
 * owner+creationKey、project 去重、metadata revision CAS，以及 08 §8.1 的停止屏障。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  fakeGitSha,
  fakeSha256,
  newUuid,
  openTestStorage,
  removeTestRoot,
  seedDraftTask,
  TEST_NOW,
} from "./cloudStorageHarness.js";
import type { TestStorageHandle } from "./cloudStorageHarness.js";
import { isCloudStorageError } from "../src/cloud/adapters/storage/cloudStorageError.js";

async function withStorage(run: (handle: TestStorageHandle) => Promise<void>): Promise<void> {
  const handle = await openTestStorage();
  try {
    await run(handle);
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
}

function startRequest(taskId: string, overrides: Record<string, unknown> = {}) {
  return {
    taskId,
    commandId: newUuid(),
    intent: "start" as const,
    payloadHash: fakeSha256("s"),
    prompt: "首条工作",
    expectedTaskRevision: 0,
    start: { baseBranch: "main", provider: "daytona" },
    runRecipe: {
      provider: "daytona",
      resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
      firstCommandConfig: {},
      baseSha: fakeGitSha("base"),
    },
    taskBranch: "cloud/task-1",
    createOperationId: newUuid(),
    quota: { maxConcurrentRuns: 3 },
    now: TEST_NOW + 1,
    ...overrides,
  };
}

test("project 与 task 的唯一约束承担去重", async () => {
  await withStorage(async ({ storage }) => {
    const principalId = newUuid();
    await storage.ensurePrincipal({ principalId, now: TEST_NOW });
    const first = await storage.storage.projects.createOrGet({
      projectId: newUuid(),
      ownerPrincipalId: principalId,
      kind: "github-repo",
      repositoryId: 99,
      installationId: 5,
      repoOwner: "zcode",
      repoName: "fixture",
      defaultBranch: "main",
      now: TEST_NOW,
    });
    const second = await storage.storage.projects.createOrGet({
      projectId: newUuid(),
      ownerPrincipalId: principalId,
      kind: "github-repo",
      repositoryId: 99,
      installationId: 5,
      repoOwner: "zcode",
      repoName: "fixture",
      now: TEST_NOW + 10,
    });
    assert.equal(second.projectId, first.projectId);
    assert.equal(second.revision, 0);

    const found = await storage.storage.projects.findByRepository(principalId, 99);
    assert.equal(found?.projectId, first.projectId);

    const taskId = newUuid();
    const create = {
      taskId,
      ownerPrincipalId: principalId,
      projectId: first.projectId,
      title: "task",
      creationKey: "ck-1",
      workspaceIdentity: `cloud-task:${taskId}`,
      now: TEST_NOW,
    };
    const task = await storage.storage.tasks.createDraft(create);
    // 响应丢失后的重试：同 taskId + 同 creationKey 必须返回既有 Task（11 §5）。
    const duplicateKey = await storage.storage.tasks.createDraft({ ...create, now: TEST_NOW + 5 });
    assert.equal(duplicateKey.taskId, task.taskId, "同 creationKey 必须返回既有 Task");
    const byKey = await storage.storage.tasks.findByCreationKey(principalId, "ck-1");
    assert.equal(byKey?.taskId, task.taskId);

    await assert.rejects(
      storage.storage.tasks.createDraft({ ...create, taskId: newUuid(), creationKey: "ck-2" }),
      (error: unknown) => isCloudStorageError(error) && error.reason === "invalid-record",
      "workspaceIdentity 与 taskId 不一致必须拒绝（08 §4.1）",
    );
  });
});

test("task metadata / 状态迁移都是 revision CAS", async () => {
  await withStorage(async ({ storage }) => {
    const seeded = await seedDraftTask(storage);
    const patched = await storage.storage.tasks.patchMetadata({
      taskId: seeded.taskId,
      expectedRevision: 0,
      title: "renamed",
      now: TEST_NOW + 1,
    });
    assert.equal(patched?.title, "renamed");
    assert.equal(patched?.revision, 1);

    const stale = await storage.storage.tasks.patchMetadata({
      taskId: seeded.taskId,
      expectedRevision: 0,
      title: "stale write",
      now: TEST_NOW + 2,
    });
    assert.equal(stale, null, "旧 revision 不得覆盖另一端写入");
    assert.equal((await storage.storage.tasks.get(seeded.taskId))?.title, "renamed");

    const transitioned = await storage.storage.tasks.transitionStatus({
      taskId: seeded.taskId,
      from: ["draft"],
      to: "active",
      revision: 2,
      now: TEST_NOW + 3,
    });
    assert.equal(transitioned?.status, "active");

    const wrongFrom = await storage.storage.tasks.transitionStatus({
      taskId: seeded.taskId,
      from: ["draft"],
      to: "archived",
      revision: 3,
      now: TEST_NOW + 4,
    });
    assert.equal(wrongFrom, null, "from 列表不匹配必须返回 null（08 §3.1）");

    const regressed = await storage.storage.tasks.transitionStatus({
      taskId: seeded.taskId,
      from: ["active"],
      to: "completed",
      revision: 2,
      now: TEST_NOW + 5,
    });
    assert.equal(regressed, null, "revision 未前进不得改写元数据");

    const draftConfigAfterActive = await storage.storage.tasks.patchMetadata({
      taskId: seeded.taskId,
      expectedRevision: 2,
      draftStartConfig: { baseBranch: "dev", provider: "e2b" },
      now: TEST_NOW + 6,
    });
    assert.equal(draftConfigAfterActive, null, "启动配置只在 draft 可改（11 §5）");
  });
});

test("单有效写 run：唯一约束与代际 CAS", async () => {
  await withStorage(async ({ storage }) => {
    const seeded = await seedDraftTask(storage);
    const first = await storage.storage.acceptInput(startRequest(seeded.taskId));
    assert.equal(first.status, "accepted");
    if (first.status !== "accepted") throw new Error("unreachable");
    const runId = first.runId as string;
    assert.ok(runId);

    const task = await storage.storage.tasks.get(seeded.taskId);
    assert.equal(task?.activeRunId, runId);
    assert.equal(task?.nextRunGeneration, 2);
    assert.equal(task?.status, "active");
    assert.equal(task?.baseSha, fakeGitSha("base"));
    assert.equal(task?.taskBranch, "cloud/task-1");

    const active = await storage.storage.runs.activeOfTask(seeded.taskId);
    assert.equal(active?.runId, runId);
    assert.equal(active?.runGeneration, 1);
    assert.equal(active?.connectionEpoch, 1);
    assert.equal(active?.firstInputCommandId, first.receipt.commandId);

    // 直接再分配：DB 层拒绝第二个有效写 run（08 §4.2）。
    await assert.rejects(
      storage.storage.runs.reserveRun({
        taskId: seeded.taskId,
        runId: newUuid(),
        executionRecipe: {
          provider: "daytona",
          resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
          firstCommandConfig: {},
        },
        quota: { maxConcurrentRuns: 3 },
        now: TEST_NOW + 2,
      }),
      (error: unknown) => isCloudStorageError(error) && error.reason === "active-write-run-exists",
    );

    // 旧代际不得改写：状态迁移、epoch、租期、handle 全部按 generation CAS。
    assert.equal(
      await storage.storage.runs.transitionStatus({
        runId,
        runGeneration: 2,
        from: ["provisioning"],
        to: "ready",
        now: TEST_NOW + 3,
      }),
      null,
    );
    assert.equal(
      await storage.storage.runs.bumpConnectionEpoch({ runId, runGeneration: 1, expectedEpoch: 5 }),
      null,
    );
    assert.equal(
      await storage.storage.runs.recordProviderHandle({
        runId,
        runGeneration: 2,
        provider: "daytona",
        providerHandle: "sb-2",
        now: TEST_NOW + 4,
      }),
      false,
    );

    const ready = await storage.storage.runs.transitionStatus({
      runId,
      runGeneration: 1,
      from: ["provisioning"],
      to: "ready",
      now: TEST_NOW + 5,
    });
    assert.equal(ready?.status, "ready");
    assert.equal(
      await storage.storage.runs.bumpConnectionEpoch({ runId, runGeneration: 1, expectedEpoch: 1 }),
      2,
    );
    assert.equal(
      await storage.storage.runs.bumpConnectionEpoch({ runId, runGeneration: 1, expectedEpoch: 1 }),
      null,
    );

    // 终态 run 不再接受新的连接接管，也不允许复活。
    const stopped = await storage.storage.runs.transitionStatus({
      runId,
      runGeneration: 1,
      from: ["ready"],
      to: "stopped",
      endReason: "user-stop",
      now: TEST_NOW + 6,
    });
    assert.equal(stopped?.status, "stopped");
    assert.equal(
      await storage.storage.runs.bumpConnectionEpoch({ runId, runGeneration: 1, expectedEpoch: 2 }),
      null,
    );
    assert.equal(
      await storage.storage.runs.transitionStatus({
        runId,
        runGeneration: 1,
        from: ["stopped"],
        to: "ready",
        now: TEST_NOW + 7,
      }),
      null,
      "终态 run 不可复活（08 §3.2）",
    );
    assert.equal(await storage.storage.runs.activeOfTask(seeded.taskId), null);
  });
});

test("配额按未释放的非终态 run 计数（01 §4.3）", async () => {
  await withStorage(async ({ storage }) => {
    const first = await seedDraftTask(storage, { repositoryId: 1 });
    const second = await seedDraftTask(storage, { repositoryId: 2 });
    const quota = { maxConcurrentRuns: 1 };
    const accepted = await storage.storage.acceptInput(startRequest(first.taskId, { quota }));
    assert.equal(accepted.status, "accepted");
    const secondTask = await storage.storage.tasks.get(second.taskId);
    const blocked = await storage.storage.acceptInput(
      startRequest(second.taskId, { quota, expectedTaskRevision: secondTask?.revision ?? 0 }),
    );
    assert.equal(blocked.status, "conflict");
    if (blocked.status !== "conflict") throw new Error("unreachable");
    assert.equal(blocked.reason, "quota-exceeded");
    assert.equal(blocked.code, "quota_exceeded");

    // 终态但不释放配额：仍然占槽（01 §4.3「终止结果未知的资源都占槽」）。
    const runId = accepted.status === "accepted" ? (accepted.runId as string) : "";
    await storage.storage.runs.transitionStatus({
      runId,
      runGeneration: 1,
      from: ["provisioning"],
      to: "failed",
      endReason: "bootstrap-failed",
      now: TEST_NOW + 10,
    });
    const stillBlocked = await storage.storage.acceptInput(
      startRequest(second.taskId, { quota, expectedTaskRevision: secondTask?.revision ?? 0 }),
    );
    assert.equal(stillBlocked.status, "conflict");

    await storage.storage.runs.releaseQuota({
      runId,
      reason: "provider-terminated",
      now: TEST_NOW + 11,
    });
    const released = await storage.storage.acceptInput(
      startRequest(second.taskId, { quota, expectedTaskRevision: secondTask?.revision ?? 0 }),
    );
    assert.equal(released.status, "accepted");
  });
});

test("停止屏障与撤销（08 §8.1）", async () => {
  await withStorage(async ({ storage }) => {
    const seeded = await seedDraftTask(storage);
    assert.equal(
      await storage.storage.runs.requestStop({
        taskId: seeded.taskId,
        operationId: newUuid(),
        now: TEST_NOW,
      }),
      false,
      "无有效 run 时不得伪造停止事实",
    );
    const accepted = await storage.storage.acceptInput(startRequest(seeded.taskId));
    if (accepted.status !== "accepted") throw new Error("unreachable");
    const runId = accepted.runId as string;
    const stopOperationId = newUuid();

    assert.equal(
      await storage.storage.runs.requestStop({
        taskId: seeded.taskId,
        operationId: stopOperationId,
        now: TEST_NOW + 1,
      }),
      true,
    );
    const stopped = await storage.storage.runs.get(runId);
    assert.equal(stopped?.stopRequested, true);
    assert.equal(stopped?.stopOperationId, stopOperationId);

    // 第二个 stop 请求不得改写依赖链上的 operationId。
    await storage.storage.runs.requestStop({
      taskId: seeded.taskId,
      operationId: newUuid(),
      now: TEST_NOW + 2,
    });
    assert.equal((await storage.storage.runs.get(runId))?.stopOperationId, stopOperationId);

    assert.equal(
      await storage.storage.runs.clearStopRequest({
        taskId: seeded.taskId,
        expectedOperationId: newUuid(),
      }),
      false,
      "operationId 不匹配不得撤销屏障",
    );
    assert.equal(
      await storage.storage.runs.clearStopRequest({
        taskId: seeded.taskId,
        expectedOperationId: stopOperationId,
      }),
      true,
    );
    assert.equal((await storage.storage.runs.get(runId))?.stopRequested, false);
  });
});

test("租期事实只能更新当前代际，估计期限必须带置信度（08 §7）", async () => {
  await withStorage(async ({ storage }) => {
    const seeded = await seedDraftTask(storage);
    const accepted = await storage.storage.acceptInput(startRequest(seeded.taskId));
    if (accepted.status !== "accepted") throw new Error("unreachable");
    const runId = accepted.runId as string;

    await assert.rejects(
      storage.storage.runs.updateLease({
        runId,
        runGeneration: 1,
        deadlineEstimate: TEST_NOW + 60_000,
        now: TEST_NOW + 1,
      }),
      (error: unknown) => isCloudStorageError(error) && error.reason === "invalid-record",
    );

    assert.equal(
      await storage.storage.runs.updateLease({
        runId,
        runGeneration: 1,
        deadlineEstimate: TEST_NOW + 60_000,
        deadlineConfidence: "medium",
        hardDeadlineAt: TEST_NOW + 120_000,
        now: TEST_NOW + 2,
      }),
      true,
    );
    const run = await storage.storage.runs.get(runId);
    assert.equal(run?.deadlineConfidence, "medium");
    assert.equal(run?.hardDeadlineAt, TEST_NOW + 120_000);
    assert.equal(run?.lastBusinessActivityAt, undefined);

    await storage.storage.runs.touchBusinessActivity({ runId, at: TEST_NOW + 3 });
    assert.equal((await storage.storage.runs.get(runId))?.lastBusinessActivityAt, TEST_NOW + 3);

    assert.equal(
      await storage.storage.runs.updateLease({
        runId,
        runGeneration: 9,
        expiresAt: TEST_NOW + 5,
        now: TEST_NOW + 4,
      }),
      false,
      "旧代际的租期结果不得更新新 run",
    );
  });
});

test("输入投递状态机只允许前进，acceptanceSeq 在 Task 内唯一递增", async () => {
  await withStorage(async ({ storage }) => {
    const seeded = await seedDraftTask(storage);
    const accepted = await storage.storage.acceptInput(startRequest(seeded.taskId));
    if (accepted.status !== "accepted") throw new Error("unreachable");
    const commandId = accepted.receipt.commandId;

    // 同态幂等改写合法（domain canAdvanceDeliveryStatus 的 from===to 例外，与内存 fake
    // 同一口径；03 修订审计第二批：预算闭环降级靠它为已收口输入补注 last_error）——
    // 只覆盖 COALESCE 字段，状态不回退、不越级。
    const sameState = await storage.storage.inputs.markDelivery({
      taskId: seeded.taskId,
      commandId,
      to: "accepted",
      now: TEST_NOW + 1,
    });
    assert.equal(sameState?.deliveryStatus, "accepted", "同态改写是幂等 no-op，不是回退");

    const delivering = await storage.storage.inputs.markDelivery({
      taskId: seeded.taskId,
      commandId,
      to: "delivering",
      now: TEST_NOW + 2,
    });
    assert.equal(delivering?.deliveryStatus, "delivering");

    // 真正的回退边（delivering → accepted）仍被拒：状态机只允许前进（02 §6.3）。
    assert.equal(
      await storage.storage.inputs.markDelivery({
        taskId: seeded.taskId,
        commandId,
        to: "accepted",
        now: TEST_NOW + 3,
      }),
      null,
      "已 delivering/admitted 的输入不得回退",
    );

    const uncertain = await storage.storage.inputs.markDelivery({
      taskId: seeded.taskId,
      commandId,
      to: "uncertain",
      now: TEST_NOW + 4,
    });
    assert.equal(uncertain?.deliveryStatus, "uncertain");

    // 已发出但结果不明不得报 cancelled（02 §6.3）。
    assert.equal(
      await storage.storage.inputs.cancelPending({
        taskId: seeded.taskId,
        commandId,
        now: TEST_NOW + 5,
      }),
      null,
    );
    // uncertain 必须先对账：允许回到 delivering 后确认为 admitted。
    assert.equal(
      (
        await storage.storage.inputs.markDelivery({
          taskId: seeded.taskId,
          commandId,
          to: "delivering",
          now: TEST_NOW + 6,
        })
      )?.deliveryStatus,
      "delivering",
    );
    const admitted = await storage.storage.inputs.markDelivery({
      taskId: seeded.taskId,
      commandId,
      to: "admitted",
      now: TEST_NOW + 7,
    });
    assert.equal(admitted?.deliveryStatus, "admitted");
    assert.equal(
      await storage.storage.inputs.markDelivery({
        taskId: seeded.taskId,
        commandId,
        to: "uncertain",
        now: TEST_NOW + 8,
      }),
      null,
      "admitted 是 runtime 裁决事实，不得再改为 uncertain",
    );

    const payload = await storage.storage.payloads.readInputPayload({
      taskId: seeded.taskId,
      commandId,
    });
    assert.equal(payload?.prompt, "首条工作");
    assert.deepEqual(await storage.storage.inputs.listDeliverable(seeded.taskId), []);
  });
});

test("accepted→uncertain→accepted→admitted 在真实存储可达（2026-10-07 P1 回归）", async () => {
  await withStorage(async ({ storage }) => {
    const seeded = await seedDraftTask(storage);
    const accepted = await storage.storage.acceptInput(startRequest(seeded.taskId));
    if (accepted.status !== "accepted") throw new Error("unreachable");
    const commandId = accepted.receipt.commandId;
    const runId = accepted.runId as string;

    // 回归背景（specs/cloud-agent/02 §6.3）：storage 侧曾有第二份边表且边集不一致
    // （accepted 缺 admitted/uncertain、uncertain 缺 accepted），使 app 层按 domain
    // 边表写入的合法迁移在真实存储被 CAS 拒绝后静默丢弃。下面三步正是旧边表下走不通
    // 的边，必须走真实 repo（含 SQL 事务与 CAS）验证。
    const uncertain = await storage.storage.inputs.markDelivery({
      taskId: seeded.taskId,
      commandId,
      to: "uncertain",
      lastError: "rpc-timeout",
      now: TEST_NOW + 2,
    });
    assert.equal(
      uncertain?.deliveryStatus,
      "uncertain",
      "accepted → uncertain：RPC timeout/断连不是 rejected，先置待对账（02 §6.3）",
    );

    const requeued = await storage.storage.inputs.markDelivery({
      taskId: seeded.taskId,
      commandId,
      to: "accepted",
      lastError: "requeued-after-reconcile",
      now: TEST_NOW + 3,
    });
    assert.equal(
      requeued?.deliveryStatus,
      "accepted",
      "uncertain → accepted：对账确认未到达后退回 accepted，由 dispatcher 用同 commandId 重投",
    );

    const admitted = await storage.storage.inputs.markDelivery({
      taskId: seeded.taskId,
      commandId,
      to: "admitted",
      runtimeAck: { commandId, status: "accepted", revisionAtDecision: 1 },
      runId,
      now: TEST_NOW + 4,
    });
    assert.equal(
      admitted?.deliveryStatus,
      "admitted",
      "accepted → admitted：runtime ACK 快于控制面 delivering 写入时 ACK 仍须落地（02 §6.3）",
    );
    assert.equal(admitted?.runtimeAck?.status, "accepted", "ACK 事实随状态一起持久");

    // 终态不再前进：更慢的 ACK / 迟到写入不得覆盖已落地结论。
    assert.equal(
      await storage.storage.inputs.markDelivery({
        taskId: seeded.taskId,
        commandId,
        to: "delivering",
        now: TEST_NOW + 5,
      }),
      null,
      "admitted 是 runtime 裁决事实，后续写入必须被拒",
    );
    assert.deepEqual(await storage.storage.inputs.listDeliverable(seeded.taskId), []);
  });
});

test("取消只作用于未开始投递的输入，且幂等", async () => {
  await withStorage(async ({ storage }) => {
    const seeded = await seedDraftTask(storage);
    const accepted = await storage.storage.acceptInput(startRequest(seeded.taskId));
    if (accepted.status !== "accepted") throw new Error("unreachable");
    const commandId = accepted.receipt.commandId;

    const cancelled = await storage.storage.inputs.cancelPending({
      taskId: seeded.taskId,
      commandId,
      now: TEST_NOW + 1,
    });
    assert.equal(cancelled?.deliveryStatus, "cancelled");
    const again = await storage.storage.inputs.cancelPending({
      taskId: seeded.taskId,
      commandId,
      now: TEST_NOW + 2,
    });
    assert.equal(again?.deliveryStatus, "cancelled", "重复撤销幂等返回原记录");
    assert.deepEqual(await storage.storage.inputs.listDeliverable(seeded.taskId), []);
  });
});

test("checkpoint 与 artifact 的约束承担证据要求（08 §8.2、§9）", async () => {
  await withStorage(async ({ storage }) => {
    const seeded = await seedDraftTask(storage);
    const accepted = await storage.storage.acceptInput(startRequest(seeded.taskId));
    if (accepted.status !== "accepted") throw new Error("unreachable");
    const runId = accepted.runId as string;
    const operationId = newUuid();

    await assert.rejects(
      storage.storage.projections.recordCheckpoint({
        operationId,
        taskId: seeded.taskId,
        runId,
        runGeneration: 1,
        state: "saved",
        includedFiles: [],
        createdAt: TEST_NOW,
        updatedAt: TEST_NOW,
      }),
      "saved 必须有 confirmedRemoteSha（08 §8.2）",
    );

    await storage.storage.projections.recordCheckpoint({
      operationId,
      taskId: seeded.taskId,
      runId,
      runGeneration: 1,
      state: "saved",
      includedFiles: ["src/index.ts"],
      localSha: fakeGitSha("local"),
      confirmedRemoteSha: fakeGitSha("remote"),
      createdAt: TEST_NOW,
      updatedAt: TEST_NOW + 1,
    });
    await storage.storage.tasks.recordCheckpointSha({
      taskId: seeded.taskId,
      remoteSha: fakeGitSha("remote"),
      now: TEST_NOW + 2,
    });
    const checkpoints = await storage.storage.projections.listCheckpoints(seeded.taskId);
    assert.equal(checkpoints.length, 1);
    assert.equal(checkpoints[0]?.confirmedRemoteSha, fakeGitSha("remote"));
    assert.equal(
      (await storage.storage.tasks.get(seeded.taskId))?.lastCheckpointSha,
      fakeGitSha("remote"),
    );

    await assert.rejects(
      storage.storage.tasks.recordArtifact({
        taskId: seeded.taskId,
        kind: "noChanges",
        prStatus: "none",
      }),
      "noChanges 必须有持久摘要（08 §9）",
    );
    await storage.storage.tasks.recordArtifact({
      taskId: seeded.taskId,
      kind: "noChanges",
      prStatus: "none",
      summaryRef: "summary-1",
    });
    await assert.rejects(
      storage.storage.tasks.recordCheckpointSha({
        taskId: newUuid(),
        remoteSha: fakeGitSha("x"),
        now: TEST_NOW,
      }),
      (error: unknown) => isCloudStorageError(error) && error.code === "not_found",
    );
  });
});

test("CR-6 的三个 CAS 成员：会话映射、保存风险、验收意图", async () => {
  await withStorage(async ({ storage }) => {
    const seeded = await seedDraftTask(storage);
    const accepted = await storage.storage.acceptInput(startRequest(seeded.taskId));
    assert.equal(accepted.status, "accepted");
    if (accepted.status !== "accepted") throw new Error("unreachable");
    const runId = accepted.runId as string;

    // runtime 会话映射：CAS 匹配代际且 run 非终态才写。
    assert.equal(
      await storage.storage.runs.setRunRuntimeSessionId({
        runId,
        runGeneration: 2,
        runtimeSessionId: "sess-stale",
        now: TEST_NOW + 1,
      }),
      false,
      "旧代际不得写会话映射",
    );
    assert.equal(
      await storage.storage.runs.setRunRuntimeSessionId({
        runId,
        runGeneration: 1,
        runtimeSessionId: "sess-1",
        now: TEST_NOW + 2,
      }),
      true,
    );
    assert.equal((await storage.storage.runs.get(runId))?.runtimeSessionId, "sess-1");

    // 保存风险：终止路径上写入，因此不限制 run 状态。
    await storage.storage.runs.transitionStatus({
      runId,
      runGeneration: 1,
      from: ["provisioning"],
      to: "failed",
      endReason: "bootstrap-failed",
      now: TEST_NOW + 3,
    });
    assert.equal(
      await storage.storage.runs.setRunDataAtRisk({
        runId,
        runGeneration: 1,
        dataAtRisk: true,
        now: TEST_NOW + 4,
      }),
      true,
      "终态 run 仍必须能标记 dataAtRisk（08 §8.2）",
    );
    assert.equal((await storage.storage.runs.get(runId))?.dataAtRisk, true);
    assert.equal(
      await storage.storage.runs.setRunDataAtRisk({
        runId,
        runGeneration: 9,
        dataAtRisk: false,
        now: TEST_NOW + 5,
      }),
      false,
    );
    assert.equal(
      await storage.storage.runs.setRunRuntimeSessionId({
        runId,
        runGeneration: 1,
        runtimeSessionId: "sess-late",
        now: TEST_NOW + 6,
      }),
      false,
      "终态 run 不再接受会话映射",
    );

    // 验收意图：revision CAS。
    const requested = await storage.storage.tasks.setCompleteRequested({
      taskId: seeded.taskId,
      expectedRevision: (await storage.storage.tasks.get(seeded.taskId))?.revision ?? 0,
      requested: true,
      now: TEST_NOW + 7,
    });
    assert.equal(requested?.completeRequested, true);
    const revision = requested?.revision ?? 0;
    assert.equal(
      await storage.storage.tasks.setCompleteRequested({
        taskId: seeded.taskId,
        expectedRevision: revision - 1,
        requested: false,
        now: TEST_NOW + 8,
      }),
      null,
      "旧 revision 不得改写验收意图",
    );
    assert.equal((await storage.storage.tasks.get(seeded.taskId))?.completeRequested, true);
    const cleared = await storage.storage.tasks.setCompleteRequested({
      taskId: seeded.taskId,
      expectedRevision: revision,
      requested: false,
      now: TEST_NOW + 9,
    });
    assert.equal(cleared?.completeRequested, false);
  });
});

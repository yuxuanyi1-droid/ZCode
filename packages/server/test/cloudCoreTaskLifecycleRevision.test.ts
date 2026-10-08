/**
 * P0 回归（2026-10-07 review）：Task 生命周期命令的 revision CAS 传值。
 *
 * 契约在三层必须一致（specs/cloud-agent 03 §6 complete/archive/reactivate/restore 行、
 * 08 §3.1 Task 状态表、08 §9 验收意图；端口 JSDoc 见 app/ports/taskPort.ts:41-46）：
 * - 真实 repo：`UPDATE tasks SET revision = ? ... WHERE ... AND revision < ?`
 *   （adapters/storage/repositories/taskRepo.ts:195）→ 传入的 `revision` 是**新的 revision**，
 *   必须严格大于当前值，成功时直接落该值（允许跳号）；
 * - 端口 fake：同一语义（test/cloudCoreStorageFake.ts）；
 * - app 命令：archive/reactivate/restore 传「当前值 + 1」，complete 读回 latest 后传 latest+1。
 *
 * 旧实现四处传的是当前值：fake 旧语义（相等即成功 + 自动 +1）下全绿，真实 SQLite 则
 * `revision < ?` 恒不成立 → `changes:0` → 四个命令恒 stale；complete 还因
 * `complete_requested` 已置位（revision 已前进）而无法用原 revision 收口，形成死锁。
 * 本文件同时钉住「app 命令成功且 revision 前进」与「真实 repo / fake 同序列结果一致」。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  assembleCloudControlPlane,
  type CloudControlPlane,
} from "../src/cloud/app/assembleCloudControlPlane.js";
import type { StoragePort } from "../src/cloud/app/ports/storagePort.js";
import type { CloudAppResult } from "../src/cloud/app/result.js";
import type { TaskDetailResponse } from "@zcode/shared";
import {
  createFakeArtifacts,
  createFakeAttachmentPort,
  createFakeDriverRegistry,
  createFakeExecutionProjections,
  createFakeGitGrantBroker,
  createFakeGitHub,
  createFakeInteractionDecisions,
  createFakeProvisioningEnvelope,
  createFakeRuntimeCommands,
  createFakeSandboxDriver,
  createFakeTemplateResolver,
} from "./cloudCoreAdapterFakes.js";
import {
  buildTestPlane,
  createFakeOutbox,
  FakeClock,
  FakeHash,
  FakeIds,
} from "./cloudCoreFakes.js";
import { newUuid, openTestStorage, removeTestRoot, TEST_NOW } from "./cloudStorageHarness.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";

/** 只换存储实现：其余端口与 `buildTestPlane` 用同一组 fake，parity 差异只可能来自存储。 */
function assemblePlaneOver(storage: StoragePort): CloudControlPlane {
  const clock = new FakeClock();
  const ids = new FakeIds();
  const gitGrant = createFakeGitGrantBroker({
    now: () => clock.now(),
    newGrantId: () => ids.newId(),
  });
  return assembleCloudControlPlane({
    storage,
    operations: createFakeOutbox(),
    github: createFakeGitHub(),
    drivers: createFakeDriverRegistry(createFakeSandboxDriver()),
    attachments: createFakeAttachmentPort(),
    runtimeCommands: createFakeRuntimeCommands(),
    clock,
    ids,
    hash: new FakeHash(),
    templates: createFakeTemplateResolver(),
    interactionDecisions: createFakeInteractionDecisions(),
    executionProjections: createFakeExecutionProjections(),
    artifacts: createFakeArtifacts(),
    provisioningEnvelope: createFakeProvisioningEnvelope(),
    gitGrantStore: gitGrant.store,
    gitGrantBroker: gitGrant.broker,
  });
}

test("P0 回归：archive/restore/complete 成功后 revision 前进（transitionStatus 传的是新 revision）", async () => {
  const context = buildTestPlane();
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.equal(project.ok, true);
  if (!project.ok) return;
  const created = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "P0 revision",
    creationKey: "ck-p0-revision",
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.equal(created.ok, true, created.ok ? "" : `${created.code}/${created.reason}`);
  if (!created.ok) return;
  const taskId = created.value.taskId;
  assert.equal((await context.storage.tasks.get(taskId))?.revision, 0);

  // 1) archive：draft → archived，revision 前进 1（03 §6 archive 行、08 §3.1）。
  const archived = await context.plane.commands.taskLifecycle.archiveTask({
    principalId: PRINCIPAL,
    taskId,
  });
  assert.equal(archived.ok, true, archived.ok ? "" : `${archived.code}/${archived.reason}`);
  const afterArchive = await context.storage.tasks.get(taskId);
  assert.equal(afterArchive?.status, "archived");
  assert.equal(afterArchive?.archivedFromStatus, "draft");
  assert.equal(afterArchive?.revision, 1, "archive 必须把 revision 推进到新值");
  assert.equal(archived.ok && archived.value.task.revision, afterArchive?.revision);

  // 2) restore：archived → archivedFromStatus，revision 再前进 1（03 §6 restore 行）。
  const restored = await context.plane.commands.taskLifecycle.restoreTask({
    principalId: PRINCIPAL,
    taskId,
  });
  assert.equal(restored.ok, true, restored.ok ? "" : `${restored.code}/${restored.reason}`);
  assert.equal(restored.ok && restored.value.task.status, "draft");
  assert.equal((await context.storage.tasks.get(taskId))?.revision, 2);

  // 3) complete 前置是 active（08 §3.1）：用同一条 CAS 语义（新 revision）把 draft 推到 active。
  const activated = await context.storage.tasks.transitionStatus({
    taskId,
    from: ["draft"],
    to: "active",
    revision: 3,
    now: context.clock.now(),
  });
  assert.equal(activated?.status, "active");

  // 4) complete：08 §9 先持久验收意图，再转 completed；两次写都必须成功。
  const completed = await context.plane.commands.taskLifecycle.completeTask({
    principalId: PRINCIPAL,
    taskId,
  });
  assert.equal(completed.ok, true, completed.ok ? "" : `${completed.code}/${completed.reason}`);
  const afterComplete = await context.storage.tasks.get(taskId);
  assert.equal(afterComplete?.status, "completed");
  assert.equal(afterComplete?.completeRequested, true, "complete_requested 已置位（08 §9）");
  assert.equal(afterComplete?.revision, 5, "complete = 验收意图 + 状态迁移各前进一次");
  assert.equal(completed.ok && completed.value.task.revision, afterComplete?.revision);

  // 5) completed 幂等：再次 complete 不再写 revision（旧实现的死锁点）。
  const again = await context.plane.commands.taskLifecycle.completeTask({
    principalId: PRINCIPAL,
    taskId,
  });
  assert.equal(again.ok, true, again.ok ? "" : `${again.code}/${again.reason}`);
  assert.equal((await context.storage.tasks.get(taskId))?.revision, 5);
});

interface LifecycleStep {
  step: string;
  kind: "repo" | "command";
  ok: boolean;
  code: string | null;
  reason: string | null;
  /** 命令返回的详情投影里的 revision（repo 步骤为 null）：投影也不能落后于持久事实。 */
  projectionRevision: number | null;
  storedStatus: string | null;
  storedRevision: number | null;
  completeRequested: boolean | null;
  archivedFromStatus: string | null;
}

/** 每个步骤都同时记「操作结果」与「落库后的事实」，真实 repo 与 fake 逐字段对比。 */
async function recordStep(
  storage: StoragePort,
  taskId: string,
  step: string,
  kind: LifecycleStep["kind"],
  result: { ok: boolean; code?: string; reason?: string; projectionRevision?: number },
): Promise<LifecycleStep> {
  const stored = await storage.tasks.get(taskId);
  return {
    step,
    kind,
    ok: result.ok,
    code: result.code ?? null,
    reason: result.reason ?? null,
    projectionRevision: result.projectionRevision ?? null,
    storedStatus: stored?.status ?? null,
    storedRevision: stored?.revision ?? null,
    completeRequested: stored?.completeRequested ?? null,
    archivedFromStatus: stored?.archivedFromStatus ?? null,
  };
}

function commandResult(result: CloudAppResult<TaskDetailResponse>): {
  ok: boolean;
  code?: string;
  reason?: string;
  projectionRevision?: number;
} {
  return result.ok
    ? { ok: true, projectionRevision: result.value.task.revision }
    : { ok: false, code: result.code, reason: result.reason };
}

/**
 * 同一操作序列打在两套存储上：seed → archive → restore → activate → complete →
 * reactivate → archive（含幂等）→ restore，中途穿插两条 CAS 契约反例。
 */
async function runLifecycleSequence(input: {
  storage: StoragePort;
  plane: CloudControlPlane;
  principalId: string;
  now: number;
}): Promise<LifecycleStep[]> {
  const { storage, plane, principalId, now } = input;
  const steps: LifecycleStep[] = [];

  const project = await storage.projects.createOrGet({
    projectId: newUuid(),
    ownerPrincipalId: principalId,
    kind: "github-repo",
    repositoryId: 42,
    installationId: 7,
    repoOwner: "zcode",
    repoName: "parity-fixture",
    defaultBranch: "main",
    now,
  });
  const taskId = newUuid();
  const draft = await storage.tasks.createDraft({
    taskId,
    ownerPrincipalId: principalId,
    projectId: project.projectId,
    title: "parity fixture",
    creationKey: `ck-${taskId}`,
    draftStartConfig: { baseBranch: "main", provider: "daytona" },
    workspaceIdentity: `cloud-task:${taskId}`,
    now,
  });
  steps.push(
    await recordStep(storage, taskId, "createDraft", "repo", { ok: draft.revision === 0 }),
  );

  const archived = await plane.commands.taskLifecycle.archiveTask({ principalId, taskId });
  steps.push(await recordStep(storage, taskId, "archiveTask", "command", commandResult(archived)));

  const restored = await plane.commands.taskLifecycle.restoreTask({ principalId, taskId });
  steps.push(await recordStep(storage, taskId, "restoreTask", "command", commandResult(restored)));

  // complete 的前置是 active（08 §3.1）：走同一条 CAS（新 revision）落库。
  const current = await storage.tasks.get(taskId);
  const activated = await storage.tasks.transitionStatus({
    taskId,
    from: ["draft"],
    to: "active",
    revision: (current?.revision ?? 0) + 1,
    now,
  });
  steps.push(
    await recordStep(storage, taskId, "repo:activate", "repo", { ok: activated !== null }),
  );

  // CAS 契约反例：revision 未严格大于当前值必须 stale 返回 null（真实 repo 的 `revision < ?`）。
  const equalRevision = await storage.tasks.transitionStatus({
    taskId,
    from: ["active"],
    to: "completed",
    revision: (await storage.tasks.get(taskId))?.revision ?? 0,
    now,
  });
  steps.push(
    await recordStep(storage, taskId, "repo:stale-equal-revision", "repo", {
      ok: equalRevision === null,
    }),
  );

  const completed = await plane.commands.taskLifecycle.completeTask({ principalId, taskId });
  steps.push(
    await recordStep(storage, taskId, "completeTask", "command", commandResult(completed)),
  );

  const reactivated = await plane.commands.taskLifecycle.reactivateTask({ principalId, taskId });
  steps.push(
    await recordStep(storage, taskId, "reactivateTask", "command", commandResult(reactivated)),
  );

  const archivedAgain = await plane.commands.taskLifecycle.archiveTask({ principalId, taskId });
  steps.push(
    await recordStep(storage, taskId, "archiveTask#2", "command", commandResult(archivedAgain)),
  );

  const archivedIdempotent = await plane.commands.taskLifecycle.archiveTask({
    principalId,
    taskId,
  });
  steps.push(
    await recordStep(
      storage,
      taskId,
      "archiveTask#3(幂等)",
      "command",
      commandResult(archivedIdempotent),
    ),
  );

  const restoredAgain = await plane.commands.taskLifecycle.restoreTask({ principalId, taskId });
  steps.push(
    await recordStep(storage, taskId, "restoreTask#2", "command", commandResult(restoredAgain)),
  );

  // CAS 契约反例：`from` 列表不匹配必须返回 null（08 §3.1 允许操作表）。
  const wrongFrom = await storage.tasks.transitionStatus({
    taskId,
    from: ["draft"],
    to: "archived",
    revision: ((await storage.tasks.get(taskId))?.revision ?? 0) + 1,
    now,
  });
  steps.push(
    await recordStep(storage, taskId, "repo:wrong-from", "repo", { ok: wrongFrom === null }),
  );

  return steps;
}

test("P0 parity：同一生命周期命令序列在真实 SQLite 与端口 fake 上结果一致", async () => {
  const handle = await openTestStorage();
  try {
    const realSteps = await runLifecycleSequence({
      storage: handle.storage.storage,
      plane: assemblePlaneOver(handle.storage.storage),
      principalId: PRINCIPAL,
      now: TEST_NOW,
    });
    const fakeContext = buildTestPlane();
    const fakeSteps = await runLifecycleSequence({
      storage: fakeContext.storage,
      plane: fakeContext.plane,
      principalId: PRINCIPAL,
      now: TEST_NOW,
    });

    assert.equal(realSteps.length, fakeSteps.length, "两侧步骤数必须一致");
    for (let index = 0; index < realSteps.length; index += 1) {
      const real = realSteps[index];
      const fake = fakeSteps[index];
      assert.deepEqual(
        real,
        fake,
        `步骤 ${real?.step}：真实 repo 与 fake 的（状态、revision、错误码）必须一致`,
      );
    }

    // 非平凡性：命令步骤必须真的成功且 revision 持续前进，否则「两侧同样 stale」也会 deepEqual。
    const commandSteps = realSteps.filter((step) => step.kind === "command");
    assert.equal(commandSteps.length, 7, "archive/restore/complete/reactivate 四个命令共 7 步");
    for (const step of commandSteps) {
      assert.equal(step.ok, true, `${step.step} 必须成功（旧实现在真实 SQLite 恒 stale）`);
    }
    const expectedRevisions = new Map<string, number>([
      ["archiveTask", 1],
      ["restoreTask", 2],
      ["completeTask", 5],
      ["reactivateTask", 6],
      ["archiveTask#2", 7],
      ["archiveTask#3(幂等)", 7],
      ["restoreTask#2", 8],
    ]);
    for (const step of commandSteps) {
      assert.equal(
        step.storedRevision,
        expectedRevisions.get(step.step) ?? null,
        `${step.step} 后的 revision 与预期不符`,
      );
      assert.equal(
        step.projectionRevision,
        step.storedRevision,
        `${step.step} 返回的投影 revision 必须等于落库事实`,
      );
    }
  } finally {
    const root = handle.root;
    await handle.close();
    await removeTestRoot(root);
  }
});

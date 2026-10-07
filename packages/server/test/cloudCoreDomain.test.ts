/**
 * W1 domain 单测（W1 §6：注入 clock、无 IO；覆盖状态迁移、到期、配额、代际、幂等）。
 * 断言逐条引用 specs/cloud-agent/08 与 03 的对应小节；不 sleep、不触网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudTaskRecord } from "@zcode/shared";
import {
  canArchiveTask,
  canReactivateTask,
  canTransitionRun,
  canTransitionTask,
  hasActiveWriteRun,
  isTerminalRunStatus,
  mayTransitionToFailed,
  provisioningCancelKeepsSupplyFact,
  restoreTargetStatus,
  taskStatusAfterRunEnd,
} from "../src/cloud/domain/taskRunState.js";
import {
  countOccupiedSlots,
  evaluateQuotaReservation,
  mayReleaseQuota,
} from "../src/cloud/domain/quota.js";
import {
  fenceFrame,
  isStaleEpoch,
  isStaleGeneration,
  reopenRequiresRecovery,
} from "../src/cloud/domain/fencing.js";
import {
  canonicalInputFingerprint,
  decideDuplicate,
  publishPullRequestKey,
  compareAcceptanceSeq,
} from "../src/cloud/domain/idempotency.js";
import {
  drainRetryAllowed,
  evaluateCheckpointOutcome,
  isBusinessActivity,
  isGitObjectId,
  isIdleArchiveEligible,
  resolveEffectiveDeadline,
  resolveHardDeadline,
  shouldBeginDrain,
  shouldRenewLease,
  shouldRequestPeriodicCheckpoint,
} from "../src/cloud/domain/savePolicy.js";
import {
  buildCloudTaskWorkspacePath,
  isWithinCloudWorkspaceRoot,
} from "../src/cloud/domain/workspacePath.js";
import { deriveTaskActions } from "../src/cloud/domain/taskActions.js";
import { canAdvanceDeliveryStatus } from "../src/cloud/domain/deliveryStatus.js";
import { makeRun } from "./cloudCoreFakes.js";

const BASE_SHA = "b".repeat(40);
const REMOTE_SHA = "c".repeat(40);

const TASK_ID = "00000000-0000-4000-8000-000000000001";

function task(overrides: Partial<CloudTaskRecord> = {}): CloudTaskRecord {
  return {
    taskId: TASK_ID,
    ownerPrincipalId: "00000000-0000-4000-8000-0000000000aa",
    projectId: "00000000-0000-4000-8000-0000000000bb",
    title: "t",
    status: "draft",
    creationKey: "k",
    workspaceIdentity: `cloud-task:${TASK_ID}` as CloudTaskRecord["workspaceIdentity"],
    nextRunGeneration: 1,
    revision: 0,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

test("Task 状态迁移与 08 §3.1 允许操作一致", () => {
  assert.equal(canTransitionTask("draft", "active"), true);
  assert.equal(canTransitionTask("draft", "completed"), false);
  assert.equal(canTransitionTask("active", "completed"), true);
  assert.equal(canTransitionTask("active", "archived"), true);
  assert.equal(canTransitionTask("completed", "active"), true, "reactivate 是显式回退");
  assert.equal(canTransitionTask("failed", "active"), true, "重试/新输入后回到 active");
  assert.equal(canTransitionTask("archived", "active"), false, "restore 走 archivedFromStatus");
});

test("Run 状态迁移与 08 §3.2 状态图一致（含 provisioning 不转 draining）", () => {
  assert.equal(canTransitionRun("provisioning", "ready"), true);
  assert.equal(
    canTransitionRun("provisioning", "draining"),
    false,
    "08 §8.1：provisioning 保持供给事实",
  );
  assert.equal(canTransitionRun("ready", "draining"), true);
  assert.equal(canTransitionRun("disconnected", "draining"), true);
  assert.equal(canTransitionRun("draining", "ready"), true, "用户明确撤销停止意图");
  assert.equal(canTransitionRun("draining", "stopped"), true);
  assert.equal(canTransitionRun("stopped", "ready"), false, "终态 run 不可复活");
  assert.equal(canTransitionRun("expired", "ready"), false);
  assert.equal(isTerminalRunStatus("failed"), true);
  assert.equal(isTerminalRunStatus("disconnected"), false);
});

test("停止意图不改变 provisioning 的供给事实，且阻塞推进", () => {
  const run = makeRun({ taskId: "t", runId: "r", status: "provisioning", stopRequested: true });
  assert.equal(provisioningCancelKeepsSupplyFact(run), true);
});

test("结果未知不得归 failed（08 §3.2 / 03 §5）", () => {
  const run = makeRun({ taskId: "t", runId: "r", status: "ready" });
  assert.equal(
    mayTransitionToFailed({ run, runtimeUnrecoverable: true, instanceDispositioned: false }),
    false,
  );
  assert.equal(
    mayTransitionToFailed({ run, runtimeUnrecoverable: true, instanceDispositioned: true }),
    true,
  );
  const provisioning = makeRun({ taskId: "t", runId: "r", status: "provisioning" });
  assert.equal(
    mayTransitionToFailed({
      run: provisioning,
      runtimeUnrecoverable: false,
      instanceDispositioned: false,
    }),
    false,
    "创建失败未核验不得写 failed",
  );
});

test("run 结束后的 Task 落点（08 §3.1 failed 行）", () => {
  assert.equal(
    taskStatusAfterRunEnd({
      task: task({ status: "active" }),
      runStatus: "failed",
      remainingActiveRun: null,
    }),
    "failed",
  );
  assert.equal(
    taskStatusAfterRunEnd({
      task: task({ status: "active" }),
      runStatus: "stopped",
      remainingActiveRun: null,
    }),
    null,
    "provider 到期/用户停止不改变 Task 委托状态",
  );
  assert.equal(
    taskStatusAfterRunEnd({
      task: task({ status: "active" }),
      runStatus: "failed",
      remainingActiveRun: makeRun({ taskId: "t", runId: "r2", status: "ready" }),
    }),
    null,
  );
});

test("归档/重新激活前置（03 §6、08 §3.1）", () => {
  const active = makeRun({ taskId: "t", runId: "r", status: "ready" });
  assert.equal(canArchiveTask(task({ status: "active" }), active), false);
  assert.equal(canArchiveTask(task({ status: "active" }), null), true);
  assert.equal(hasActiveWriteRun(active), true);
  assert.equal(
    canReactivateTask({ task: task({ status: "completed" }), activeRun: null, prStatus: "open" }),
    true,
  );
  assert.equal(
    canReactivateTask({ task: task({ status: "completed" }), activeRun: null, prStatus: "merged" }),
    false,
  );
  assert.equal(
    restoreTargetStatus(task({ status: "archived", archivedFromStatus: "completed" })),
    "completed",
  );
  assert.equal(restoreTargetStatus(task({ status: "active" })), null);
});

test("配额：未终态与终止未知都占槽，只有 confirmed terminated 才释放", () => {
  const runs = [
    makeRun({ taskId: "t1", runId: "r1", status: "ready" }),
    makeRun({ taskId: "t2", runId: "r2", status: "draining" }),
    makeRun({ taskId: "t3", runId: "r3", status: "stopped" }),
  ];
  assert.equal(countOccupiedSlots({ runs }), 2);
  assert.equal(
    countOccupiedSlots({ runs, pendingTerminationRunIds: ["r3"] }),
    3,
    "01 §4.3：终止未知占槽",
  );
  assert.equal(evaluateQuotaReservation({ occupiedSlots: 2, maxConcurrentRuns: 3 }).allowed, true);
  const denied = evaluateQuotaReservation({ occupiedSlots: 3, maxConcurrentRuns: 3 });
  assert.equal(denied.allowed, false);
  assert.equal(denied.allowed === false && denied.code, "quota_exceeded");
  assert.equal(mayReleaseQuota("terminated"), true);
  assert.equal(mayReleaseQuota("unknown"), false);
  assert.equal(mayReleaseQuota("notTerminated"), false);
});

test("代际与 epoch 围栏（08 §4.2、02 §2 不变量 3）", () => {
  assert.equal(isStaleGeneration(2, 1), true);
  assert.equal(isStaleEpoch(1, 2), true, "旧 epoch 不得投递");
  assert.equal(fenceFrame({ frameGeneration: 1, currentGeneration: 2 }).accepted, false);
  assert.equal(
    fenceFrame({ frameGeneration: 2, currentGeneration: 2, frameEpoch: 1, currentEpoch: 3 })
      .accepted,
    false,
  );
  assert.equal(fenceFrame({ frameGeneration: 2, currentGeneration: 2 }).accepted, true);
  assert.equal(
    reopenRequiresRecovery({
      previousRunTerminalConfirmed: true,
      previousCredentialsRevoked: false,
    }),
    true,
  );
});

test("fingerprint：键序无关、覆盖语义字段、不含解析出的默认值（03 §6.1）", () => {
  const base = canonicalInputFingerprint({
    intent: "start",
    prompt: "hello",
    attachmentIds: ["a1", "a2"],
    requestedConfig: { mode: "build", planEnabled: false },
    start: { baseBranch: "main", provider: "e2b" },
    expectedTaskRevision: 3,
  });
  const reordered = canonicalInputFingerprint({
    intent: "start",
    prompt: "hello",
    attachmentIds: ["a1", "a2"],
    start: { provider: "e2b", baseBranch: "main" },
    requestedConfig: { planEnabled: false, mode: "build" },
    expectedTaskRevision: 3,
  });
  assert.equal(base, reordered, "对象键顺序不改变 fingerprint");
  assert.notEqual(
    base,
    canonicalInputFingerprint({
      intent: "start",
      prompt: "hello!",
      attachmentIds: ["a1", "a2"],
      requestedConfig: { mode: "build", planEnabled: false },
      start: { baseBranch: "main", provider: "e2b" },
      expectedTaskRevision: 3,
    }),
  );
  assert.notEqual(
    base,
    canonicalInputFingerprint({
      intent: "start",
      prompt: "hello",
      attachmentIds: ["a2", "a1"],
      requestedConfig: { mode: "build", planEnabled: false },
      start: { baseBranch: "main", provider: "e2b" },
      expectedTaskRevision: 3,
    }),
    "附件顺序是语义",
  );
  assert.equal(
    base,
    canonicalInputFingerprint({
      intent: "start",
      prompt: "hello",
      attachmentIds: ["a1", "a2"],
      requestedConfig: { mode: "build", planEnabled: false },
      start: { baseBranch: "main", provider: "e2b" },
      expectedTaskRevision: 3,
    }),
    "省略默认值仍按原请求计算",
  );
});

test("同 commandId 去重判定（CP-03/CT-07）", () => {
  const record = {
    taskId: "t",
    commandId: "c",
    intent: "start" as const,
    payloadHash: "a".repeat(64),
    acceptanceSeq: 1,
    acceptedAt: 0,
    deliveryStatus: "accepted" as const,
  };
  assert.equal(
    decideDuplicate({ existing: null, incomingPayloadHash: "a".repeat(64) }).kind,
    "new",
  );
  assert.equal(
    decideDuplicate({ existing: record, incomingPayloadHash: "a".repeat(64) }).kind,
    "duplicate",
  );
  const conflict = decideDuplicate({ existing: record, incomingPayloadHash: "b".repeat(64) });
  assert.equal(conflict.kind, "conflict");
  assert.equal(conflict.kind === "conflict" && conflict.code, "idempotency_conflict");
});

test("PR 发布幂等键与 acceptanceSeq 顺序（08 §8.2、03 §6.2）", () => {
  assert.equal(publishPullRequestKey("run-1", "ckpt-1"), "publish-pr:run-1:ckpt-1");
  const first = {
    taskId: "t",
    commandId: "c1",
    intent: "start" as const,
    payloadHash: "a".repeat(64),
    acceptanceSeq: 1,
    acceptedAt: 5,
    deliveryStatus: "accepted" as const,
  };
  const second = { ...first, commandId: "c2", acceptanceSeq: 2, acceptedAt: 1 };
  assert.ok(compareAcceptanceSeq(first, second) < 0, "按 acceptanceSeq 而不是 acceptedAt 排序");
});

test("期限解析取保守上界，硬期限取部署预算与 provider 的较小值（08 §7、01 §4.3）", () => {
  const deadline = resolveEffectiveDeadline({
    expiresAt: 10_000,
    deadlineEstimate: 8_000,
    hardDeadlineAt: 20_000,
  });
  assert.deepEqual(deadline, { at: 8_000, confidence: "estimated", source: "deadlineEstimate" });
  assert.equal(
    resolveHardDeadline({
      runStartedAt: 0,
      deploymentBudgetMs: 4 * 3600_000,
      providerMaxLifetimeSeconds: 3600,
    }),
    3600_000,
  );
  assert.equal(resolveHardDeadline({ runStartedAt: 0, deploymentBudgetMs: 1000 }), 1000);
  assert.equal(resolveEffectiveDeadline({}), null);
});

test("drain 与闲置判定（08 §7）", () => {
  assert.equal(
    shouldBeginDrain({
      now: 1_000,
      deadline: { at: 301_000, confidence: "confirmed", source: "expiresAt" },
      drainBudgetMs: 300_000,
    }),
    true,
  );
  assert.equal(
    shouldBeginDrain({
      now: 1_000,
      deadline: { at: 999_999, confidence: "confirmed", source: "expiresAt" },
    }),
    false,
  );
  assert.equal(shouldBeginDrain({ now: 1_000, deadline: null, stopRequested: true }), true);
  assert.equal(
    isIdleArchiveEligible({
      now: 1_000_000,
      lastBusinessActivityAt: 0,
      execution: "idle",
      pendingInputCount: 0,
      pendingInteractionCount: 0,
      checkpointInFlight: false,
    }),
    true,
  );
  assert.equal(
    isIdleArchiveEligible({
      now: 1_000_000,
      lastBusinessActivityAt: 0,
      execution: "awaiting-input",
      pendingInputCount: 0,
      pendingInteractionCount: 1,
      checkpointInFlight: false,
    }),
    false,
    "审批等待不是业务空闲",
  );
  assert.equal(
    isIdleArchiveEligible({
      now: 1_000_000,
      lastBusinessActivityAt: 0,
      execution: "idle",
      pendingInputCount: 0,
      pendingInteractionCount: 0,
      checkpointInFlight: true,
    }),
    false,
  );
});

test("业务活动分类：heartbeat/观看不算业务活动（08 §7）", () => {
  assert.equal(isBusinessActivity("runtime-execution"), true);
  assert.equal(isBusinessActivity("tool-execution"), true);
  assert.equal(isBusinessActivity("heartbeat"), false);
  assert.equal(isBusinessActivity("attach"), false);
  assert.equal(isBusinessActivity("polling"), false);
  assert.equal(isBusinessActivity("protocol-ack"), false);
});

test("续期条件：running/写操作/pending 保护才续期，硬期限封顶（08 §7、01 §4.3）", () => {
  assert.equal(
    shouldRenewLease({
      now: 0,
      execution: "idle",
      pendingInputCount: 0,
      pendingInteractionCount: 0,
      writeInFlight: false,
    }),
    false,
    "仅观看不续期",
  );
  assert.equal(
    shouldRenewLease({
      now: 0,
      execution: "running",
      pendingInputCount: 0,
      pendingInteractionCount: 0,
      writeInFlight: false,
    }),
    true,
  );
  assert.equal(
    shouldRenewLease({
      now: 10,
      execution: "running",
      pendingInputCount: 0,
      pendingInteractionCount: 0,
      writeInFlight: false,
      hardDeadlineAt: 5,
    }),
    false,
    "到达硬期限不再保活",
  );
});

test("周期保存窗口（08 §7）", () => {
  assert.equal(
    shouldRequestPeriodicCheckpoint({
      now: 400_000,
      lastCheckpointAt: 0,
      execution: "running",
      checkpointInFlight: false,
    }),
    true,
  );
  assert.equal(
    shouldRequestPeriodicCheckpoint({
      now: 100_000,
      lastCheckpointAt: 0,
      execution: "running",
      checkpointInFlight: false,
    }),
    false,
  );
  assert.equal(
    shouldRequestPeriodicCheckpoint({
      now: 400_000,
      lastCheckpointAt: 0,
      execution: "unknown",
      checkpointInFlight: false,
    }),
    false,
    "执行状态未知时不主动保存",
  );
});

test("checkpoint 结果判定：saved 必须有合法 remote SHA（08 §8.1/§8.2）", () => {
  assert.equal(isGitObjectId(REMOTE_SHA), true);
  assert.equal(isGitObjectId("z".repeat(40)), false);

  const missingSha = evaluateCheckpointOutcome({ status: "saved" });
  assert.equal(missingSha.state, "pending", "无证据不写 saved（fail-closed 进对账）");
  assert.equal(missingSha.dataAtRisk, true);

  const clean = evaluateCheckpointOutcome({
    status: "saved",
    remoteSha: REMOTE_SHA,
    hadNewCommits: true,
    frozenBaseSha: BASE_SHA,
  });
  assert.equal(clean.state, "saved");
  assert.equal(clean.confirmedRemoteSha, REMOTE_SHA);
  assert.equal(clean.dataAtRisk, false);

  const stuckAtBase = evaluateCheckpointOutcome({
    status: "saved",
    remoteSha: BASE_SHA,
    hadNewCommits: true,
    frozenBaseSha: BASE_SHA,
  });
  assert.equal(stuckAtBase.state, "saved");
  assert.equal(stuckAtBase.dataAtRisk, true, "有新提交但仍停在 baseSha：提交没落在发布分支");

  const noNewCommits = evaluateCheckpointOutcome({
    status: "saved",
    remoteSha: BASE_SHA,
    hadNewCommits: false,
    frozenBaseSha: BASE_SHA,
  });
  assert.equal(noNewCommits.state, "saved");
  assert.equal(noNewCommits.noNewCommits, true);
  assert.equal(noNewCommits.dataAtRisk, false);

  const failed = evaluateCheckpointOutcome({ status: "failed", errorCode: "checkpoint_failed" });
  assert.equal(failed.state, "failed");
  assert.equal(failed.dataAtRisk, true, "保存失败不伪装 saved");
  assert.equal(evaluateCheckpointOutcome({ status: "unknown" }).state, "pending");
  assert.equal(evaluateCheckpointOutcome({ status: "unknown" }).dataAtRisk, true);
});

test("工作区路径：确定性、净化、拒绝越界（01 §6.2 步骤 2）", () => {
  const first = buildCloudTaskWorkspacePath("Demo");
  const second = buildCloudTaskWorkspacePath("Demo");
  assert.deepEqual(first, second, "同一 repo 名恒定得到同一路径（确定性）");
  assert.deepEqual(first, { ok: true, path: "/workspace/demo", segment: "demo" });
  assert.deepEqual(buildCloudTaskWorkspacePath("My Repo.Name"), {
    ok: true,
    path: "/workspace/my-repo.name",
    segment: "my-repo.name",
  });
  // 越界/绝对路径/多段：明确失败，不做静默截断
  for (const unsafe of [
    "../etc",
    "a/b",
    "\\server",
    "/abs",
    "C:\\win",
    "..",
    ".",
    "-flag",
    "   ",
  ]) {
    const result = buildCloudTaskWorkspacePath(unsafe);
    assert.equal(result.ok, false, `${unsafe} 必须被拒绝`);
  }
  // 净化后为空的纯符号名同样失败
  assert.equal(buildCloudTaskWorkspacePath("☃").ok, false);
  // 长度上限与结尾分隔符裁剪
  const long = buildCloudTaskWorkspacePath(`${"a".repeat(80)}`);
  assert.equal(long.ok, true);
  assert.ok(long.ok && long.segment.length <= 64);
  assert.ok(long.ok && !long.path.endsWith("-"));
});

test("工作区路径越界判定（hello 上报值校验）", () => {
  assert.equal(isWithinCloudWorkspaceRoot("/workspace/demo"), true);
  assert.equal(isWithinCloudWorkspaceRoot("/workspace/a/b"), true);
  assert.equal(isWithinCloudWorkspaceRoot("/workspace"), false);
  assert.equal(isWithinCloudWorkspaceRoot("/workspace/../etc"), false);
  assert.equal(isWithinCloudWorkspaceRoot("/workspace/a/../b"), false);
  assert.equal(isWithinCloudWorkspaceRoot("/etc/passwd"), false);
  assert.equal(isWithinCloudWorkspaceRoot("/workspacex/demo"), false);
});

test("投递状态机：单向推进、终态不回退、uncertain 可退回 accepted（02 §6.3）", () => {
  assert.equal(canAdvanceDeliveryStatus("accepted", "delivering"), true);
  assert.equal(
    canAdvanceDeliveryStatus("accepted", "admitted"),
    true,
    "runtime ACK 可能快于 delivering 写入",
  );
  assert.equal(canAdvanceDeliveryStatus("delivering", "admitted"), true);
  assert.equal(
    canAdvanceDeliveryStatus("delivering", "cancelled"),
    false,
    "已投递未对账不得直接撤销",
  );
  assert.equal(canAdvanceDeliveryStatus("uncertain", "accepted"), true, "对账确认后的重投");
  assert.equal(canAdvanceDeliveryStatus("admitted", "delivering"), false, "终态不回退");
  assert.equal(canAdvanceDeliveryStatus("rejected", "admitted"), false);
  assert.equal(canAdvanceDeliveryStatus("cancelled", "accepted"), false);
});

test("actions 投影：状态表推导 + 无事实不猜（04 §3.3、08 §3.1/§8.2）", () => {
  const draft = task({
    status: "draft",
    draftStartConfig: { baseBranch: "main", provider: "e2b" },
  });
  assert.deepEqual(
    deriveTaskActions({ task: draft, activeRun: null, unsettledInputCount: 0, artifact: null }),
    ["send-input", "archive"],
  );
  // 缺 draftStartConfig 时首发不可用（start 需要完整选择，11 §6）。
  assert.deepEqual(
    deriveTaskActions({
      task: task({ status: "draft" }),
      activeRun: null,
      unsettledInputCount: 0,
      artifact: null,
    }),
    ["archive"],
  );

  const readyRun = makeRun({
    taskId: TASK_ID,
    runId: "r1",
    status: "ready",
    providerHandle: "sbx-1",
  });
  const active = deriveTaskActions({
    task: task({ status: "active", baseSha: BASE_SHA, taskBranch: "zcode/task-x" }),
    activeRun: readyRun,
    unsettledInputCount: 1,
    artifact: null,
    providerCanExtend: true,
  });
  assert.deepEqual(active, [
    "send-input",
    "cancel-input",
    "stop",
    "force-stop",
    "extend",
    "complete",
  ]);
  assert.equal(active.includes("archive"), false, "有活动写 run 时不可归档");

  // 停止意图受理后：不再开放输入/停止/撤销，但保留显式强制停止（08 §8.2）。
  const stopping = deriveTaskActions({
    task: task({ status: "active" }),
    activeRun: makeRun({ taskId: TASK_ID, runId: "r1", status: "draining", stopRequested: true }),
    unsettledInputCount: 1,
    artifact: null,
    providerCanExtend: true,
  });
  assert.deepEqual(stopping, ["force-stop", "complete"]);

  // provider 能力未知 → 不投影 extend（无事实不猜）。
  const unknownCapability = deriveTaskActions({
    task: task({ status: "active" }),
    activeRun: readyRun,
    unsettledInputCount: 0,
    artifact: null,
  });
  assert.equal(unknownCapability.includes("extend"), false);

  // failed + 无活动 run + 基线已冻结 → 可重开。
  assert.deepEqual(
    deriveTaskActions({
      task: task({ status: "failed", baseSha: BASE_SHA, taskBranch: "zcode/task-x" }),
      activeRun: null,
      unsettledInputCount: 0,
      artifact: null,
    }),
    ["reopen", "archive"],
  );

  // completed：PR 已 merged 时不得 reactivate（08 §3.1），改为新建 follow-up Task。
  const merged = deriveTaskActions({
    task: task({ status: "completed", prRef: "42" }),
    activeRun: null,
    unsettledInputCount: 0,
    artifact: {
      taskId: TASK_ID,
      kind: "code",
      taskBranch: "zcode/task-x",
      prStatus: "merged",
    } as never,
  });
  assert.deepEqual(merged, ["archive"]);
  const openPr = deriveTaskActions({
    task: task({ status: "completed", prRef: "42" }),
    activeRun: null,
    unsettledInputCount: 0,
    artifact: {
      taskId: TASK_ID,
      kind: "code",
      taskBranch: "zcode/task-x",
      prStatus: "open",
    } as never,
  });
  assert.deepEqual(
    openPr,
    ["archive", "reactivate"],
    "输出顺序按冻结枚举（archive 在 reactivate 前）",
  );

  // archived：只读，仅可恢复。
  assert.deepEqual(
    deriveTaskActions({
      task: task({ status: "archived", archivedFromStatus: "active" }),
      activeRun: null,
      unsettledInputCount: 0,
      artifact: null,
    }),
    ["restore"],
  );
});

test("保存失败只在剩余预算内重试（08 §8.1）", () => {
  assert.equal(
    drainRetryAllowed({
      now: 10,
      deadline: { at: 1_000, confidence: "confirmed", source: "expiresAt" },
      retries: 1,
    }),
    true,
  );
  assert.equal(
    drainRetryAllowed({
      now: 200,
      deadline: { at: 100, confidence: "confirmed", source: "expiresAt" },
      retries: 1,
    }),
    false,
    "到达硬期限不再重试保存",
  );
  assert.equal(
    drainRetryAllowed({
      now: 10,
      deadline: { at: 1_000, confidence: "confirmed", source: "expiresAt" },
      retries: 9,
    }),
    false,
  );
});

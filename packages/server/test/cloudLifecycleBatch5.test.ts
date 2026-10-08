/**
 * 生命周期 v2 第 5 批验收：终验缺陷 B 修复（2026-10-09，无头终验 checkpoint 死循环）。
 *
 * - 保存通路 grant 签发收口（01 §7.2 签发时机修订）：周期保存与 stop/drain 在发
 *   `checkpoint.request` 前成组签发 push+fetch——终验中周期保存从不签发，沙箱 push
 *   兑换必然 403 `no-issued-grant`；draining 的 fetch（远端 SHA 对账读）不再被
 *   stopRequested 拒签（否则 push 落地也拿不到保存事实）。
 * - 执行侧结果帧必达（08 §8.1 修订）：checkpoint 通路抛错也按 failed 回
 *   `checkpoint.result`——不回帧会让 op 靠 attempt 封顶结算、周期保存每拍重建 op。
 * - 业务活动事实源收窄（08 §7 修订）：投影 ingest 只在批次实际新增记录时推进
 *   lastBusinessActivityAt；WAL 重投/补发（0 新增）不得制造「running」假象。
 * - 周期保存失败退避（30s→2min→5min 封顶）+ 未落定 op 不重建 + 在途占用有界窗口；
 *   「上次周期保存已 failed」不永久阻塞空闲 pause（run.dataAtRisk 如实承载）。
 *
 * 全部用例受控时钟、无 sleep、不触网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CloudProjectionRecord,
  CloudCheckpointRecord,
  ProjectionBatchFrame,
} from "@zcode/shared";
import { handleControlFrame } from "../src/cloud/execution/app/bridgeInbound.js";
import { createBridgeRuntimeState } from "../src/cloud/execution/app/bridgeState.js";
import type {
  BridgeConnectionPort,
  BridgeTransportPort,
} from "../src/cloud/execution/app/ports.js";
import type { CloudRunAddress } from "@zcode/shared";
import { CLOUD_BRIDGE_PROTOCOL_VERSION } from "@zcode/shared";
import type { BridgeSessionOptions } from "../src/cloud/execution/app/bridgeState.js";
import {
  checkpointRetryIntervalMs,
  CHECKPOINT_IN_FLIGHT_WINDOW_MS,
  CHECKPOINT_RETRY_LADDER_MS,
  consecutiveCheckpointFailures,
  hasCheckpointInFlight,
} from "../src/cloud/domain/checkpointPolicy.js";
import { authorizeGitGrant } from "../src/cloud/app/credentialAuthorization/authorization.js";
import { createTestClock, testLogger } from "./cloudBridgeFakes.js";
import {
  createBootstrapFake,
  createCredentialStore,
  createProjectionFake,
  createRuntimeFake,
} from "./cloudExecutionFakes.js";
import { attachReadySession, buildTestPlane, type TestPlane } from "./cloudCoreFakes.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000c5";
let sequence = 0;

/** 走完 create + attach + markReady 的 ready run（周期保存/空闲 pause 的起点）。 */
async function seedReadyRun(context: TestPlane): Promise<{
  taskId: string;
  runId: string;
  runGeneration: number;
}> {
  sequence += 1;
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.ok ? project.value.projectId : "",
    title: `defect-b-${sequence}`,
    creationKey: `ck-b5-${sequence}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.ok ? task.value.taskId : "",
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-${(sequence + 0xb50).toString(16).padStart(12, "0")}`,
      prompt: "go",
      expectedTaskRevision: task.ok ? task.value.revision : 0,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  await context.plane.provisioning.create.runCreateOnce();
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  await attachReadySession(context, {
    taskId: task.ok ? task.value.taskId : "",
    runId: run.runId,
    runGeneration: run.runGeneration,
  });
  const ready = await context.plane.runs.markReady({
    taskId: task.ok ? task.value.taskId : "",
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.ok(ready.ok);
  return {
    taskId: task.ok ? task.value.taskId : "",
    runId: run.runId,
    runGeneration: run.runGeneration,
  };
}

/** 只走到「输入已接纳 + create 完成」的 provisioning run（授权判定用例的起点）。 */
async function seedAcceptedRun(context: TestPlane): Promise<{
  taskId: string;
  runId: string;
  runGeneration: number;
}> {
  sequence += 1;
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.ok ? project.value.projectId : "",
    title: `authorize-b5-${sequence}`,
    creationKey: `ck-b5-auth-${sequence}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.ok ? task.value.taskId : "",
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-${(sequence + 0xbd0).toString(16).padStart(12, "0")}`,
      prompt: "go",
      expectedTaskRevision: task.ok ? task.value.revision : 0,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  return {
    taskId: task.ok ? task.value.taskId : "",
    runId: run.runId,
    runGeneration: run.runGeneration,
  };
}

function checkpointRecord(
  context: TestPlane,
  session: { taskId: string; runId: string; runGeneration: number },
  overrides: Partial<CloudCheckpointRecord> = {},
): CloudCheckpointRecord {
  return {
    operationId: context.ids.newId(),
    taskId: session.taskId,
    runId: session.runId,
    runGeneration: session.runGeneration,
    state: "failed",
    includedFiles: [],
    createdAt: context.clock.now(),
    updatedAt: context.clock.now(),
    ...overrides,
  };
}

function projectionRecord(
  session: { taskId: string; runId: string; runGeneration: number },
  sourceSeq: number,
  contentHash: string,
): CloudProjectionRecord {
  return {
    schemaVersion: 1,
    taskId: session.taskId,
    runId: session.runId,
    runGeneration: session.runGeneration,
    runtimeIncarnation: "incarnation-b5",
    topic: `conversation/sess-b5-${sequence}`,
    logEpoch: "epoch-b5",
    sourceSeq,
    kind: "delta",
    payload: { text: `payload-${sourceSeq}` },
    contentHash,
  };
}

function batch(records: CloudProjectionRecord[], connectionEpoch: number): ProjectionBatchFrame {
  return { protocolVersion: 1, type: "projection.batch", connectionEpoch, records };
}

// ── A. 保存策略纯函数（08 §7 修订 2026-10-09） ──

test("checkpointRetryIntervalMs：失败退避 30s→2min→5min 封顶，且不低于周期档", () => {
  const base = 30_000;
  assert.equal(
    checkpointRetryIntervalMs({ consecutiveFailures: 0, periodicCheckpointMs: base }),
    base,
  );
  assert.equal(
    checkpointRetryIntervalMs({ consecutiveFailures: 1, periodicCheckpointMs: base }),
    CHECKPOINT_RETRY_LADDER_MS[0],
  );
  assert.equal(
    checkpointRetryIntervalMs({ consecutiveFailures: 2, periodicCheckpointMs: base }),
    CHECKPOINT_RETRY_LADDER_MS[1],
  );
  assert.equal(
    checkpointRetryIntervalMs({ consecutiveFailures: 3, periodicCheckpointMs: base }),
    CHECKPOINT_RETRY_LADDER_MS[2],
  );
  assert.equal(
    checkpointRetryIntervalMs({ consecutiveFailures: 9, periodicCheckpointMs: base }),
    CHECKPOINT_RETRY_LADDER_MS[2],
    "封顶：更多失败不再放大",
  );
  assert.equal(
    checkpointRetryIntervalMs({ consecutiveFailures: 2, periodicCheckpointMs: 300_000 }),
    300_000,
    "周期档更长时按周期档（退避只放大、不缩短）",
  );
});

test("hasCheckpointInFlight：窗口内 saving/pending 算占用，超窗僵尸记录不阻塞", () => {
  const now = 10_000_000;
  const inWindow = now - (CHECKPOINT_IN_FLIGHT_WINDOW_MS - 1);
  const stale = now - (CHECKPOINT_IN_FLIGHT_WINDOW_MS + 1);
  assert.equal(
    hasCheckpointInFlight({ records: [{ state: "pending", updatedAt: inWindow }], now }),
    true,
  );
  assert.equal(
    hasCheckpointInFlight({ records: [{ state: "saving", updatedAt: inWindow }], now }),
    true,
  );
  assert.equal(
    hasCheckpointInFlight({ records: [{ state: "pending", updatedAt: stale }], now }),
    false,
    "超窗 pending 是僵尸事实，不再占用保存通道",
  );
  assert.equal(
    hasCheckpointInFlight({
      records: [
        { state: "failed", updatedAt: inWindow },
        { state: "saved", updatedAt: inWindow },
      ],
      now,
    }),
    false,
    "failed/saved 是已落定事实，不占用",
  );
});

test("consecutiveCheckpointFailures：按 updatedAt 降序数开头连续 failed", () => {
  const records = [
    { state: "saved" as const, updatedAt: 100 },
    { state: "failed" as const, updatedAt: 300 },
    { state: "failed" as const, updatedAt: 200 },
  ];
  assert.equal(consecutiveCheckpointFailures(records), 2, "最新两条 failed → 连击 2");
  assert.equal(consecutiveCheckpointFailures([{ state: "pending", updatedAt: 5 }]), 0);
  assert.equal(consecutiveCheckpointFailures([]), 0);
});

// ── B. 授权判定（01 §7.2 签发时机修订） ──

test("draining 保存通路：fetch（远端对账读）与 push 可签发，clone 仍拒（01 §7.2 修订）", async () => {
  const context = buildTestPlane();
  const session = await seedAcceptedRun(context);
  const now = context.clock.now();
  // provisioning → ready → (stop 受理) → draining：与 beginDrain 相同的状态事实。
  await context.storage.runs.transitionStatus({
    runId: session.runId,
    runGeneration: session.runGeneration,
    from: ["provisioning"],
    to: "ready",
    now,
  });
  await context.storage.runs.requestStop({
    taskId: session.taskId,
    operationId: context.ids.newId(),
    now,
  });
  const draining = await context.storage.runs.transitionStatus({
    runId: session.runId,
    runGeneration: session.runGeneration,
    from: ["ready"],
    to: "draining",
    endReason: "user-stop",
    now,
  });
  assert.ok(draining);
  const run = await context.storage.runs.get(session.runId);
  const task = await context.storage.tasks.get(session.taskId);
  assert.ok(run && task);

  // 修复断言：stopRequested 下 draining 的 fetch 不再被拒（终验 03:42:11 的兑换断点）。
  const fetchIssued = await context.plane.gitGrants.issueForRun({
    runId: session.runId,
    purpose: "fetch",
  });
  assert.equal(
    fetchIssued.ok,
    true,
    fetchIssued.ok ? "" : `${fetchIssued.code}/${fetchIssued.reason}`,
  );
  const pushIssued = await context.plane.gitGrants.issueForRun({
    runId: session.runId,
    purpose: "push",
  });
  assert.equal(pushIssued.ok, true, "draining 的保存写（push）照旧可签发");
  const cloneIssued = await context.plane.gitGrants.issueForRun({
    runId: session.runId,
    purpose: "clone",
  });
  assert.equal(cloneIssued.ok, false);
  assert.equal(
    cloneIssued.ok === false && cloneIssued.reason,
    "stop-requested",
    "clone 不在例外内",
  );
  // 授权纯判定同口径。
  const decision = authorizeGitGrant({ run, task, purpose: "fetch" });
  assert.ok(decision.ok);
});

// ── C. 周期保存：grant 签发 + 退避 + 不重建 op ──

test("周期保存：checkpoint 请求前成组签发 push+fetch，push 可真实兑换（终验缺陷 B 回归）", async () => {
  const context = buildTestPlane({ config: { periodicCheckpointMs: 30_000 } });
  const session = await seedReadyRun(context);
  await context.storage.runs.touchBusinessActivity({
    runId: session.runId,
    at: context.clock.now(),
  });
  // 捕获「发 checkpoint.request 时 push grant 是否已存在」——签发必须先于请求。
  const pushGrantsAtRequest: number[] = [];
  const original = context.attachmentPort.requestCheckpoint.bind(context.attachmentPort);
  context.attachmentPort.requestCheckpoint = async (request) => {
    pushGrantsAtRequest.push(
      context.gitGrantStore.records.filter(
        (item) =>
          item.runId === session.runId && item.purpose === "push" && item.status === "issued",
      ).length,
    );
    return original(request);
  };

  const report = await context.plane.lifecycle.checkpoints.sweepPeriodicCheckpoints();
  assert.equal(report.requested, 1);
  assert.equal(context.attachmentPort.checkpoints.length, 1);
  assert.equal(pushGrantsAtRequest[0], 1, "checkpoint 请求时 push grant 已签发");
  const purposes = context.gitGrantStore.records
    .filter((item) => item.runId === session.runId)
    .map((item) => item.purpose);
  assert.ok(
    purposes.includes("push") && purposes.includes("fetch"),
    "push+fetch 成组签发（01 §7.2 签发时机修订）",
  );

  // 端到端：签发的 push grant 能被沙箱真实兑换（＝周期保存能真实 push）。
  const redeem = await context.plane.gitGrants.redeem({
    runId: session.runId,
    purpose: "push",
    runGeneration: session.runGeneration,
    repositoryId: 101,
  });
  assert.equal(redeem.ok, true, redeem.ok ? "" : `${redeem.code}/${redeem.reason}`);

  // 该 run 的 checkpoint op 未落定 → 同一 run 不重建新 op。
  const again = await context.plane.lifecycle.checkpoints.sweepPeriodicCheckpoints();
  assert.equal(again.requested, 0, "未落定 op 存在时不重建（08 §7 修订）");
  assert.equal(context.attachmentPort.checkpoints.length, 1);
});

test("周期保存退避：连续 failed 记录按阶梯放大间隔，成功恢复正常周期档", async () => {
  const context = buildTestPlane({ config: { periodicCheckpointMs: 30_000 } });
  const session = await seedReadyRun(context);
  await context.storage.runs.touchBusinessActivity({
    runId: session.runId,
    at: context.clock.now(),
  });
  const sweep = () => context.plane.lifecycle.checkpoints.sweepPeriodicCheckpoints();
  const settle = () => context.plane.lifecycle.checkpoints.sweepCheckpointOperations();
  /** 最近一个 pending checkpoint op 的 id（结果帧落 record 必须与 op 同键才能结算）。 */
  const lastPendingOpId = () => {
    const pending = [...context.outbox.records.values()].filter(
      (item) => item.kind === "checkpoint" && item.state === "pending",
    );
    return pending[pending.length - 1]?.operationId;
  };

  // 1 次失败：间隔为阶梯第 1 档（=周期档 30s）。
  await context.storage.projections.recordCheckpoint(
    checkpointRecord(context, session, { updatedAt: context.clock.now() }),
  );
  const tooSoon = await sweep();
  assert.equal(tooSoon.requested, 0, "失败后未到退避间隔不重建");
  context.clock.advance(31_000);
  assert.equal((await sweep()).requested, 1, "30s 后按阶梯第 1 档重试");
  // 结果帧按 op id 落 failed record → op 即时结算。
  const firstOpId = lastPendingOpId();
  assert.ok(firstOpId);
  await context.storage.projections.recordCheckpoint(
    checkpointRecord(context, session, { operationId: firstOpId }),
  );
  assert.ok((await settle()).failed >= 1, "failed 记录即时结算 op");

  // 2 次失败：R1 + R2（与 op1 同键结算的 failed 记录）连击 2 → 间隔放大到 2min。
  const withinLadder = await sweep();
  assert.equal(withinLadder.requested, 0, "2 次失败后 30s < 120s 不重试");
  context.clock.advance(60_000);
  assert.equal((await sweep()).requested, 0, "90s 仍 < 120s");
  context.clock.advance(60_000);
  assert.equal((await sweep()).requested, 1, "150s ≥ 120s 重试");
  const secondOpId = lastPendingOpId();
  assert.ok(secondOpId);
  await context.storage.projections.recordCheckpoint(
    checkpointRecord(context, session, {
      operationId: secondOpId,
      state: "saved",
      confirmedRemoteSha: "a".repeat(40),
    }),
  );
  await settle();

  // 保存成功：连击清零，恢复周期档。
  context.clock.advance(31_000);
  const recovered = await context.plane.lifecycle.checkpoints.sweepPeriodicCheckpoints();
  assert.equal(recovered.requested, 1, "成功后恢复周期档（连击清零）");
});

test("结果帧缺失：op attempt 封顶结算计入退避，不无限重建 op（终验死循环回归）", async () => {
  const context = buildTestPlane({ config: { periodicCheckpointMs: 30_000 } });
  const session = await seedReadyRun(context);
  await context.storage.runs.touchBusinessActivity({
    runId: session.runId,
    at: context.clock.now(),
  });
  const sweep = () => context.plane.lifecycle.checkpoints.sweepPeriodicCheckpoints();
  const settle = () => context.plane.lifecycle.checkpoints.sweepCheckpointOperations();
  const checkpointOpCount = () =>
    [...context.outbox.records.values()].filter((item) => item.kind === "checkpoint").length;

  // 第 1 个 op：三次租约（30s 一拍）内无结果帧 → attempt 3 封顶结算 failed。
  assert.equal((await sweep()).requested, 1);
  await settle();
  context.clock.advance(30_000);
  await settle();
  context.clock.advance(30_000);
  const exhausted = await settle();
  assert.equal(exhausted.failed, 1, "attempt 3 封顶结算 failed");
  assert.equal(checkpointOpCount(), 1);

  // 修复断言：结果缺失连击计入退避——30s 内不再重建新 op（终验里这里每 30s +1 个 op）。
  context.clock.advance(1_000);
  assert.equal((await sweep()).requested, 0, "退避锚（封顶时刻）起 30s 内不重建");
  context.clock.advance(30_000);
  assert.equal((await sweep()).requested, 1, "阶梯第 1 档到期后允许重试");
  assert.equal(checkpointOpCount(), 2);

  // 第 2 个 op 再次无结果耗尽 → 连击 2 → 间隔放大到 2min。
  for (let round = 0; round < 3; round += 1) {
    await settle();
    context.clock.advance(30_000);
  }
  assert.equal(checkpointOpCount(), 2, "第 2 个 op 也已封顶结算，不自动新增");
  assert.equal((await sweep()).requested, 0, "连击 2 → 120s 内不重建");
  context.clock.advance(120_000);
  assert.equal((await sweep()).requested, 1, "120s 后按阶梯第 2 档重试");
  assert.equal(checkpointOpCount(), 3);
});

test("在途窗口：新鲜 pending 记录照常阻塞保存，超窗僵尸记录不阻塞（08 §7 修订）", async () => {
  const context = buildTestPlane({ config: { periodicCheckpointMs: 30_000 } });
  const session = await seedReadyRun(context);
  await context.storage.runs.touchBusinessActivity({
    runId: session.runId,
    at: context.clock.now(),
  });
  await context.storage.projections.recordCheckpoint(
    checkpointRecord(context, session, { state: "pending", updatedAt: context.clock.now() }),
  );
  context.clock.advance(30_000);
  const duringFlight = await context.plane.lifecycle.checkpoints.sweepPeriodicCheckpoints();
  assert.equal(duringFlight.requested, 0, "结果未到且在窗口内 → 保存通道占用");

  context.clock.advance(200_000);
  const afterZombie = await context.plane.lifecycle.checkpoints.sweepPeriodicCheckpoints();
  assert.equal(afterZombie.requested, 1, "超窗 pending 不再阻塞周期保存（风险由 dataAtRisk 承载）");
});

// ── D. 空闲 pause：failed/僵尸记录不永久阻塞（08 §7 修订） ──

async function seedIdleReadyRun(context: TestPlane, idleForMs: number) {
  const session = await seedReadyRun(context);
  // start 输入已投递并被 runtime 确认：工作面清空，才有「空闲」可言。
  const inputs = await context.storage.inputs.listDeliverable(session.taskId);
  for (const input of inputs) {
    await context.storage.inputs.markDelivery({
      taskId: session.taskId,
      commandId: input.commandId,
      to: "admitted",
      now: context.clock.now(),
    });
  }
  // 修复依据（2026-10-07 复核缺陷 1）：不再手工 detach——bridge session 保持注册
  // （沙箱存活期间 bridge 恒在线的真实前提）；空闲判定的事实源是 BrowserWatchPort
  // （浏览器观看流），测试平面未 open 观看即「无人观看」。
  // 业务活动事实回拨到阈值之前（08 §7：lastBusinessActivityAt 是业务活动事实）。
  await context.storage.runs.touchBusinessActivity({
    runId: session.runId,
    at: context.clock.now() - idleForMs,
  });
  return session;
}

test("空闲 pause e2e：上次周期保存 failed（dataAtRisk）不阻塞 pause，按事实暂停", async () => {
  const context = buildTestPlane({ config: { idlePauseMs: 60_000 } });
  context.driver.pauseResume = "memory";
  const session = await seedIdleReadyRun(context, 60_000);
  // 修复断言（2026-10-07 复核缺陷 1）：bridge session 在册（恒在线的真实前提），
  // 空闲 pause 不再被它阻塞——事实源是浏览器观看流，不是 attachment 注册表。
  assert.notEqual(context.plane.attachments.current(session.runId), null, "bridge 在线");
  await context.storage.projections.recordCheckpoint(
    checkpointRecord(context, session, { updatedAt: context.clock.now() }),
  );
  await context.storage.runs.setRunDataAtRisk({
    runId: session.runId,
    runGeneration: session.runGeneration,
    dataAtRisk: true,
    now: context.clock.now(),
  });

  const report = await context.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(report.paused, 1, "failed 保存不阻塞空闲 pause（08 §7 修订）");
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "paused");
  assert.equal(run?.endReason, "idle-pause");
  assert.equal(run?.dataAtRisk, true, "风险标注如实保留，不虚报已保存");
});

test("空闲 pause：超窗僵尸 pending 记录不阻塞；新鲜 pending 记录照常顺延", async () => {
  const context = buildTestPlane({ config: { idlePauseMs: 60_000 } });
  context.driver.pauseResume = "memory";
  const session = await seedIdleReadyRun(context, 60_000);
  await context.storage.projections.recordCheckpoint(
    checkpointRecord(context, session, {
      state: "pending",
      updatedAt: context.clock.now() - (CHECKPOINT_IN_FLIGHT_WINDOW_MS + 1_000),
    }),
  );
  const zombie = await context.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(zombie.paused, 1, "僵尸 pending 不永久阻塞 pause");

  const context2 = buildTestPlane({ config: { idlePauseMs: 60_000 } });
  context2.driver.pauseResume = "memory";
  const session2 = await seedIdleReadyRun(context2, 60_000);
  await context2.storage.projections.recordCheckpoint(
    checkpointRecord(context2, session2, { state: "pending", updatedAt: context2.clock.now() }),
  );
  const fresh = await context2.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(fresh.paused, 0, "窗口内的 pending 仍算保存通道占用");
  assert.equal((await context2.storage.runs.get(session2.runId))?.status, "ready");
});

// ── E. 投影 ingest 业务活动收窄（08 §7 修订） ──

test("投影 ingest：重投批次（0 新增）不推进业务活动；新增批次推进（终验缺陷 B 回归）", async () => {
  const context = buildTestPlane();
  const session = await seedReadyRun(context);
  const activityAt = async () =>
    (await context.storage.runs.get(session.runId))?.lastBusinessActivityAt;

  const records = [
    projectionRecord(session, 0, "c".repeat(64)),
    projectionRecord(session, 1, "d".repeat(64)),
  ];
  const first = await context.plane.projections.ingest.ingestProjectionBatch(
    batch(records, session.runGeneration),
  );
  assert.equal(first.accepted, 2);
  const afterFirst = await activityAt();
  assert.ok(afterFirst !== undefined, "新增记录推进 lastBusinessActivityAt");

  // WAL 重投：同键同内容（0 新增）→ 活动事实保持不变（终验中每 30s 重投刷新活动的根因）。
  context.clock.advance(60_000);
  const replay = await context.plane.projections.ingest.ingestProjectionBatch(
    batch(records, session.runGeneration),
  );
  assert.equal(replay.accepted, 0);
  assert.equal(await activityAt(), afterFirst, "重投批次不刷新业务活动");

  // 新记录（真正的 runtime/工具执行）才推进。
  context.clock.advance(60_000);
  await context.plane.projections.ingest.ingestProjectionBatch(
    batch([projectionRecord(session, 2, "e".repeat(64))], session.runGeneration),
  );
  const afterNew = await activityAt();
  assert.ok(afterNew !== undefined && afterNew > (afterFirst ?? 0), "新增记录推进业务活动");
});

// ── F. 执行侧：checkpoint 结果帧必达（08 §8.1 修订） ──

test("checkpoint 通路抛错仍回 failed 结果帧，不吞保存事实（终验缺陷 B 回归）", async () => {
  const state = createBridgeRuntimeState();
  state.status = "ready";
  state.epoch = 1;
  state.connectionReady = true;
  const sent: unknown[] = [];
  let closed: string | undefined;
  const connection: BridgeConnectionPort = {
    send: (text: string) => sent.push(JSON.parse(text)),
    close: (reason: string) => {
      closed = reason;
    },
  };
  const address: CloudRunAddress = {
    taskId: "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51",
    runId: "1f14e45f-ceea-467a-9a1e-1f0d3b2a4c52",
    runGeneration: 1,
    workspaceIdentity: "cloud-task:x",
    workspacePath: "/workspace/demo",
    remoteSessionId: "remote-1",
  };
  const options: BridgeSessionOptions = {
    address,
    bridgeUrl: "wss://cloud.example.test/ws/cloud/bridge/x",
    workspacePathHint: "/workspace/demo",
    transport: {} as BridgeTransportPort,
    credentials: createCredentialStore().port,
    projection: createProjectionFake(),
    rpcRelay: { handle: () => undefined, releaseAll: () => undefined },
    bootstrap: createBootstrapFake(createRuntimeFake()),
    // 模拟 grant 兑换失败沿 withGrant 抛出（终验 2026-10-09 现场）。
    checkpoint: {
      run: async () => {
        throw new Error("git grant request failed with status 403");
      },
    },
    drain: { onDrain: async () => undefined },
    clock: createTestClock(),
    logger: testLogger(),
    newAttemptId: () => "attempt-1",
    newResumeToken: () => "resume-1",
    jitter: () => 0,
  };
  const operationId = "2f14e45f-ceea-467a-9a1e-1f0d3b2a4c53";

  await handleControlFrame(
    state,
    options,
    {
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "checkpoint.request",
      operationId,
      runId: address.runId,
      runGeneration: 1,
      connectionEpoch: 1,
      purpose: "manual",
    },
    connection,
  );

  assert.equal(sent.length, 1, "结果帧必须回（02 §4）");
  const frame = sent[0] as {
    type: string;
    status: string;
    errorCode?: string;
    operationId: string;
  };
  assert.equal(frame.type, "checkpoint.result");
  assert.equal(frame.status, "failed");
  assert.equal(frame.errorCode, "checkpoint_failed");
  assert.equal(frame.operationId, operationId);
  assert.equal(closed, undefined, "不关连接：保存事实照常回传");
});

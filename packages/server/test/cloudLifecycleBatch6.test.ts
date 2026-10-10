/**
 * 生命周期 v2 第 6 批验收：生命周期 v2 审计第一批修复（2026-10-09，P1/P2/P3 第一组）。
 *
 * - 【P1】terminate 明确拒绝（notTerminated → op failed）后的持久重试：failed terminate op
 *   按 attempt 退避（30s→2min→5min 封顶）重排队为 pending，由补偿循环重试 provider 终止；
 *   attempt 封顶（10 次）后保持 failed + 升级告警，终局兜底 keepalive liveness。
 *   屏障指针不入队的形态（force-stop / paused 起源 drain）由 stop sweep 直接驱动
 *   terminateRun——不再 waitingSave 死循环。
 * - 【P1】paused 自驱 resume 的触发输入放宽为 accepted|delivering|uncertain：idle pause
 *   与投递并发的 TOCTOU、控制面重启 delivering→uncertain 都可达非 accepted 态，只认
 *   accepted 会让 paused run 成僵尸（03 §6 修订）。
 * - 【P2】空闲占用的输入事实含 uncertain（08 §7 修订）：空闲 pause 拍与 idle drain 的
 *   pendingInputCount 都计入 uncertain，可能执行中的 run 不被暂停/归档。
 * - 【P3】forceStopTask 检查 paused/ready→draining CAS 结果：CAS 失败按重读状态分支
 *   （paused/draining → advancePausedStop；ready → 补 draining CAS 后 terminate）。
 *
 * 全部用例受控时钟、无 sleep、不触网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudCheckpointRecord } from "@zcode/shared";
import {
  TERMINATE_RETRY_MAX_ATTEMPTS,
  terminateRetryDue,
  terminateRetryIntervalMs,
} from "../src/cloud/domain/terminateRetryPolicy.js";
import { attachReadySession, buildTestPlane, type TestPlane } from "./cloudCoreFakes.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000c6";
let sequence = 0;

/** 走完 start → create → attach → markReady 的 ready run（stop 通路的起点）。 */
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
    title: `audit-b6-${sequence}`,
    creationKey: `ck-b6-${sequence}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.ok ? task.value.taskId : "",
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-${(sequence + 0xb60).toString(16).padStart(12, "0")}`,
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

/** 走完 start → create → ready → pauseRun 的 paused run（resume/暂停中停止的起点）。 */
async function seedPausedRun(
  context: TestPlane,
  options: { admitStartInput?: boolean } = {},
): Promise<{ taskId: string; runId: string; runGeneration: number }> {
  context.driver.pauseResume = "memory";
  const session = await seedReadyRun(context);
  const paused = await context.plane.lifecycle.pauseResume.pauseRun({
    taskId: session.taskId,
    runId: session.runId,
    reason: "idle-pause",
  });
  assert.ok(paused.ok, paused.ok ? "" : `${paused.code}/${paused.reason}`);
  if (options.admitStartInput === true) {
    // start 输入已投递收口（admitted，模拟 runtime ACK）：移出 deliverable 集，
    // 让「有无待投递输入」的事实只由后续 append 决定。
    const deliverable = await context.storage.inputs.listDeliverable(session.taskId);
    for (const input of deliverable) {
      await context.storage.inputs.markDelivery({
        taskId: session.taskId,
        commandId: input.commandId,
        to: "admitted",
        now: context.clock.now(),
      });
    }
  }
  return session;
}

/** paused run 上追加一条 append（202 持久接收，delivery=accepted）。 */
async function appendInput(
  context: TestPlane,
  session: { taskId: string; runId: string; runGeneration: number },
  suffix: number,
): Promise<string> {
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId: `00000000-0000-4000-8000-${(sequence * 16 + suffix + 0xbe0)
        .toString(16)
        .padStart(12, "0")}`,
      prompt: "continue",
      expectedRunGeneration: session.runGeneration,
    },
  });
  assert.ok(submit.ok, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  return submit.ok ? submit.value.commandId : "";
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
    state: "saved",
    includedFiles: [],
    createdAt: context.clock.now(),
    updatedAt: context.clock.now(),
    confirmedRemoteSha: "a".repeat(40),
    ...overrides,
  };
}

/**
 * 把 stop 通路的 checkpoint op 结算为 saved（保存前置已确认，sweep 随后走到 terminate）。
 */
async function settleStopCheckpointSaved(
  context: TestPlane,
  session: {
    taskId: string;
    runId: string;
    runGeneration: number;
  },
): Promise<void> {
  const run = await context.storage.runs.get(session.runId);
  assert.ok(run?.stopOperationId, "stop 屏障已写（stopOperationId 指向 checkpoint op）");
  await context.storage.projections.recordCheckpoint(
    checkpointRecord(context, session, { operationId: run.stopOperationId }),
  );
  const settled = await context.plane.lifecycle.checkpoints.sweepCheckpointOperations();
  assert.ok(settled.settled >= 1, "saved 记录即时结算 checkpoint op");
}

// ── A. terminate 重试纯策略（08 §8.1 修订 2026-10-09） ──

test("terminateRetryIntervalMs：退避 30s→2min→5min 封顶；attempt<=0 立即可试", () => {
  assert.equal(terminateRetryIntervalMs(0), 0);
  assert.equal(terminateRetryIntervalMs(1), 30_000);
  assert.equal(terminateRetryIntervalMs(2), 120_000);
  assert.equal(terminateRetryIntervalMs(3), 300_000);
  assert.equal(terminateRetryIntervalMs(9), 300_000, "阶梯封顶：更多失败不再放大");
});

test("terminateRetryDue：按 failed 结算时刻退避；attempt 封顶后恒 false", () => {
  const failedAt = 1_000_000;
  assert.equal(
    terminateRetryDue({ attempt: 1, failedAt, now: failedAt + 30_000 }),
    true,
    "阶梯第 1 档到期（≥ 判定）",
  );
  assert.equal(
    terminateRetryDue({ attempt: 1, failedAt, now: failedAt + 29_999 }),
    false,
    "退避窗口内不重试",
  );
  assert.equal(
    terminateRetryDue({ attempt: TERMINATE_RETRY_MAX_ATTEMPTS, failedAt, now: failedAt + 1e9 }),
    false,
    "attempt 封顶：不再重排队（升级告警，终局归 keepalive liveness）",
  );
  assert.equal(
    terminateRetryDue({ attempt: TERMINATE_RETRY_MAX_ATTEMPTS - 1, failedAt, now: failedAt + 1e9 }),
    true,
  );
});

// ── B.【P1】failed terminate op 重试：一次拒绝 → 退避重试 → 终态 ──

test("P1 终止重试：notTerminated 一次 → 退避窗口内不打 provider → 重试成功收口 stopped", async () => {
  const context = buildTestPlane();
  const session = await seedReadyRun(context);
  const stopped = await context.plane.commands.stop.stopTask({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.ok(stopped.ok);
  await settleStopCheckpointSaved(context, session);

  // 第 1 次 terminate：provider 明确拒绝（如 403/402）→ op failed。
  context.driver.terminateStatus = "notTerminated";
  const first = await context.plane.commands.stop.sweep();
  assert.equal(first.advanced, 0);
  assert.equal(first.waitingSave, 1, "终止未确认：等待重试，不收口");
  const terminateOpKey = `terminate:${session.runId}:${session.runGeneration}`;
  const failedOp = await context.outbox.findByKey(terminateOpKey);
  assert.equal(failedOp?.state, "failed");
  assert.equal(failedOp?.attempt, 1);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "draining");

  // 退避窗口内：不重排队、不打 provider（30s 阶梯第 1 档）。
  const second = await context.plane.commands.stop.sweep();
  assert.equal(second.waitingSave, 1);
  assert.equal(context.driver.terminateCalls, 2, "terminate+cleanup 各 1 次，无新增");
  assert.equal((await context.outbox.findByKey(terminateOpKey))?.state, "failed");

  // 退避到期：重排队 → 补偿循环重试 → provider 确认 → run 收口终态 + 释放配额。
  context.clock.advance(31_000);
  context.driver.terminateStatus = "terminated";
  const third = await context.plane.commands.stop.sweep();
  assert.equal(third.advanced, 1, "重试成功：本拍收口");
  const settledOp = await context.outbox.findByKey(terminateOpKey);
  assert.equal(settledOp?.state, "settled");
  assert.equal(settledOp?.attempt, 2, "attempt 累计（重试复用同一 op，不换 id）");
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "stopped");
  assert.equal(run?.stopRequested, true, "停止屏障事实保留");
  assert.equal(run?.dataAtRisk, false, "checkpoint 已确认 saved：不虚报数据风险");
  assert.ok(context.storage.quotaReleases.includes(session.runId), "provider 确认后释放配额槽");
});

test("P1 封顶告警：attempt 达上限后不再重排队，op 保持 failed、run 留给 keepalive liveness", async () => {
  const context = buildTestPlane();
  const session = await seedReadyRun(context);
  const stopped = await context.plane.commands.stop.stopTask({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.ok(stopped.ok);
  await settleStopCheckpointSaved(context, session);
  context.driver.terminateStatus = "notTerminated";

  // 逐次按阶梯推进时钟驱动重试，直至 attempt 封顶（10 次）。
  const terminateOpKey = `terminate:${session.runId}:${session.runGeneration}`;
  await context.plane.commands.stop.sweep();
  for (let attempt = 2; attempt <= TERMINATE_RETRY_MAX_ATTEMPTS; attempt += 1) {
    context.clock.advance(terminateRetryIntervalMs(attempt - 1));
    await context.plane.commands.stop.sweep();
    assert.equal(
      (await context.outbox.findByKey(terminateOpKey))?.attempt,
      attempt,
      `第 ${attempt} 次 provider 重试`,
    );
  }
  assert.equal(
    (await context.outbox.findByKey(terminateOpKey))?.state,
    "failed",
    "封顶时保持 failed",
  );

  // 封顶后即使退避窗口再长也不再重排队/打 provider（升级告警通路；结构化 error 日志）。
  const callsAtCap = context.driver.terminateCalls;
  context.clock.advance(600_000);
  const stalled = await context.plane.commands.stop.sweep();
  assert.equal(stalled.waitingSave, 1, "封顶后不再收口：等待 keepalive liveness 兜底");
  context.clock.advance(600_000);
  await context.plane.commands.stop.sweep();
  assert.equal(context.driver.terminateCalls, callsAtCap, "封顶后不打 provider");
  assert.equal((await context.storage.runs.get(session.runId))?.status, "draining");
});

test("P1 paused 起源停止（屏障无 op）：stop sweep 驱动 terminate 重试收口，不再 waitingSave 死循环", async () => {
  const context = buildTestPlane();
  const session = await seedPausedRun(context);
  // provider 拒绝终止：stopTask 的即时推进（advancePausedStop）失败，run 停在 draining
  //（pauseResume.sweep 只处理 paused，stop sweep 的屏障指针不入队 → 原实现死等）。
  context.driver.terminateStatus = "notTerminated";
  const stopped = await context.plane.commands.stop.stopTask({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.ok(stopped.ok);
  const draining = await context.storage.runs.get(session.runId);
  assert.equal(draining?.status, "draining");
  assert.ok(draining?.stopOperationId, "屏障已写（paused 起源：无 checkpoint op 行）");
  assert.equal(await context.outbox.get(draining?.stopOperationId ?? ""), null, "op 未入队");
  const terminateOpKey = `terminate:${session.runId}:${session.runGeneration}`;
  assert.equal((await context.outbox.findByKey(terminateOpKey))?.state, "failed", "首次拒绝已结算");

  // 未到退避：sweep 驱动 terminateRun 但不打 provider，保持等待。
  const first = await context.plane.commands.stop.sweep();
  assert.equal(first.waitingSave, 1);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "draining");

  // 退避到期：重排队 → 重试成功 → 收口 stopped；无 checkpoint 证据 → dataAtRisk 如实标注。
  context.clock.advance(31_000);
  context.driver.terminateStatus = "terminated";
  const second = await context.plane.commands.stop.sweep();
  assert.equal(second.advanced, 1);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "stopped");
  assert.equal(run?.dataAtRisk, true, "无已保存事实：不虚报（08 §8.2）");
  assert.equal(run?.endReason, "stop");
});

// ── C.【P1】resume 触发输入放宽（03 §6 修订） ──

test("P1 resume 触发：paused run 只有 uncertain 输入 → sweep 自驱 resume（不僵尸）", async () => {
  const context = buildTestPlane();
  const session = await seedPausedRun(context, { admitStartInput: true });

  // 无 deliverable 输入：不 resume（负例对照）。
  const idle = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(idle.resumed, 0);

  // append 被 TOCTOU/重启归为 uncertain（对账待收敛态）：仍是用户等待意图。
  const commandId = await appendInput(context, session, 1);
  const marked = await context.storage.inputs.markDelivery({
    taskId: session.taskId,
    commandId,
    to: "uncertain",
    now: context.clock.now(),
  });
  assert.ok(marked, "accepted → uncertain 是合法迁移（03 §8 对账入口）");

  context.driver.pauseResume = "memory";
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.resumed, 1, "uncertain 输入触发自驱 resume");
  assert.equal(context.driver.resumeCalls, 1);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "ready");
  // resume 通路不直接投递：uncertain 输入由既有 reconcile/重投通路收敛。
  const input = await context.storage.inputs.get(session.taskId, commandId);
  assert.equal(input?.deliveryStatus, "uncertain");
});

test("P1 resume 触发：delivering 输入同样触发；输家分支（预算耗尽）行为不变", async () => {
  const context = buildTestPlane();
  const session = await seedPausedRun(context, { admitStartInput: true });
  const commandId = await appendInput(context, session, 2);
  await context.storage.inputs.markDelivery({
    taskId: session.taskId,
    commandId,
    to: "delivering",
    now: context.clock.now(),
  });
  context.driver.pauseResume = "memory";
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.resumed, 1, "delivering 输入触发自驱 resume");
  assert.equal((await context.storage.runs.get(session.runId))?.status, "ready");
});

// ── D.【P2】空闲占用的输入事实含 uncertain（08 §7 修订） ──

test("P2 空闲 pause：有 uncertain 输入的 run 不被暂停（可能执行中，暂停即僵尸）", async () => {
  const context = buildTestPlane({ config: { idlePauseMs: 60_000 } });
  context.driver.pauseResume = "memory";
  const session = await seedReadyRun(context);
  const deliverable = await context.storage.inputs.listDeliverable(session.taskId);
  for (const input of deliverable) {
    await context.storage.inputs.markDelivery({
      taskId: session.taskId,
      commandId: input.commandId,
      to: "admitted",
      now: context.clock.now(),
    });
  }
  await context.storage.runs.touchBusinessActivity({
    runId: session.runId,
    at: context.clock.now() - 60_000,
  });
  const commandId = await appendInput(context, session, 3);
  await context.storage.inputs.markDelivery({
    taskId: session.taskId,
    commandId,
    to: "uncertain",
    now: context.clock.now(),
  });

  const report = await context.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(report.paused, 0, "uncertain 输入占用工作面：不 pause");
  assert.equal(report.skipped, 1);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "ready");
});

test("P2 idle drain：uncertain 输入同样阻塞归档（与空闲 pause 同一口径，08 §7）", async () => {
  const context = buildTestPlane({ config: { idleArchiveThresholdMs: 1_000 } });
  // pauseResume=none（缺省门禁）：idle 归 drain 拍（单轨 F-3 的 none 级路径）。
  const session = await seedReadyRun(context);
  const deliverable = await context.storage.inputs.listDeliverable(session.taskId);
  for (const input of deliverable) {
    await context.storage.inputs.markDelivery({
      taskId: session.taskId,
      commandId: input.commandId,
      to: "admitted",
      now: context.clock.now(),
    });
  }
  await context.storage.runs.touchBusinessActivity({
    runId: session.runId,
    at: context.clock.now() - 2_000,
  });
  const commandId = await appendInput(context, session, 4);
  await context.storage.inputs.markDelivery({
    taskId: session.taskId,
    commandId,
    to: "uncertain",
    now: context.clock.now(),
  });

  const report = await context.plane.lifecycle.drain.sweep();
  assert.equal(report.began, 0, "uncertain 输入阻塞 idle drain");
  assert.equal(report.skipped, 1);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "ready");
});

// ── E.【P3】forceStopTask 的 CAS 复核（08 §8.1 修订） ──

test("P3 force-stop CAS 失败（停止推进赢得竞争）：重读 draining → advancePausedStop 收口", async () => {
  const context = buildTestPlane();
  const session = await seedPausedRun(context);
  const task = await context.storage.tasks.get(session.taskId);
  assert.ok(task);

  // 竞态模拟：force-stop 的 draining CAS 之前，stop 推进通路已把 paused→draining 落地
  //（同 generation），force-stop 的 CAS 因此失败；恢复原实现后按重读状态分支。
  const original = context.storage.runs.transitionStatus.bind(context.storage.runs);
  let intercepted = false;
  context.storage.runs.transitionStatus = async (request) => {
    if (!intercepted && request.to === "draining") {
      intercepted = true;
      context.storage.runs.transitionStatus = original;
      await original({
        runId: request.runId,
        runGeneration: request.runGeneration,
        from: ["paused"],
        to: "draining",
        endReason: "user-stop",
        now: context.clock.now(),
      });
      return null;
    }
    return original(request);
  };

  const forced = await context.plane.commands.stop.forceStopTask({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    operationId: `00000000-0000-4000-8000-${(sequence + 0xbf0).toString(16).padStart(12, "0")}`,
    expectedRevision: task.revision,
    lossAcknowledgement: true,
  });
  assert.ok(forced.ok);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "stopped", "停止推进共用实现收口终态");
  assert.equal(run?.dataAtRisk, true, "无 checkpoint 证据：如实标注（advancePausedStop 语义）");
});

test("P3 force-stop CAS 失败（resume 赢得竞争）：重读 ready → 补 draining CAS → terminate 收口", async () => {
  const context = buildTestPlane();
  const session = await seedPausedRun(context);
  const task = await context.storage.tasks.get(session.taskId);
  assert.ok(task);

  // 竞态模拟：force-stop 的 draining CAS 之前，resume sweep 已把 paused→ready 落地
  //（沙箱恢复运行）；注入 CAS 失败以覆盖「CAS 结果被丢弃」的原始缺陷分支。
  const original = context.storage.runs.transitionStatus.bind(context.storage.runs);
  let intercepted = false;
  context.storage.runs.transitionStatus = async (request) => {
    if (!intercepted && request.to === "draining") {
      intercepted = true;
      context.storage.runs.transitionStatus = original;
      await original({
        runId: request.runId,
        runGeneration: request.runGeneration,
        from: ["paused"],
        to: "ready",
        now: context.clock.now(),
      });
      return null;
    }
    return original(request);
  };

  const forced = await context.plane.commands.stop.forceStopTask({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    operationId: `00000000-0000-4000-8000-${(sequence + 0xc00).toString(16).padStart(12, "0")}`,
    expectedRevision: task.revision,
    lossAcknowledgement: true,
  });
  assert.ok(forced.ok);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "stopped", "不滞留 ready+stopRequested 拖到硬期限");
  assert.equal(run?.endReason, "force-stop", "补写的 draining CAS 携带 force-stop 标注");
  assert.equal(run?.dataAtRisk, true, "显式丢失确认：如实标注（08 §8.2）");
  assert.ok(context.driver.terminateCalls >= 1);
});

/**
 * 生命周期 v2 第 3 批验收：空闲 pause 策略（决策文档 D3 定稿附录、specs/cloud-agent/08 §7
 * 的 2026-10-09 修订）+ 第 2 批遗留 1/2。
 *
 * 覆盖：
 * - idlePolicy 纯决策全分支（D5：决策与 IO 分离，测试不打桩）：阈值边界（≥）、禁用（0）、
 *   非 ready、stopRequested 优先、能力门禁 none（fail-closed）、有客户端连接（v1 简化：
 *   有连接即不算空闲）、pending input、checkpoint 在途、无活动事实、disk 级参与；
 * - 配置解析全分支：`ZCODE_CLOUD_SANDBOX_IDLE_PAUSE_SECONDS`（contract 登记 → 解析 →
 *   校验 → 装配透传），缺省 600s、0=禁用、负数/非整数 fail-closed 报 issue；
 * - lifecycleLoops 集成：空闲触发 pauseRun（B-4 顺序）、有连接顺延、tick 报告计数；
 * - 单轨互斥（F-3）：memory 级 provider 的 idle 归空闲 pause（drain.sweep 关闭 idle 分支），
 *   none provider 维持 idle drain——同一 run 不得既被 pause 又被 idle drain；
 * - 第 2 批遗留 1：force-stop 对 paused 先推进 draining（迁移表无 paused→stopped 边）；
 * - 第 2 批遗留 2：keepalive liveness 跳过 stopRequested=1（非 draining）run 的收口——
 *   终态由 stop 推进路径定 stopped，不与 stop 屏障抢收口权。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { decideIdlePause } from "../src/cloud/app/lifecycle/idlePolicy.js";
import { CLOUD_CORE_DEFAULTS, resolveCloudCoreConfig } from "../src/cloud/app/config.js";
import { canTransitionRun } from "../src/cloud/domain/taskRunState.js";
import { buildTestPlane, attachReadySession, type TestPlane } from "./cloudCoreFakes.js";
import type { LoopSchedulerPort } from "../src/cloud/app/ports/loopSchedulerPort.js";
import { startCloudLifecycleLoops } from "../src/cloud/app/lifecycleLoops.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";
const DEFAULT_IDLE_MS = CLOUD_CORE_DEFAULTS.idlePauseMs;

/** idlePolicy 纯决策的一组「其余条件全满足」事实基线。 */
function idleFacts(overrides: Partial<Parameters<typeof decideIdlePause>[0]> = {}) {
  const now = 10_000_000;
  return {
    runStatus: "ready" as const,
    stopRequested: false,
    pauseResume: "memory" as const,
    lastBusinessActivityAt: now - DEFAULT_IDLE_MS,
    hasBrowserWatcher: false,
    pendingInputCount: 0,
    checkpointInFlight: false,
    now,
    thresholdMs: DEFAULT_IDLE_MS,
    ...overrides,
  };
}

// ── A. idlePolicy 纯决策全分支 ──

test("idlePolicy：无活动达到阈值 → pause（边界取 ≥）", () => {
  assert.deepEqual(decideIdlePause(idleFacts()), {
    action: "pause",
    reason: "idle-threshold-met",
  });
  // 边界：恰好等于阈值 → pause；差 1ms → below-threshold。
  const now = 10_000_000;
  assert.equal(
    decideIdlePause(idleFacts({ lastBusinessActivityAt: now - DEFAULT_IDLE_MS })).action,
    "pause",
  );
  assert.deepEqual(
    decideIdlePause(idleFacts({ lastBusinessActivityAt: now - DEFAULT_IDLE_MS + 1 })),
    { action: "skip", reason: "below-threshold" },
  );
});

test("idlePolicy：阈值 0 = 部署禁用，其余条件全满足也不 pause", () => {
  assert.deepEqual(decideIdlePause(idleFacts({ thresholdMs: 0 })), {
    action: "skip",
    reason: "disabled",
  });
});

test("idlePolicy：仅 ready run 参与；provisioning/paused/draining 一律 skip", () => {
  assert.deepEqual(decideIdlePause(idleFacts({ runStatus: "provisioning" })), {
    action: "skip",
    reason: "not-ready",
  });
  assert.deepEqual(decideIdlePause(idleFacts({ runStatus: "paused" })), {
    action: "skip",
    reason: "not-ready",
  });
  assert.deepEqual(decideIdlePause(idleFacts({ runStatus: "draining" })), {
    action: "skip",
    reason: "not-ready",
  });
});

test("idlePolicy：stopRequested 优先（屏障已受理，归 stop/drain 通路）", () => {
  assert.deepEqual(decideIdlePause(idleFacts({ stopRequested: true })), {
    action: "skip",
    reason: "stop-requested",
  });
});

test("idlePolicy：能力门禁 none 不可达（fail-closed）；disk 级参与", () => {
  assert.deepEqual(decideIdlePause(idleFacts({ pauseResume: "none" })), {
    action: "skip",
    reason: "capability-none",
  });
  assert.equal(decideIdlePause(idleFacts({ pauseResume: "disk" })).action, "pause");
});

test("idlePolicy：有浏览器观看连接不 pause（v1 无「即将暂停」广播面，保守简化）", () => {
  assert.deepEqual(decideIdlePause(idleFacts({ hasBrowserWatcher: true })), {
    action: "skip",
    reason: "browser-watching",
  });
});

test("idlePolicy：工作面保护——pending input、checkpoint 在途、无活动事实都不算空闲", () => {
  assert.deepEqual(decideIdlePause(idleFacts({ pendingInputCount: 1 })), {
    action: "skip",
    reason: "pending-input",
  });
  assert.deepEqual(decideIdlePause(idleFacts({ checkpointInFlight: true })), {
    action: "skip",
    reason: "checkpoint-in-flight",
  });
  assert.deepEqual(decideIdlePause(idleFacts({ lastBusinessActivityAt: undefined })), {
    action: "skip",
    reason: "no-activity-fact",
  });
});

// ── B. 配置解析（app 层 resolveCloudCoreConfig；入口键解析见 cloudEntryConfig.test.ts）──

test("idlePauseMs 解析：缺省 600s、可覆盖、0=禁用保留、非法回落缺省", () => {
  assert.equal(resolveCloudCoreConfig().idlePauseMs, 600_000);
  assert.equal(resolveCloudCoreConfig({ idlePauseMs: 60_000 }).idlePauseMs, 60_000);
  // 0 是合法值（显式禁用），不得被 positiveInt 语义回落成默认开启。
  assert.equal(resolveCloudCoreConfig({ idlePauseMs: 0 }).idlePauseMs, 0);
  // 负数/非有限值 fail-closed 回落缺省（入口解析层已报 issue，这里是第二道防线）。
  assert.equal(resolveCloudCoreConfig({ idlePauseMs: -5 }).idlePauseMs, 600_000);
  assert.equal(resolveCloudCoreConfig({ idlePauseMs: Number.NaN }).idlePauseMs, 600_000);
});

// ── C. 控制面集成（buildTestPlane：只替换端口 fake）──

/** 手动调度器：记录注册的周期任务，测试按需逐拍驱动（不引入真实定时器）。 */
function manualScheduler() {
  const tasks = new Map<number, () => Promise<void>>();
  let counter = 0;
  const scheduler: LoopSchedulerPort = {
    schedule(intervalMs, task) {
      counter += 1;
      const id = counter;
      void intervalMs;
      tasks.set(id, task);
      return () => tasks.delete(id);
    },
    delay(_delayMs, task) {
      counter += 1;
      const id = counter;
      void task();
      return () => tasks.delete(id);
    },
  };
  return {
    scheduler,
    tick: async () => {
      for (const task of tasks.values()) await task();
    },
  };
}

/**
 * 走完 start → create → ready，并把 run 摆成「空闲 pause 候选」：
 * start 输入已投递收口（admitted，模拟 runtime ACK）、业务活动事实回拨到 `idleForMs`
 * 之前。bridge session 保持注册（沙箱存活期间 bridge 恒在线，2026-10-07 复核缺陷 1 的
 * 真实前提）；「浏览器是否观看」由 `watching` 走 BrowserWatchPort fake 单独模拟。
 */
async function idleReadyRun(
  context: TestPlane,
  options: { index: number; idleForMs: number; watching?: boolean },
): Promise<{ taskId: string; runId: string; runGeneration: number }> {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Idle flow",
    creationKey: `ck-idle-${options.index}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const commandId = `00000000-0000-4000-8000-0000000000c${options.index}`;
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId,
      prompt: "work",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  const runId = submit.value.runId ?? "";
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  await attachReadySession(context, {
    taskId: task.value.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
  });
  const ready = await context.plane.runs.markReady({
    taskId: task.value.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.ok(ready.ok);
  // start 输入已投递并被 runtime 确认（admitted）：工作面清空，才有「空闲」可言。
  const admitted = await context.storage.inputs.markDelivery({
    taskId: task.value.taskId,
    commandId,
    to: "admitted",
    now: context.clock.now(),
  });
  assert.ok(admitted);
  if (options.watching) context.browserWatch.open(run.runId);
  // 业务活动事实回拨（08 §7：lastBusinessActivityAt 是业务活动事实，非心跳）。
  await context.storage.runs.touchBusinessActivity({
    runId: run.runId,
    at: context.clock.now() - options.idleForMs,
  });
  return { taskId: task.value.taskId, runId: run.runId, runGeneration: run.runGeneration };
}

test("空闲触发 pauseRun（D3）：无活动 ≥ 阈值 + 无浏览器观看 + memory 能力 → ready→paused", async () => {
  const context = buildTestPlane({ config: { idlePauseMs: 60_000 } });
  context.driver.pauseResume = "memory";
  const session = await idleReadyRun(context, { index: 1, idleForMs: 60_000 });
  // 修复断言（2026-10-07 复核缺陷 1）：bridge session 全程在册——bridge 在线不再是
  // 空闲 pause 的阻塞事实，观看连接（BrowserWatchPort）才是。
  assert.notEqual(context.plane.attachments.current(session.runId), null, "bridge 在线");
  const report = await context.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(report.examined, 1);
  assert.equal(report.paused, 1);
  assert.equal(context.driver.pauseCalls, 1, "走 pauseRun 助手（B-4：provider 确认在前）");
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "paused");
  assert.equal(run?.endReason, "idle-pause");
  assert.equal(
    context.plane.attachments.current(session.runId),
    null,
    "B-4：CAS 前 detach registry",
  );
});

test("浏览器观看中顺延：bridge 在线 + 观看连接打开 → 同一拍 skip；关闭后恢复 pause", async () => {
  const context = buildTestPlane({ config: { idlePauseMs: 60_000 } });
  context.driver.pauseResume = "memory";
  const session = await idleReadyRun(context, {
    index: 2,
    idleForMs: 60_000,
    watching: true,
  });
  const watching = await context.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(watching.paused, 0, "有浏览器观看连接不算空闲（08 §7）");
  assert.equal(watching.skipped, 1);
  assert.equal(context.driver.pauseCalls, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "ready");

  // 观看连接关闭即清（任务通道断开）：下一拍按事实暂停。
  context.browserWatch.close(session.runId);
  const afterClose = await context.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(afterClose.paused, 1, "连接关闭后事实回落，空闲 pause 恢复");
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
});

test("能力门禁关闭（默认 none）：空闲 pause 路径休眠；阈值未达同样顺延", async () => {
  const context = buildTestPlane({ config: { idlePauseMs: 60_000 } });
  // driver pauseResume 保持默认 none（与生产 A-7 门禁同构）。
  const session = await idleReadyRun(context, { index: 3, idleForMs: 60_000 });
  const report = await context.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(report.paused, 0);
  assert.equal(report.skipped, 1);
  assert.equal(context.driver.pauseCalls, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "ready");

  // 未达阈值：有事实但不够长。
  const context2 = buildTestPlane({ config: { idlePauseMs: 60_000 } });
  context2.driver.pauseResume = "memory";
  await idleReadyRun(context2, { index: 4, idleForMs: 59_999 });
  const report2 = await context2.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(report2.paused, 0);
  assert.equal(report2.skipped, 1);
});

test("部署禁用（阈值 0）：idleSweep 整条路径休眠，不扫存储不碰 provider", async () => {
  const context = buildTestPlane({ config: { idlePauseMs: 0 } });
  context.driver.pauseResume = "memory";
  const session = await idleReadyRun(context, { index: 5, idleForMs: 3_600_000 });
  const report = await context.plane.lifecycle.pauseResume.idleSweep();
  assert.deepEqual(report, { examined: 0, paused: 0, skipped: 0, failed: 0 });
  assert.equal(context.driver.pauseCalls, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "ready");
});

test("stopRequested 优先：已受理停止的 ready run 不被空闲 pause（归 stop/drain 通路）", async () => {
  const context = buildTestPlane({ config: { idlePauseMs: 60_000 } });
  context.driver.pauseResume = "memory";
  const session = await idleReadyRun(context, { index: 6, idleForMs: 60_000 });
  await context.storage.runs.requestStop({
    taskId: session.taskId,
    operationId: "00000000-0000-4000-8000-0000000000b1",
    now: context.clock.now(),
  });
  const report = await context.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(report.paused, 0);
  assert.equal(report.skipped, 1);
  assert.equal(context.driver.pauseCalls, 0);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "ready");
  assert.equal(run?.stopRequested, true);
});

test("lifecycleTick 集成：空闲拍先于 drain，报告计数 idlePausedRuns；同拍不被 idle drain", async () => {
  const context = buildTestPlane({
    config: { idlePauseMs: 60_000, idleArchiveThresholdMs: 60_000 },
  });
  context.driver.pauseResume = "memory";
  await idleReadyRun(context, { index: 7, idleForMs: 60_000 });
  const harness = manualScheduler();
  const loops = startCloudLifecycleLoops(context.plane, { scheduler: harness.scheduler });
  const report = await loops.runOnce();
  assert.equal(report.idlePausedRuns, 1);
  const runs = await context.storage.runs.listNonTerminal();
  assert.equal(runs.length, 1);
  assert.equal(runs[0]?.status, "paused", "单轨：pause 落地，同拍未被 idle drain");
  await loops.stop();
});

test("单轨互斥（F-3）：memory 级 provider 的 idle 不走 drain.sweep，归空闲 pause；none 级维持 idle drain", async () => {
  // memory 级：drain.sweep 关闭 idle 分支（即便闲置阈值已到），idle 归空闲 pause 拍。
  const memoryContext = buildTestPlane({
    config: { idlePauseMs: 60_000, idleArchiveThresholdMs: 1_000 },
  });
  memoryContext.driver.pauseResume = "memory";
  const memorySession = await idleReadyRun(memoryContext, { index: 8, idleForMs: 60_000 });
  const drainReport = await memoryContext.plane.lifecycle.drain.sweep();
  assert.equal(drainReport.began, 0, "memory 级不被 idle drain（单轨第一道互斥的兜底守卫）");
  assert.equal((await context_run(memoryContext, memorySession.runId))?.status, "ready");
  const idleReport = await memoryContext.plane.lifecycle.pauseResume.idleSweep();
  assert.equal(idleReport.paused, 1, "idle 由空闲 pause 拍收口");
  assert.equal((await context_run(memoryContext, memorySession.runId))?.status, "paused");

  // none 级（门禁关闭/Modal 类）：维持既有 idle drain 行为不变。
  const noneContext = buildTestPlane({ config: { idleArchiveThresholdMs: 1_000 } });
  const noneSession = await idleReadyRun(noneContext, { index: 9, idleForMs: 60_000 });
  const noneDrainReport = await noneContext.plane.lifecycle.drain.sweep();
  assert.equal(noneDrainReport.began, 1, "其余 provider 维持 idle drain（08 §7 修订）");
  assert.equal((await context_run(noneContext, noneSession.runId))?.status, "draining");
});

/** 测试内取 run 的简写（避免与解构名冲突）。 */
function context_run(context: TestPlane, runId: string) {
  return context.storage.runs.get(runId);
}

test("第 2 批遗留 1：force-stop 对 paused 先推进 draining（迁移表无 paused→stopped 边）", async () => {
  const context = buildTestPlane();
  context.driver.pauseResume = "memory";
  const session = await idleReadyRun(context, { index: 10, idleForMs: 0 });
  const paused = await context.plane.lifecycle.pauseResume.pauseRun({
    taskId: session.taskId,
    runId: session.runId,
    reason: "idle-pause",
  });
  assert.ok(paused.ok);
  const task = await context.storage.tasks.get(session.taskId);
  assert.ok(task);
  const forceStop = await context.plane.commands.stop.forceStopTask({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    operationId: "00000000-0000-4000-8000-0000000000b2",
    expectedRevision: task.revision,
    lossAcknowledgement: true,
  });
  assert.ok(forceStop.ok);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(
    run?.status,
    "stopped",
    "屏障 → paused→draining → 直接 terminate → stopped（行为表）",
  );
  assert.equal(run?.endReason, "force-stop");
  assert.equal(run?.dataAtRisk, true, "显式丢失确认：如实标 dataAtRisk（08 §8.2）");
});

test("第 2 批遗留 2：keepalive liveness 跳过 stopRequested=1 的收口，stop 路径定 stopped", async () => {
  const context = buildTestPlane();
  context.driver.pauseResume = "memory";
  const session = await idleReadyRun(context, { index: 11, idleForMs: 0 });
  const paused = await context.plane.lifecycle.pauseResume.pauseRun({
    taskId: session.taskId,
    runId: session.runId,
    reason: "idle-pause",
  });
  assert.ok(paused.ok);
  // 只写屏障（stop 受理后、推进前的形态）；provider 保留期尽（实例消失）。
  await context.storage.runs.requestStop({
    taskId: session.taskId,
    operationId: "00000000-0000-4000-8000-0000000000b3",
    now: context.clock.now(),
  });
  context.driver.inspectStatus = "notFound";
  context.clock.advance(120_000);
  // 迁移表没有 paused→stopped 边：liveness 不得把「用户已停止」的 run 收口成 expired，
  // 也不得绕过推进通路直接写 stopped——跳过，终态归 stop 推进路径。
  const report = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(report.instancesLost, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
  // stop 推进通路（与 stopTask 共用同一实现）按屏障收口 stopped。
  const sweepReport = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(sweepReport.stopAdvanced, 1);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "stopped", "stop 路径定 stopped（08 §3.2）");
  assert.equal(run?.dataAtRisk, true, "paused 停止无 checkpoint 可执行：如实标 dataAtRisk");
});

test("纯 domain 回归：迁移表保持无 paused→stopped 边（stop 推进必须先过 draining）", () => {
  assert.equal(canTransitionRun("paused", "draining"), true);
  assert.equal(canTransitionRun("paused", "stopped"), false);
});

/**
 * 生命周期 v2 审计第二批（P2）验收（specs/cloud-agent/03 修订 2026-10-09、01 §4.1 修订）：
 *
 * - 停止链路崩溃窗口自愈（keepalive 侧兜底）：draining + stopRequested + stop 指针无
 *   operation 行且停摆（paused 分支不入队 checkpoint op）→ keepalive 认领并复用
 *   advancePausedStop 直接 terminate 收口 stopped。stop sweep 对同一形态的即时驱动是
 *   第一道通路（batch6/P1）；本兜底在其停摆（超过 drain 预算仍无进展）时生效，
 *   同幂等 terminate op 键，双通路无竞争。op 存在（pending）的 run 不认领（保存重试
 *   归 stop sweep，不绕过保存前置，08 §8.1）。
 * - 启动对账 stop-pending 守卫：已受理停止、未在停止推进中的 run 不以 expired 落账，
 *   终态交停止推进通路收口 stopped。
 * - 暂停预算耗尽的时间兜底：paused + 预算耗尽超宽限（PAUSED_BUDGET_TERMINATION_GRACE_MS）
 *   → 经既有终止入口主动终止，provider 确认后收口 expired 并释放槽；带停止意图的 paused
 *   run 不走该兜底（终态语义归停止推进通路）。
 * - disk-pause 观测调停：paused run 的 stopped 观测按保留态处理不收口（keepalive 与
 *   启动对账同口径）；notFound 才是真终局。
 * - E2B suspending 过渡态归 unknown 观测（映射 + wire 层）。
 * - 预算耗尽闭环两条降级路径：触发输入 cancelled 收口带明确 lastError（UI receipt 可见）。
 * - 预算耗尽闭环触发放宽（03 §6 修订 2026-10-09，与 pauseResume.sweep 同一 domain 谓词）：
 *   只有 uncertain 输入的 paused run 也走「停旧 + 重开」闭环，prompt 取首条 deliverable
 *   append（与 accepted 同规则）；触发输入本身照旧终态收口（uncertain 保留对账）。
 * - SQLite markDelivery 与 domain canAdvanceDeliveryStatus 同口径（同态幂等改写允许）。
 *
 * 全部用例受控时钟、无 sleep、不触网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudTaskRecord } from "@zcode/shared";
import { attachReadySession, buildTestPlane, type TestPlane } from "./cloudCoreFakes.js";
import { CLOUD_CORE_DEFAULTS } from "../src/cloud/app/config.js";
import {
  PAUSED_BUDGET_END_REASON,
  PAUSED_BUDGET_TERMINATION_GRACE_MS,
  PROVIDER_LIVENESS_RECHECK_MS,
} from "../src/cloud/app/lifecycle/keepalive.js";
import { BUDGET_EXHAUSTED_INPUT_LAST_ERROR } from "../src/cloud/app/lifecycle/budgetExhaustedClosure.js";
import type { CloudAdapterLogger } from "../src/cloud/adapters/sandbox/adapterError.js";
import {
  createE2bRestClient,
  inspectE2bSandbox,
  mapE2bSandboxState,
} from "../src/cloud/adapters/sandbox/e2bRest.js";
import type {
  SandboxFetch,
  SandboxFetchResponse,
} from "../src/cloud/adapters/sandbox/sandboxRest.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000a6";

/** adapter wire 层的静默 logger（同 cloudSandboxDrivers 的 silentLogger 形状）。 */
const silentLogger: CloudAdapterLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

function wireResponse(status: number, body: unknown): SandboxFetchResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
  };
}

/** start → create → ready → paused（经 pause 助手，同 batch2 形态）。 */
async function pausedRun(
  context: TestPlane,
  index: number,
): Promise<{ taskId: string; runId: string; runGeneration: number }> {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: `audit-batch7-${index}`,
    creationKey: `ck-b7-paused-${index}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-${(0xc60 + index).toString(16).padStart(12, "0")}`,
      prompt: "first prompt",
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
  context.driver.pauseResume = "memory";
  const paused = await context.plane.lifecycle.pauseResume.pauseRun({
    taskId: task.value.taskId,
    runId: run.runId,
    reason: "idle-pause",
  });
  assert.ok(paused.ok, `pauseRun 失败：${paused.ok === false ? paused.reason : ""}`);
  return { taskId: task.value.taskId, runId: run.runId, runGeneration: run.runGeneration };
}

/** start → create → ready（崩溃窗口负例的起点）。 */
async function readyRun(
  context: TestPlane,
  index: number,
): Promise<{ taskId: string; runId: string; runGeneration: number }> {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: `audit-batch7-ready-${index}`,
    creationKey: `ck-b7-ready-${index}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-${(0xcb0 + index).toString(16).padStart(12, "0")}`,
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
  return { taskId: task.value.taskId, runId: run.runId, runGeneration: run.runGeneration };
}

// ── 1. 停止链路崩溃窗口自愈（keepalive 侧兜底推进）──

test("崩溃窗口自愈：draining+stopRequested 无 stop op 且停摆 → keepalive 兜底推进 stopped", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context, 1);
  // 复现崩溃窗口：beginDrain 写屏障 + paused→draining 后、advancePausedStop 前崩溃
  // （paused 分支不走保存通道，checkpoint op 从未入队）。
  const drained = await context.plane.lifecycle.drain.beginDrain({
    taskId: session.taskId,
    runId: session.runId,
    reason: "user-stop",
  });
  assert.ok(drained.ok);
  const stalled = await context.storage.runs.get(session.runId);
  assert.equal(stalled?.status, "draining");
  assert.equal(stalled?.stopRequested, true);
  assert.ok(stalled?.stopOperationId, "屏障指针已写");
  assert.equal(
    stalled?.stopOperationId ? await context.outbox.get(stalled.stopOperationId) : null,
    null,
    "op 行从未入队（崩溃窗口的缺损事实）",
  );

  // drain 预算内不认领：正常推进在一拍内完成，兜底不抢跑。
  const early = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(early.stopFallbackAdvanced, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "draining");
  assert.equal(context.driver.terminateCalls, 0);

  // 停摆超过 drain 预算 → 认领：直接 terminate（无 checkpoint 前置）→ stopped。
  context.clock.advance(CLOUD_CORE_DEFAULTS.drainBudgetMs + 1);
  const report = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(report.stopFallbackAdvanced, 1);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "stopped");
  assert.equal(run?.endReason, "stop");
  assert.equal(run?.dataAtRisk, true, "op 从未入队：保存未确认，如实标 dataAtRisk（08 §8.2）");
  assert.ok(context.driver.terminateCalls >= 1, "暂停停止语义：直接 terminate 通路");
  assert.ok(context.storage.quotaReleases.includes(session.runId), "provider 确认终止后释放槽");
});

test("崩溃窗口守卫：stop op 存在（pending）的 draining run 不被认领，保存重试归 stop sweep", async () => {
  const context = buildTestPlane();
  const session = await readyRun(context, 1);
  // ready 路径的 stop：beginDrain 入队 checkpoint op（pending）。
  const drained = await context.plane.lifecycle.drain.beginDrain({
    taskId: session.taskId,
    runId: session.runId,
    reason: "user-stop",
  });
  assert.ok(drained.ok);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "draining");
  assert.ok(run?.stopOperationId);
  assert.ok(await context.outbox.get(run.stopOperationId), "ready 路径 op 已入队");

  context.clock.advance(CLOUD_CORE_DEFAULTS.drainBudgetMs + 1);
  const report = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(report.stopFallbackAdvanced, 0, "op 在：不绕过保存前置（08 §8.1）");
  assert.equal((await context.storage.runs.get(session.runId))?.status, "draining");
  assert.equal(context.driver.terminateCalls, 0);
});

// ── 2. 启动对账 stop-pending 守卫 ──

test("启动对账守卫：已受理停止的 paused run 不以 expired 落账，终态归停止推进通路", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context, 2);
  await context.storage.runs.requestStop({
    taskId: session.taskId,
    operationId: "00000000-0000-4000-8000-0000000000d2",
    now: context.clock.now(),
  });
  context.driver.inspectStatus = "notFound";
  const summary = await context.plane.reconciler.reconcileOnStartup();
  assert.equal(summary.stopPending, 1);
  assert.equal(summary.settled, 0);
  assert.equal(
    (await context.storage.runs.get(session.runId))?.status,
    "paused",
    "用户显式停止的 run 不以 expired 落账（03 修订审计第二批）",
  );

  // 停止推进通路收口 stopped（pauseResume sweep 认领 paused+stopRequested）。
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.stopAdvanced, 1);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "stopped");
  assert.equal(run?.endReason, "stop");
});

// ── 3. 暂停预算耗尽的时间兜底 ──

test("预算宽限兜底：paused 超宽限 → 主动终止收口 expired 并释放槽；宽限内不动", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context, 3);
  const run = await context.storage.runs.get(session.runId);
  assert.ok(run?.hardDeadlineAt, "start 接纳事务已落硬期限（暂停预算）");

  // 宽限内（预算耗尽但未超宽限）：维持 paused，不终止、不收口。
  context.clock.set(run.hardDeadlineAt + PAUSED_BUDGET_TERMINATION_GRACE_MS - 1);
  const early = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(early.pausedBudgetClosed, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
  assert.equal(context.driver.terminateCalls, 0);
  assert.equal(context.storage.quotaReleases.length, 0);

  // 超宽限一拍：主动终止（provider 确认为证据）→ expired + 释放槽 + dataAtRisk 如实。
  context.clock.advance(1);
  const report = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(report.pausedBudgetClosed, 1);
  const closed = await context.storage.runs.get(session.runId);
  assert.equal(closed?.status, "expired");
  assert.equal(closed?.endReason, PAUSED_BUDGET_END_REASON);
  assert.equal(closed?.dataAtRisk, true, "暂停态无已确认保存事实：不宣称工作全保住（08 §8.2）");
  assert.ok(context.driver.terminateCalls >= 1);
  assert.ok(context.storage.quotaReleases.includes(session.runId));
});

test("预算宽限兜底让位停止意图：带 stopRequested 的 paused run 不落 expired", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context, 4);
  await context.storage.runs.requestStop({
    taskId: session.taskId,
    operationId: "00000000-0000-4000-8000-0000000000d4",
    now: context.clock.now(),
  });
  const run = await context.storage.runs.get(session.runId);
  assert.ok(run?.hardDeadlineAt);
  context.clock.set(run.hardDeadlineAt + PAUSED_BUDGET_TERMINATION_GRACE_MS + 1);

  const report = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(report.pausedBudgetClosed, 0, "停止意图优先：终态语义归停止推进通路（stopped）");
  assert.equal(context.driver.terminateCalls, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
});

// ── 4. disk-pause 观测调停（paused run 的 stopped 观测不收口）──

test("观测调停：paused run 的 stopped 观测按保留态处理不收口；notFound 才 expired", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context, 5);
  // Daytona disk 级暂停：pause 当场改写 paused 后，每次 inspect 都返回 stop 系停态。
  context.driver.inspectStatus = "stopped";
  const first = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(first.instancesLost, 0, "paused + stopped 观测：disk-pause 保留态，不收口");
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
  assert.equal(context.storage.quotaReleases.length, 0);

  // notFound 才是真终局（provider 保留期尽 → expired）。
  context.driver.inspectStatus = "notFound";
  context.clock.advance(PROVIDER_LIVENESS_RECHECK_MS + 1);
  const second = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(second.instancesLost, 1);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "expired");
  assert.ok(context.storage.quotaReleases.includes(session.runId));
});

test("观测调停（启动对账）：paused run 的 stopped 观测保持 paused，不以终局落账", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context, 6);
  context.driver.inspectStatus = "stopped";
  const summary = await context.plane.reconciler.reconcileOnStartup();
  assert.equal(summary.alive, 1);
  assert.equal(summary.settled, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
});

// ── 5. E2B suspending 过渡态 → unknown ──

test("E2B 过渡态映射：suspending 归 unknown（不收口），stopped/archived 仍归 stopped", async () => {
  assert.equal(mapE2bSandboxState("suspending"), undefined, "暂停进行中：非终局，归 unknown");
  assert.equal(mapE2bSandboxState("paused"), "paused");
  assert.equal(mapE2bSandboxState("running"), "running");
  assert.equal(mapE2bSandboxState("stopped"), "stopped");
  assert.equal(mapE2bSandboxState("archived"), "stopped");

  // wire 层：inspect 返回 suspending → unknown 观察（startup/keepalive/compensation
  // 三个消费者对 unknown 都是安全的「不收口」，孤儿实例不再被误判终局）。
  let calls = 0;
  const fetch: SandboxFetch = async () => {
    calls += 1;
    return wireResponse(200, { state: "suspending" });
  };
  const rest = createE2bRestClient({
    apiKey: async () => "key",
    baseUrl: "https://api.e2b.dev",
    requestTimeoutMs: 1_000,
    fetch,
    logger: silentLogger,
  });
  const observation = await inspectE2bSandbox({
    rest,
    logger: silentLogger,
    now: () => 1,
    sandboxId: "sbx-suspending",
  });
  assert.equal(calls, 1);
  assert.equal(observation.status, "unknown");
});

// ── 6. 预算耗尽闭环降级的用户反馈 ──

test("闭环降级（reopen 被拒）：触发输入 cancelled 带明确 lastError，用户不再假等待", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context, 7);
  const commandId = "00000000-0000-4000-8000-0000000001c7";
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId,
      prompt: "too late",
      expectedRunGeneration: session.runGeneration,
    },
  });
  assert.ok(submit.ok);
  // 让 reopen 预检失败（清掉冻结基线 → task-baseline-not-frozen），复现降级路径 2。
  const staleBaseline = context.storage.tasksById.get(session.taskId);
  assert.ok(staleBaseline);
  const degradedTask: CloudTaskRecord = { ...staleBaseline };
  delete (degradedTask as Partial<CloudTaskRecord>).baseSha;
  delete (degradedTask as Partial<CloudTaskRecord>).taskBranch;
  context.storage.tasksById.set(session.taskId, degradedTask);

  const run = await context.storage.runs.get(session.runId);
  assert.ok(run?.hardDeadlineAt);
  context.clock.set(run.hardDeadlineAt + 1);
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.budgetExhausted, 1);
  assert.equal(report.budgetExhaustedReopened, 0, "串联被拒：不计数、不重试");
  assert.equal((await context.storage.runs.get(session.runId))?.status, "stopped");

  const trigger = await context.storage.inputs.get(session.taskId, commandId);
  assert.equal(trigger?.deliveryStatus, "cancelled");
  assert.equal(
    trigger?.lastError,
    BUDGET_EXHAUSTED_INPUT_LAST_ERROR,
    "run-ended 的 cancelled 收口被补注可读原因（UI receipt/历史自然可见）",
  );
});

test("闭环降级（terminate 未确认）：触发输入先收口带 lastError；随后崩溃窗口兜底收口 stopped", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context, 8);
  const commandId = "00000000-0000-4000-8000-0000000001c8";
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId,
      prompt: "too late too",
      expectedRunGeneration: session.runGeneration,
    },
  });
  assert.ok(submit.ok);
  context.driver.pauseResume = "memory";
  // 终止结果未知：advancePausedStop 无法确认 → 降级路径 1。
  context.driver.terminateStatus = "unknown";

  const run = await context.storage.runs.get(session.runId);
  assert.ok(run?.hardDeadlineAt);
  context.clock.set(run.hardDeadlineAt + 1);
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.budgetExhausted, 1);
  assert.equal(report.budgetExhaustedReopened, 0);
  const degrading = await context.storage.runs.get(session.runId);
  assert.equal(degrading?.status, "draining", "终止未确认：保持 draining 占槽");

  const trigger = await context.storage.inputs.get(session.taskId, commandId);
  assert.equal(trigger?.deliveryStatus, "cancelled", "确定未投递（预算耗尽 + 停止屏障）：先行收口");
  assert.equal(trigger?.lastError, BUDGET_EXHAUSTED_INPUT_LAST_ERROR);

  // 组合崩溃窗口兜底：终止恢复可确认后，keepalive 认领 draining+stopRequested+无
  // checkpoint op 的 run，直接 terminate 收口 stopped（terminate op ambiguous 到期重领
  // 后按 provider 证据结算）。
  context.driver.terminateStatus = "terminated";
  context.clock.advance(CLOUD_CORE_DEFAULTS.drainBudgetMs + 60_000 + 1);
  const keep = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(keep.stopFallbackAdvanced, 1);
  const closed = await context.storage.runs.get(session.runId);
  assert.equal(closed?.status, "stopped");
  assert.equal(closed?.dataAtRisk, true);
});

// ── 7. 预算耗尽闭环触发放宽（03 §6 修订：delivering/uncertain 同为触发输入）──

test("预算耗尽闭环（uncertain 触发）：paused run 只有 uncertain 输入也停旧+重开，prompt 随 reopen 携带", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context, 9);
  const commandId = "00000000-0000-4000-8000-0000000001c9";
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId,
      prompt: "uncertain wake",
      expectedRunGeneration: session.runGeneration,
    },
  });
  assert.ok(submit.ok);
  // 复现非 accepted 触发态：控制面重启把投递在途的输入归为 uncertain（03 §8 对账态）。
  // 旧判定只认 accepted 时，该输入永远触发不了闭环，run 成僵尸（audit P1 同源残留）。
  const marked = await context.storage.inputs.markDelivery({
    taskId: session.taskId,
    commandId,
    to: "uncertain",
    now: context.clock.now(),
  });
  assert.equal(marked?.deliveryStatus, "uncertain", "accepted→uncertain 是边表内合法推进");
  context.driver.pauseResume = "memory";

  const run = await context.storage.runs.get(session.runId);
  assert.ok(run?.hardDeadlineAt);
  context.clock.set(run.hardDeadlineAt + 1);
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.budgetExhausted, 1);
  assert.equal(report.budgetExhaustedReopened, 1, "uncertain 触发同样走「停旧 + 重开」闭环");
  assert.equal(context.driver.resumeCalls, 0, "预算耗尽不再发起 resume");
  const closed = await context.storage.runs.get(session.runId);
  assert.equal(closed?.status, "stopped", "旧 run 经暂停中停止推进收口终态");
  assert.equal(closed?.stopRequested, true, "复用持久停止屏障（08 §8.1）");
  assert.ok(context.driver.terminateCalls >= 1, "暂停态直接 terminate（无 checkpoint 前置）");
  // 触发输入本身照旧终态收口：uncertain 是对账态，settle 不伪称 cancelled（D4-3）。
  const trigger = await context.storage.inputs.get(session.taskId, commandId);
  assert.equal(trigger?.deliveryStatus, "uncertain");
  // reopen 携带首条 deliverable append 的 prompt（与 accepted 同规则）。
  const deliverable = await context.storage.inputs.listDeliverable(session.taskId);
  const reopenInput = deliverable.find((input) => input.intent === "reopen");
  assert.ok(reopenInput, "串联 reopen input 已被同一 gateway 接纳");
  assert.equal(reopenInput.deliveryStatus, "accepted");
  const payload = await context.storage.payloads.readInputPayload({
    taskId: session.taskId,
    commandId: reopenInput.commandId,
  });
  assert.equal(payload?.prompt, "uncertain wake", "uncertain 输入原文随 reopen 首条投递");
  assert.notEqual(reopenInput.commandId, commandId);
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created", "新 run 已进入 provisioning");
});

// ── 8. SQLite markDelivery 与 domain 同口径（同态幂等改写）──

test("SQLite markDelivery：cancelled→cancelled 幂等补注 last_error；回退仍被拒", async () => {
  const { openTestStorage, removeTestRoot, seedDraftTask, seedActiveRun } =
    await import("./cloudStorageHarness.js");
  const handle = await openTestStorage();
  try {
    const seeded = await seedDraftTask(handle.storage);
    const run = await seedActiveRun(handle.storage, seeded);
    const inputs = handle.storage.storage.inputs;
    const cancelled = await inputs.markDelivery({
      taskId: seeded.taskId,
      commandId: run.commandId,
      to: "cancelled",
      lastError: "run-ended",
      now: 2,
    });
    assert.equal(cancelled?.deliveryStatus, "cancelled");

    // 同态幂等改写（03 修订审计第二批）：预算闭环降级为已按 run-ended 落账的触发输入
    // 补注可读原因。此前 SQLite 侧按严格边表拒绝该写入（与内存 fake 语义不一致）。
    const annotated = await inputs.markDelivery({
      taskId: seeded.taskId,
      commandId: run.commandId,
      to: "cancelled",
      lastError: BUDGET_EXHAUSTED_INPUT_LAST_ERROR,
      now: 3,
    });
    assert.ok(annotated, "同态改写不被 CAS 拒绝");
    assert.equal(annotated.lastError, BUDGET_EXHAUSTED_INPUT_LAST_ERROR);

    // 越级/回退仍被拒：cancelled 没有前进边。
    const backward = await inputs.markDelivery({
      taskId: seeded.taskId,
      commandId: run.commandId,
      to: "accepted",
      now: 4,
    });
    assert.equal(backward, null);
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

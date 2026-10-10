/**
 * 断连后的 provider 事实核对（01 §4.3 只有确认释放才释放计费槽、08 §7 断连保留槽位、03 §5）。
 *
 * 现场（真实链路）：sandbox 已被 provider 删除（DELETE 204），控制面却把 run 一直留在
 * disconnected 且不释放槽位，直到硬期限——期间所有新接纳都 409 quota_exceeded。
 * 本文件断言 lifecycle sweep 会在断连/停摆时核对 provider 事实，并且**只按确定事实**收口。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { attachReadySession, buildTestPlane } from "./cloudCoreFakes.js";
import { CLOUD_CORE_DEFAULTS } from "../src/cloud/app/config.js";
import {
  PROVIDER_INSTANCE_LOST_END_REASON,
  PROVIDER_LIVENESS_RECHECK_MS,
} from "../src/cloud/app/lifecycle/keepalive.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";

/**
 * 走完 start（可选 create → ready），返回 task/run（断连、sweep 隔离用例的起点）。
 * `index` 区分同一 context 内的多个 run（sweep per-run 隔回归：三个 run 中毒一个）。
 */
async function readyRun(context: ReturnType<typeof buildTestPlane>, index = 1) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Fix login flow",
    creationKey: `ck-liveness-${index}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-0000000000c${index}`,
      prompt: "do the thing",
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

async function disconnectedRun(context: ReturnType<typeof buildTestPlane>) {
  const session = await readyRun(context);
  const disconnected = await context.plane.runs.markDisconnected({
    runId: session.runId,
    runGeneration: session.runGeneration,
    reason: "bridge-socket-closed",
  });
  assert.ok(disconnected.ok);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "disconnected");
  return session;
}

test("断连后 provider 明确实例不存在 → 按 provider-instance-lost 收口并释放槽位（01 §4.3、08 §7）", async () => {
  const context = buildTestPlane();
  const session = await disconnectedRun(context);

  context.driver.inspectStatus = "notFound";
  const report = await context.plane.lifecycle.keepalive.sweep();

  assert.equal(report.instancesLost, 1);
  assert.equal(context.driver.inspectCalls, 1);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "expired", "未请求停止却资源消失：按 expired 收口（08 §3.2）");
  assert.equal(run?.endReason, PROVIDER_INSTANCE_LOST_END_REASON);
  assert.equal(run?.dataAtRisk, true, "如实暴露风险，不宣称工作已保住（08 §8.2）");
  assert.equal(
    context.storage.quotaReleases.includes(session.runId),
    true,
    "provider 确认资源已消失后才释放计费槽",
  );
});

test("provider 报实例仍在 → 断连 run 保持不动、不释放槽位（断连本身保留槽位，08 §7）", async () => {
  const context = buildTestPlane();
  const session = await disconnectedRun(context);

  context.driver.inspectStatus = "running";
  const report = await context.plane.lifecycle.keepalive.sweep();

  assert.equal(report.instancesLost, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "disconnected");
  assert.equal(context.storage.quotaReleases.length, 0);
});

test("provider 不可达/结果未知 → 不猜、不释放槽位，只记 warn 且下一轮再查（01 §4.3、03 §5）", async () => {
  const context = buildTestPlane();
  const session = await disconnectedRun(context);

  context.driver.inspectOutcome = "throw";
  const first = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(first.instancesLost, 0);
  assert.equal(context.driver.inspectCalls, 1);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "disconnected");
  assert.equal(context.storage.quotaReleases.length, 0, "结果未知不等于资源已释放");

  // 节流窗口内不重复打 provider；超过核对周期后必须再查（最终以确定事实收口）。
  await context.plane.lifecycle.keepalive.sweep();
  assert.equal(context.driver.inspectCalls, 1, "同一核对周期内不重复打 provider");
  context.clock.advance(PROVIDER_LIVENESS_RECHECK_MS);
  await context.plane.lifecycle.keepalive.sweep();
  assert.equal(context.driver.inspectCalls, 2, "下一轮仍会再查");
});

test("已终态/已释放槽位的 run 不被重复处理（幂等）", async () => {
  const context = buildTestPlane();
  const session = await disconnectedRun(context);

  context.driver.inspectStatus = "notFound";
  await context.plane.lifecycle.keepalive.sweep();
  assert.equal(context.driver.inspectCalls, 1);

  context.clock.advance(10 * PROVIDER_LIVENESS_RECHECK_MS);
  const again = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(again.instancesLost, 0);
  assert.equal(context.driver.inspectCalls, 1, "终态 run 不再核对 provider");
  assert.equal(
    context.storage.quotaReleases.filter((runId) => runId === session.runId).length,
    1,
    "槽位只释放一次",
  );
});

test("drain 停摆且实例已消失 → 收口为 stopped 并释放槽位；未停摆不打 provider（08 §8.1）", async () => {
  const context = buildTestPlane();
  const session = await readyRun(context);
  // 保存通路在途的 drain（checkpoint op 已入队、pending）：liveness 仍负责停摆核对——
  // 「屏障无 op」的 draining run 由停止兜底通路认领（keepalive 兜底 / stop sweep），
  // 不经过本分支（cloudLifecycleBatch7）。
  const drained = await context.plane.lifecycle.drain.beginDrain({
    taskId: session.taskId,
    runId: session.runId,
    reason: "hard-deadline",
  });
  assert.ok(drained.ok);
  context.driver.inspectStatus = "notFound";

  // 仍在 drain 预算内：可能只是保存慢，不核对也不收口（"慢"不是收口依据）。
  context.clock.advance(CLOUD_CORE_DEFAULTS.drainBudgetMs - 1);
  const early = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(early.instancesLost, 0);
  assert.equal(context.driver.inspectCalls, 0, "draining 未停摆不打 provider");
  assert.equal((await context.storage.runs.get(session.runId))?.status, "draining");

  // 超过 drain 预算仍停在 draining（停摆）→ 核对一次；实例已消失 → 收口 stopped 并释放槽位。
  context.clock.advance(1);
  const report = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(report.instancesLost, 1);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "stopped");
  assert.equal(run?.endReason, PROVIDER_INSTANCE_LOST_END_REASON);
  assert.equal(run?.dataAtRisk, true, "保存未经确认：如实暴露风险（08 §8.2）");
  assert.equal(context.storage.quotaReleases.includes(session.runId), true);
});

/** start → create（不 ready）：run 停在 provisioning 且已落 provider handle。 */
async function provisioningRun(context: ReturnType<typeof buildTestPlane>, index: number) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Provision hang",
    creationKey: `ck-liveness-provisioning-${index}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-0000000000d${index}`,
      prompt: "do the thing",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  const runId = submit.value.runId ?? "";
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  const run = await context.storage.runs.get(runId);
  assert.ok(run?.providerHandle);
  return { taskId: task.value.taskId, runId: run.runId, sandboxId: run.providerHandle ?? "" };
}

test("D4-9：readiness sweep 单 run 抛错不拖垮其余 run（第二个 run 抛错，一/三仍被收口）", async () => {
  const context = buildTestPlane();
  const first = await provisioningRun(context, 1);
  const second = await provisioningRun(context, 2);
  const third = await provisioningRun(context, 3);
  // 只让第二个 run 的 provider 核验抛错（模拟毒 run）。
  context.driver.inspectThrowSandboxIds = new Set([second.sandboxId]);

  context.clock.advance(CLOUD_CORE_DEFAULTS.readinessSoftTimeoutMs + 1);
  const report = await context.plane.provisioning.readiness.sweep();

  assert.equal(report.inspected, 3, "三个 run 都被检视，毒 run 只损失自己");
  const isTerminal = (status?: string) =>
    status === "stopped" || status === "expired" || status === "failed";
  assert.equal(
    isTerminal((await context.storage.runs.get(first.runId))?.status),
    true,
    "第一个 run 仍被收口（running 无 bridge → 终止）",
  );
  assert.equal(
    ["provisioning"].includes((await context.storage.runs.get(second.runId))?.status ?? ""),
    true,
    "抛错 run 保留待下一轮（不猜、不建替代沙箱）",
  );
  assert.equal(
    isTerminal((await context.storage.runs.get(third.runId))?.status),
    true,
    "第三个 run 仍被收口",
  );
});

test("D4-9：startup 对账单 run 抛错不拖垮其余 run（ examined 全量、存活核验继续）", async () => {
  const context = buildTestPlane();
  const first = await provisioningRun(context, 1);
  const second = await provisioningRun(context, 2);
  const third = await provisioningRun(context, 3);
  context.driver.inspectThrowSandboxIds = new Set([second.sandboxId]);

  const summary = await context.plane.reconciler.reconcileOnStartup();

  assert.equal(summary.examined, 3, "毒 run 不减少其后 run 的对账");
  assert.equal(summary.alive, 2, "第一与第三个 run 仍完成存活核验");
  assert.equal(summary.settled, 0);
  assert.equal((await context.storage.runs.get(first.runId))?.status, "provisioning");
  assert.equal((await context.storage.runs.get(third.runId))?.status, "provisioning");
});

test("D4-9：keepalive 续期 extendDeadline 抛错不穿透 sweep（其余 run 仍续期）", async () => {
  const context = buildTestPlane();
  const first = await readyRun(context, 1);
  const second = await readyRun(context, 2);
  const third = await readyRun(context, 3);
  context.driver.extendDeadlineThrowSandboxIds = new Set([`sandbox-${second.runId}`]);

  // 进入续期 lead 窗口（硬期限 = 接纳时刻 + 1h，lead = 5 分钟）；start 输入未投递
  // → pendingInputCount=1 → 有业务需要续期（08 §7）。
  context.clock.advance(3_600_000 - 60_000);
  const report = await context.plane.lifecycle.keepalive.sweep();

  assert.equal(report.renewed, 2, "第一与第三个 run 续期成功");
  assert.equal(report.skipped, 1, "抛错 run 记 skipped（保持旧的已确认期限，08 §7）");
  const renewedAt = (await context.storage.runs.get(first.runId))?.expiresAt;
  assert.equal(renewedAt, 0, "fake driver 确认值被落库");
  const poisoned = await context.storage.runs.get(second.runId);
  assert.equal(
    poisoned?.expiresAt,
    context.clock.now() - (3_600_000 - 60_000) + 3_600_000,
    "抛错 run 的期限事实未被伪造推进",
  );
  assert.equal((await context.storage.runs.get(third.runId))?.expiresAt, 0);
});

/**
 * W1 app 集成测试（W1 §6：只替换端口 fake；覆盖 CP-07/08/10/11/12 与 CT-01/02/03 的非 UI 部分）。
 * 用例只驱动 app 服务与端口 fake，不启动 HTTP/WS、不触网、不 sleep。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CHECKPOINT_PENDING_MAX_ATTEMPTS } from "../src/cloud/domain/savePolicy.js";
import { checkpointOperationKey } from "../src/cloud/domain/idempotency.js";
import { attachReadySession, buildTestPlane } from "./cloudCoreFakes.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";
const OTHER_PRINCIPAL = "00000000-0000-4000-8000-0000000000cc";

async function seedDraftTask(context: ReturnType<typeof buildTestPlane>) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.equal(project.ok, true);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.ok ? project.value.projectId : "",
    title: "Fix login flow",
    creationKey: "ck-1",
    // templateRef 是服务端受控引用（11 §5）；create 需要版本/摘要固定的镜像（01 §5.1）。
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.equal(task.ok, true);
  return { project: project.ok ? project.value : null, task: task.ok ? task.value : null };
}

/** 走完 start → create → ready，返回运行上下文（供投递/停止/重开用例复用）。 */
async function startRun(context: ReturnType<typeof buildTestPlane>) {
  const { task } = await seedDraftTask(context);
  assert.ok(task);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-0000000000c1",
      prompt: "do the thing",
      expectedTaskRevision: task.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.equal(submit.ok, true, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  const runId = submit.ok ? submit.value.runId : undefined;
  assert.ok(runId);
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  await context.plane.provisioning.readiness.sweep();
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  await attachReadySession(context, {
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
  });
  const ready = await context.plane.runs.markReady({
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(ready.ok, true);
  return { task, run, readyRun: ready.ok ? ready.value : null };
}

test("CT-01/CT-02：同 principal 同 repo 只创建一个 Project，仓库身份取自动作授权事实", async () => {
  const context = buildTestPlane();
  const first = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  const second = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
    displayName: "ignored",
  });
  assert.equal(first.ok && second.ok, true);
  assert.equal(first.ok && second.ok && first.value.projectId === second.value.projectId, true);
  assert.equal(first.ok && first.value.repoOwner, "octo");
  assert.equal(first.ok && first.value.installationId, 7);
  const missing = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 999,
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.code, "not_found");
});

test("CT-03：draft 响应丢失后用原 creationKey 恢复同一 Task，且不触发 provider 调用", async () => {
  const context = buildTestPlane();
  const { task } = await seedDraftTask(context);
  const retry = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: task?.projectId ?? "",
    title: "different title",
    creationKey: "ck-1",
  });
  assert.equal(retry.ok, true);
  assert.equal(retry.ok && retry.value.taskId === task?.taskId, true);
  assert.equal(context.storage.tasksById.size, 1);
  assert.equal(context.driver.createCalls, 0, "draft 不创建 provider 资源（11 §5）");
  assert.equal(context.storage.createOperations.length, 0);
});

test("CP-08：跨主体访问统一 not_found，不泄漏存在性", async () => {
  const context = buildTestPlane();
  const { task } = await seedDraftTask(context);
  assert.ok(task);
  const foreign = await context.plane.tasks.getTask({
    principalId: OTHER_PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(foreign.ok, false);
  assert.equal(foreign.ok === false && foreign.code, "not_found");
  const detail = await context.plane.taskDetail.getDetail({
    principalId: OTHER_PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(detail.ok === false && detail.code, "not_found");
  const inputs = await context.plane.inputs.listInputs({
    principalId: OTHER_PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(inputs.ok === false && inputs.code, "not_found");
});

test("首发后 draftStartConfig 冻结，PATCH 只能改标题（03 §6、11 §5）", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  assert.ok(task && run);
  const frozen = await context.plane.tasks.patchTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    expectedRevision: (await context.storage.tasks.get(task.taskId))?.revision ?? 0,
    draftStartConfig: { baseBranch: "develop", provider: "e2b" },
  });
  assert.equal(frozen.ok, false);
  assert.equal(frozen.ok === false && frozen.reason, "draft-start-config-frozen");
});

test("R3：ready run 确定失败后 Task 收口 failed，重复收口幂等（08 §3.1 failed 行）", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  assert.ok(task && run);
  const settled = await context.plane.runs.settleTerminal({
    runId: run.runId,
    runGeneration: run.runGeneration,
    to: "failed",
    endReason: "runtime-unrecoverable",
    termination: "terminated",
  });
  assert.equal(settled.ok, true, settled.ok ? "" : `${settled.code}/${settled.reason}`);
  const runAfter = await context.storage.runs.get(run.runId);
  assert.equal(runAfter?.status, "failed");
  const taskAfter = await context.storage.tasks.get(task.taskId);
  assert.equal(taskAfter?.status, "failed", "失败 run 的 active Task 必须 CAS 为 failed");
  const revision = taskAfter?.revision ?? 0;

  // 幂等：重复 settle 已终态 run 不报错；Task 已 failed 不再重复推进 revision。
  const again = await context.plane.runs.settleTerminal({
    runId: run.runId,
    runGeneration: run.runGeneration,
    to: "failed",
    endReason: "runtime-unrecoverable",
    termination: "terminated",
  });
  assert.equal(again.ok, true);
  assert.equal((await context.storage.tasks.get(task.taskId))?.revision, revision);
});

test("R3：provisioning create 确定失败后 Task 收口 failed（08 §3.1 failed 行）", async () => {
  const context = buildTestPlane();
  context.driver.createOutcome = "throw-coded";
  context.driver.createErrorCode = "unsupported_template";
  const { task } = await seedDraftTask(context);
  assert.ok(task);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-0000000000e1",
      prompt: "go",
      expectedTaskRevision: task.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.equal(submit.ok, true, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt?.outcome, "failed");
  const stored = await context.storage.tasks.get(task.taskId);
  assert.equal(stored?.status, "failed", "provisioning 确定失败的 Task 不能停在 active");
});

test("R3：Project 软删除幂等，删除后 list / 刷新均不可见（15 §R3、03 §6）", async () => {
  const context = buildTestPlane();
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const projectId = project.value.projectId;

  const deleted = await context.plane.tasks.deleteProject({
    principalId: PRINCIPAL,
    projectId,
  });
  assert.equal(deleted.ok, true, deleted.ok ? "" : `${deleted.code}/${deleted.reason}`);
  assert.equal(context.storage.archivedProjectIds.has(projectId), true, "必须落归档写入");
  const listed = await context.plane.tasks.listProjects({ principalId: PRINCIPAL });
  assert.equal(listed.ok && listed.value.items.some((item) => item.projectId === projectId), false);
  assert.equal(await context.storage.projects.get(projectId), null, "普通读取过滤已归档");
  assert.equal(
    await context.storage.projects.findByRepository(PRINCIPAL, 101),
    null,
    "按仓库查找过滤已归档",
  );

  // 重复删除幂等：已归档事实存在时仍返回 deleted=true，不报 not_found。
  const repeated = await context.plane.tasks.deleteProject({
    principalId: PRINCIPAL,
    projectId,
  });
  assert.equal(repeated.ok, true);
  assert.deepEqual(repeated.ok ? repeated.value : null, { deleted: true });
  const stillHidden = await context.plane.tasks.listProjects({ principalId: PRINCIPAL });
  assert.equal(
    stillHidden.ok && stillHidden.value.items.some((item) => item.projectId === projectId),
    false,
    "刷新（重新 list）仍不出现",
  );
});

test("CP-12：有任务的 Project 不物理删除；有活动 run 的 Task 归档时先停止运行环境再归档", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  assert.ok(task && run);
  // Project 删除仍默认 409（03 §6、08 §9：有未归档任务时不级联丢历史）。
  const deleted = await context.plane.tasks.deleteProject({
    principalId: PRINCIPAL,
    projectId: task.projectId,
  });
  assert.equal(deleted.ok, false);
  assert.equal(deleted.ok === false && deleted.reason, "project-has-tasks");

  // 2026-10-18 用户决议：归档不再被活动 run 阻塞——归档命令先持久停止意图并经 provider
  // terminate 停止沙箱（不等待 checkpoint），随即把 Task 置为 archived。
  const archived = await context.plane.commands.taskLifecycle.archiveTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.ok(
    archived.ok,
    `有活动 run 的 Task 也可归档：${archived.ok === false ? archived.reason : ""}`,
  );
  assert.equal(archived.ok === true && archived.value.task.status, "archived");
  assert.equal(archived.ok === true && archived.value.task.archivedFromStatus, "active");
  const stopped = await context.storage.runs.get(run.runId);
  assert.equal(stopped?.status, "stopped", "provider 确认终止后 run 收口 stopped");
  assert.equal(stopped?.stopRequested, true, "归档驱动停止写持久屏障");
  assert.equal(stopped?.dataAtRisk, true, "未保存即终止：dataAtRisk 如实落库（08 §8.2）");
  assert.ok(context.driver.terminateCalls >= 1, "归档时经 provider SDK 终止沙箱");
  assert.equal(context.attachmentPort.checkpoints.length, 0, "归档停止不发起 checkpoint 请求");
  assert.ok(context.storage.quotaReleases.includes(run.runId), "provider 确认终止后释放槽");

  // 幂等：已归档任务再次归档直接返回既有详情。
  const archivedAgain = await context.plane.commands.taskLifecycle.archiveTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(archivedAgain.ok, true);
  assert.equal(archivedAgain.ok === true && archivedAgain.value.task.status, "archived");
});

test("归档 ready run：provider terminate 被调用、run 变 stopped、task archived、dataAtRisk=true（2026-10-18）", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  assert.ok(task && run);
  const archived = await context.plane.commands.taskLifecycle.archiveTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.ok(
    archived.ok,
    `归档应成功：${archived.ok === false ? `${archived.code}/${archived.reason}` : ""}`,
  );
  assert.equal(archived.ok === true && archived.value.task.status, "archived");
  const after = await context.storage.runs.get(run.runId);
  assert.equal(after?.status, "stopped");
  assert.equal(after?.stopRequested, true);
  assert.ok(after?.stopOperationId, "停止屏障持久化 stopOperationId");
  assert.equal(after?.dataAtRisk, true, "ready 运行环境未保存即终止：风险如实标注");
  assert.ok(context.driver.terminateCalls >= 1, "provider terminate 被调用");
  assert.equal(context.attachmentPort.checkpoints.length, 0, "归档不发起 checkpoint、不等待保存");
});

test("归档 terminate 未确认（unknown）：task 仍归档，run 留 draining 由 sweep 收口（2026-10-18）", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  assert.ok(task && run);
  context.driver.terminateStatus = "unknown";
  const archived = await context.plane.commands.taskLifecycle.archiveTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.ok(
    archived.ok,
    `终止未确认不阻塞归档：${archived.ok === false ? `${archived.code}/${archived.reason}` : ""}`,
  );
  assert.equal(archived.ok === true && archived.value.task.status, "archived");
  const after = await context.storage.runs.get(run.runId);
  assert.equal(after?.status, "draining", "run 留 draining 占槽，由 stop/compensation sweep 收口");
  assert.equal(after?.stopRequested, true, "停止屏障与 terminate operation 已持久");
  assert.ok(context.driver.terminateCalls >= 1, "已尝试 provider 终止");
});

test("CP-11：未 ready 的 Run 与无 attachment 时解析执行目标返回结构化 not_ready", async () => {
  const context = buildTestPlane();
  const { task } = await seedDraftTask(context);
  assert.ok(task);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-0000000000d1",
      prompt: "p",
      expectedTaskRevision: task.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.equal(submit.ok, true);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  const beforeReady = await context.plane.router.resolveExecutionTarget({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(beforeReady.ok, false);
  assert.equal(beforeReady.ok === false && beforeReady.reason, "run-provisioning");

  await context.plane.provisioning.create.runCreateOnce();
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  await attachReadySession(context, {
    taskId: task.taskId,
    runId,
    runGeneration: run.runGeneration,
  });
  await context.plane.runs.markReady({
    taskId: task.taskId,
    runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  const wrongGeneration = await context.plane.router.resolveExecutionTarget({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    expectedRunGeneration: 99,
  });
  assert.equal(wrongGeneration.ok, false);
  assert.equal(wrongGeneration.ok === false && wrongGeneration.code, "stale");
  const resolved = await context.plane.router.resolveExecutionTarget({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.ok && resolved.value.workspaceIdentity, `cloud-task:${task.taskId}`);
});

test("CP-07/CP-10：旧代际 ready 被拒绝；有活动写 run 时拒绝自动重开", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  assert.ok(task && run);
  const staleReady = await context.plane.runs.markReady({
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration + 1,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(staleReady.ok, false);
  assert.equal(staleReady.ok === false && staleReady.code, "stale");

  const eligibility = await context.plane.commands.reopen.verifyReopenEligibility(task);
  assert.equal(eligibility.ok, false);
  assert.equal(eligibility.ok === false && eligibility.code, "recovery_required");

  // 停止 + 确认终止后：重开前置放行，且仍要求显式选择恢复点（08 §9）。
  await context.plane.commands.stop.forceStopTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    operationId: "00000000-0000-4000-8000-0000000000e1",
    expectedRevision: (await context.storage.tasks.get(task.taskId))?.revision ?? 0,
    lossAcknowledgement: true,
  });
  const stopped = await context.storage.runs.get(run.runId);
  assert.equal(stopped?.status, "stopped");
  assert.equal(stopped?.dataAtRisk, true, "force-stop 是显式丢失确认（03 §6）");
  const taskAfter = await context.storage.tasks.get(task.taskId);
  assert.ok(taskAfter);
  const reopened = await context.plane.commands.reopen.verifyReopenEligibility(taskAfter);
  assert.equal(reopened.ok, true);
  assert.deepEqual(reopened.ok && reopened.value.resumeChoices, ["restart-from-base"]);
});

test("D4-12：旧实例终止未确认（槽位未释放）时拒绝自动重开，确认后放行（08 §9、01 §4.3）", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  assert.ok(task && run);
  // 终止结果未知的收口：run 状态已终态，但 provider 处置未确认、计费槽仍保留
  //（01 §4.3「终止结果未知的资源都占槽」，runOrchestrator 允许该状态存在）。
  const settled = await context.plane.runs.settleTerminal({
    runId: run.runId,
    runGeneration: run.runGeneration,
    to: "expired",
    endReason: "provider-unknown",
    termination: "notTerminated",
  });
  assert.ok(settled.ok);
  assert.equal(context.storage.quotaReleases.includes(run.runId), false, "终止未确认不释放槽位");
  const taskAfter = await context.storage.tasks.get(task.taskId);
  assert.ok(taskAfter);
  const blocked = await context.plane.commands.reopen.verifyReopenEligibility(taskAfter);
  assert.equal(blocked.ok, false);
  assert.ok(!blocked.ok && blocked.code === "recovery_required");
  assert.ok(
    !blocked.ok && blocked.reason === "previous-run-termination-unconfirmed",
    "结构化 reason：旧实例处置未确认（防双沙箱计费槽）",
  );

  // liveness 对账确认终止并释放槽位后（keepalive sweep 的正常产出），重开放行。
  await context.storage.runs.releaseQuota({
    runId: run.runId,
    reason: "provider-terminated",
    now: context.clock.now(),
  });
  const taskConfirmed = await context.storage.tasks.get(task.taskId);
  assert.ok(taskConfirmed);
  const allowed = await context.plane.commands.reopen.verifyReopenEligibility(taskConfirmed);
  assert.equal(allowed.ok, true);
});

test("stop 意图阻断 ready 发布与投递（08 §8.1、CT-15）", async () => {
  const context = buildTestPlane();
  const { task } = await seedDraftTask(context);
  assert.ok(task);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-0000000000f1",
      prompt: "p",
      expectedTaskRevision: task.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  // create 之前取消：屏障阻断启动，run 收口为 stopped 且不创建资源。
  const stopped = await context.plane.commands.stop.stopTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(stopped.ok, true);
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt?.outcome, "skipped");
  assert.equal(attempt?.reason, "stop-requested");
  assert.equal(context.driver.createCalls, 0);
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.status, "stopped");
  const detail = await context.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(detail.ok, true);
  assert.equal(
    detail.ok ? detail.value.activeRun : null,
    undefined,
    "终态 run 不再是有效写 run：activeOfTask 只回非终态（08 §4.2，与真实 repo 同口径）",
  );
});

test("心跳看门狗：超时只把 Run 推进到 disconnected（02 §8、08 §3.2）", async () => {
  const context = buildTestPlane();
  const { run } = await startRun(context);
  context.plane.attachments.heartbeat({
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
    at: context.clock.now(),
  });
  context.clock.advance(120_000);
  const report = await context.plane.watchdog.sweep();
  assert.equal(report.expired, 1);
  const after = await context.storage.runs.get(run.runId);
  assert.equal(after?.status, "disconnected", "断连不是 expired/failed");
  assert.equal(
    context.plane.attachments.current(run.runId),
    null,
    "失效连接不再被解析为有效 attachment",
  );
});

test("保活：不支持 extend 不伪造续期；成功续期按 runGeneration CAS（08 §7、01 §4.3）", async () => {
  const context = buildTestPlane();
  const { run } = await startRun(context);
  await context.storage.runs.touchBusinessActivity({ runId: run.runId, at: context.clock.now() });
  await context.storage.runs.updateLease({
    runId: run.runId,
    runGeneration: run.runGeneration,
    expiresAt: context.clock.now() + 60_000,
    now: context.clock.now(),
  });
  context.driver.extendDeadline = async () => ({ status: "unsupported" });
  const unsupported = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(unsupported.unsupported, 1);
  assert.equal(
    (await context.storage.runs.get(run.runId))?.expiresAt,
    context.clock.now() + 60_000,
    "保留上一次已确认的 expiresAt",
  );

  context.driver.extendDeadline = async () => ({ status: "confirmed", expiresAt: 12_345 });
  const renewed = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(renewed.renewed, 1);
  assert.equal((await context.storage.runs.get(run.runId))?.expiresAt, 12_345);
});

test("硬期限 drain 会写持久屏障并请求沙箱侧收口（08 §7/§8.1）", async () => {
  const context = buildTestPlane();
  const { run } = await startRun(context);
  await context.storage.runs.updateLease({
    runId: run.runId,
    runGeneration: run.runGeneration,
    hardDeadlineAt: context.clock.now() + 60_000,
    now: context.clock.now(),
  });
  const report = await context.plane.lifecycle.drain.sweep();
  assert.equal(report.began, 1);
  const after = await context.storage.runs.get(run.runId);
  assert.equal(after?.status, "draining");
  assert.equal(after?.stopRequested, true, "先持久停止屏障再通知（08 §8.1）");
  assert.equal(context.attachmentPort.drains.length, 1);
  assert.equal(context.attachmentPort.checkpoints.length, 1);
});

test("checkpoint 结果落库与操作结算（08 §8.2、03 §5）", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  const taskBranch = (await context.storage.tasks.get(task.taskId))?.taskBranch;
  assert.ok(taskBranch, "首次接纳已冻结任务分支");
  await context.plane.commands.stop.stopTask({ principalId: PRINCIPAL, taskId: task.taskId });
  const operationId = (await context.storage.runs.get(run.runId))?.stopOperationId ?? "";
  const saved = await context.plane.lifecycle.checkpoints.handleCheckpointResult({
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    frame: {
      protocolVersion: 1,
      type: "checkpoint.result",
      operationId,
      status: "saved",
      branch: taskBranch,
      remoteSha: "d".repeat(40),
      hadNewCommits: true,
    },
  });
  assert.equal(saved.ok && saved.value.state, "saved");
  assert.equal((await context.storage.tasks.get(task.taskId))?.lastCheckpointSha, "d".repeat(40));
  const sweep = await context.plane.lifecycle.checkpoints.sweepCheckpointOperations();
  assert.equal(sweep.settled, 1, "只有带租约的 worker 结算 operation");
  const operation = await context.outbox.get(operationId);
  assert.equal(operation?.state, "settled");

  // 无合法 remote SHA 的 saved 结果 fail-closed，不写 saved（08 §8.1 第三批）。
  // R2：结果必须对应真实 operation（15 §3），因此为这条用例另入队一个 checkpoint op。
  const bogusOperationId = "00000000-0000-4000-8000-0000000000b7";
  await context.outbox.enqueue({
    operationId: bogusOperationId,
    kind: "checkpoint",
    idempotencyKey: checkpointOperationKey(run.runId, bogusOperationId),
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    now: context.clock.now(),
  });
  const bogus = await context.plane.lifecycle.checkpoints.handleCheckpointResult({
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    frame: {
      protocolVersion: 1,
      type: "checkpoint.result",
      operationId: bogusOperationId,
      status: "saved",
      branch: taskBranch,
      remoteSha: "not-a-sha",
    },
  });
  assert.equal(bogus.ok && bogus.value.state, "pending");
  assert.equal(
    bogus.ok && bogus.value.confirmedRemoteSha,
    undefined,
    "无证据不写 confirmedRemoteSha",
  );
  assert.equal(bogus.ok && typeof bogus.value.riskSummary === "string", true);
});

test("R2 checkpoint 归属与单调性：伪造 operation / 错误 branch / 迟到 failed 均不覆盖保存事实", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  const taskBranch = (await context.storage.tasks.get(task.taskId))?.taskBranch;
  assert.ok(taskBranch, "首次接纳已冻结任务分支");
  await context.plane.commands.stop.stopTask({ principalId: PRINCIPAL, taskId: task.taskId });
  const base = {
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
  } as const;
  const enqueueCheckpoint = async (operationId: string) => {
    await context.outbox.enqueue({
      operationId,
      kind: "checkpoint",
      idempotencyKey: checkpointOperationKey(run.runId, operationId),
      taskId: task.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      now: context.clock.now(),
    });
  };

  // ① 不存在（伪造）的 operationId：拒绝记录，不改 dataAtRisk / lastCheckpointSha。
  const forged = await context.plane.lifecycle.checkpoints.handleCheckpointResult({
    ...base,
    frame: {
      protocolVersion: 1,
      type: "checkpoint.result",
      operationId: "00000000-0000-4000-8000-0000000000f1",
      status: "saved",
      branch: taskBranch,
      remoteSha: "f".repeat(40),
      hadNewCommits: true,
    },
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.ok === false && forged.reason, "checkpoint-operation-not-found");
  assert.equal(context.storage.checkpoints.length, 0, "伪造结果不落库");
  assert.equal((await context.storage.runs.get(run.runId))?.dataAtRisk, false);
  assert.equal((await context.storage.tasks.get(task.taskId))?.lastCheckpointSha, undefined);

  // ② saved 但 branch 不是 Task 的任务分支：fail-closed 记为 failed，不伪造 saved。
  const wrongBranchOperationId = "00000000-0000-4000-8000-0000000000f2";
  await enqueueCheckpoint(wrongBranchOperationId);
  const wrongBranch = await context.plane.lifecycle.checkpoints.handleCheckpointResult({
    ...base,
    frame: {
      protocolVersion: 1,
      type: "checkpoint.result",
      operationId: wrongBranchOperationId,
      status: "saved",
      branch: "zcode/task-other-branch",
      remoteSha: "a".repeat(40),
      hadNewCommits: true,
    },
  });
  assert.equal(wrongBranch.ok && wrongBranch.value.state, "failed");
  assert.equal(wrongBranch.ok && wrongBranch.value.confirmedRemoteSha, undefined);
  assert.equal((await context.storage.runs.get(run.runId))?.dataAtRisk, true);
  assert.equal(
    (await context.storage.tasks.get(task.taskId))?.lastCheckpointSha,
    undefined,
    "错误分支不得推进 lastCheckpointSha",
  );

  // ③ 同一 operationId 已 saved：迟到 failed 不得覆盖记录/风险标注/lastCheckpointSha。
  const savedOperationId = "00000000-0000-4000-8000-0000000000f3";
  await enqueueCheckpoint(savedOperationId);
  const saved = await context.plane.lifecycle.checkpoints.handleCheckpointResult({
    ...base,
    frame: {
      protocolVersion: 1,
      type: "checkpoint.result",
      operationId: savedOperationId,
      status: "saved",
      branch: taskBranch,
      remoteSha: "e".repeat(40),
      hadNewCommits: true,
    },
  });
  assert.equal(saved.ok && saved.value.state, "saved");
  assert.equal((await context.storage.runs.get(run.runId))?.dataAtRisk, false);
  assert.equal((await context.storage.tasks.get(task.taskId))?.lastCheckpointSha, "e".repeat(40));

  context.clock.advance(1_000);
  const lateFailed = await context.plane.lifecycle.checkpoints.handleCheckpointResult({
    ...base,
    frame: {
      protocolVersion: 1,
      type: "checkpoint.result",
      operationId: savedOperationId,
      status: "failed",
      errorCode: "checkpoint_failed",
      error: "late failure",
    },
  });
  assert.equal(lateFailed.ok && lateFailed.value.state, "saved", "saved 是终态");
  const persisted = (await context.storage.projections.listCheckpoints(task.taskId)).find(
    (item) => item.operationId === savedOperationId,
  );
  assert.equal(persisted?.state, "saved");
  assert.equal(persisted?.confirmedRemoteSha, "e".repeat(40));
  assert.equal((await context.storage.runs.get(run.runId))?.dataAtRisk, false);
  assert.equal((await context.storage.tasks.get(task.taskId))?.lastCheckpointSha, "e".repeat(40));
});

test("启动对账：重启把在途投递收口为 uncertain，按 provider 存活/终止分流（03 §8）", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  await context.storage.inputs.markDelivery({
    taskId: task.taskId,
    commandId: (await context.storage.inputs.listDeliverable(task.taskId))[0]?.commandId ?? "",
    to: "delivering",
    runId: run.runId,
    now: context.clock.now(),
  });
  const alive = await context.plane.reconciler.reconcileOnStartup();
  assert.equal(alive.alive, 1);
  assert.equal(alive.inputsUncertain, 1, "receipt 无 ACK 先置 uncertain（02 §6.3）");
  assert.equal((await context.storage.runs.get(run.runId))?.status, "ready", "不创建重复沙箱");

  context.driver.inspectStatus = "stopped";
  const terminated = await context.plane.reconciler.reconcileOnStartup();
  assert.equal(terminated.settled, 1);
  const after = await context.storage.runs.get(run.runId);
  assert.equal(after?.status, "expired");
  assert.equal(after?.dataAtRisk, true, "provider 终止但保存结果不可知");
});

test("complete 使用同一 drain 通路：活动 run 未终止前不宣告 completed（08 §9）", async () => {
  const context = buildTestPlane();
  const { task } = await startRun(context);
  const pending = await context.plane.commands.taskLifecycle.completeTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.ok === false && pending.reason, "completion-drain-in-progress");
  assert.equal((await context.storage.runs.activeOfTask(task.taskId))?.status, "draining");

  await context.plane.commands.stop.sweep();
  const detail = await context.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(detail.ok, true);
  // 归档前 run 已终态：complete 必须真正收口（这里 provider 未确认终止时保持 not_ready）。
  const again = await context.plane.commands.taskLifecycle.completeTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(again.ok, false);
  assert.equal(again.ok === false && again.reason, "completion-drain-in-progress");
});

test("任务详情的 actions 投影：按状态表推导、服务端仍独立校验（04 §3.3）", async () => {
  const context = buildTestPlane();
  const { task } = await seedDraftTask(context);
  assert.ok(task);
  const draftDetail = await context.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(
    draftDetail.ok && JSON.stringify(draftDetail.value.actions),
    JSON.stringify(["send-input", "archive"]),
  );

  const started = await startRun(context);
  const activeDetail = await context.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: started.task.taskId,
  });
  assert.ok(activeDetail.ok);
  const actions = activeDetail.value.actions;
  assert.ok(actions.includes("stop"), "活动 run 可停止");
  assert.ok(actions.includes("force-stop"), "显式强制停止是单独动作");
  assert.ok(actions.includes("complete"), "active 可验收（必要时先 drain）");
  assert.ok(actions.includes("send-input"), "ready run 可追加输入");
  assert.ok(actions.includes("extend"), "provider 支持续期时投影 extend");
  assert.ok(
    actions.includes("archive"),
    "有活动写 run 时也可归档（2026-10-18：服务端先停止运行环境再归档）",
  );
  assert.equal(activeDetail.value.actions.length > 0, true);

  // actions 不是授权凭据：停止后 stop 立即从投影消失，但服务端仍会独立校验。
  await context.plane.commands.stop.stopTask({
    principalId: PRINCIPAL,
    taskId: started.task.taskId,
  });
  const stopping = await context.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: started.task.taskId,
  });
  assert.ok(stopping.ok);
  assert.equal(stopping.value.actions.includes("stop"), false, "受理停止后不再开放 stop");
  assert.equal(stopping.value.actions.includes("send-input"), false, "停止屏障下不再开放新输入");
  assert.ok(stopping.value.actions.includes("force-stop"));
});

test("任务详情暴露 attachment 瞬态连接事实：run=ready 不代表 attachment ready（resume 窗口）", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  assert.ok(task && run);

  // resume 窗口：run 已被控制面 CAS 为 ready，但 bridge 尚未重连 → attachment 未 ready。
  context.attachmentPort.setReady(run.runId, false);
  const notReady = await context.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.ok(notReady.ok);
  assert.equal(notReady.value.activeRun?.status, "ready", "连接事实不得改写 run 状态");
  assert.equal(notReady.value.attachmentReady, false, "attachment 未回连时详情如实投影 false");

  // attachment 回连后同一 run 的详情翻为 true（瞬态事实，不是持久状态）。
  context.attachmentPort.setReady(run.runId, true);
  const ready = await context.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.ok(ready.ok);
  assert.equal(ready.value.attachmentReady, true);

  // 无 activeRun（draft）时不带该字段：连接事实只对当前 run 有意义。
  // 独立装配：同一平面里 creationKey 去重会复用上面已启动的任务。
  const draftContext = buildTestPlane();
  const draft = await seedDraftTask(draftContext);
  assert.ok(draft.task);
  const draftDetail = await draftContext.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: draft.task.taskId,
  });
  assert.ok(draftDetail.ok);
  assert.equal("attachmentReady" in draftDetail.value, false);
});

test("reactivate 需要 PR 状态投影：有 prRef 时明确 not_implemented（CR-4）", async () => {
  const context = buildTestPlane();
  const { task } = await seedDraftTask(context);
  assert.ok(task);
  await context.storage.tasks.transitionStatus({
    taskId: task.taskId,
    from: ["draft"],
    to: "completed",
    // `revision` 是新的 revision（必须严格大于当前值），不是 CAS 期望值（ports/taskPort.ts:41-46）。
    revision: task.revision + 1,
    completeRequested: true,
    now: context.clock.now(),
  });
  // PR 状态来自 artifact 投影（读取端口未冻结，见报告 CR-4）：有 prRef 时必须明确拒绝。
  const completed = await context.storage.tasks.get(task.taskId);
  assert.ok(completed);
  assert.equal(completed.status, "completed", "前置：CAS 已把 draft 迁移到 completed（08 §3.1）");
  context.storage.tasksById.set(completed.taskId, { ...completed, prRef: "42" });
  const withPr = await context.plane.commands.taskLifecycle.reactivateTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(withPr.ok, false);
  assert.equal(withPr.ok === false && withPr.code, "not_implemented");
  const reactivated = await context.plane.commands.taskLifecycle.reactivateTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(reactivated.ok, false, "有 prRef 时不允许 reactivate");
  const activated = await context.plane.commands.taskLifecycle.restoreTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(activated.ok, false, "非 archived 不能 restore");
});

// ── 第 4 批（D4-4 剩余 + C-1/C-4）：stop op 链与 checkpoint 僵尸治理 ──

test("C-1：已有停止屏障时 beginDrain 复用 run.stopOperationId，不新建 op 不改写指针", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  const first = await context.plane.commands.stop.stopTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(first.ok, true);
  const barrierId = (await context.storage.runs.get(run.runId))?.stopOperationId ?? "";
  assert.ok(barrierId);
  assert.equal(
    [...context.outbox.records.values()].filter((op) => op.kind === "checkpoint").length,
    1,
    "第一次 stop 只入队一个 checkpoint op",
  );

  // 幂等重试 + drain sweep 重试：都不得新建第二个 checkpoint 意图。
  const again = await context.plane.commands.stop.stopTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(again.ok, true);
  const checkpointOps = [...context.outbox.records.values()].filter(
    (op) => op.kind === "checkpoint",
  );
  assert.equal(checkpointOps.length, 1, "重试不得新建第二个 checkpoint 意图（C-1）");
  assert.equal(checkpointOps[0]?.operationId, barrierId);
  assert.equal(
    (await context.storage.runs.get(run.runId))?.stopOperationId,
    barrierId,
    "屏障指针不被改写",
  );
  // 重试仍会把保存通知按**同一 operationId** 重发到沙箱（重试成功的回写通道）。
  assert.ok(context.attachmentPort.checkpoints.length >= 2);
  assert.ok(
    context.attachmentPort.checkpoints.every((id) => id === barrierId),
    "重发必须携带同一 operationId",
  );
});

test("D4-4：stop op 重试成功按最新状态收口，不再假 dataAtRisk", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  const taskBranch = (await context.storage.tasks.get(task.taskId))?.taskBranch;
  assert.ok(taskBranch, "首次接纳已冻结任务分支");
  await context.plane.commands.stop.stopTask({ principalId: PRINCIPAL, taskId: task.taskId });
  const operationId = (await context.storage.runs.get(run.runId))?.stopOperationId ?? "";

  // 第一次保存失败：op 结算 failed，dataAtRisk 如实标注（08 §8.2）。
  await context.plane.lifecycle.checkpoints.handleCheckpointResult({
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    frame: {
      protocolVersion: 1,
      type: "checkpoint.result",
      operationId,
      status: "failed",
      errorCode: "checkpoint_failed",
      error: "git push rejected",
    },
  });
  const settleFailed = await context.plane.lifecycle.checkpoints.sweepCheckpointOperations();
  assert.equal(settleFailed.failed, 1);
  assert.equal((await context.storage.runs.get(run.runId))?.dataAtRisk, true);

  // 预算内重试：stop sweep 走 beginDrain（复用同一 op），沙箱重试成功回写同一 operationId。
  const retrySweep = await context.plane.commands.stop.sweep();
  assert.equal(retrySweep.waitingSave, 1, "failed 且预算未耗尽：走重试");
  assert.ok(
    context.attachmentPort.checkpoints.filter((id) => id === operationId).length >= 2,
    "重试按同一 operationId 重发保存请求",
  );
  await context.plane.lifecycle.checkpoints.handleCheckpointResult({
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    frame: {
      protocolVersion: 1,
      type: "checkpoint.result",
      operationId,
      status: "saved",
      branch: taskBranch,
      remoteSha: "e".repeat(40),
      hadNewCommits: true,
    },
  });

  // 失败的 op 行不再被租约结算：stop sweep 按记录的最新事实（saved）放行收口。
  const finalSweep = await context.plane.commands.stop.sweep();
  assert.equal(finalSweep.advanced, 1);
  const finished = await context.storage.runs.get(run.runId);
  assert.equal(finished?.status, "stopped");
  assert.equal(finished?.dataAtRisk, false, "重试成功不得假 dataAtRisk（读最新 op 状态，08 §8.2）");
});

test("force-stop 不入队保存前置：sweep 查不到 op 时跳过保存通路等待 terminate（C-1/D4-4）", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  const detail = await context.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.ok(detail.ok);
  // 终止无法核验：run 停在 draining，stop sweep 才会走到「查 op」分支。
  context.driver.terminateStatus = "unknown";
  const stopped = await context.plane.commands.stop.forceStopTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    operationId: "00000000-0000-4000-8000-0000000000fe",
    expectedRevision: detail.ok ? detail.value.task.revision : 0,
    lossAcknowledgement: true,
  });
  assert.equal(stopped.ok, true);
  const draining = await context.storage.runs.get(run.runId);
  assert.equal(draining?.status, "draining");
  assert.equal(draining?.stopRequested, true);
  assert.equal(
    draining?.endReason,
    "force-stop",
    "前置：force-stop 的屏障指针是客户端 operationId（从未入队）",
  );
  assert.equal(
    [...context.outbox.records.values()].some((op) => op.kind === "checkpoint"),
    false,
    "force-stop 跳过保存前置：没有 checkpoint op",
  );

  const report = await context.plane.commands.stop.sweep();
  assert.equal(report.waitingSave, 1);
  assert.equal(context.attachmentPort.checkpoints.length, 0, "不得对 force-stop 重启保存通路");
  assert.equal(context.attachmentPort.drains.length, 0, "不得对 force-stop 重启保存通路");
  assert.equal(
    (await context.storage.runs.get(run.runId))?.status,
    "draining",
    "保持等待 terminate（compensation 循环按 op 收口）",
  );
});

test("C-4：run 已终态后僵尸 checkpoint op 结算为 failed，不再无限 pending", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  await context.plane.commands.stop.stopTask({ principalId: PRINCIPAL, taskId: task.taskId });
  const operationId = (await context.storage.runs.get(run.runId))?.stopOperationId ?? "";
  // 保存结果永远不来（沙箱死了）：run 直接到达终态。
  const terminal = await context.storage.runs.transitionStatus({
    runId: run.runId,
    runGeneration: run.runGeneration,
    from: ["draining"],
    to: "stopped",
    endReason: "stop",
    now: context.clock.now(),
  });
  assert.ok(terminal);

  const report = await context.plane.lifecycle.checkpoints.sweepCheckpointOperations();
  assert.equal(report.failed, 1, "run 终态 → op 结算 failed（reason=run-terminal）");
  const operation = await context.outbox.get(operationId);
  assert.equal(operation?.state, "failed");
  assert.deepEqual(await context.outbox.listUnsettled(), [], "僵尸 op 不再留在 unsettled 集合");
  // 幂等：再次 sweep 不重复处理已结算 op。
  const again = await context.plane.lifecycle.checkpoints.sweepCheckpointOperations();
  assert.equal(again.failed, 0);
});

test("C-4：结果长期未到的 pending op 按 attempt 上限结算 failed + 告警", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  await context.plane.commands.stop.stopTask({ principalId: PRINCIPAL, taskId: task.taskId });
  const operationId = (await context.storage.runs.get(run.runId))?.stopOperationId ?? "";
  // run 保持非终态（draining），但保存结果始终不来：按领取次数封顶。
  for (let round = 1; round < CHECKPOINT_PENDING_MAX_ATTEMPTS; round += 1) {
    const report = await context.plane.lifecycle.checkpoints.sweepCheckpointOperations();
    assert.equal(report.settled + report.failed, 0, `第 ${round} 轮仍保留 pending`);
    assert.equal((await context.outbox.get(operationId))?.attempt, round);
    // 租约到期后才能重领。
    context.clock.advance(30_000);
  }
  const exhausted = await context.plane.lifecycle.checkpoints.sweepCheckpointOperations();
  assert.equal(exhausted.failed, 1, "attempt 达到上限后结算 failed");
  const operation = await context.outbox.get(operationId);
  assert.equal(operation?.state, "failed");
});

test("C-4：分相领取——停止 sweep 只领屏障关联 op，周期保存不让它饿死", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  // 先入队一个周期保存 op（更早创建，FIFO 头部），再走 stop（屏障 op 更晚）。
  await context.outbox.enqueue({
    operationId: "00000000-0000-4000-8000-000000000be5",
    kind: "checkpoint",
    idempotencyKey: "checkpoint:periodic-first",
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    now: context.clock.now(),
  });
  const began = await context.plane.commands.stop.stopTask({
    principalId: PRINCIPAL,
    taskId: task.taskId,
  });
  assert.equal(began.ok, true);
  const barrierId = (await context.storage.runs.get(run.runId))?.stopOperationId ?? "";
  assert.ok(barrierId);
  assert.notEqual(barrierId, "00000000-0000-4000-8000-000000000be5");

  // 只领一个：必须领到停止屏障关联的 op，而不是 FIFO 头部的周期保存 op。
  // （barrier op 无保存结果 → 结算 pending，不进 settled/failed/ambiguous 计数。）
  const report = await context.plane.lifecycle.checkpoints.sweepCheckpointOperations({
    maxLeases: 1,
  });
  assert.equal(report.settled + report.ambiguous + report.failed, 0);
  assert.equal(
    (await context.outbox.get(barrierId))?.attempt,
    1,
    "第 1 相（停止相）先领屏障关联 op",
  );
  assert.equal(
    (await context.outbox.get("00000000-0000-4000-8000-000000000be5"))?.attempt,
    0,
    "周期保存 op 未被抢先领取（分相）",
  );

  // 第 2 相（排除屏障关联）：周期保存 op 正常被领。
  const secondPhase = await context.plane.lifecycle.checkpoints.sweepCheckpointOperations({
    maxLeases: 4,
  });
  assert.equal(
    (await context.outbox.get("00000000-0000-4000-8000-000000000be5"))?.attempt,
    1,
    "第 2 相领取周期保存 op（不饿死）",
  );
  assert.ok(secondPhase);
});

test("stop 保存失败重试会重新排队操作，attempt 可推进（2026-10-18 停止死锁回归）", async () => {
  const context = buildTestPlane();
  const { task, run } = await startRun(context);
  await context.plane.commands.stop.stopTask({ principalId: PRINCIPAL, taskId: task.taskId });
  const operationId = (await context.storage.runs.get(run.runId))?.stopOperationId ?? "";
  assert.ok(operationId);

  // 第一次保存失败 → 结果落库、op 结算 failed（attempt=1）。
  await context.plane.lifecycle.checkpoints.handleCheckpointResult({
    taskId: task.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    frame: {
      protocolVersion: 1,
      type: "checkpoint.result",
      operationId,
      status: "failed",
      errorCode: "checkpoint_failed",
      error: "git push rejected",
    },
  });
  await context.plane.lifecycle.checkpoints.sweepCheckpointOperations();
  const failed = await context.outbox.get(operationId);
  assert.equal(failed?.state, "failed");
  assert.equal(failed?.attempt, 1, "首次失败后 attempt 不再增长（旧实现的死锁起点）");

  // stop sweep 进入预算内重试：必须把 failed op 重新排队，否则 attempt 永远冻结在 1，
  // 重试预算永远用不完，run 卡在 draining 直到硬期限。
  const drainsBeforeRetry = context.attachmentPort.drains.length;
  const retry = await context.plane.commands.stop.sweep();
  assert.equal(retry.waitingSave, 1);
  const requeued = await context.outbox.get(operationId);
  assert.equal(requeued?.state, "pending", "重试必须重新武装同一条停止保存操作");
  assert.equal(
    context.attachmentPort.drains.length,
    drainsBeforeRetry,
    "重试不得重复发 drain：旧执行节点会因此关闭刚重连的 bridge，保存结果丢失",
  );
});

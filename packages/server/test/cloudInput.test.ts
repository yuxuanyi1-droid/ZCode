/**
 * W1 输入通路集成测试（W1 §6：覆盖 CP-02/03/06/13 与 CT-06/07/09/10/14/16/18 的非 UI 部分）。
 * 断言引用 02 §6.1/§6.2/§6.3 与 03 §6.1/§6.2；只替换端口 fake，不触网、不 sleep。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { attachReadySession, buildTestPlane } from "./cloudCoreFakes.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";

let taskCounter = 0;

async function draftTask(context: ReturnType<typeof buildTestPlane>) {
  taskCounter += 1;
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.equal(project.ok, true);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.ok ? project.value.projectId : "",
    title: "Fix login flow",
    creationKey: `ck-input-${taskCounter}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.equal(task.ok, true);
  assert.ok(task.ok);
  return task.value;
}

function startRequest(taskRevision: number, commandId: string, prompt = "do it") {
  return {
    intent: "start" as const,
    commandId,
    prompt,
    expectedTaskRevision: taskRevision,
    start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  };
}

async function acceptedStart(context: ReturnType<typeof buildTestPlane>, commandId: string) {
  const task = await draftTask(context);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: startRequest(task.revision, commandId),
  });
  assert.equal(submit.ok, true, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  assert.ok(submit.ok);
  return { task, receipt: submit.value };
}

test("CP-03/CT-07：同 commandId 同 payload 返回原回执，不同 payload 返回冲突", async () => {
  const context = buildTestPlane();
  const task = await draftTask(context);
  const first = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: startRequest(task.revision, "00000000-0000-4000-8000-000000000101"),
  });
  assert.equal(first.ok, true);
  // 同 key 重放：即使任务 revision 已增长也返回原回执（03 §6.1 尾段）。
  const replay = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: startRequest(task.revision, "00000000-0000-4000-8000-000000000101"),
  });
  assert.equal(replay.ok, true);
  assert.deepEqual(replay.ok && replay.value, first.ok && first.value);
  assert.equal(context.storage.inputsByKey.size, 1, "只有一个 input 与一个 Run 意图");
  assert.equal(context.storage.createOperations.length, 1);

  const conflict = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: startRequest(
      task.revision,
      "00000000-0000-4000-8000-000000000101",
      "different prompt",
    ),
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.ok === false && conflict.code, "idempotency_conflict");
  assert.equal(context.storage.inputsByKey.size, 1);
});

test("CP-02：接纳事务失败时没有 accepted、没有 create 操作、没有 provider 调用", async () => {
  const context = buildTestPlane({ storage: { failAcceptInput: true } });
  const task = await draftTask(context);
  await assert.rejects(
    context.plane.inputs.submit({
      principalId: PRINCIPAL,
      taskId: task.taskId,
      source: "http",
      request: startRequest(task.revision, "00000000-0000-4000-8000-000000000102"),
    }),
    /storage unavailable/,
  );
  assert.equal(context.storage.createOperations.length, 0);
  assert.equal(context.storage.inputsByKey.size, 0);
  assert.equal(context.driver.createCalls, 0);
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt, null, "没有 create 操作可领取");
});

test("存储不可写时 create worker 不调用 provider（03 §8 启动顺序）", async () => {
  const context = buildTestPlane({ storage: { writable: false } });
  const task = await draftTask(context);
  await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: startRequest(task.revision, "00000000-0000-4000-8000-000000000103"),
  });
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt, null);
  assert.equal(context.driver.createCalls, 0);
});

test("CT-06：接纳事务固定预检时的分支 SHA，之后不重新解析 HEAD", async () => {
  const context = buildTestPlane();
  const task = await draftTask(context);
  const originalHead = context.github.branches.get("101|main");
  assert.ok(originalHead);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: startRequest(task.revision, "00000000-0000-4000-8000-000000000104"),
  });
  assert.equal(submit.ok, true);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  // 分支在创建等待期间前移：冻结基线不变（11 §6、CT-06）。
  context.github.branches.set("101|main", "e".repeat(40));
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.executionRecipe?.baseSha, originalHead);
  const frozenTask = await context.storage.tasks.get(task.taskId);
  assert.equal(frozenTask?.baseSha, originalHead);
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  assert.equal((await context.storage.runs.get(runId))?.executionRecipe?.baseSha, originalHead);
});

test("CT-09/CT-10：并发 start 只有一个成功，另一请求不降级为 append", async () => {
  const context = buildTestPlane();
  const task = await draftTask(context);
  const first = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: startRequest(task.revision, "00000000-0000-4000-8000-000000000105"),
  });
  assert.equal(first.ok, true);
  const second = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: startRequest(task.revision, "00000000-0000-4000-8000-000000000106", "second"),
  });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.code, "stale");
  assert.equal(second.ok === false && second.reason, "start-on-non-draft");
  assert.equal(context.storage.inputsByKey.size, 1);
  const run = await context.storage.runs.get(first.ok ? (first.value.runId ?? "") : "");
  assert.equal(
    run?.firstInputCommandId,
    "00000000-0000-4000-8000-000000000105",
    "首命令固定，不提拔",
  );
});

test("CT-16/11 §7：append 要求 ready 且 generation 匹配", async () => {
  const context = buildTestPlane();
  const { task, receipt } = await acceptedStart(context, "00000000-0000-4000-8000-000000000107");
  const runId = receipt.runId ?? "";
  const append = (generation: number, commandId: string) => ({
    intent: "append" as const,
    commandId,
    prompt: "more",
    expectedRunGeneration: generation,
  });

  const proving = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "rpc",
    request: append(1, "00000000-0000-4000-8000-000000000108"),
  });
  assert.equal(proving.ok, false);
  assert.equal(proving.ok === false && proving.code, "not_ready");

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

  const stale = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "rpc",
    request: append(99, "00000000-0000-4000-8000-000000000109"),
  });
  assert.equal(stale.ok, false);
  assert.equal(stale.ok === false && stale.code, "stale");

  const accepted = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "rpc",
    request: append(1, "00000000-0000-4000-8000-00000000010a"),
  });
  assert.equal(accepted.ok, true);
  assert.equal(accepted.ok && accepted.value.deliveryStatus, "accepted", "202 是持久接收不是 ACK");
});

test("CT-14/CT-10：ready 后由后台投递首命令（createSession），无 attachment 时不投递", async () => {
  const context = buildTestPlane();
  const { task, receipt } = await acceptedStart(context, "00000000-0000-4000-8000-00000000010b");
  const runId = receipt.runId ?? "";
  const beforeReady = await context.plane.delivery.dispatchTask(task.taskId);
  assert.equal(beforeReady.outcomes[0]?.result, "wait");
  assert.equal(beforeReady.outcomes[0]?.reason, "run-provisioning");

  await context.plane.provisioning.create.runCreateOnce();
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  // ready 门控：welcome → bootstrap.config → ready；随后若连接失效则不再投递（02 §5.3、CP-11）。
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
  context.plane.attachments.detach({ runId, at: context.clock.now(), reason: "test-detach" });
  const noAttachment = await context.plane.delivery.dispatchTask(task.taskId);
  assert.equal(noAttachment.outcomes[0]?.reason, "no-attachment");
  assert.equal(context.attachmentPort.sent.length, 0);

  // 重新接管（新 socket）：同一 epoch 语义下继续投递。
  await attachReadySession(context, {
    taskId: task.taskId,
    runId,
    runGeneration: run.runGeneration,
  });
  const dispatched = await context.plane.delivery.dispatchTask(task.taskId);
  assert.equal(dispatched.outcomes[0]?.result, "sent");
  assert.equal(context.attachmentPort.sent.length, 1);
  const envelope = context.attachmentPort.sent[0]?.envelope as { type: string; commandId: string };
  assert.equal(envelope.type, "createSession");
  assert.equal(envelope.commandId, "00000000-0000-4000-8000-00000000010b");
  const input = await context.storage.inputs.get(
    task.taskId,
    "00000000-0000-4000-8000-00000000010b",
  );
  assert.equal(input?.deliveryStatus, "delivering", "投递后进入 delivering，等 runtime ACK");
});

test("CP-13：requestedConfig 在接纳时固定，之后不再漂移（03 §6.1）", async () => {
  const context = buildTestPlane();
  const task = await draftTask(context);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "http",
    request: {
      ...startRequest(task.revision, "00000000-0000-4000-8000-00000000010c"),
      requestedConfig: { mode: "plan", planEnabled: true },
    },
  });
  assert.equal(submit.ok, true);
  const input = await context.storage.inputs.get(
    task.taskId,
    "00000000-0000-4000-8000-00000000010c",
  );
  assert.deepEqual(input?.requestedConfig, { mode: "plan", planEnabled: true });
  assert.equal(input?.payloadHash.length, 64, "fingerprint 只覆盖原请求语义字段");
});

test("CP-06：ACK 丢失先置 uncertain，对账查到结果则落 admitted，不重复副作用", async () => {
  const context = buildTestPlane();
  const { task, receipt } = await acceptedStart(context, "00000000-0000-4000-8000-00000000010d");
  const runId = receipt.runId ?? "";
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
  context.attachmentPort.sendResult = {
    status: "rejected",
    code: "bridge_disconnected",
    reason: "closed",
  };
  const failed = await context.plane.delivery.dispatchTask(task.taskId);
  assert.equal(failed.outcomes[0]?.result, "uncertain", "断连不是 rejected");
  const uncertain = await context.storage.inputs.get(
    task.taskId,
    "00000000-0000-4000-8000-00000000010d",
  );
  assert.equal(uncertain?.deliveryStatus, "uncertain");

  // runtime 已有该命令事实：对账落地为 admitted，不重发（02 §6.3）。
  context.runtimeCommands.result = {
    status: "found",
    ack: {
      commandId: "00000000-0000-4000-8000-00000000010d",
      status: "accepted",
      revisionAtDecision: 1,
      result: { type: "createSession", sessionId: "runtime-session-1" },
    },
  };
  const reconciled = await context.plane.inputControl.reconcileTask(task.taskId);
  assert.equal(reconciled.resolved, 1);
  const admitted = await context.storage.inputs.get(
    task.taskId,
    "00000000-0000-4000-8000-00000000010d",
  );
  assert.equal(admitted?.deliveryStatus, "admitted");
  assert.equal(
    admitted?.runtimeSessionId,
    "runtime-session-1",
    "保存 receipt 与 runtime session 映射",
  );

  // runtime 明确没有该命令事实：退回 accepted 由 dispatcher 重发同 commandId（幂等）。
  const second = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    source: "rpc",
    request: {
      intent: "append",
      commandId: "00000000-0000-4000-8000-00000000010e",
      prompt: "next",
      expectedRunGeneration: run.runGeneration,
    },
  });
  assert.equal(second.ok, true);
  await context.storage.inputs.markDelivery({
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-00000000010e",
    to: "uncertain",
    now: context.clock.now(),
  });
  context.runtimeCommands.result = { status: "unknown" };
  context.attachmentPort.sendResult = { status: "sent" };
  const resent = await context.plane.inputControl.reconcileTask(task.taskId);
  assert.equal(resent.resent, 1);
  const requeued = await context.plane.delivery.dispatchTask(task.taskId);
  assert.equal(requeued.outcomes[0]?.result, "sent");
  const resendEnvelope = context.attachmentPort.sent.at(-1)?.envelope as {
    type: string;
    commandId: string;
  };
  assert.equal(resendEnvelope.type, "sendText");
  assert.equal(
    resendEnvelope.commandId,
    "00000000-0000-4000-8000-00000000010e",
    "重发复用原 commandId",
  );
});

test("API 旧代际 ACK 被拒绝（08 §4.2、CP-07）", async () => {
  const context = buildTestPlane();
  const { task, receipt } = await acceptedStart(context, "00000000-0000-4000-8000-00000000010f");
  await context.plane.projections.ingest.recordRuntimeAck({
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-00000000010f",
    runId: receipt.runId ?? "",
    runGeneration: 99,
    deliveryStatus: "admitted",
    runtimeAck: {
      commandId: "00000000-0000-4000-8000-00000000010f",
      status: "accepted",
      revisionAtDecision: 1,
    },
  });
  const input = await context.storage.inputs.get(
    task.taskId,
    "00000000-0000-4000-8000-00000000010f",
  );
  assert.equal(input?.deliveryStatus, "accepted", "旧代际 ACK 不落地");
});

test("02 §6.2：duplicate/failed ACK 的投递状态映射", async () => {
  const context = buildTestPlane();
  const { task, receipt } = await acceptedStart(context, "00000000-0000-4000-8000-000000000110");
  const runId = receipt.runId ?? "";
  const common = {
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000110",
    runId,
    runGeneration: 1,
  };
  await context.plane.projections.ingest.recordRuntimeAck({
    ...common,
    deliveryStatus: "rejected",
    runtimeAck: {
      commandId: common.commandId,
      status: "failed",
      reasonCode: "fault.test",
      revisionAtDecision: 1,
    },
  });
  const input = await context.storage.inputs.get(task.taskId, common.commandId);
  assert.equal(input?.deliveryStatus, "rejected");
  assert.equal(input?.lastError, "fault.test");
});

test("CP-14：cancel 不误报 cancelled；未开始投递的输入可幂等撤销", async () => {
  const context = buildTestPlane();
  const { task } = await acceptedStart(context, "00000000-0000-4000-8000-000000000111");
  const cancelled = await context.plane.inputControl.cancelInput({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000111",
  });
  assert.equal(cancelled.ok, true);
  assert.equal(cancelled.ok && cancelled.value.deliveryStatus, "cancelled");
  const again = await context.plane.inputControl.cancelInput({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000111",
  });
  assert.equal(again.ok && again.value.deliveryStatus, "cancelled", "幂等撤销");

  // 已投递但结果未知：运行时不可达时不报 cancelled（02 §6.3）。
  const second = await acceptedStart(context, "00000000-0000-4000-8000-000000000112");
  await context.storage.inputs.markDelivery({
    taskId: second.task.taskId,
    commandId: "00000000-0000-4000-8000-000000000112",
    to: "uncertain",
    runId: second.receipt.runId,
    now: context.clock.now(),
  });
  context.runtimeCommands.result = { status: "unavailable", retryable: true };
  const unknown = await context.plane.inputControl.cancelInput({
    principalId: PRINCIPAL,
    taskId: second.task.taskId,
    commandId: "00000000-0000-4000-8000-000000000112",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false && unknown.reason, "input-ack-unknown");

  // 已 admitted：取消需要独立的幂等 runtime 命令（持久记录端口未冻结，见 CR-3）。
  const admitted = await acceptedStart(context, "00000000-0000-4000-8000-000000000113");
  await context.storage.inputs.markDelivery({
    taskId: admitted.task.taskId,
    commandId: "00000000-0000-4000-8000-000000000113",
    to: "admitted",
    runId: admitted.receipt.runId,
    now: context.clock.now(),
  });
  const requiresRuntimeCancel = await context.plane.inputControl.cancelInput({
    principalId: PRINCIPAL,
    taskId: admitted.task.taskId,
    commandId: "00000000-0000-4000-8000-000000000113",
  });
  assert.equal(requiresRuntimeCancel.ok, false);
  assert.equal(requiresRuntimeCancel.ok === false && requiresRuntimeCancel.code, "not_implemented");
});

test("交互决定：持久记录 + 围栏 + 独立 cancelCommandId（03 §7.2、02 §6.3）", async () => {
  const context = buildTestPlane();
  const { task, receipt } = await acceptedStart(context, "00000000-0000-4000-8000-000000000114");
  const runId = receipt.runId ?? "";
  const decision = {
    principalId: PRINCIPAL,
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000115",
    runId,
    runGeneration: 1,
    interactionId: "interaction-1",
    kind: "permission" as const,
    answer: { optionId: "allow" },
  };
  // 未 ready 时的提交仍**持久接纳**（载荷已落库，等重连/重装后投递），不是失败。
  const notReady = await context.plane.commands.interactions.submitDecision(decision);
  assert.equal(notReady.ok, true, notReady.ok ? "" : `${notReady.code}/${notReady.reason}`);
  assert.equal(notReady.ok && notReady.value.deliveryStatus, "accepted");
  assert.equal(context.attachmentPort.sent.length, 0, "无 attachment 时不投递");

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
  await context.storage.inputs.markDelivery({
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000114",
    to: "admitted",
    runtimeSessionId: "runtime-session-1",
    now: context.clock.now(),
  });
  const delivered = await context.plane.commands.interactions.submitDecision(decision);
  assert.equal(delivered.ok, true, delivered.ok ? "" : `${delivered.code}/${delivered.reason}`);
  assert.equal(delivered.ok && delivered.value.deliveryStatus, "delivering");
  const envelope = context.attachmentPort.sent.at(-1)?.envelope as {
    type: string;
    sessionId: string;
  };
  assert.equal(envelope.type, "resolveInteraction");
  assert.equal(envelope.sessionId, "runtime-session-1");

  // 同 interactionId 同载荷：返回既有 receipt，不重复投递（幂等）。
  const replay = await context.plane.commands.interactions.submitDecision(decision);
  assert.equal(replay.ok && replay.value.deliveryStatus, "delivering");
  assert.equal(context.attachmentPort.sent.length, 1);
  // 同 interactionId 不同载荷：冲突。
  const conflict = await context.plane.commands.interactions.submitDecision({
    ...decision,
    commandId: "00000000-0000-4000-8000-000000000116",
    answer: { optionId: "deny" },
  });
  assert.equal(conflict.ok === false && conflict.code, "idempotency_conflict");

  const stale = await context.plane.commands.interactions.submitDecision({
    ...decision,
    runGeneration: 9,
  });
  assert.equal(stale.ok === false && stale.code, "stale");
});

test("决定的取消：未投递直接撤销；已投递先对账；admitted 走独立 cancelCommandId（02 §6.3、CP-14）", async () => {
  const context = buildTestPlane();
  const { task, receipt } = await acceptedStart(context, "00000000-0000-4000-8000-000000000117");
  const runId = receipt.runId ?? "";
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
  await context.storage.inputs.markDelivery({
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000117",
    to: "admitted",
    runtimeSessionId: "runtime-session-2",
    now: context.clock.now(),
  });
  const decisions = context.plane.commands.interactions;

  // ① accepted（runtime 不可达时不投递）→ 直接撤销。
  const notReady = await decisions.submitDecision({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000130",
    runId,
    runGeneration: run.runGeneration,
    interactionId: "interaction-accepted",
    kind: "permission",
    answer: { optionId: "allow" },
  });
  assert.equal(notReady.ok, true);
  context.plane.attachments.detach({ runId, at: context.clock.now(), reason: "test-detach" });
  const pending = await decisions.submitDecision({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000131",
    runId,
    runGeneration: run.runGeneration,
    interactionId: "interaction-pending",
    kind: "permission",
    answer: { optionId: "allow" },
  });
  assert.equal(pending.ok, true, "无 attachment 时仍持久接纳");
  assert.equal(pending.ok && pending.value.deliveryStatus, "accepted", "投递停在 accepted");
  const cancelledPending = await decisions.cancelDecision({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    interactionId: "interaction-pending",
    commandId: "00000000-0000-4000-8000-000000000131",
    cancelCommandId: "00000000-0000-4000-8000-000000000132",
  });
  assert.equal(
    cancelledPending.ok && cancelledPending.value.deliveryStatus,
    "cancelled",
    `cancel failed: ${JSON.stringify(cancelledPending)}`,
  );

  // ② delivering + runtime 不可达 → 不报 cancelled（先对账）。
  await attachReadySession(context, {
    taskId: task.taskId,
    runId,
    runGeneration: run.runGeneration,
  });
  context.runtimeCommands.result = { status: "unavailable", retryable: true };
  const unknown = await decisions.cancelDecision({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    interactionId: "interaction-accepted",
    commandId: "00000000-0000-4000-8000-000000000130",
    cancelCommandId: "00000000-0000-4000-8000-000000000133",
  });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false && unknown.reason, "decision-ack-unknown");

  // ③ runtime 明确没有该命令事实 → 可安全撤销。
  context.runtimeCommands.result = { status: "unknown" };
  const reconciled = await decisions.cancelDecision({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    interactionId: "interaction-accepted",
    commandId: "00000000-0000-4000-8000-000000000130",
    cancelCommandId: "00000000-0000-4000-8000-000000000134",
  });
  assert.equal(reconciled.ok && reconciled.value.deliveryStatus, "cancelled");
});

test("决定 ACK 回写：按 (taskId, deliveryCommandId) 反查并推进；查不到不新建记录（02 §6.2/§6.3）", async () => {
  const context = buildTestPlane();
  const { task, receipt } = await acceptedStart(context, "00000000-0000-4000-8000-000000000140");
  const runId = receipt.runId ?? "";
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
  await context.storage.inputs.markDelivery({
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000140",
    to: "admitted",
    runtimeSessionId: "runtime-session-3",
    now: context.clock.now(),
  });
  const submitted = await context.plane.commands.interactions.submitDecision({
    principalId: PRINCIPAL,
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000141",
    runId,
    runGeneration: run.runGeneration,
    interactionId: "interaction-ack",
    kind: "permission",
    answer: { optionId: "allow" },
  });
  assert.equal(submitted.ok && submitted.value.deliveryStatus, "delivering");

  // runtime 裁决后经 ingest 的 ACK 通道回写：命中决定记录（deliveryCommandId 反查）。
  await context.plane.projections.ingest.recordRuntimeAck({
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000141",
    runId,
    runGeneration: run.runGeneration,
    deliveryStatus: "admitted",
    runtimeAck: {
      commandId: "00000000-0000-4000-8000-000000000141",
      status: "accepted",
      revisionAtDecision: 2,
    },
  });
  const decision = await context.interactionDecisions.findDecisionByDeliveryCommandId(
    task.taskId,
    "00000000-0000-4000-8000-000000000141",
  );
  assert.equal(decision?.deliveryStatus, "admitted", "决定状态按投递 commandId 回写");

  // 查不到记录的 ACK：不新建记录、不改任何状态（只留痕）。
  await context.plane.projections.ingest.recordRuntimeAck({
    taskId: task.taskId,
    commandId: "00000000-0000-4000-8000-000000000142",
    runId,
    runGeneration: run.runGeneration,
    deliveryStatus: "admitted",
    runtimeAck: {
      commandId: "00000000-0000-4000-8000-000000000142",
      status: "accepted",
      revisionAtDecision: 3,
    },
  });
  const stray = await context.interactionDecisions.findDecisionByDeliveryCommandId(
    task.taskId,
    "00000000-0000-4000-8000-000000000142",
  );
  assert.equal(stray, null, "不得为无记录 ACK 新建决定");
  const strayInput = await context.storage.inputs.get(
    task.taskId,
    "00000000-0000-4000-8000-000000000142",
  );
  assert.equal(strayInput, null, "也不得新建输入记录");
});

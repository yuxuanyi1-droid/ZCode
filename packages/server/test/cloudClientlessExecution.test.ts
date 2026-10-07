/**
 * W10 验收抽样（specs/cloud-agent/04 §9 `CP-05`、`W-04`）：**无客户端也继续执行**。
 *
 * 断言的是「客户端页面所有权」这件事本身，而不是某个 UI 文案：
 * - `CP-05`：accepted 之后关闭唯一浏览器（这里等价于**从头到尾没有任何客户端订阅**），
 *   控制面仍自行 provision → ready → 把首个输入投递给 runtime。
 * - `W-04`：202 之后关页面，CLI/runtime 只 admit 一次；prompt 持久；重开（再来一轮后台
 *   投递）既不 autoSend、也不新造 commandId。
 *
 * 证据口径（W10 §4）：每条断言都能回指到 owner——
 *   provider 侧 = `driver.createCalls`；投递事实 = `attachmentPort.sent`（控制面唯一写入路径）；
 *   runtime 准入 = `storage.inputs` 的 receipt；客户端事实 = 计数为 0 的读端口 trip wire。
 * 时序全部由显式调用推进（`runCreateOnce` / `markReady` / `dispatchOnce`），不用 sleep。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { attachReadySession, buildTestPlane } from "./cloudCoreFakes.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";
const COMMAND_ID = "00000000-0000-4000-8000-000000000c01";
const PROMPT = "fix the flaky login test";

/**
 * 「没有客户端」不是靠不调用某个函数来暗示，而是可观测的 trip wire：
 * 浏览器订阅任务事实只会走 taskDetail / projections.history 这两个读端口
 * （03 §7.1 分面），这里统计它们的调用次数，整轮必须保持 0。
 */
function instrumentClientReads(plane: ReturnType<typeof buildTestPlane>["plane"]): {
  calls: () => number;
} {
  let calls = 0;
  const detail = plane.taskDetail.getDetail.bind(plane.taskDetail);
  plane.taskDetail.getDetail = async (input) => {
    calls += 1;
    return detail(input);
  };
  const history = plane.projections.history;
  const readHistory = history.readHistory.bind(history);
  const readSnapshot = history.readSnapshot.bind(history);
  history.readHistory = async (input) => {
    calls += 1;
    return readHistory(input);
  };
  history.readSnapshot = async (input) => {
    calls += 1;
    return readSnapshot(input);
  };
  return { calls: () => calls };
}

async function seedAcceptedStart(context: ReturnType<typeof buildTestPlane>) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Clientless task",
    creationKey: "ck-clientless",
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  // source=http 就是页面提交的那条路（03 §6）；返回等价于 202 的持久回执。
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: COMMAND_ID,
      prompt: PROMPT,
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.equal(submit.ok, true, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  assert.ok(submit.ok);
  return { taskId: task.value.taskId, receipt: submit.value };
}

test("CP-05：accepted 后无任何客户端订阅，控制面仍自行 provision → ready → 投递首输入", async () => {
  const context = buildTestPlane();
  const clientReads = instrumentClientReads(context.plane);

  const { taskId, receipt } = await seedAcceptedStart(context);
  // 202 语义：持久接收，但还没有 provider 资源。
  assert.equal(receipt.commandId, COMMAND_ID);
  assert.equal(context.driver.createCalls, 0, "202 不等于创建沙箱");
  assert.equal(context.attachmentPort.sent.length, 0, "202 不等于投递");

  // 后台 worker（HTTP/RPC 之外的服务端循环）创建执行环境。
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(context.driver.createCalls, 1, "控制面自行创建唯一一个 provider 实例");
  assert.ok(created, "create 意图被后台 runner 领取");

  const run = await context.storage.runs.get(receipt.runId ?? "");
  assert.ok(run, "run 事实已持久");

  await attachReadySession(context, {
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
  });
  const ready = await context.plane.runs.markReady({
    taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.equal(ready.ok, true, ready.ok ? "" : `${ready.code}/${ready.reason}`);

  // 无客户端仍然投递：走的正是 03 §8 的后台循环入口。
  const reports = await context.plane.delivery.dispatchOnce();
  const outcome = reports
    .flatMap((report) => report.outcomes)
    .find((item) => item.commandId === COMMAND_ID);
  assert.ok(outcome, "后台循环必须覆盖该 Task");
  assert.equal(outcome?.result, "sent", "无页面也把输入送到 runtime");

  assert.equal(context.attachmentPort.sent.length, 1, "投递唯一写入路径只走一次");
  assert.deepEqual(
    context.attachmentPort.sent.map((item) => item.commandId),
    [COMMAND_ID],
    "投递的是事务固定的原 commandId",
  );
  assert.equal(clientReads.calls(), 0, "全程没有任何客户端读端口被调用（= 没有页面订阅）");
});

test("W-04：202 后关页只 admit 一次；重开不 autoSend、不重造 commandId", async () => {
  const context = buildTestPlane();
  const { taskId, receipt } = await seedAcceptedStart(context);
  const runId = receipt.runId ?? "";

  await context.plane.provisioning.create.runCreateOnce();
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  await attachReadySession(context, {
    taskId,
    runId,
    runGeneration: run.runGeneration,
  });
  await context.plane.runs.markReady({
    taskId,
    runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });

  const first = await context.plane.delivery.dispatchOnce();
  assert.equal(
    first.flatMap((report) => report.outcomes).filter((item) => item.result === "sent").length,
    1,
  );
  const delivering = await context.storage.inputs.get(taskId, COMMAND_ID);
  assert.equal(delivering?.deliveryStatus, "delivering", "投递后等待 runtime ACK");

  // runtime 侧准入（真实链路里这来自 CommandAck；这里是同一 ingest 端口）。
  await context.plane.projections.ingest.recordRuntimeAck({
    taskId,
    commandId: COMMAND_ID,
    runId,
    runGeneration: run.runGeneration,
    deliveryStatus: "admitted",
    runtimeAck: {
      commandId: COMMAND_ID,
      status: "accepted",
      revisionAtDecision: 1,
      result: { type: "createSession", sessionId: "runtime-session-clientless" },
    },
  });

  // 「用户重新打开页面」= 再来若干轮后台投递；已准入的输入不得再投一次。
  await context.plane.delivery.dispatchOnce();
  await context.plane.delivery.dispatchOnce();

  const admitted = await context.storage.inputs.get(taskId, COMMAND_ID);
  assert.equal(admitted?.deliveryStatus, "admitted", "runtime 准入是终态事实");
  assert.equal(admitted?.runtimeSessionId, "runtime-session-clientless");
  assert.equal(
    context.attachmentPort.sent.filter((item) => item.commandId === COMMAND_ID).length,
    1,
    "同一 commandId 只投递一次（无 autoSend、无重试换 id）",
  );
  assert.equal(
    new Set(context.attachmentPort.sent.map((item) => item.commandId)).size,
    1,
    "没有新造 commandId",
  );

  // prompt 持久在控制面（02 §6.1：投递只读持久正文，不读调用方内存）。
  const payload = await context.storage.payloads.readInputPayload({
    taskId,
    commandId: COMMAND_ID,
  });
  assert.equal(payload?.prompt, PROMPT, "关页不丢 prompt，重开读的是同一份持久正文");
});

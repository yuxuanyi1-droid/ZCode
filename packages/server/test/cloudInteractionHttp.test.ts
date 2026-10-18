/**
 * 交互决定 HTTP 端点验收（specs/cloud-agent 03 §7.2、02 §6.3、spec 15 §R6）。
 *
 * 用真实 app 用例 + 真实路由（Hono 直调）覆盖：202 持久接纳、同 interactionId 幂等、
 * 跨主体 404、stale/stopRequested 围栏、GET 回执只读、取消端点。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { registerCloudHttpRoutes } from "../src/cloud/adapters/http/routes.js";
import type { CloudHttpRouteDeps } from "../src/cloud/adapters/http/support.js";
import type { CloudBridgeChannel } from "../src/cloud/adapters/ws/bridgeChannel.js";
import { buildTestPlane, attachReadySession } from "./cloudCoreFakes.js";
import type { TestPlane } from "./cloudCoreFakes.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";
const OTHER_PRINCIPAL = "00000000-0000-4000-8000-0000000000bb";
/** HTTP 用例不触发 WS：桥只作占位。 */
const bridgeStub = {} as unknown as CloudBridgeChannel;

let taskCounter = 0;

function appFor(context: TestPlane, principalId = PRINCIPAL): Hono {
  const app = new Hono();
  const deps: CloudHttpRouteDeps = {
    plane: context.plane,
    router: context.plane.router,
    bridge: bridgeStub,
    principalId,
    publicOrigin: "https://cloud.example.test",
    githubConfigured: true,
  };
  registerCloudHttpRoutes(app, deps);
  return app;
}

function commandId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

async function startedTask(
  context: TestPlane,
): Promise<{ taskId: string; runId: string; startCommandId: string }> {
  taskCounter += 1;
  const startCommandId = commandId(900 + taskCounter);
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "交互端点任务",
    creationKey: `ck-interaction-${taskCounter}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: startCommandId,
      prompt: "run",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  assert.ok(submit.value.runId);
  return { taskId: task.value.taskId, runId: submit.value.runId, startCommandId };
}

function postDecision(
  app: Hono,
  taskId: string,
  interactionId: string,
  body: unknown,
): Promise<Response> {
  return app.request(`/api/cloud/tasks/${taskId}/interactions/${interactionId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST 决定返回 202 持久回执；GET 可读；同 payload 幂等、不同 payload 冲突", async () => {
  const context = buildTestPlane();
  const { taskId, runId } = await startedTask(context);
  const app = appFor(context);
  const body = {
    commandId: commandId(1),
    runId,
    runGeneration: 1,
    kind: "permission",
    answer: { optionId: "allow" },
  };

  const first = await postDecision(app, taskId, "interaction-http-1", body);
  assert.equal(first.status, 202, "202 = 控制面持久接纳，不是 runtime 裁决");
  const receipt = (await first.json()) as Record<string, unknown>;
  assert.deepEqual(receipt, {
    taskId,
    interactionId: "interaction-http-1",
    deliveryStatus: "accepted",
  });
  assert.equal("runtimeAck" in receipt, false, "控制面不得伪造 CommandAck");

  const read = await app.request(`/api/cloud/tasks/${taskId}/interactions/interaction-http-1`);
  assert.equal(read.status, 200);
  assert.deepEqual(await read.json(), receipt);

  // 同 interactionId 同 answer：返回既有 receipt，不重复持久记录。
  const replay = await postDecision(app, taskId, "interaction-http-1", body);
  assert.equal(replay.status, 202);
  assert.deepEqual(await replay.json(), receipt);

  // 同 interactionId 不同 answer：幂等冲突（03 §6.1 同语义）。
  const conflict = await postDecision(app, taskId, "interaction-http-1", {
    ...body,
    commandId: commandId(2),
    answer: { optionId: "deny" },
  });
  assert.equal(conflict.status, 409);
  const conflictBody = (await conflict.json()) as { code: string; details?: { reason?: string } };
  assert.equal(conflictBody.code, "idempotency_conflict");
  assert.equal(conflictBody.details?.reason, "interaction-payload-mismatch");
});

test("跨主体读/写统一 404；路径参数与 body 严格校验", async () => {
  const context = buildTestPlane();
  const { taskId, runId } = await startedTask(context);
  const stranger = appFor(context, OTHER_PRINCIPAL);
  const body = {
    commandId: commandId(3),
    runId,
    runGeneration: 1,
    kind: "permission",
    answer: { optionId: "allow" },
  };

  const write = await postDecision(stranger, taskId, "interaction-cross", body);
  assert.equal(write.status, 404, "跨主体不得泄漏任务存在性");
  assert.equal(((await write.json()) as { code: string }).code, "not_found");
  const read = await stranger.request(`/api/cloud/tasks/${taskId}/interactions/interaction-cross`);
  assert.equal(read.status, 404);

  // body 严格 schema：未知字段/未知 kind 在路由层拒绝。
  const app = appFor(context);
  const invalidBody = await postDecision(app, taskId, "interaction-invalid", {
    ...body,
    principalId: PRINCIPAL,
  });
  assert.equal(invalidBody.status, 400);
  assert.equal(((await invalidBody.json()) as { code: string }).code, "validation_failed");
  const invalidKind = await postDecision(app, taskId, "interaction-invalid", {
    ...body,
    kind: "question",
  });
  assert.equal(invalidKind.status, 400);
});

test("stale generation 与 stopRequested 门禁仍由 InteractionCommands 执行", async () => {
  const context = buildTestPlane();
  const { taskId, runId } = await startedTask(context);
  const app = appFor(context);
  const body = {
    commandId: commandId(4),
    runId,
    runGeneration: 1,
    kind: "elicitation",
    answer: { action: "accept", content: { q1: ["a"] } },
  };

  const stale = await postDecision(app, taskId, "interaction-stale", {
    ...body,
    runGeneration: 9,
  });
  assert.equal(stale.status, 409);
  const staleBody = (await stale.json()) as { code: string; details?: { reason?: string } };
  assert.equal(staleBody.code, "stale");

  await context.storage.runs.requestStop({
    taskId,
    operationId: commandId(5),
    now: context.clock.now(),
  });
  const stopped = await postDecision(app, taskId, "interaction-stopped", body);
  assert.equal(stopped.status, 409);
  const stoppedBody = (await stopped.json()) as { code: string; details?: { reason?: string } };
  assert.equal(stoppedBody.code, "stale");
  assert.equal(stoppedBody.details?.reason, "stop-requested");
});

test("取消端点：未投递直接 cancelled；重复取消幂等；未知决定 404", async () => {
  const context = buildTestPlane();
  const { taskId, runId } = await startedTask(context);
  const app = appFor(context);
  const submitBody = {
    commandId: commandId(6),
    runId,
    runGeneration: 1,
    kind: "permission",
    answer: { optionId: "allow" },
  };
  assert.equal((await postDecision(app, taskId, "interaction-cancel", submitBody)).status, 202);

  const cancelBody = { commandId: commandId(6), cancelCommandId: commandId(7) };
  const cancel = (): Promise<Response> =>
    app.request(`/api/cloud/tasks/${taskId}/interactions/interaction-cancel/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cancelBody),
    });
  const first = await cancel();
  assert.equal(first.status, 200);
  assert.equal(
    ((await first.json()) as { deliveryStatus: string }).deliveryStatus,
    "cancelled",
    "尚未投递的决定直接撤销投递意图（02 §6.3）",
  );
  const again = await cancel();
  assert.equal(again.status, 200);
  assert.equal(((await again.json()) as { deliveryStatus: string }).deliveryStatus, "cancelled");

  const unknown = await app.request(
    `/api/cloud/tasks/${taskId}/interactions/interaction-missing/cancel`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cancelBody),
    },
  );
  assert.equal(unknown.status, 404);
  assert.equal(((await unknown.json()) as { code: string }).code, "not_found");
});

/**
 * 让 run 具备投递前提：create 操作落地 workspacePath，首个 ACK 回填 runtime session
 * （与生产 ACK 路径一致），再注册并置位 ready attachment。
 */
async function attachDeliverableRuntime(
  context: TestPlane,
  input: { taskId: string; runId: string; startCommandId: string },
): Promise<void> {
  await context.plane.provisioning.create.runCreateOnce();
  await context.plane.projections.ingest.recordRuntimeAck({
    taskId: input.taskId,
    commandId: input.startCommandId,
    runId: input.runId,
    runGeneration: 1,
    deliveryStatus: "admitted",
    runtimeAck: {
      commandId: input.startCommandId,
      status: "accepted",
      revisionAtDecision: 1,
      result: { type: "createSession", sessionId: `runtime-${input.runId}` },
    },
  });
  await attachReadySession(context, {
    taskId: input.taskId,
    runId: input.runId,
    runGeneration: 1,
  });
}

test("快速 ACK：ACK 先于 delivering 写入时 submitDecision 返回 admitted 而非 409", async () => {
  const context = buildTestPlane();
  const { taskId, runId, startCommandId } = await startedTask(context);
  await attachDeliverableRuntime(context, { taskId, runId, startCommandId });
  const app = appFor(context);
  const decisionCommandId = commandId(11);

  // 投递回调内模拟快速 ACK：先把决定记录 accepted → admitted，再返回 sent；
  // 随后控制面写 delivering 会被状态机拒绝（admitted 是终态），必须读回 admitted。
  const send = context.attachmentPort.sendCommand.bind(context.attachmentPort);
  context.attachmentPort.sendCommand = async (request) => {
    await context.plane.projections.ingest.recordRuntimeAck({
      taskId,
      commandId: request.commandId,
      runId,
      runGeneration: 1,
      deliveryStatus: "admitted",
      runtimeAck: {
        commandId: request.commandId,
        status: "accepted",
        revisionAtDecision: 1,
      },
    });
    return send(request);
  };

  const response = await postDecision(app, taskId, "interaction-fast-ack", {
    commandId: decisionCommandId,
    runId,
    runGeneration: 1,
    kind: "permission",
    answer: { optionId: "allow" },
  });
  assert.equal(response.status, 202, "ACK 先到是合法投递结果，不能报告 409");
  assert.deepEqual(await response.json(), {
    taskId,
    interactionId: "interaction-fast-ack",
    deliveryStatus: "admitted",
  });

  // 持久事实与投影一致：决定已 admitted，GET 读到同一 receipt。
  const read = await app.request(`/api/cloud/tasks/${taskId}/interactions/interaction-fast-ack`);
  assert.equal(read.status, 200);
  assert.equal(((await read.json()) as { deliveryStatus: string }).deliveryStatus, "admitted");
});

test("快速 ACK：cancelDecision 的 cancelled CAS 被 ACK 抢先时返回 admitted 并投递独立取消命令", async () => {
  const context = buildTestPlane();
  const { taskId, runId, startCommandId } = await startedTask(context);
  const app = appFor(context);
  const decisionCommandId = commandId(21);
  // 无 attachment：决定停在 accepted，取消会走「直接撤销投递意图」分支。
  const submitted = await postDecision(app, taskId, "interaction-cancel-race", {
    commandId: decisionCommandId,
    runId,
    runGeneration: 1,
    kind: "permission",
    answer: { optionId: "allow" },
  });
  assert.equal(submitted.status, 202);
  assert.equal(((await submitted.json()) as { deliveryStatus: string }).deliveryStatus, "accepted");
  await attachDeliverableRuntime(context, { taskId, runId, startCommandId });

  // 模拟 ACK 恰好落在 cancelDecision 读到 accepted 与写 cancelled 之间。
  const decisions = context.interactionDecisions;
  const setStatus = decisions.setDecisionDeliveryStatus.bind(decisions);
  let raced = false;
  decisions.setDecisionDeliveryStatus = async (request) => {
    if (!raced && request.status === "cancelled") {
      raced = true;
      await context.plane.projections.ingest.recordRuntimeAck({
        taskId,
        commandId: decisionCommandId,
        runId,
        runGeneration: 1,
        deliveryStatus: "admitted",
        runtimeAck: {
          commandId: decisionCommandId,
          status: "accepted",
          revisionAtDecision: 1,
        },
      });
    }
    return setStatus(request);
  };

  const cancelCommandId = commandId(22);
  const cancel = await app.request(
    `/api/cloud/tasks/${taskId}/interactions/interaction-cancel-race/cancel`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commandId: decisionCommandId, cancelCommandId }),
    },
  );
  assert.equal(cancel.status, 200, "ACK 先到不是取消失败");
  assert.deepEqual(await cancel.json(), {
    taskId,
    interactionId: "interaction-cancel-race",
    deliveryStatus: "admitted",
  });
  assert.equal(
    context.attachmentPort.sent.at(-1)?.commandId,
    cancelCommandId,
    "已 admitted 的决定走独立 cancelCommandId，不伪造 cancelled",
  );
  assert.equal(
    (await decisions.getDecision(taskId, "interaction-cancel-race"))?.deliveryStatus,
    "admitted",
  );
});

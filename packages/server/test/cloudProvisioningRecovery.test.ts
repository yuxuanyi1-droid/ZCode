/**
 * R1 provisioning 幂等与恢复（specs/cloud-agent/15 §3 R1；01 §5.1 第 3 条、§5.3、
 * 03 §5 CP-04、08 §8.1）。
 *
 * 覆盖：
 * - create 成功但 handle 未落库（进程崩溃窗口）→ 重跑 create worker 先对账，不重复 create；
 * - 统一恢复路径持久 workspacePath、拉起 supervisor，且 bridge hello 的路径校验通过；
 * - run 已有 providerHandle 时 create worker 禁止再次 create；
 * - startup/readiness 对账恢复 handle 不重复 create；
 * - startup 把 provider 观测 paused 的 ready run 按事实收敛到 paused。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CloudBridgeControlFrame } from "@zcode/shared";
import { handleBridgeHandshake } from "../src/cloud/adapters/ws/handshake.js";
import type { LiveConnection } from "../src/cloud/adapters/ws/types.js";
import { CLOUD_CORE_DEFAULTS } from "../src/cloud/app/config.js";
import { buildCloudTaskWorkspacePath } from "../src/cloud/domain/workspacePath.js";
import { FakeHash, attachReadySession, buildTestPlane } from "./cloudCoreFakes.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";
const WORKSPACE = buildCloudTaskWorkspacePath("demo").path;

let counter = 0;

/** 走完「draft → start 接纳」，返回持久 Task/Run 标识（不执行 create worker）。 */
async function acceptedRun(context: ReturnType<typeof buildTestPlane>) {
  counter += 1;
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Recovery task",
    creationKey: `ck-recovery-${counter}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-00000000c${String(counter).padStart(3, "0")}`,
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.equal(submit.ok, true, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  return { taskId: task.value.taskId, runId };
}

/**
 * 模拟「provider create 成功、recordProviderHandle 前崩溃」：driver.create 抛未知错误、
 * 即时对账也未知 → operation=ambiguous、run 无 handle（与崩溃窗口后的持久形态一致）。
 */
async function crashBeforeHandlePersisted(
  context: ReturnType<typeof buildTestPlane>,
  runId: string,
) {
  context.driver.createOutcome = "throw-unknown";
  context.driver.findCreateResultOutcome = "unknown";
  const first = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(first?.outcome, "unknown");
  const operation = await context.outbox.findByKey(`create:${runId}`);
  assert.ok(operation);
  assert.equal(operation.state, "ambiguous");
  assert.equal(context.driver.createCalls, 1);
  assert.equal((await context.storage.runs.get(runId))?.providerHandle, undefined);
  return { operation, first };
}

/** 走完 create → ready（供 startup paused 收敛用例复用）。 */
async function readyRun(context: ReturnType<typeof buildTestPlane>) {
  const session = await acceptedRun(context);
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  const run = await context.storage.runs.get(session.runId);
  assert.ok(run);
  await attachReadySession(context, {
    taskId: session.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  const ready = await context.plane.runs.markReady({
    taskId: session.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.ok(ready.ok);
  return { ...session, run: ready.ok ? ready.value : run };
}

function createFakeSocket() {
  const sent: string[] = [];
  let closed: { code?: number; reason?: string } | undefined;
  return {
    sent,
    closedInfo: () => closed,
    socket: {
      send: (data: string) => sent.push(data),
      close: (code?: number, reason?: string) => {
        closed = { code, reason };
      },
      onMessage: (_handler: (data: string) => void) => undefined,
      onClose: (_handler: (closeInfo?: { code?: number; reason?: string }) => void) => undefined,
    },
  };
}

test("R1：create 成功但 handle 未落库 → 重跑 create worker 先对账，只 create 一次并恢复 ready", async () => {
  const context = buildTestPlane();
  const { runId } = await acceptedRun(context);
  const { operation } = await crashBeforeHandlePersisted(context, runId);

  // 模拟进程重启：ambiguous 租约到期后重新领取；provider 事实显示资源已创建。
  context.clock.advance(61_000);
  context.driver.findCreateResultOutcome = "created";
  const findCallsBefore = context.driver.findCreateResultCalls;
  const retried = await context.plane.provisioning.create.runCreateOnce();

  assert.equal(retried?.outcome, "created");
  assert.equal(context.driver.createCalls, 1, "同 run 的 driver.create 最多一次");
  assert.equal(
    context.driver.findCreateResultCalls,
    findCallsBefore + 1,
    "attempt > 1 必须在 create 前按 operationKey 对账",
  );
  assert.equal(
    context.driver.lastFindCreateResultOptions?.operationAttemptedAtMs,
    operation.createdAt,
    "对账锚点 = create operation 的持久 createdAt",
  );
  assert.equal(context.driver.startSupervisorCalls, 1, "对账命中后走统一恢复并拉起 supervisor");

  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  assert.equal(run.providerHandle, "sandbox-reconciled");
  assert.equal(run.workspacePath, WORKSPACE, "恢复路径补持久 workspacePath");

  // 恢复出的 run 能完成 ready 门控（bootstrap.config → ready）。
  await attachReadySession(context, {
    taskId: run.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  const ready = await context.plane.runs.markReady({
    taskId: run.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.ok(ready.ok, ready.ok ? "" : `${ready.code}/${ready.reason}`);
  assert.equal((await context.outbox.findByKey(`create:${runId}`))?.state, "settled");
});

test("R1：恢复路径持久 workspacePath、拉起 supervisor，bridge hello 路径校验通过", async () => {
  const context = buildTestPlane();
  const { runId } = await acceptedRun(context);
  await crashBeforeHandlePersisted(context, runId);
  context.clock.advance(61_000);
  context.driver.findCreateResultOutcome = "created";
  assert.equal((await context.plane.provisioning.create.runCreateOnce())?.outcome, "created");

  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  assert.equal(run.workspacePath, WORKSPACE);
  assert.equal(context.driver.lastSupervisorStart?.workspacePath, WORKSPACE);
  assert.equal(context.driver.lastSupervisorStart?.runId, runId);

  // hello 路径校验：hello 必须上报与持久事实逐字节相同的 workspacePath。
  // 用恢复后的 run 事实 + 新票据走真实握手函数；持久路径为空/不一致会被 1008 拒绝。
  const ticket = "recovery-ticket-1";
  await context.storage.credentials.saveInitial({
    runId: run.runId,
    runGeneration: run.runGeneration,
    credentialHash: createHash("sha256").update(ticket).digest("hex"),
    expiresAt: context.clock.now() + 60_000,
    bootstrapOperationId: "recovery-hello",
  });
  const fake = createFakeSocket();
  const connection: LiveConnection = {
    socket: fake.socket,
    taskId: run.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
    runtimeIncarnation: "incarnation-1",
    authenticated: false,
  };
  const frame: CloudBridgeControlFrame = {
    protocolVersion: 1,
    type: "bridge.hello",
    address: {
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      workspaceIdentity: `cloud-task:${run.taskId}`,
      workspacePath: run.workspacePath ?? "",
      remoteSessionId: `remote-${run.runId}`,
    },
    helloAttemptId: "00000000-0000-4000-8000-000000007a01",
    credentialToken: ticket,
    candidateNextResumeToken: "candidate-1",
    runtimeIncarnation: "incarnation-1",
  };
  const outcome = await handleBridgeHandshake(
    {
      services: () => context.plane,
      registry: context.plane.attachments,
      storage: context.storage,
      clock: context.clock,
      hash: new FakeHash(),
      ids: context.ids,
    },
    connection,
    frame,
  );
  assert.equal(outcome.handled, true);
  assert.equal(fake.closedInfo(), undefined, "hello 不应因 workspace-path-mismatch 被关闭");
  assert.equal(connection.authenticated, true);
  assert.ok(
    fake.sent.some((item) => (JSON.parse(item) as { type: string }).type === "bridge.welcome"),
    "hello 后发送 welcome",
  );
});

test("R1：run 已有 providerHandle 时 create worker 禁止再次 create，直接走恢复/启动", async () => {
  const context = buildTestPlane();
  const { runId } = await acceptedRun(context);
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  assert.equal(context.driver.createCalls, 1);
  assert.equal(context.driver.startSupervisorCalls, 1);

  // 模拟「handle 已落库、create operation 未结算」的崩溃形态：重新领到同一 create 操作。
  const operation = await context.outbox.findByKey(`create:${runId}`);
  assert.ok(operation);
  const record = context.outbox.records.get(operation.operationId);
  assert.ok(record);
  record.state = "pending";
  record.leaseExpiresAt = undefined;
  const findCallsBefore = context.driver.findCreateResultCalls;

  const retried = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(retried?.outcome, "created");
  assert.equal(context.driver.createCalls, 1, "已有 providerHandle：绝不再次 create");
  assert.equal(
    context.driver.findCreateResultCalls,
    findCallsBefore,
    "有 handle 时不需要按 operationKey 对账",
  );
  assert.equal(context.driver.startSupervisorCalls, 2, "统一恢复路径重复拉起（沙箱内 flock 幂等）");
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.providerHandle, `sandbox-${runId}`);
  assert.equal(run?.workspacePath, WORKSPACE);
});

test("R1：startup 对账恢复 handle 不重复 create，并补 workspacePath/拉起 supervisor", async () => {
  const context = buildTestPlane();
  const { runId } = await acceptedRun(context);
  await crashBeforeHandlePersisted(context, runId);
  context.driver.findCreateResultOutcome = "created";

  const summary = await context.plane.reconciler.reconcileOnStartup();
  assert.equal(summary.alive, 1);
  assert.equal(context.driver.createCalls, 1, "startup 恢复不得再次 create");
  assert.equal(context.driver.startSupervisorCalls, 1, "startup 发现 handle 必须拉起 supervisor");
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.workspacePath, WORKSPACE);
  assert.equal(context.driver.lastSupervisorStart?.workspacePath, WORKSPACE);
});

test("R1：readiness 对账恢复 handle 不重复 create", async () => {
  const context = buildTestPlane();
  const { runId } = await acceptedRun(context);
  await crashBeforeHandlePersisted(context, runId);
  context.driver.findCreateResultOutcome = "created";
  context.clock.advance(CLOUD_CORE_DEFAULTS.readinessSoftTimeoutMs + 1_000);
  const findCallsBefore = context.driver.findCreateResultCalls;

  await context.plane.provisioning.readiness.sweep();
  assert.equal(context.driver.createCalls, 1, "readiness 恢复不得再次 create");
  assert.equal(context.driver.findCreateResultCalls, findCallsBefore + 1);
  assert.equal(context.driver.startSupervisorCalls, 1, "readiness 发现 handle 必须拉起 supervisor");
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.workspacePath, WORKSPACE);
});

test("R1：startup 对账把 provider 观测 paused 的 ready run 按事实收敛到 paused", async () => {
  const context = buildTestPlane();
  const { runId } = await readyRun(context);
  assert.equal((await context.storage.runs.get(runId))?.status, "ready");
  context.driver.inspectStatus = "paused";

  const summary = await context.plane.reconciler.reconcileOnStartup();
  assert.equal(summary.alive, 1);
  assert.equal(summary.settled, 0);
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.status, "paused", "无连接的 ready run 不能因 provider paused 观测留在 ready");
  assert.equal(run?.endReason, "provider-paused-after-restart");
});

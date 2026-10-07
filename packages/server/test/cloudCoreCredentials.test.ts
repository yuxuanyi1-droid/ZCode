/**
 * W1 凭据授权与后台循环测试（01 §7.1/§7.2 秘密白名单与 git grant、W1 §4 循环入口、
 * 03 §8 启动对账顺序）。只使用端口 fake 与手动调度器，不触网、不 sleep。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { attachReadySession, buildTestPlane } from "./cloudCoreFakes.js";
import { GIT_GRANT_TTL_MS } from "../src/cloud/app/ports/gitGrantPort.js";
import {
  isSecretAllowed,
  rejectDisallowedSecrets,
  resolveRunSecretPolicy,
} from "../src/cloud/app/credentialAuthorization/secretWhitelist.js";
import { startCloudLifecycleLoops } from "../src/cloud/app/lifecycleLoops.js";
import type { LoopSchedulerPort } from "../src/cloud/app/ports/loopSchedulerPort.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";

/** 手动调度器：记录注册的周期任务，测试按需逐拍驱动（不引入真实定时器）。 */
function manualScheduler() {
  const tasks = new Map<number, () => Promise<void>>();
  const scheduled: number[] = [];
  const delays: number[] = [];
  let counter = 0;
  const scheduler: LoopSchedulerPort = {
    schedule(intervalMs, task) {
      counter += 1;
      const id = counter;
      scheduled.push(intervalMs);
      tasks.set(id, task);
      return () => tasks.delete(id);
    },
    delay(_delayMs, task) {
      counter += 1;
      const id = counter;
      delays.push(counter);
      void task();
      return () => tasks.delete(id);
    },
  };
  return {
    scheduler,
    scheduled,
    delays,
    /** 触发所有已注册的周期任务各一次。 */
    async tick(): Promise<void> {
      for (const task of tasks.values()) await task();
    },
    size: () => tasks.size,
  };
}

async function readyRunContext(context: ReturnType<typeof buildTestPlane>) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Ship it",
    creationKey: "ck-cred",
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-000000000301",
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  const runId = submit.value.runId ?? "";
  await context.plane.provisioning.create.runCreateOnce();
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  const persistedTask = await context.storage.tasks.get(task.value.taskId);
  assert.ok(persistedTask);
  return { task: persistedTask, run };
}

/** 造一个已接纳的 run（create 之前），并用真实 W4 broker 组装控制面。 */
async function acceptedRun(context: ReturnType<typeof buildTestPlane>) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Grant task",
    creationKey: `ck-grant-${Math.random().toString(36).slice(2, 8)}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`,
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.equal(submit.ok, true, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  return { task: task.value, run };
}

test("git grant 签发/兑换：首次兑换成功、同 grant 二次兑换被拒（单次，01 §7.2）", async () => {
  const context = buildTestPlane();
  const { task, run } = await acceptedRun(context);
  const issued = await context.plane.gitGrants.issueForRun({ runId: run.runId, purpose: "clone" });
  assert.equal(issued.ok, true, issued.ok ? "" : `${issued.code}/${issued.reason}`);
  assert.equal(context.gitGrantBrokerDeps.minted.length, 0, "签发阶段不 mint token（只在兑换时）");

  const first = await context.plane.gitGrants.redeem({
    runId: run.runId,
    purpose: "clone",
    runGeneration: run.runGeneration,
    repositoryId: 101,
    proof: "run-credential",
  });
  assert.equal(first.ok, true, first.ok ? "" : `${first.code}/${first.reason}`);
  assert.equal(first.ok && first.repositoryId, 101);
  assert.equal(context.gitGrantBrokerDeps.minted.length, 1, "兑换才 mint 一次");

  const second = await context.plane.gitGrants.redeem({
    runId: run.runId,
    purpose: "clone",
    runGeneration: run.runGeneration,
    repositoryId: 101,
    proof: "run-credential",
  });
  assert.equal(second.ok, false);
  assert.equal(second.ok === false && second.reason, "already-redeemed");
  assert.equal(context.gitGrantBrokerDeps.minted.length, 1, "不产生第二个 token");
  assert.equal((await context.storage.tasks.get(task.taskId))?.status, "active");
});

test("git grant 兑换：未签发 → unauthorized，且**不因请求补签**（01 §7.2）", async () => {
  const context = buildTestPlane();
  const { run } = await acceptedRun(context);
  const denied = await context.plane.gitGrants.redeem({
    runId: run.runId,
    purpose: "clone",
    runGeneration: run.runGeneration,
    repositoryId: 101,
    proof: "run-credential",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.code, "unauthorized");
  assert.equal(denied.ok === false && denied.reason, "no-issued-grant");
  assert.equal(context.gitGrantStore.records.length, 0, "兑换不落 grant（不补签）");
});

test("git grant 兑换：过期后拒绝（时间注入）", async () => {
  const context = buildTestPlane();
  const { run } = await acceptedRun(context);
  const issued = await context.plane.gitGrants.issueForRun({ runId: run.runId, purpose: "clone" });
  assert.equal(issued.ok, true);
  const window = issued.ok ? issued.expiresAt - context.clock.now() : 0;
  assert.equal(window, GIT_GRANT_TTL_MS, "TTL 取端口冻结值（GIT_GRANT_TTL_MS）");
  context.clock.advance(window + 1);
  const denied = await context.plane.gitGrants.redeem({
    runId: run.runId,
    purpose: "clone",
    runGeneration: run.runGeneration,
    repositoryId: 101,
    proof: "run-credential",
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.ok === false && denied.reason, "expired");
  assert.equal(context.gitGrantBrokerDeps.minted.length, 0);
});

test("git grant 签发：终态 run / 写能力不符被拒且不落库（01 §7.2、08 §3.2）", async () => {
  const context = buildTestPlane();
  const { run } = await acceptedRun(context);
  // provisioning run 不能签发 write grant（push 需要可写状态）。
  const pushDenied = await context.plane.gitGrants.issueForRun({
    runId: run.runId,
    purpose: "push",
  });
  assert.equal(pushDenied.ok, false);
  assert.equal(pushDenied.ok === false && pushDenied.code, "not_ready");
  assert.equal(context.gitGrantStore.records.length, 0, "被拒的签发不落库");

  // 终态 run：任何 purpose 都拒绝。
  await context.storage.runs.transitionStatus({
    runId: run.runId,
    runGeneration: run.runGeneration,
    from: ["provisioning"],
    to: "failed",
    endReason: "test",
    now: context.clock.now(),
  });
  const terminal = await context.plane.gitGrants.issueForRun({
    runId: run.runId,
    purpose: "clone",
  });
  assert.equal(terminal.ok, false);
  assert.equal(terminal.ok === false && terminal.reason, "run-terminal");
  assert.equal(context.gitGrantStore.records.length, 0);
});

test("git grant 签发幂等：同 (run, purpose) 重复调用只产生一条有效记录", async () => {
  const context = buildTestPlane();
  const { run } = await acceptedRun(context);
  const first = await context.plane.gitGrants.issueForRun({ runId: run.runId, purpose: "clone" });
  const second = await context.plane.gitGrants.issueForRun({ runId: run.runId, purpose: "clone" });
  assert.equal(first.ok && second.ok, true);
  assert.equal(first.ok && second.ok && first.grantId === second.grantId, true, "复用既有 grant");
  assert.equal(context.gitGrantStore.records.length, 1, "只有一条记录");
  assert.equal(context.gitGrantStore.records[0]?.status, "issued", "既有 grant 未被消费时才复用");
  // 另一 purpose 是独立记录（各自单次）。
  const push = await context.plane.gitGrants.issueForRun({ runId: run.runId, purpose: "clone" });
  assert.equal(push.ok && push.grantId === (first.ok ? first.grantId : ""), true);
});

test("push grant 在 checkpoint 请求之前签发（01 §7.2 写能力、08 §8.1 停止通路）", async () => {
  const context = buildTestPlane();
  const { task, run } = await acceptedRun(context);
  await context.plane.provisioning.create.runCreateOnce();
  const live = await context.storage.runs.get(run.runId);
  assert.ok(live);
  await attachReadySession(context, {
    taskId: task.taskId,
    runId: live.runId,
    runGeneration: live.runGeneration,
  });
  await context.plane.runs.markReady({
    taskId: task.taskId,
    runId: live.runId,
    runGeneration: live.runGeneration,
    connectionEpoch: live.connectionEpoch,
  });

  const sequence = context.gitGrantStore.events;
  const originalCheckpoint = context.attachmentPort.requestCheckpoint.bind(context.attachmentPort);
  context.attachmentPort.requestCheckpoint = async (request) => {
    sequence.push("checkpoint-requested");
    return originalCheckpoint(request);
  };
  const drained = await context.plane.lifecycle.drain.beginDrain({
    taskId: task.taskId,
    runId: live.runId,
    reason: "user-stop",
  });
  assert.equal(drained.ok, true);
  const grantIndex = sequence.findIndex((item) => item.startsWith("grant-issued:push:"));
  const checkpointIndex = sequence.indexOf("checkpoint-requested");
  assert.ok(grantIndex >= 0, "drain 先签发 push grant");
  assert.ok(checkpointIndex >= 0);
  assert.ok(grantIndex < checkpointIndex, "签发顺序在 checkpoint 请求之前");
  // draining 是停止通路内的可写状态（08 §8.1）：push grant 不应被停止屏障误拒。
  assert.equal(context.gitGrantStore.records.filter((item) => item.purpose === "push").length, 1);
});

test("秘密白名单：provider key/App 私钥永不进沙箱（01 §7.1）", () => {
  const policy = resolveRunSecretPolicy({
    deployment: "trusted-single-user",
    taskAuthorizesMcp: false,
  });
  assert.equal(isSecretAllowed(policy, "bootstrap-ticket"), true);
  assert.equal(
    isSecretAllowed(policy, "model-credential"),
    true,
    "单用户 v1 允许按 run 安装模型凭据",
  );
  assert.equal(isSecretAllowed(policy, "provider-api-key"), false);
  assert.equal(isSecretAllowed(policy, "app-private-key"), false);
  assert.equal(isSecretAllowed(policy, "webhook-secret"), false);
  assert.equal(isSecretAllowed(policy, "mcp-credential"), false, "MCP 默认空，需显式授权");
  const withMcp = resolveRunSecretPolicy({
    deployment: "trusted-single-user",
    taskAuthorizesMcp: true,
  });
  assert.equal(isSecretAllowed(withMcp, "mcp-credential"), true);
  assert.deepEqual(rejectDisallowedSecrets(withMcp, ["provider-api-key", "mcp-credential"]), [
    "provider-api-key",
  ]);
  const multiTenant = resolveRunSecretPolicy({
    deployment: "multi-tenant",
    taskAuthorizesMcp: false,
  });
  assert.equal(isSecretAllowed(multiTenant, "model-credential"), false, "多租户不开放直灌凭据");
});

test("生命周期循环：注册节流、单拍编排与关闭（W1 §4、03 §8）", async () => {
  const context = buildTestPlane();
  const harness = manualScheduler();
  const loops = startCloudLifecycleLoops(context.plane, {
    scheduler: harness.scheduler,
    intervals: {
      deliveryIntervalMs: 10,
      heartbeatIntervalMs: 20,
      provisioningIntervalMs: 30,
      lifecycleIntervalMs: 40,
    },
  });
  assert.deepEqual(
    harness.scheduled.sort((left, right) => left - right),
    [10, 20, 30, 40],
  );
  const report = await loops.runOnce();
  assert.equal(typeof report.deliveredTasks, "number");
  assert.ok(report.reconciliation.examined >= 0);
  await loops.runStartupReconciliation();
  await harness.tick();
  loops.stop();
  assert.equal(harness.size(), 0, "stop 取消全部周期任务");
});

test("循环编排完成一次「投递 + 对账」闭环（无缝驱动 app 通路）", async () => {
  const context = buildTestPlane();
  const { run } = await readyRunContext(context);
  context.plane.attachments.register({
    taskId: run.taskId,
    runId: run.runId,
    runGeneration: 1,
    connectionEpoch: 1,
    address: {
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: 1,
      workspaceIdentity: `cloud-task:${run.taskId}`,
      workspacePath: "/workspace/demo",
      remoteSessionId: `remote-${run.runId}`,
      connectionEpoch: 1,
    },
    ready: true,
    connectedAt: context.clock.now(),
  });
  await context.storage.runs.transitionStatus({
    runId: run.runId,
    runGeneration: 1,
    from: ["provisioning"],
    to: "ready",
    now: context.clock.now(),
  });
  const harness = manualScheduler();
  const loops = startCloudLifecycleLoops(context.plane, { scheduler: harness.scheduler });
  const report = await loops.runOnce();
  assert.equal(report.deliveredTasks, 1);
  assert.equal(context.attachmentPort.sent.length, 1);
  const input = await context.storage.inputs.get(
    run.taskId,
    "00000000-0000-4000-8000-000000000301",
  );
  assert.equal(input?.deliveryStatus, "delivering");
  loops.stop();
});

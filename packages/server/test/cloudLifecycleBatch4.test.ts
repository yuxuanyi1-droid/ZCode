/**
 * 生命周期 v2 第 4 批：create 租约三件套（C-3）与 runtime-exit 消费（D4-2 中间步）。
 *
 * - 租约续期覆盖 create 全程：provider create 60s+ 时持有方续租，租约窗口内不产生
 *   第二个租约（迟到分配的根源）；续期丢失立即退出。
 * - 迟到分配两阶段清账：终止意图先持久，provider 重试 30s 预算耗尽后保持 ambiguous
 *   + 告警，不再反复打 provider。
 * - runtime-exit：控制面消费心跳 processAlive 事实，确认后按 runtime-exit 语义标注
 *   断连原因（落 run.endReason），与「断网」区分。控制面不据此重建 supervisor。
 *
 * 说明：标注「真实时钟」的用例使用毫秒级真实定时器驱动续租循环（<1s），其余用例
 * 全部受控时钟、无 sleep。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxDriverPort } from "../src/cloud/app/ports/sandboxDriverPort.js";
import type { StoragePort } from "../src/cloud/app/ports/storagePort.js";
import {
  bridgeCloseDisconnectReason,
  nextRuntimeDeadStreak,
  runtimeExitConfirmed,
  RUNTIME_EXIT_DEAD_STREAK_LIMIT,
} from "../src/cloud/domain/runtimeExit.js";
import {
  leaseKeepaliveIntervalMs,
  startOperationLeaseKeepalive,
} from "../src/cloud/app/provisioning/leaseKeepalive.js";
import { routeInboundFrame } from "../src/cloud/adapters/ws/inbound.js";
import { createAttachmentRegistry } from "../src/cloud/app/attachments/registry.js";
import type { CloudBridgeContext, LiveConnection } from "../src/cloud/adapters/ws/types.js";
import { buildTestPlane, createFakeSandboxDriver, type TestPlane } from "./cloudCoreFakes.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000b4";

/** 走完 start（不执行 create），返回 run 上下文（create 租约用例的起点）。 */
async function submitStart(context: TestPlane) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.ok ? project.value.projectId : "",
    title: "lease keepalive",
    creationKey: `ck-${context.ids.newId()}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.ok ? task.value.taskId : "",
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-${context.ids.newId().slice(24)}`,
      prompt: "do the thing",
      expectedTaskRevision: task.ok ? task.value.revision : 0,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  assert.ok(runId);
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  return {
    taskId: task.ok ? task.value.taskId : "",
    runId: run.runId,
    runGeneration: run.runGeneration,
  };
}

// ── C-3：create 租约续期 ──

test("leaseKeepaliveIntervalMs：租期/3 夹在 [250ms, 15s]", () => {
  assert.equal(leaseKeepaliveIntervalMs(300), 250);
  assert.equal(leaseKeepaliveIntervalMs(60_000), 15_000);
  assert.equal(leaseKeepaliveIntervalMs(3_000), 1_000);
});

test("leaseKeepalive：受控时钟下逐拍续租；结算/令牌丢失后立即停止", async () => {
  const renewals: { token: string; now: number }[] = [];
  let settleLease = false;
  const gates: (() => void)[] = [];
  const keepalive = startOperationLeaseKeepalive({
    operations: {
      renewLease: async (request) => {
        renewals.push({ token: request.leaseToken, now: request.now });
        return !settleLease;
      },
    },
    clock: { now: () => 1_000 + renewals.length * 100 },
    operationId: "op-1",
    leaseToken: "token-1",
    leaseMs: 600,
    delay: () => new Promise<void>((resolve) => gates.push(resolve)),
  });
  // 前 3 拍：每拍一次续租，令牌不变。
  for (let tick = 0; tick < 3; tick += 1) {
    gates.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(renewals.length, 3);
  assert.ok(renewals.every((item) => item.token === "token-1"));
  assert.equal(keepalive.renewals(), 3);
  assert.equal(keepalive.lost(), false);
  // 结算后续租返回 false：keepalive 立即退出，不再发新续租。
  settleLease = true;
  gates.shift()?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(keepalive.lost(), true);
  const before = renewals.length;
  for (let tick = 0; tick < 2; tick += 1) {
    gates.shift()?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal(renewals.length, before, "丢失后不再续租");
  await keepalive.stop();
});

test("C-3：create 悬挂期间租约被续期，到期窗口内不产生第二个租约（真实时钟）", async () => {
  let openGate: (() => void) | null = null;
  const gatedDriver: SandboxDriverPort = {
    ...createFakeSandboxDriver(),
    async create(input) {
      await new Promise<void>((resolve) => {
        openGate = resolve;
      });
      return {
        provider: "e2b",
        sandboxId: `sandbox-${input.runId}`,
        providerDeadline: input.requestedDeadline,
      };
    },
  };
  const context = buildTestPlane({ driver: gatedDriver });
  await submitStart(context);
  // 测试侧以真实时间推进受控时钟（模拟 60s+ 的 create 期间时间流逝）。
  const ticker = setInterval(() => context.clock.advance(100), 20);
  try {
    const attempt = context.plane.provisioning.create.runCreateOnce({
      workerId: "lease-worker",
      leaseMs: 900,
    });
    // 等 create 进入悬挂（gate 已挂上）并跨过原租期窗口。
    for (let i = 0; i < 80 && openGate === null; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(openGate, "create 应已进入悬挂");
    await new Promise<void>((resolve) => setTimeout(resolve, 400));
    assert.ok(context.outbox.renewals.length >= 1, "create 悬挂期间持有方在续租");
    // 原 900ms 租期已过（时钟被推进），但租约被续走：第二个 worker 领不到同一 create。
    const thief = await context.outbox.leaseNext({
      kinds: ["create"],
      workerId: "thief",
      leaseMs: 60_000,
      now: context.clock.now(),
    });
    assert.equal(thief, null, "create 60s+ 不得被二次租约（C-3）");
    openGate();
    const outcome = await attempt;
    assert.equal(outcome?.outcome, "created");
  } finally {
    clearInterval(ticker);
  }
  const operation = [...context.outbox.records.values()].find((op) => op.kind === "create");
  assert.equal(operation?.state, "settled");
});

// ── C-3：迟到分配两阶段清账 ──

test("迟到分配清账：意图先持久，provider 重试 30s 预算耗尽后保持 ambiguous + 告警", async () => {
  const context = buildTestPlane();
  context.driver.createOutcome = "throw-unknown";
  context.driver.findCreateResultOutcome = "unknown";
  const session = await submitStart(context);
  const attempt = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(attempt?.outcome, "unknown", "create 结果未知进对账（03 §5）");
  const createOp = await context.outbox.findByKey(`create:${session.runId}`);
  assert.equal(createOp?.state, "ambiguous");
  assert.equal(context.driver.findCreateResultCalls, 1, "catch 分支对账一次");

  // 两阶段第一步：清理意图先持久（terminate/cleanup op），此时还没有任何 provider destroy。
  const requested = await context.plane.provisioning.compensation.requestTermination({
    runId: session.runId,
    runGeneration: session.runGeneration,
    reason: "reconcile-cleanup",
  });
  assert.ok(requested.ok);
  assert.equal(context.driver.terminateCalls, 0, "provider destroy 未发生");

  // 第 1 轮（预算内）：terminate/cleanup 各对账一次，结果未知 → 保持 ambiguous。
  const round1 = await context.plane.provisioning.compensation.runCompensationOnce();
  assert.equal(round1.ambiguous, 2);
  const callsAfterRound1 = context.driver.findCreateResultCalls;
  assert.ok(callsAfterRound1 >= 3, "预算内照常重试 provider 对账");
  assert.equal(context.driver.terminateCalls, 0);

  // 预算耗尽（>30s 且是重试）：保持 ambiguous + 告警，不再打 provider。
  context.clock.advance(61_000);
  const round2 = await context.plane.provisioning.compensation.runCompensationOnce();
  assert.equal(round2.ambiguous, 2, "预算耗尽仍保持 ambiguous（不猜、不释放槽位）");
  assert.equal(
    context.driver.findCreateResultCalls,
    callsAfterRound1,
    "预算耗尽不再重试 provider IO",
  );
  assert.equal(context.driver.terminateCalls, 0, "预算耗尽不再打 provider destroy");
  void session;
});

// ── D4-2：runtime-exit 消费 ──

test("runtime-exit 判定：连续死亡计数与连接关闭语义归类", () => {
  assert.equal(nextRuntimeDeadStreak({ processAlive: true, currentStreak: 2 }), 0);
  assert.equal(nextRuntimeDeadStreak({ processAlive: false, currentStreak: 0 }), 1);
  assert.equal(RUNTIME_EXIT_DEAD_STREAK_LIMIT, 2);
  assert.equal(runtimeExitConfirmed(1), false);
  assert.equal(runtimeExitConfirmed(2), true);
  assert.equal(
    bridgeCloseDisconnectReason({ runtimeExitConfirmed: false }),
    "bridge-socket-closed",
    "网络断开维持原标注",
  );
  assert.equal(
    bridgeCloseDisconnectReason({ runtimeExitConfirmed: true }),
    "runtime-exit",
    "确认过 runtime 退出的连接按 runtime-exit 标注（D4-2）",
  );
});

function makeHeartbeatFrame(processAlive: boolean, connectionEpoch: number) {
  return {
    protocolVersion: 1 as const,
    type: "bridge.heartbeat" as const,
    connectionEpoch,
    processAlive,
    activitySummary: "ready",
    walHighWatermarks: [],
    sentAt: 0,
  };
}

function makeRouteContext(run: { taskId: string; runId: string; runGeneration: number }) {
  return {
    services: () => {
      throw new Error("heartbeat 消费不触 services()");
    },
    registry: createAttachmentRegistry(),
    storage: { runs: { get: async () => run } } as unknown as StoragePort,
    clock: { now: () => 1_000 },
    hash: {} as never,
    ids: {} as never,
  } as CloudBridgeContext;
}

function makeConnection(run: {
  taskId: string;
  runId: string;
  runGeneration: number;
}): LiveConnection {
  return {
    socket: {
      send: () => undefined,
      close: () => undefined,
      onMessage: () => undefined,
      onClose: () => undefined,
    },
    taskId: run.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: 1,
    runtimeIncarnation: "unknown",
    authenticated: true,
  };
}

test("D4-2：连续两拍 processAlive=false 确认 runtime 退出事实；恢复心跳不清除连接标注", async () => {
  const run = { taskId: "task-1", runId: "run-1", runGeneration: 1 };
  const context = makeRouteContext(run);
  const connection = makeConnection(run);
  const registry = context.registry;

  // 注册 session：heartbeat 消费走 registry.heartbeat（epoch 校验）。
  registry.register({
    taskId: run.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: 1,
    address: {
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      workspaceIdentity: `cloud-task:${run.taskId}`,
      workspacePath: "/workspace/task-1",
      remoteSessionId: "remote-1",
      connectionEpoch: 1,
    },
    ready: true,
    connectedAt: 0,
  });

  await routeInboundFrame(context, connection, makeHeartbeatFrame(false, 1));
  assert.equal(connection.runtimeDeadStreak, 1);
  assert.equal(connection.runtimeExitConfirmed, undefined, "单拍死亡不确认");

  await routeInboundFrame(context, connection, makeHeartbeatFrame(false, 1));
  assert.equal(connection.runtimeDeadStreak, 2);
  assert.equal(connection.runtimeExitConfirmed, true, "连续两拍死亡确认 runtime 退出");

  // 事实标注是粘性的：恢复心跳清零计数，但本连接已确认过退出。
  await routeInboundFrame(context, connection, makeHeartbeatFrame(true, 1));
  assert.equal(connection.runtimeDeadStreak, 0);
  assert.equal(connection.runtimeExitConfirmed, true);

  // 该连接关闭时应标注 runtime-exit（bridgeChannel 消费同一事实）。
  assert.equal(
    bridgeCloseDisconnectReason({ runtimeExitConfirmed: connection.runtimeExitConfirmed === true }),
    "runtime-exit",
  );
});

test("D4-2：epoch 不匹配的心跳不消费死亡计数（旧 socket 不得毒化当前连接事实）", async () => {
  const run = { taskId: "task-1", runId: "run-2", runGeneration: 1 };
  const context = makeRouteContext(run);
  const connection = makeConnection(run);
  await routeInboundFrame(context, connection, makeHeartbeatFrame(false, 99));
  assert.equal(connection.runtimeDeadStreak, undefined, "旧 epoch 帧不进入消费");
});

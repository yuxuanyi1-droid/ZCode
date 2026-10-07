/**
 * W6 bridge 会话用例（specs/cloud-agent 02 §5.1/§5.2/§5.3、§11 B-02/B-03/B-04/B-05）。
 *
 * 断言的是**客户端恢复契约**：候选先落盘、丢 welcome 后同 attempt 恢复、CAS 已提交后
 * 旧 token 失效、epoch 接管单一有效、断网只释放网络 facade。假控制面只实现
 * 02 §5.1/§5.2 的服务端规则（见 test/cloudBridgeFakes.ts），不是同义反复。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { createBridgeSession } from "../src/cloud/execution/app/bridgeSession.js";
import type { BridgeSession } from "../src/cloud/execution/app/bridgeSession.js";
import type { BridgeTransportPort } from "../src/cloud/execution/app/ports.js";
import { createCredentialState } from "../src/cloud/execution/domain/credentialRotation.js";
import { OFFLINE_EXPIRY_GUARD_MS } from "../src/cloud/execution/domain/supervision.js";
import {
  FakeControlPlane,
  createMemoryConnectionPair,
  createTestClock,
  testLogger,
  type TestClock,
} from "./cloudBridgeFakes.js";
import {
  createBootstrapFake,
  createCheckpointRecorder,
  createCredentialStore,
  createProjectionFake,
  createRuntimeFake,
  type ProjectionFake,
  type RuntimeFake,
} from "./cloudExecutionFakes.js";

const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const RUN_ID = "1f14e45f-ceea-467a-9a1e-1f0d3b2a4c52";
const TOKEN = "bootstrap-ticket-plaintext";
/** helloAttemptId 是 uuid 形状（shared 冻结）；测试用固定值以便复现。 */
const ATTEMPT_ID = "9c1f0b7a-3f2e-4d5c-8a11-2b3c4d5e6f70";

function waitFor(predicate: () => boolean, label: string, turns = 600): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let count = 0;
    const step = () => {
      if (predicate()) return resolve();
      if (count >= turns) return reject(new Error(`timed out waiting for ${label}`));
      count += 1;
      setImmediate(step);
    };
    step();
  });
}

interface SessionFixture {
  session: BridgeSession;
  clock: TestClock;
  projection: ProjectionFake;
  runtime: RuntimeFake;
  released: string[];
  checkpoints: ReturnType<typeof createCheckpointRecorder>;
  store: ReturnType<typeof createCredentialStore>;
}

function buildSession(options: {
  transport: BridgeTransportPort;
  store: ReturnType<typeof createCredentialStore>;
  clock?: TestClock;
  runtime?: RuntimeFake;
  projection?: ProjectionFake;
}): SessionFixture {
  const clock = options.clock ?? createTestClock();
  const projection = options.projection ?? createProjectionFake();
  const runtime = options.runtime ?? createRuntimeFake();
  const checkpoints = createCheckpointRecorder();
  const released: string[] = [];
  const session = createBridgeSession({
    address: {
      taskId: TASK_ID,
      runId: RUN_ID,
      runGeneration: 1,
      workspaceIdentity: `cloud-task:${TASK_ID}`,
      workspacePath: "/workspace/demo",
      remoteSessionId: RUN_ID,
    },
    bridgeUrl: `wss://cloud.example.test/ws/cloud/bridge/${RUN_ID}`,
    workspacePathHint: "/workspace/demo",
    transport: options.transport,
    credentials: options.store.port,
    projection,
    rpcRelay: { handle: () => undefined, releaseAll: (reason) => released.push(reason) },
    bootstrap: createBootstrapFake(runtime),
    checkpoint: checkpoints,
    drain: { onDrain: async () => undefined },
    clock,
    logger: testLogger(),
    newAttemptId: () => randomUUID(),
    newResumeToken: () => randomUUID(),
    jitter: () => 0,
    timings: { heartbeatIntervalMs: 1, welcomeTimeoutMs: 2, bootstrapConfigTimeoutMs: 3 },
  });
  return { session, clock, projection, runtime, released, checkpoints, store: options.store };
}

function seed(store: ReturnType<typeof createCredentialStore>, nextResumeToken: string): void {
  void store.port.save(
    createCredentialState({
      address: { taskId: TASK_ID, runId: RUN_ID, runGeneration: 1 },
      initialToken: TOKEN,
      nextResumeToken,
      helloAttemptId: ATTEMPT_ID,
    }),
  );
}

/** 直接喂入一条 hello 的模板（B-05 里两条 socket 并发接管时复用）。 */
function helloTemplate(credentialToken: string) {
  return {
    protocolVersion: 1,
    type: "bridge.hello",
    address: {
      taskId: TASK_ID,
      runId: RUN_ID,
      runGeneration: 1,
      workspaceIdentity: `cloud-task:${TASK_ID}`,
      workspacePath: "/workspace/demo",
      remoteSessionId: RUN_ID,
    },
    helloAttemptId: ATTEMPT_ID,
    credentialToken,
    candidateNextResumeToken: "resume-B",
    runtimeIncarnation: "runtime-1",
  };
}

test("凭据阶梯：当前凭据与候选都被拒绝时 fail closed，不再无限自动旋转", async () => {
  const control = new FakeControlPlane({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    initialToken: "different-token",
  });
  const store = createCredentialStore();
  seed(store, "resume-B");
  const fixture = buildSession({ transport: control.transport(), store });
  fixture.session.start();
  let finalState = "";
  try {
    await waitFor(() => fixture.session.state() === "failed-closed", "failed-closed");
    finalState = fixture.session.state();
  } finally {
    await fixture.session.stop("test");
  }

  const tokens = control.hellos.map(
    (entry) => (entry.frame as Record<string, unknown>).credentialToken,
  );
  const attempts = control.hellos.map(
    (entry) => (entry.frame as Record<string, unknown>).helloAttemptId,
  );
  // 阶梯：当前凭据 A → 候选 B → 回退 A；三步都失败即 fail closed（02 §5.2）。
  assert.deepEqual(tokens, [TOKEN, "resume-B", TOKEN]);
  assert.deepEqual(attempts, [ATTEMPT_ID, ATTEMPT_ID, ATTEMPT_ID], "恢复必须复用同一 attemptId");
  assert.ok(
    control.hellos.every((entry) => entry.accepted === false),
    "三个被拒的 hello 都不应产生 attachment",
  );
  assert.equal(control.attachments.length, 0);
  assert.equal(finalState, "failed-closed", "两个凭据都失败必须 fail closed");
});

test("B-04：welcome 丢失后同 attempt 用持久候选恢复，rotationId 复用、epoch 递增", async () => {
  const control = new FakeControlPlane({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    initialToken: TOKEN,
    dropWelcomeOnAttempt: 1,
  });
  const store = createCredentialStore();
  seed(store, "resume-B");
  const fixture = buildSession({ transport: control.transport(), store });
  fixture.session.start();
  try {
    await waitFor(() => control.attachments.length >= 2, "second attachment after dropped welcome");
  } finally {
    await fixture.session.stop("test");
  }

  const first = control.hellos[0]!.frame as Record<string, unknown>;
  const second = control.hellos[1]!.frame as Record<string, unknown>;
  assert.equal(second.helloAttemptId, first.helloAttemptId, "恢复用原 attemptId");
  assert.equal(second.credentialToken, "resume-B", "welcome 丢失后必须用发送前已持久化的候选 B");
  assert.equal(control.hellos[1]!.rotationId, control.hellos[0]!.rotationId, "复用 rotationId");
  assert.ok(
    control.attachments[1]!.epoch > control.attachments[0]!.epoch,
    "新 socket 接管必须递增 connectionEpoch",
  );
});

test("B-03：CAS 已提交但 welcome 前崩溃，重连用候选恢复且只留一条 attachment", async () => {
  const control = new FakeControlPlane({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    initialToken: TOKEN,
    crashAfterCasOnAttempt: 1,
  });
  const store = createCredentialStore();
  seed(store, "resume-B");
  const fixture = buildSession({ transport: control.transport(), store });
  fixture.session.start();
  try {
    await waitFor(() => control.hellos.length >= 2, "recovery hello");
  } finally {
    await fixture.session.stop("test");
  }

  assert.equal(control.hellos[1]!.accepted, true, "重连必须能用候选 B 恢复");
  assert.equal(control.attachments.length, 1, "崩溃后只应有一次有效 attachment");
  assert.equal(control.attachments[0]!.rotationId, control.hellos[1]!.rotationId);
  assert.equal(control.attachments[0]!.epoch, 1, "恢复后的接管只递增一次 epoch");
});

test("B-05：epoch 接管单一有效——旧 socket 的 ready/rpc 帧被拒绝", () => {
  const control = new FakeControlPlane({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    initialToken: TOKEN,
  });
  const connectionA = createMemoryConnectionPair();
  const connectionB = createMemoryConnectionPair();

  // socket 1：CAS 提交，epoch=1。
  control.handle(helloTemplate(TOKEN), connectionA.controlSide, 1);
  const first = control.attachments.at(-1)!;
  assert.equal(first.epoch, 1);
  // socket 2：同 attempt + 候选 B 接管，epoch 递增。
  control.handle(helloTemplate("resume-B"), connectionB.controlSide, 2);
  const second = control.attachments.at(-1)!;
  assert.equal(second.epoch, 2, "新 socket 接管总是递增 epoch");
  assert.equal(second.rotationId, first.rotationId, "同 attempt 内容一致复用 rotationId");

  // 旧 socket 继续发 ready / rpc：必须被拒绝，且不影响当前 attachment。
  control.handle(
    {
      protocolVersion: 1,
      type: "bridge.ready",
      connectionEpoch: 1,
      configVersion: "policy-1",
      runtimeIncarnation: "runtime-1",
      exporterReady: true,
      walReady: true,
      executionCapabilities: [],
    },
    connectionA.controlSide,
    1,
  );
  control.handle(
    {
      protocolVersion: 1,
      type: "rpc.open",
      runId: RUN_ID,
      runGeneration: 1,
      connectionEpoch: 1,
      streamId: randomUUID(),
    },
    connectionA.controlSide,
    1,
  );
  assert.deepEqual(
    control.rejectedFrames.map((entry) => entry.reason),
    ["stale-epoch", "stale-attachment"],
    "旧 socket 的 ready 与 rpc 帧都必须被拒绝（单 epoch 生效）",
  );
  assert.equal(control.attachments.at(-1)!.epoch, 2, "旧 socket 不能改写当前 attachment");
});

test("epoch 倒退的 welcome 被拒绝：按协议错误重连而不是接受旧 socket 的接管", async () => {
  const connections: ReturnType<typeof createMemoryConnectionPair>[] = [];
  const transport: BridgeTransportPort = {
    async connect() {
      const pair = createMemoryConnectionPair();
      connections.push(pair);
      return pair.bridgeSide;
    },
  };
  const store = createCredentialStore();
  // 本地已知 epoch=5（上一次接管的结果）；控制面却回更小的 3 = 旧 socket 的接管结果。
  await store.port.save({
    ...createCredentialState({
      address: { taskId: TASK_ID, runId: RUN_ID, runGeneration: 1 },
      initialToken: TOKEN,
      nextResumeToken: "resume-B",
      helloAttemptId: ATTEMPT_ID,
    }),
    confirmed: true,
    rotationId: "rotation-prev",
    connectionEpoch: 5,
  });
  const fixture = buildSession({ transport, store });
  fixture.session.start();
  try {
    await waitFor(() => connections.length === 1, "first connection");
    connections[0]!.bridgeSide.deliver({
      protocolVersion: 1,
      type: "bridge.welcome",
      connectionEpoch: 3,
      rotationId: "rotation-old",
      capabilities: [],
      ingestCursors: [],
      policyVersion: "policy-1",
    });
    await waitFor(() => connections.length >= 2, "reconnect after stale epoch");
  } finally {
    await fixture.session.stop("test");
  }
  assert.notEqual(fixture.session.state(), "failed-closed", "协议错误是网络侧可恢复分类");
});

test("本地事实源写不进去：终态上报而不是无限重连（E2B EACCES 的教训）", async () => {
  const control = new FakeControlPlane({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    initialToken: TOKEN,
  });
  // 本地已有状态（load 成功），只有持久化失败——正是 EACCES 的真实形态。
  const seeded = createCredentialState({
    address: { taskId: TASK_ID, runId: RUN_ID, runGeneration: 1 },
    initialToken: TOKEN,
    nextResumeToken: "resume-B",
    helloAttemptId: ATTEMPT_ID,
  });
  let saves = 0;
  const fatals: string[] = [];
  const clock = createTestClock();
  const session = createBridgeSession({
    address: {
      taskId: TASK_ID,
      runId: RUN_ID,
      runGeneration: 1,
      workspaceIdentity: `cloud-task:${TASK_ID}`,
      workspacePath: "/workspace/demo",
      remoteSessionId: RUN_ID,
    },
    bridgeUrl: `wss://cloud.example.test/ws/cloud/bridge/${RUN_ID}`,
    workspacePathHint: "/workspace/demo",
    transport: control.transport(),
    credentials: {
      load: async () => seeded,
      // 模拟状态目录不可写：持久化必然失败。
      save: async () => {
        saves += 1;
        throw Object.assign(new Error("EACCES: permission denied, mkdir '/run/zcode-bridge'"), {
          code: "EACCES",
        });
      },
    },
    projection: createProjectionFake(),
    rpcRelay: { handle: () => undefined, releaseAll: () => undefined },
    bootstrap: createBootstrapFake(),
    checkpoint: createCheckpointRecorder(),
    drain: { onDrain: async () => undefined },
    clock,
    logger: testLogger(),
    newAttemptId: () => randomUUID(),
    newResumeToken: () => randomUUID(),
    jitter: () => 0,
    onFatal: (reason) => fatals.push(reason),
    timings: { heartbeatIntervalMs: 1, welcomeTimeoutMs: 2, bootstrapConfigTimeoutMs: 3 },
  });
  session.start();
  try {
    await waitFor(() => fatals.length > 0, "fatal reported");
  } finally {
    await session.stop("test");
  }
  assert.equal(fatals.length, 1, "本地写失败必须上报一次终态原因");
  assert.match(fatals[0]!, /credential state is not persistable/);
  assert.match(fatals[0]!, /EACCES/);
  assert.equal(saves, 1, "写失败不得被退避重连掩盖成反复重试");
  assert.equal(control.hellos.length, 0, "候选未落盘前不得发 hello（02 §5.1 第 2 条）");
});

test("B-02：断网超过 2 分钟 runtime PID 不变、WAL 保留、无终态上报、只释放网络 facade", async () => {
  const control = new FakeControlPlane({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    initialToken: TOKEN,
  });
  const clock = createTestClock();
  const runtime = createRuntimeFake(9876);
  const store = createCredentialStore();
  seed(store, "resume-B");

  const pairs: ReturnType<typeof createMemoryConnectionPair>[] = [];
  let failing = false;
  let socket = 0;
  const transport: BridgeTransportPort = {
    async connect() {
      if (failing) throw new Error("network unreachable");
      const pair = createMemoryConnectionPair();
      pairs.push(pair);
      socket += 1;
      pair.controlSide.onFrame((frame) => control.handle(frame, pair.controlSide, socket));
      return pair.bridgeSide;
    },
  };
  const fixture = buildSession({ transport, store, clock, runtime });
  fixture.session.start();
  await waitFor(() => pairs.length === 1 && fixture.session.context() !== null, "ready attachment");
  const pidBefore = runtime.facts().pid;
  let releasedAtOutage = 0;
  let outageState = "";
  try {
    failing = true;
    pairs[0]!.controlSide.close("network-partition");
    await waitFor(
      () => clock.elapsedMs > OFFLINE_EXPIRY_GUARD_MS && fixture.released.length > 0,
      "virtual outage beyond 2 minutes",
    );
    releasedAtOutage = fixture.released.length;
    outageState = fixture.session.state();
  } finally {
    await fixture.session.stop("test");
  }

  assert.ok(
    clock.elapsedMs > OFFLINE_EXPIRY_GUARD_MS,
    `断网虚拟时长必须超过守卫阈值，实际 ${clock.elapsedMs}ms`,
  );
  assert.ok(releasedAtOutage > 0, "断开必须释放网络侧 relay 会话");
  assert.equal(runtime.facts().pid, pidBefore, "runtime PID 不得变化");
  assert.equal(runtime.stopCalls.length, 0, "断网不得停止 runtime");
  assert.equal(fixture.projection.stopped, false, "断网不得停止投影 exporter/WAL");
  assert.equal(fixture.projection.store.present().length, 0, "WAL 内容不被断网清空或丢写");
  // 断网不是终态：Run 是否 expired 由控制面裁决（03 §2）。
  assert.notEqual(outageState, "failed-closed");
});

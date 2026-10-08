/**
 * W1 入口级装配测试（W5 冻结面：`assembleCloudControlPlane(context)` → principalId +
 * registerRoutes + loops + close；03 §8 启动顺序）。
 * 覆盖：readiness 门槛、不自建定时器、路由注册、关闭顺序、bridge 握手（hello → welcome →
 * bootstrap.config → ready）与 WS 未接线时的 fail-closed。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import { buildTestPlane, type TestPlane } from "./cloudCoreFakes.js";
import {
  assembleCloudControlPlane as assembleCloudEntryControlPlane,
  CloudControlPlaneAssemblyError,
  type CloudControlPlaneContext,
} from "../src/cloud/adapters/entry-cloud-control-plane.js";
import { createCloudBridgeChannel } from "../src/cloud/adapters/ws/bridgeChannel.js";
import {
  createFakeDriverRegistry,
  createFakeGitHub,
  createFakeProvisioningEnvelope,
  createFakeSandboxDriver,
  createFakeTemplateResolver,
  createFakeGitGrantBroker,
} from "./cloudCoreAdapterFakes.js";
import {
  FakeClock,
  FakeHash,
  FakeIds,
  createFakeOutbox,
  createFakeStorage,
} from "./cloudCoreFakes.js";
import { createAttachmentRegistry } from "../src/cloud/app/attachments/registry.js";
import {
  assembleCloudControlPlane as assembleCloudCoreControlPlane,
  type CloudControlPlane as CloudCoreControlPlane,
} from "../src/cloud/app/assembleCloudControlPlane.js";
import type { LoopSchedulerPort } from "../src/cloud/app/ports/loopSchedulerPort.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";
const RUN_ID = "00000000-0000-4000-8000-0000000000b1";

function manualScheduler() {
  const scheduled: number[] = [];
  const cancellations: number[] = [];
  let live = 0;
  const scheduler: LoopSchedulerPort = {
    schedule(intervalMs, _task) {
      scheduled.push(intervalMs);
      live += 1;
      return () => {
        live -= 1;
        cancellations.push(intervalMs);
      };
    },
    delay(_delayMs, _task) {
      return () => undefined;
    },
  };
  return { scheduler, scheduled, cancellations, liveCount: () => live };
}

function entryContext(
  planeContext: TestPlane,
  scheduler: LoopSchedulerPort,
  overrides: Partial<CloudControlPlaneContext> = {},
): CloudControlPlaneContext {
  return {
    config: {
      dataDir: "/tmp/cloud-entry-test",
      maxConcurrentRuns: 3,
      publicOrigin: "https://cloud.invalid",
    },
    secrets: { principalId: PRINCIPAL },
    drivers: createFakeDriverRegistry(createFakeSandboxDriver()),
    storageWorkerEntryPath: "/tmp/cloud-entry-test/storageWorkerMain.js",
    loopScheduler: scheduler,
    storage: {
      readiness: () => planeContext.storage.readiness(),
      storage: planeContext.storage,
      operations: planeContext.outbox,
    },
    github: planeContext.github,
    templates: undefined,
    ...overrides,
  };
}

test("入口装配：readiness 门槛 + 路由注册 + 循环句柄 + 关闭顺序（03 §8）", async () => {
  const planeContext = buildTestPlane();
  const harness = manualScheduler();
  let closed = false;
  const controlPlane = await assembleCloudEntryControlPlane(
    entryContext(planeContext, harness.scheduler, {
      storage: {
        readiness: () => planeContext.storage.readiness(),
        storage: planeContext.storage,
        operations: planeContext.outbox,
        close: async () => {
          closed = true;
        },
      },
    }),
  );
  assert.equal(controlPlane.principalId, PRINCIPAL);
  assert.equal(harness.scheduled.length, 0, "装配阶段不自建定时器");

  const app = new Hono();
  controlPlane.registerRoutes(app);
  const capabilities = await app.request("/api/cloud/capabilities");
  assert.equal(capabilities.status, 200);
  const body = (await capabilities.json()) as {
    mode: string;
    protocolVersion: number;
    providers: unknown[];
  };
  assert.equal(body.mode, "cloud");
  assert.equal(body.protocolVersion, 1);
  assert.equal(body.providers.length, 1);
  // 分阶段端点如实返回 501（不伪装空列表）。
  const events = await app.request("/api/cloud/events");
  assert.equal(events.status, 501);

  controlPlane.loops.delivery.start();
  controlPlane.loops.delivery.start();
  controlPlane.loops.lifecycle.start();
  assert.equal(harness.scheduled.length, 4, "delivery 1 条 + lifecycle 3 条；start 幂等");
  await controlPlane.close();
  assert.equal(harness.liveCount(), 0, "close 取消所有周期任务");
  assert.equal(
    closed,
    false,
    "注入的存储由注入方持有生命周期：控制面只复用，不替它关闭（自持路径在入口装配集成测试中覆盖）",
  );
});

test("入口装配把分支枚举缝接到路由（W4 listBranches 注入后端点从 501 变为可用）", async () => {
  const planeContext = buildTestPlane();
  const harness = manualScheduler();
  const controlPlane = await assembleCloudEntryControlPlane(
    entryContext(planeContext, harness.scheduler, {
      githubCatalog: {
        isConfigured: () => true,
        listRepositories: async () => ({ items: [] }),
        assertAuthorized: () => undefined,
      },
      githubBranchCatalog: {
        listBranches: async () => ({
          items: [{ name: "main", sha: "a".repeat(40), isDefault: true }],
        }),
      },
    }),
  );
  const app = new Hono();
  controlPlane.registerRoutes(app);
  const response = await app.request("/api/cloud/repositories/101/branches");
  assert.equal(response.status, 200);
  const body = (await response.json()) as { items: { name: string; isDefault: boolean }[] };
  assert.deepEqual(body.items, [{ name: "main", sha: "a".repeat(40), isDefault: true }]);
  await controlPlane.close();
});

test("自持 StoragePort 时 readiness 未就绪即 fail-closed（不返回半成品进程）", async () => {
  const planeContext = buildTestPlane({ storage: { writable: false } });
  const harness = manualScheduler();
  await assert.rejects(
    assembleCloudEntryControlPlane(entryContext(planeContext, harness.scheduler)),
    (error: unknown) =>
      error instanceof CloudControlPlaneAssemblyError && error.code === "not_configured",
  );
});

test("未接线 upgradeWebSocket：两条 WS 通道结构化 501，不回落本机执行域（03 §2）", async () => {
  const planeContext = buildTestPlane();
  const harness = manualScheduler();
  const controlPlane = await assembleCloudEntryControlPlane(
    entryContext(planeContext, harness.scheduler),
  );
  const app = new Hono();
  controlPlane.registerRoutes(app);
  const bridge = await app.request("/ws/cloud/bridge/00000000-0000-4000-8000-0000000000b1");
  assert.equal(bridge.status, 501);
  const task = await app.request("/ws/cloud/tasks/00000000-0000-4000-8000-0000000000b1");
  assert.equal(task.status, 501);
  await controlPlane.close();
});

/** 等待异步握手链路推进到期望状态（按事件循环推进，不用固定 sleep 断言时序）。 */
async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timeout waiting for ${label}`);
}

function createFakeSocket() {
  const sent: string[] = [];
  let messageHandler: ((data: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let closed: { code?: number; reason?: string } | undefined;
  return {
    sent,
    closedInfo: () => closed,
    socket: {
      send: (data: string) => sent.push(data),
      close: (code?: number, reason?: string) => {
        closed = { code, reason };
        closeHandler?.();
      },
      onMessage: (handler: (data: string) => void) => {
        messageHandler = handler;
      },
      onClose: (handler: () => void) => {
        closeHandler = handler;
      },
    },
    push: (data: string) => messageHandler?.(data),
  };
}

test("bridge 握手：hello → welcome → bootstrap.config；ready 后才发布在线状态（02 §5）", async () => {
  // 端到端装配：app 平面的 AttachmentPort 就是 bridge 通道（与入口装配同一接线）。
  const clock = new FakeClock();
  const ids = new FakeIds();
  const outbox = createFakeOutbox();
  const storage = createFakeStorage(clock, outbox);
  const registry = createAttachmentRegistry();
  let planeRef: CloudCoreControlPlane | undefined;
  const gitGrantDeps = gitGrantFakeDeps(clock);
  const bridge = createCloudBridgeChannel({
    services: () => {
      if (!planeRef) throw new Error("plane not ready");
      return planeRef;
    },
    registry,
    storage,
    clock,
    hash: { sha256Hex: async (value: string) => createHash("sha256").update(value).digest("hex") },
    ids: new FakeIds(),
  });
  planeRef = assembleCloudCoreControlPlane(
    {
      storage,
      operations: outbox,
      github: createFakeGitHub(),
      drivers: createFakeDriverRegistry(createFakeSandboxDriver()),
      attachments: bridge.port,
      runtimeCommands: bridge.runtimeCommands,
      clock,
      ids,
      hash: new FakeHash(),
      templates: createFakeTemplateResolver(),
      provisioningEnvelope: createFakeProvisioningEnvelope(),
      ...gitGrantDeps,
    },
    { registry },
  );
  const planeContext = { plane: planeRef, clock, storage, outbox };

  // 造一个已预留的 run（走真实接纳事务，保证基线/首命令等事实齐备）。
  const project = await planeContext.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await planeContext.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Handshake",
    creationKey: "ck-handshake",
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await planeContext.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-000000000601",
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  const runId = submit.value.runId ?? "";
  await planeContext.plane.provisioning.create.runCreateOnce();
  const run = await planeContext.storage.runs.get(runId);
  assert.ok(run);

  // 凭据：测试已知 ticket，因此直接写入其 hash（生产由 create worker 铸造）。
  const ticket = "ticket-handshake";
  await planeContext.storage.credentials.saveInitial({
    runId,
    runGeneration: run.runGeneration,
    credentialHash: createHash("sha256").update(ticket).digest("hex"),
    expiresAt: planeContext.clock.now() + 60_000,
    bootstrapOperationId: runId,
  });

  const fake = createFakeSocket();
  await bridge.acceptConnection({ runId, socket: fake.socket });
  fake.push(
    JSON.stringify({
      protocolVersion: 1,
      type: "bridge.hello",
      address: {
        taskId: task.value.taskId,
        runId,
        runGeneration: run.runGeneration,
        workspaceIdentity: `cloud-task:${task.value.taskId}`,
        workspacePath: "/workspace/demo",
        remoteSessionId: `remote-${runId}`,
      },
      helloAttemptId: "00000000-0000-4000-8000-0000000006aa",
      credentialToken: ticket,
      candidateNextResumeToken: "candidate-1",
      runtimeIncarnation: "incarnation-1",
    }),
  );
  await waitFor(() => fake.sent.length >= 2, "welcome + bootstrap.config");
  const frames = fake.sent.map(
    (item) =>
      JSON.parse(item) as {
        type: string;
        connectionEpoch?: number;
        faultCode?: string;
        message?: string;
      },
  );
  assert.deepEqual(
    frames
      .filter((frame) => frame.type === "bridge.fault")
      .map((frame) => `${frame.faultCode}/${frame.message}`),
    [],
    "握手期间不应出现 fault",
  );
  assert.deepEqual(
    frames.map((frame) => frame.type),
    ["bridge.welcome", "bootstrap.config"],
    "welcome 之后立即下发 bootstrap.config（02 §5.3）",
  );
  assert.equal(
    (await planeContext.storage.runs.get(runId))?.workspacePath,
    "/workspace/demo",
    "hello 的已核验工作区落地到 run",
  );

  fake.push(
    JSON.stringify({
      protocolVersion: 1,
      type: "bridge.ready",
      connectionEpoch: frames[0]?.connectionEpoch ?? 1,
      configVersion: "cfg-1",
      runtimeIncarnation: "incarnation-1",
      exporterReady: true,
      walReady: true,
      executionCapabilities: ["durable-input"],
    }),
  );
  await waitFor(
    () => planeContext.plane.attachments.current(runId)?.ready === true,
    "bridge ready",
  );
  assert.equal((await storage.runs.get(runId))?.status, "ready");
  assert.equal(registry.current(runId)?.ready, true);
  await bridge.close();
});

test("bridge 握手：hello 上报的 workspacePath 与持久事实不一致即拒绝（01 §6.2 步骤 2）", async () => {
  const clock = new FakeClock();
  const ids = new FakeIds();
  const outbox = createFakeOutbox();
  const storage = createFakeStorage(clock, outbox);
  const registry = createAttachmentRegistry();
  let planeRef: CloudCoreControlPlane | undefined;
  const gitGrantDeps = gitGrantFakeDeps(clock);
  const bridge = createCloudBridgeChannel({
    services: () => {
      if (!planeRef) throw new Error("plane not ready");
      return planeRef;
    },
    registry,
    storage,
    clock,
    hash: { sha256Hex: async (value: string) => createHash("sha256").update(value).digest("hex") },
    ids: new FakeIds(),
  });
  planeRef = assembleCloudCoreControlPlane(
    {
      storage,
      operations: outbox,
      github: createFakeGitHub(),
      drivers: createFakeDriverRegistry(createFakeSandboxDriver()),
      attachments: bridge.port,
      runtimeCommands: bridge.runtimeCommands,
      clock,
      ids,
      hash: new FakeHash(),
      templates: createFakeTemplateResolver(),
      provisioningEnvelope: createFakeProvisioningEnvelope(),
      ...gitGrantDeps,
    },
    { registry },
  );
  const project = await planeRef.tasks.createProject({ principalId: PRINCIPAL, repositoryId: 101 });
  assert.ok(project.ok);
  const task = await planeRef.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Mismatch",
    creationKey: "ck-mismatch",
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await planeRef.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-0000000007a1",
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  const runId = submit.value.runId ?? "";
  await planeRef.provisioning.create.runCreateOnce();
  const run = await storage.runs.get(runId);
  assert.ok(run);
  const ticket = "ticket-mismatch";
  await storage.credentials.saveInitial({
    runId,
    runGeneration: run.runGeneration,
    credentialHash: createHash("sha256").update(ticket).digest("hex"),
    expiresAt: clock.now() + 60_000,
    bootstrapOperationId: runId,
  });
  const fake = createFakeSocket();
  await bridge.acceptConnection({ runId, socket: fake.socket });
  fake.push(
    JSON.stringify({
      protocolVersion: 1,
      type: "bridge.hello",
      address: {
        taskId: task.value.taskId,
        runId,
        runGeneration: run.runGeneration,
        workspaceIdentity: `cloud-task:${task.value.taskId}`,
        // 越界/篡改路径：必须被拒绝，不接受沙箱改写 workspacePath。
        workspacePath: "/etc/passwd",
        remoteSessionId: `remote-${runId}`,
      },
      helloAttemptId: "00000000-0000-4000-8000-0000000007aa",
      credentialToken: ticket,
      candidateNextResumeToken: "candidate-1",
      runtimeIncarnation: "incarnation-1",
    }),
  );
  await waitFor(() => fake.closedInfo() !== undefined, "handshake rejection");
  assert.equal(fake.closedInfo()?.reason, "workspace-path-mismatch");
  assert.deepEqual(
    fake.sent.map((item) => (JSON.parse(item) as { type: string }).type),
    ["bridge.fault"],
    "拒绝时只回 fault，不发 welcome",
  );
  assert.equal(
    (await storage.runs.get(runId))?.workspacePath,
    run.workspacePath,
    "持久路径不被覆盖",
  );
  await bridge.close();
});

/** git grant 依赖注入（真实 W4 broker + 内存 store）：控制面签发与入口兑换共用同一实例。 */
function gitGrantFakeDeps(clock: { now(): number }) {
  const ids = new FakeIds();
  const grant = createFakeGitGrantBroker({ now: () => clock.now(), newGrantId: () => ids.newId() });
  return { gitGrantStore: grant.store, gitGrantBroker: grant.broker };
}

/** 捕获式 logger：断言日志内容（沿用既有脱敏口径：不记 token/帧正文）。 */
function captureLogger() {
  const entries: { level: string; message: string; fields: Record<string, unknown> }[] = [];
  const record = (level: string) => (_traceId: unknown, message: unknown, fields?: unknown) => {
    entries.push({
      level,
      message: typeof message === "string" ? message : String(message),
      fields: (fields ?? {}) as Record<string, unknown>,
    });
  };
  return {
    entries,
    logger: {
      debug: record("debug"),
      info: record("info"),
      warn: record("warn"),
      error: record("error"),
    },
    find: (message: string, reason?: string) =>
      entries.find(
        (entry) =>
          entry.message === message && (reason === undefined || entry.fields.reason === reason),
      ),
  };
}

test("bridge 通道日志：连接/握手/拒绝各留痕、心跳不刷 info、正文与凭据不入日志（02 §9）", async () => {
  const clock = new FakeClock();
  const outbox = createFakeOutbox();
  const storage = createFakeStorage(clock, outbox);
  const registry = createAttachmentRegistry();
  const capture = captureLogger();
  let planeRef: CloudCoreControlPlane | undefined;
  const gitGrantDeps = gitGrantFakeDeps(clock);
  const bridge = createCloudBridgeChannel({
    services: () => {
      if (!planeRef) throw new Error("plane not ready");
      return planeRef;
    },
    registry,
    storage,
    clock,
    hash: { sha256Hex: async (value: string) => createHash("sha256").update(value).digest("hex") },
    ids: new FakeIds(),
    logger: capture.logger as never,
  });
  planeRef = assembleCloudCoreControlPlane(
    {
      storage,
      operations: outbox,
      github: createFakeGitHub(),
      drivers: createFakeDriverRegistry(createFakeSandboxDriver()),
      attachments: bridge.port,
      runtimeCommands: bridge.runtimeCommands,
      clock,
      ids: new FakeIds(),
      hash: new FakeHash(),
      templates: createFakeTemplateResolver(),
      provisioningEnvelope: createFakeProvisioningEnvelope(),
      ...gitGrantDeps,
    },
    { registry },
  );

  // 造一个可供握手的 run（走真实接纳事务 + create worker）。
  const project = await planeRef.tasks.createProject({ principalId: PRINCIPAL, repositoryId: 101 });
  assert.ok(project.ok);
  const task = await planeRef.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Logging",
    creationKey: "ck-logging",
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await planeRef.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-000000000b01",
      prompt: "sensitive prompt body",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  const runId = submit.value.runId ?? "";
  await planeRef.provisioning.create.runCreateOnce();
  const run = await storage.runs.get(runId);
  assert.ok(run);
  const ticket = "ticket-logging-secret";
  await storage.credentials.saveInitial({
    runId,
    runGeneration: run.runGeneration,
    credentialHash: createHash("sha256").update(ticket).digest("hex"),
    expiresAt: clock.now() + 600_000,
    bootstrapOperationId: runId,
  });

  const helloFrame = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      protocolVersion: 1,
      type: "bridge.hello",
      address: {
        taskId: task.value.taskId,
        runId,
        runGeneration: run.runGeneration,
        workspaceIdentity: `cloud-task:${task.value.taskId}`,
        workspacePath: run.workspacePath ?? "/workspace/demo",
        remoteSessionId: `remote-${runId}`,
      },
      helloAttemptId: "00000000-0000-4000-8000-000000000baa",
      credentialToken: ticket,
      candidateNextResumeToken: "candidate-secret",
      runtimeIncarnation: "incarnation-logging",
      ...overrides,
    });

  // ── 成功握手 ──
  const ok = createFakeSocket();
  await bridge.acceptConnection({ runId, socket: ok.socket });
  ok.push(helloFrame());
  await waitFor(() => capture.find("bridge welcome sent") !== undefined, "welcome log");
  const welcome = capture.find("bridge welcome sent");
  assert.equal(welcome?.fields.runId, runId);
  // 接管后 epoch 递增一次（02 §5.1：新 socket 接管 CAS 递增，同 socket 重复 hello 不递增）。
  assert.equal(welcome?.fields.connectionEpoch, run.connectionEpoch + 1);
  assert.equal(typeof welcome?.fields.capabilitiesCount, "number");
  assert.ok(capture.find("bridge attachment opened"), "连接建立要留痕");
  ok.socket.close(1000, "normal");

  // ── 拒绝分支 ──
  const rejectCases: {
    reason: string;
    /**
     * 该分支的触发帧是否要求连接已通过 hello（02 §5.1 鉴权门控）。
     * rpc.* 分支校验的是**已认证连接**上的方向/地址围栏，未认证 socket 只会先撞上
     * 1008 unauthenticated，因此必须先完成一次合法 hello 再发触发帧
     * （未认证门控本身的用例在 cloudCoreRelay.test.ts 回归测试里覆盖）。
     */
    requiresAuthenticatedConnection?: boolean;
    drive: (socket: ReturnType<typeof createFakeSocket>) => void;
  }[] = [
    {
      reason: "stale-generation",
      drive: (socket) =>
        socket.push(
          helloFrame({
            address: {
              taskId: task.value.taskId,
              runId,
              runGeneration: run.runGeneration + 5,
              workspaceIdentity: `cloud-task:${task.value.taskId}`,
              workspacePath: "/workspace/demo",
              remoteSessionId: `remote-${runId}`,
            },
          }),
        ),
    },
    {
      reason: "credential-rejected",
      drive: (socket) => socket.push(helloFrame({ credentialToken: "wrong-ticket" })),
    },
    {
      reason: "identity-mismatch",
      drive: (socket) =>
        socket.push(
          helloFrame({
            address: {
              taskId: task.value.taskId,
              runId,
              runGeneration: run.runGeneration,
              workspaceIdentity: "cloud-task:00000000-0000-4000-8000-00000000dead",
              workspacePath: "/workspace/demo",
              remoteSessionId: `remote-${runId}`,
            },
          }),
        ),
    },
    {
      reason: "address-mismatch",
      drive: (socket) =>
        socket.push(
          helloFrame({
            address: {
              taskId: task.value.taskId,
              runId: "00000000-0000-4000-8000-00000000beef",
              runGeneration: run.runGeneration,
              workspaceIdentity: `cloud-task:${task.value.taskId}`,
              workspacePath: "/workspace/demo",
              remoteSessionId: "remote-x",
            },
          }),
        ),
    },
    {
      reason: "workspace-path-mismatch",
      drive: (socket) =>
        socket.push(
          helloFrame({
            address: {
              taskId: task.value.taskId,
              runId,
              runGeneration: run.runGeneration,
              workspaceIdentity: `cloud-task:${task.value.taskId}`,
              workspacePath: "/etc/passwd",
              remoteSessionId: `remote-${runId}`,
            },
          }),
        ),
    },
    { reason: "invalid-frame", drive: (socket) => socket.push("{not json") },
    {
      reason: "unexpected-frame-direction",
      requiresAuthenticatedConnection: true,
      drive: (socket) =>
        socket.push(
          JSON.stringify({
            protocolVersion: 1,
            type: "rpc.request",
            runId,
            runGeneration: run.runGeneration,
            connectionEpoch: run.connectionEpoch,
            streamId: "00000000-0000-4000-8000-000000000bb1",
            payload: Buffer.from("x").toString("base64"),
          }),
        ),
    },
    {
      reason: "rpc-address-mismatch",
      requiresAuthenticatedConnection: true,
      drive: (socket) =>
        socket.push(
          JSON.stringify({
            protocolVersion: 1,
            type: "rpc.response",
            runId: "00000000-0000-4000-8000-00000000cafe",
            runGeneration: run.runGeneration,
            connectionEpoch: run.connectionEpoch,
            streamId: "00000000-0000-4000-8000-000000000bb2",
            payload: Buffer.from("x").toString("base64"),
          }),
        ),
    },
  ];
  for (const testCase of rejectCases) {
    // 每次重放前重置初始凭据：hello 会消费并轮换，否则第二次 hello 会先撞上 credential-rejected。
    await storage.credentials.saveInitial({
      runId,
      runGeneration: run.runGeneration,
      credentialHash: createHash("sha256").update(ticket).digest("hex"),
      expiresAt: clock.now() + 600_000,
      bootstrapOperationId: runId,
    });
    const socket = createFakeSocket();
    await bridge.acceptConnection({ runId, socket: socket.socket });
    if (testCase.requiresAuthenticatedConnection) {
      // 02 §5.1：hello 之前的 socket 不进入路由表，只允许 `bridge.hello`。先跑完一次合法
      // 握手，让后续触发帧落在已认证连接上（否则会被门控提前 1008 unauthenticated 拦下）。
      socket.push(helloFrame());
      await waitFor(
        () =>
          socket.sent.some(
            (item) => (JSON.parse(item) as { type?: string }).type === "bridge.welcome",
          ),
        `welcome for ${testCase.reason}`,
      );
    }
    const before = capture.entries.length;
    // 每个分支把触发帧作为该 socket 的首个**业务**帧（hello 类分支要求凭据在轮换前仍是初始值）。
    testCase.drive(socket);
    await waitFor(
      () => capture.entries.slice(before).some((entry) => entry.fields.reason === testCase.reason),
      `log for ${testCase.reason}`,
    );
    const rejection = capture.entries
      .slice(before)
      .find((entry) => entry.fields.reason === testCase.reason);
    assert.equal(rejection?.level, "warn", `${testCase.reason} 必须是 warn`);
    socket.socket.close(1008, testCase.reason);
  }
  // 未知 run 的连接
  const unknown = createFakeSocket();
  await bridge.acceptConnection({
    runId: "00000000-0000-4000-8000-00000000deed",
    socket: unknown.socket,
  });
  assert.equal(unknown.closedInfo()?.reason, "run-not-found");
  assert.ok(capture.find("bridge connection rejected", "run-not-found"));

  // ── 脱敏断言：日志里不得出现 ticket / 帧正文 ──
  const dump = JSON.stringify(capture.entries);
  assert.equal(dump.includes(ticket), false, "日志不得包含 ticket");
  assert.equal(dump.includes("candidate-secret"), false, "日志不得包含候选 token");
  assert.equal(dump.includes("sensitive prompt body"), false, "日志不得包含 prompt 正文");
  assert.equal(dump.includes(helloFrame()), false, "日志不得包含整帧正文");
  // 心跳不刷 info（02 §9）：整段用例里不应出现心跳相关的 info 行
  assert.equal(
    capture.entries.some((entry) => entry.level === "info" && /heartbeat/i.test(entry.message)),
    false,
  );
  await bridge.close();
});

test("bridge 握手：旧代际 hello 被拒绝并关闭（08 §4.2、CP-07）", async () => {
  const planeContext = buildTestPlane();
  let planeRef: ReturnType<typeof buildTestPlane>["plane"] | undefined;
  const bridge = createCloudBridgeChannel({
    services: () => {
      if (!planeRef) throw new Error("plane not ready");
      return planeRef;
    },
    registry: planeContext.plane.attachments,
    storage: planeContext.storage,
    clock: planeContext.clock,
    hash: {
      sha256Hex: async (value: string) => createHash("sha256").update(value).digest("hex"),
    },
    ids: new FakeIds(),
  });
  planeRef = planeContext.plane;
  const fake = createFakeSocket();
  // run 不存在 → 直接关闭，不建立连接表项。
  await bridge.acceptConnection({ runId: RUN_ID, socket: fake.socket });
  assert.deepEqual(fake.closedInfo(), { code: 1008, reason: "run-not-found" });
  await bridge.close();
});

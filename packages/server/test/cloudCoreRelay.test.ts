/**
 * W1 × W6 的 relay/命令通道接线测试（控制面侧）：
 * - 浏览器任务通道：真实的 ChannelClient 字节经 `rpc.open/request` 转发到沙箱、`rpc.response`
 *   回投；旧 epoch 帧被拒绝（02 §0/§2 不变量 3、03 §7.1）。
 * - durable input：经 W6 的 `CloudCommandTransport` 下发（`rpc.*` → 沙箱 ChannelServer），
 *   runtime 的 `CommandAck` 经 `onRuntimeAck` 落到 receipt（delivering → admitted）；
 *   断连时保持 uncertain，绝不伪造 sent（02 §2 不变量 6、§6.3）。
 *
 * 沙箱侧用**真实 ChannelServer**（与 W6 的 rpcRelay 同一机制）当替身：不是类型兼容，而是
 * 真的把字节跑完一整条 RPC。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  ChannelClient,
  ChannelServer,
  Emitter,
  Event,
  VSBuffer,
  type IChannel,
  type IMessagePassingProtocol,
  type IServerChannel,
} from "@zcode/rpc";
import { CLOUD_RPC_PROTOCOL_VERSION, ServiceChannels, type CloudRpcFrame } from "@zcode/shared";
import {
  FakeClock,
  FakeHash,
  FakeIds,
  createFakeDriverRegistry,
  createFakeGitHub,
  createFakeOutbox,
  createFakeSandboxDriver,
  createFakeStorage,
} from "./cloudCoreFakes.js";
import {
  createFakeProvisioningEnvelope,
  createFakeTemplateResolver,
  createFakeGitGrantBroker,
} from "./cloudCoreAdapterFakes.js";
import { createCloudBridgeChannel } from "../src/cloud/adapters/ws/bridgeChannel.js";
import { createAttachmentRegistry } from "../src/cloud/app/attachments/registry.js";
import {
  assembleCloudControlPlane,
  type CloudControlPlane,
} from "../src/cloud/app/assembleCloudControlPlane.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";
const TICKET = "relay-ticket";

/** 沙箱侧替身：`rpc.open/request` → 真实 ChannelServer；回投 `rpc.response`。 */
function createFakeSandboxRelay(input: { emit: (frame: CloudRpcFrame) => void }) {
  class RelayProtocol implements IMessagePassingProtocol {
    readonly onMessage: Emitter<VSBuffer>["event"];
    private readonly emitter = new Emitter<VSBuffer>();
    constructor(private readonly sink: (payload: VSBuffer) => void) {
      this.onMessage = this.emitter.event;
    }
    send(buffer: VSBuffer): void {
      this.sink(buffer);
    }
    deliver(buffer: VSBuffer): void {
      this.emitter.fire(buffer);
    }
    dispose(): void {
      this.emitter.dispose();
    }
  }

  const sessions = new Map<string, { protocol: RelayProtocol; server: ChannelServer }>();
  const received: CloudRpcFrame[] = [];

  function agentChannel(): IServerChannel {
    return {
      call: (_context, command, arg) => {
        if (command === "sendConversationCommandV4") {
          const envelope = (arg as { envelope?: { commandId?: string } }).envelope;
          return Promise.resolve({
            commandId: envelope?.commandId ?? "unknown",
            status: "accepted",
            revisionAtDecision: 1,
          });
        }
        if (command === "queryConversationCommandsV4") {
          const params = arg as { commands?: { commandId: string }[] };
          return Promise.resolve({
            results: (params.commands ?? []).map((item) => ({
              key: { sessionId: null, commandId: item.commandId },
              result: "unknown",
            })),
          });
        }
        return Promise.resolve({ ok: true, command });
      },
      listen: () => Event.None,
    };
  }

  return {
    received,
    handle(frame: CloudRpcFrame): void {
      received.push(frame);
      switch (frame.type) {
        case "rpc.open": {
          const protocol = new RelayProtocol((payload) =>
            input.emit({
              protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
              type: "rpc.response",
              runId: frame.runId,
              runGeneration: frame.runGeneration,
              connectionEpoch: frame.connectionEpoch,
              streamId: frame.streamId,
              payload: Buffer.from(payload.buffer).toString("base64"),
            }),
          );
          const server = new ChannelServer(protocol, "cloud-attachment");
          server.registerChannel(ServiceChannels.ZCodeAgent, agentChannel());
          server.registerChannel(ServiceChannels.File, agentChannel());
          sessions.set(frame.streamId, { protocol, server });
          return;
        }
        case "rpc.request":
          sessions
            .get(frame.streamId)
            ?.protocol.deliver(VSBuffer.wrap(new Uint8Array(Buffer.from(frame.payload, "base64"))));
          return;
        case "rpc.close":
          sessions.get(frame.streamId)?.protocol.dispose();
          sessions.delete(frame.streamId);
          return;
        default:
          return;
      }
    },
    dispose() {
      for (const session of sessions.values()) session.protocol.dispose();
      sessions.clear();
    },
  };
}

/**
 * 内存 socket 替身。
 * `deferCloseEvent` 模拟真实 WS 库的时序：`close()` 的调用方先返回，关闭**事件**随后
 * 异步送达——因此 socket 的 close 回调总是晚于控制面内部的接管/注册更新。
 */
function createFakeSocket(options: { deferCloseEvent?: boolean } = {}) {
  const sent: string[] = [];
  let messageHandler: ((data: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let closed: { code?: number; reason?: string } | undefined;
  let closeEvents = 0;
  const socket = {
    send: (data: string) => sent.push(data),
    close: (code?: number, reason?: string) => {
      if (closed) return;
      closed = { code, reason };
      const emit = () => {
        closeEvents += 1;
        closeHandler?.();
      };
      if (options.deferCloseEvent) setImmediate(emit);
      else emit();
    },
    onMessage: (handler: (data: string) => void) => {
      messageHandler = handler;
    },
    onClose: (handler: () => void) => {
      closeHandler = handler;
    },
  };
  return {
    socket,
    sent,
    closedInfo: () => closed,
    /** 已送达的 close 事件次数（用于等待延迟送达的关闭事件）。 */
    closeEvents: () => closeEvents,
    push: (data: string) => messageHandler?.(data),
  };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * 等一个 Promise 落定（按事件循环推进，与 `waitFor` 同一纪律）。
 * 修复依据（2026-10-07 高负载 flake 排查）：本文件全部链路都在内存里（storage fake、
 * relay、socket fake 均同步/微任务落定），完成所需的**事件循环轮数**与机器负载无关；
 * 用真实 `setTimeout` 做 race 反而把「链路是否接通」混入「墙钟是否被并行测试进程饿死」
 * ——workflow 高负载轮里 3s 实时预算可被单纯调度延迟耗尽，造成假失败。改为轮数预算：
 * 链路断了照样确定性地报 `timeout waiting for ...`，链路通时无论多慢的机器都通过。
 */
async function waitForCall<T>(promise: Promise<T>, label: string): Promise<T> {
  let settled = false;
  let value: T | undefined;
  let failure: { error: unknown } | undefined;
  void promise.then(
    (result) => {
      settled = true;
      value = result;
    },
    (error: unknown) => {
      settled = true;
      failure = { error };
    },
  );
  await waitFor(() => settled, label);
  if (failure) throw failure.error;
  return value as T;
}

interface RelayHarness {
  plane: CloudControlPlane;
  bridge: ReturnType<typeof createCloudBridgeChannel>;
  relay: ReturnType<typeof createFakeSandboxRelay>;
  fake: ReturnType<typeof createFakeSocket>;
  storage: ReturnType<typeof createFakeStorage>;
  clock: FakeClock;
  taskId: string;
  runId: string;
  runGeneration: number;
  connectionEpoch: number;
  /**
   * `runs.markDisconnected` 的 fire-and-forget 调用是否全部落定（bridge 关闭路径不 await
   * 它，只自兜 catch）。缺席断言（「关闭不得置 disconnected」）必须等这些在途调用落定后
   * 再检查存储事实，否则断言观察的是「写还没来得及落地」，守卫若回归会表现为偶发而非
   * 稳定失败（2026-10-07 高负载 flake 排查：把墙钟/调度敏感的观察换成确定性事实等待）。
   */
  markDisconnectedSettled: () => boolean;
}

/**
 * 端到端装配：app 平面的 attachment 端口就是 bridge 通道；沙箱侧由 fake relay 应答。
 * 走真实接纳事务 → create worker → bridge hello（welcome + bootstrap.config）→ ready。
 * `deferCloseEvent` 传给建连的 socket（接管时序用例需要「关闭事件异步送达」）。
 */
async function setupReadyRun(options: { deferCloseEvent?: boolean } = {}): Promise<RelayHarness> {
  const clock = new FakeClock();
  const ids = new FakeIds();
  const outbox = createFakeOutbox();
  const storage = createFakeStorage(clock, outbox);
  const registry = createAttachmentRegistry();
  let planeRef: CloudControlPlane | undefined;
  const gitGrant = createFakeGitGrantBroker({
    now: () => clock.now(),
    newGrantId: () => ids.newId(),
  });
  const gitGrantDeps = { gitGrantStore: gitGrant.store, gitGrantBroker: gitGrant.broker };
  const bridge = createCloudBridgeChannel({
    services: () => {
      if (!planeRef) throw new Error("plane not ready");
      return planeRef;
    },
    registry,
    storage,
    clock,
    hash: { sha256Hex: async (value: string) => createHash("sha256").update(value).digest("hex") },
    ids,
  });
  const plane = assembleCloudControlPlane(
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
  planeRef = plane;

  // 跟踪 fire-and-forget 的 markDisconnected：bridge 的 socket 关闭路径调用它后不等待
  // （bridgeChannel.ts 只自兜 catch），测试要断言「无副作用」就必须能等到它落定。
  const markDisconnectedState = { total: 0, settled: 0 };
  const runsApi = plane.runs;
  const originalMarkDisconnected = runsApi.markDisconnected.bind(runsApi);
  runsApi.markDisconnected = ((input: Parameters<typeof originalMarkDisconnected>[0]) => {
    markDisconnectedState.total += 1;
    return originalMarkDisconnected(input).then(
      (value) => {
        markDisconnectedState.settled += 1;
        return value;
      },
      (error: unknown) => {
        markDisconnectedState.settled += 1;
        throw error;
      },
    );
  }) as typeof runsApi.markDisconnected;
  const markDisconnectedSettled = () =>
    markDisconnectedState.total > 0 &&
    markDisconnectedState.settled === markDisconnectedState.total;

  const project = await plane.tasks.createProject({ principalId: PRINCIPAL, repositoryId: 101 });
  assert.ok(project.ok);
  const task = await plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Relay task",
    creationKey: "ck-relay",
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-000000000801",
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.equal(submit.ok, true, submit.ok ? "" : `${submit.code}/${submit.reason}`);
  const runId = submit.ok ? (submit.value.runId ?? "") : "";
  await plane.provisioning.create.runCreateOnce();
  const run = await storage.runs.get(runId);
  assert.ok(run);
  assert.equal(run.workspacePath, "/workspace/demo");

  await storage.credentials.saveInitial({
    runId,
    runGeneration: run.runGeneration,
    credentialHash: createHash("sha256").update(TICKET).digest("hex"),
    expiresAt: clock.now() + 600_000,
    bootstrapOperationId: runId,
  });

  const fake = createFakeSocket(options);
  const relay = createFakeSandboxRelay({ emit: (frame) => fake.push(JSON.stringify(frame)) });
  // 控制面发出的每一帧都先过 relay（模拟执行节点消费 rpc.* 帧）。
  const originalSend = fake.socket.send;
  fake.socket.send = (data: string) => {
    originalSend(data);
    const parsed = safeParse(data) as { type?: string } | undefined;
    if (parsed && typeof parsed.type === "string" && parsed.type.startsWith("rpc.")) {
      relay.handle(parsed as CloudRpcFrame);
    }
  };

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
        workspacePath: run.workspacePath ?? "/workspace/demo",
        remoteSessionId: `remote-${runId}`,
      },
      helloAttemptId: "00000000-0000-4000-8000-0000000008aa",
      credentialToken: TICKET,
      candidateNextResumeToken: "candidate-relay",
      runtimeIncarnation: "incarnation-relay",
    }),
  );
  await waitFor(
    () =>
      fake.sent.some(
        (item) => (safeParse(item) as { type?: string } | undefined)?.type === "bridge.welcome",
      ) &&
      fake.sent.some(
        (item) => (safeParse(item) as { type?: string } | undefined)?.type === "bootstrap.config",
      ),
    "welcome + bootstrap.config",
  );
  const welcome = fake.sent
    .map((item) => safeParse(item) as { type?: string; connectionEpoch?: number } | undefined)
    .find((frame) => frame?.type === "bridge.welcome");
  const connectionEpoch = welcome?.connectionEpoch ?? 1;
  fake.push(
    JSON.stringify({
      protocolVersion: 1,
      type: "bridge.ready",
      connectionEpoch,
      configVersion: "cfg-1",
      runtimeIncarnation: "incarnation-relay",
      exporterReady: true,
      walReady: true,
      executionCapabilities: ["durable-input"],
    }),
  );
  await waitFor(() => registry.current(runId)?.ready === true, "attachment ready");

  return {
    plane,
    bridge,
    relay,
    fake,
    storage,
    clock,
    taskId: task.value.taskId,
    runId,
    runGeneration: run.runGeneration,
    connectionEpoch,
    markDisconnectedSettled,
  };
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

test("浏览器 RPC：ChannelClient 字节经 rpc.* 转发到沙箱并回投响应（03 §7.1）", async () => {
  const harness = await setupReadyRun();
  let clientListener: ((buffer: VSBuffer) => void) | undefined;
  let stream: ReturnType<typeof harness.bridge.openBrowserRpcStream> = null;
  // 浏览器先起（与生产一致：浏览器已连着，控制面随后开流）；流未开时不下发字节。
  const client = new ChannelClient({
    send: (buffer: VSBuffer) => stream?.forwardToSandbox(Buffer.from(buffer.buffer)),
    onMessage: (listener) => {
      clientListener = listener as (buffer: VSBuffer) => void;
      return {
        dispose: () => {
          clientListener = undefined;
        },
      };
    },
  });
  stream = harness.bridge.openBrowserRpcStream({
    runId: harness.runId,
    runGeneration: harness.runGeneration,
    connectionEpoch: harness.connectionEpoch,
    // 沙箱回投的字节直接灌回浏览器的 ChannelClient（与 Web UI 的 onMessage 契约一致）。
    deliver: (payload) => clientListener?.(VSBuffer.wrap(new Uint8Array(payload))),
    onClosed: () => undefined,
  });
  assert.ok(stream, "ready attachment 上应能打开浏览器流");
  const activeStream = stream;
  try {
    const channel = client.getChannel<IChannel>(ServiceChannels.File);
    // 有界等待（轮数预算，见 waitForCall）：转发链路未通时给出明确失败，而不是让用例
    // 挂住；也不用真实 setTimeout——那会把墙钟调度延迟误判成链路故障。
    const response = (await waitForCall(
      channel.call("readFile", { path: "/workspace/demo/a.txt" }),
      "browser rpc call",
    )) as { command?: string };
    assert.equal(response.command, "readFile", "响应经 relay 原样回投给浏览器");
    assert.equal(harness.relay.received[0]?.type, "rpc.open", "先开 rpc.open 再发请求");
    assert.ok(harness.relay.received.some((frame) => frame.type === "rpc.request"));
    assert.equal(harness.relay.received[0]?.runId, harness.runId);
    assert.equal(
      harness.relay.received[0]?.connectionEpoch,
      harness.connectionEpoch,
      "帧携带当前 connectionEpoch",
    );
  } finally {
    activeStream.close("test-done");
  }
});

test("浏览器 RPC：旧 connectionEpoch 的响应被拒绝（02 §2 不变量 3）", async () => {
  const harness = await setupReadyRun();
  const delivered: Buffer[] = [];
  const stream = harness.bridge.openBrowserRpcStream({
    runId: harness.runId,
    runGeneration: harness.runGeneration,
    connectionEpoch: harness.connectionEpoch,
    deliver: (payload) => delivered.push(payload),
    onClosed: () => undefined,
  });
  assert.ok(stream);
  const streamId = stream.streamId;
  const deliveredText = () => delivered.map((item) => item.toString());

  // 伪造一条旧 epoch 的响应帧（runGeneration 正确、epoch 落后）。
  harness.fake.push(
    JSON.stringify({
      protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
      type: "rpc.response",
      runId: harness.runId,
      runGeneration: harness.runGeneration,
      connectionEpoch: harness.connectionEpoch - 1,
      streamId,
      payload: Buffer.from("stale-payload").toString("base64"),
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deliveredText().includes("stale-payload"), false, "旧代际帧不得回投给浏览器");

  // 当前 epoch 的响应正常回投。
  harness.fake.push(
    JSON.stringify({
      protocolVersion: CLOUD_RPC_PROTOCOL_VERSION,
      type: "rpc.response",
      runId: harness.runId,
      runGeneration: harness.runGeneration,
      connectionEpoch: harness.connectionEpoch,
      streamId,
      payload: Buffer.from("fresh-payload").toString("base64"),
    }),
  );
  await waitFor(() => deliveredText().includes("fresh-payload"), "fresh response");
  stream.close("test-done");
});

test("durable input：经传输下发并被 runtime ACK 标 admitted（02 §6.2）", async () => {
  const harness = await setupReadyRun();
  try {
    const dispatched = await harness.plane.delivery.dispatchTask(harness.taskId);
    assert.equal(dispatched.outcomes[0]?.result, "sent", "命令经 rpc.* 下发成功");
    const receipt = await harness.storage.inputs.get(
      harness.taskId,
      "00000000-0000-4000-8000-000000000801",
    );
    assert.equal(receipt?.deliveryStatus, "admitted", "runtime ACK 落到 receipt");
    assert.ok(
      harness.relay.received.some((frame) => frame.type === "rpc.request"),
      "命令确实以 rpc.request 帧进入沙箱",
    );
  } finally {
    await harness.bridge.close();
  }
});

test("durable input：bridge 断开时不伪造 sent（输入保持 accepted，02 §6.3）", async () => {
  const harness = await setupReadyRun();
  harness.fake.socket.close(1001, "test-disconnect");
  await new Promise((resolve) => setImmediate(resolve));
  // 断开后再 append 一条输入：dispatcher 必须等待，而不是声称已投递。
  const append = await harness.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: harness.taskId,
    source: "rpc",
    request: {
      intent: "append",
      commandId: "00000000-0000-4000-8000-000000000802",
      prompt: "next",
      expectedRunGeneration: harness.runGeneration,
    },
  });
  if (append.ok) {
    const dispatched = await harness.plane.delivery.dispatchTask(harness.taskId);
    const outcome = dispatched.outcomes.find(
      (item) => item.commandId === "00000000-0000-4000-8000-000000000802",
    );
    assert.ok(outcome);
    assert.notEqual(outcome?.result, "sent", "断连后不得声称已投递");
    const receipt = await harness.storage.inputs.get(
      harness.taskId,
      "00000000-0000-4000-8000-000000000802",
    );
    assert.ok(
      receipt?.deliveryStatus === "accepted" || receipt?.deliveryStatus === "uncertain",
      `断连后的投递状态必须保守（实际 ${receipt?.deliveryStatus}）`,
    );
  }
  await harness.bridge.close();
});

// ── 02 §5.1 鉴权门控回归（2026-10-07 review P0）──
// `/ws/cloud/bridge/*` 在 HTTP 升级层豁免 lite-token，唯一的鉴权闸口是 hello 帧。
// 因此：未完成 hello 的 socket 不得进入路由表、不得处理非 hello 帧、关闭也不得触发
// registry 摘除 / `runs.markDisconnected`；新 socket 接管时旧连接被关闭且不误伤新 session。

/** 取 socket 已发出的第一帧指定类型（sent 一律是 JSON 文本）。 */
function sentFrame<T extends { type?: string }>(sent: string[], type: string): T | undefined {
  return sent.map((item) => safeParse(item) as T | undefined).find((frame) => frame?.type === type);
}

test("未鉴权 socket：非 hello 帧被 close(1008, unauthenticated)，关闭不摘除 attachment、不置 disconnected（02 §5.1）", async () => {
  const harness = await setupReadyRun();
  const readySession = harness.plane.attachments.current(harness.runId);
  assert.ok(readySession, "前置：已认证连接的 session 在册");
  assert.equal(readySession.ready, true, "前置：attachment 已 ready");
  const projectionsBefore = harness.storage.projectionRecords.length;

  // 只知 runId 的未鉴权方：accept 之后不发 hello，直接注入一个 schema 合法、且 epoch 与
  // 在册 session 一致的伪造投影批次——修复前它会被 ingest 落库并占据路由槽。
  const intruder = createFakeSocket();
  await harness.bridge.acceptConnection({ runId: harness.runId, socket: intruder.socket });
  intruder.push(
    JSON.stringify({
      protocolVersion: 1,
      type: "projection.batch",
      connectionEpoch: harness.connectionEpoch,
      records: [
        {
          schemaVersion: 1,
          taskId: harness.taskId,
          runId: harness.runId,
          runGeneration: harness.runGeneration,
          runtimeIncarnation: "forged-incarnation",
          topic: "conversation/forged",
          logEpoch: "epoch-forged",
          sourceSeq: 0,
          kind: "delta",
          payload: { text: "forged" },
          contentHash: "f".repeat(64),
        },
      ],
    }),
  );
  await waitFor(() => intruder.closedInfo() !== undefined, "unauthenticated close");
  assert.deepEqual(intruder.closedInfo(), { code: 1008, reason: "unauthenticated" });
  assert.deepEqual(intruder.sent, [], "未鉴权连接不得收到任何控制帧");

  // 关闭副作用必须缺席：否则未鉴权方一关连接就能摘除真实 session / 把 run 置 disconnected。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    harness.plane.attachments.current(harness.runId)?.connectionEpoch,
    readySession.connectionEpoch,
    "未鉴权 socket 的关闭不得摘除在册 session",
  );
  assert.equal(
    (await harness.storage.runs.get(harness.runId))?.status,
    "ready",
    "未鉴权 socket 的关闭不得把 run 置 disconnected",
  );
  assert.equal(harness.storage.projectionRecords.length, projectionsBefore, "伪造投影批次不得落库");
  await harness.bridge.close();
});

test("新 socket hello 接管：旧连接被 close superseded，registry 保留新 epoch session（02 §5.1）", async () => {
  // 旧连接的关闭**事件**异步送达（真实 WS 语义）：接管与注册完成后才触发旧 socket 的
  // close 回调——这正是「旧连接不得摘除新 session」必须成立的那个时序。
  const harness = await setupReadyRun({ deferCloseEvent: true });
  const run = await harness.storage.runs.get(harness.runId);
  assert.ok(run?.workspacePath, "前置：持久工作区事实在册");
  const previous = harness.plane.attachments.current(harness.runId);
  assert.ok(previous, "前置：旧连接的 session 在册");

  // 第二个 socket：凭据用上一轮 hello 落下的候选 resume token（02 §5.1 凭据轮换），
  // epoch 由控制面 CAS 递增。
  const takeover = createFakeSocket();
  await harness.bridge.acceptConnection({ runId: harness.runId, socket: takeover.socket });
  takeover.push(
    JSON.stringify({
      protocolVersion: 1,
      type: "bridge.hello",
      address: {
        taskId: harness.taskId,
        runId: harness.runId,
        runGeneration: harness.runGeneration,
        workspaceIdentity: `cloud-task:${harness.taskId}`,
        workspacePath: run.workspacePath,
        remoteSessionId: `remote-${harness.runId}`,
      },
      helloAttemptId: "00000000-0000-4000-8000-0000000008ab",
      credentialToken: "candidate-relay",
      candidateNextResumeToken: "candidate-relay-2",
      runtimeIncarnation: "incarnation-relay-2",
    }),
  );
  await waitFor(() => sentFrame(takeover.sent, "bridge.welcome") !== undefined, "takeover welcome");
  const newEpoch = sentFrame<{ connectionEpoch?: number }>(
    takeover.sent,
    "bridge.welcome",
  )?.connectionEpoch;
  assert.equal(typeof newEpoch, "number");
  assert.ok((newEpoch ?? 0) > previous.connectionEpoch, "接管必须递增 connectionEpoch");

  // 旧连接被显式关闭（superseded）；它的关闭不得摘除新 epoch session，也不得改写 run 状态。
  assert.deepEqual(harness.fake.closedInfo(), { code: 1008, reason: "superseded" });
  await waitFor(
    () => harness.plane.attachments.current(harness.runId)?.connectionEpoch === newEpoch,
    "new epoch session registered",
  );
  // 旧 socket 的关闭事件此刻才送达：detach 必须按期望代际逐项校验，不得按 runId 无条件摘除。
  await waitFor(() => harness.fake.closeEvents() > 0, "old socket close event delivered");
  assert.equal(
    harness.plane.attachments.current(harness.runId)?.connectionEpoch,
    newEpoch,
    "旧连接迟到的关闭事件不得摘除新 epoch session",
  );
  // 关闭路径的 markDisconnected 是 fire-and-forget：先等它落定（被代际 CAS 拒绝也要等
  // 拒绝本身完成），再查存储事实——否则断言观察的是「写尚未落地」，只是碰巧通过。
  await waitFor(() => harness.markDisconnectedSettled(), "late markDisconnected settled");
  assert.equal(
    (await harness.storage.runs.get(harness.runId))?.status,
    "ready",
    "旧连接的关闭不得把 run 置 disconnected（代际不符的 markDisconnected 被拒）",
  );
  // 新连接是唯一路由目标：心跳必须落在新 session 上。
  takeover.push(
    JSON.stringify({
      protocolVersion: 1,
      type: "bridge.heartbeat",
      connectionEpoch: newEpoch,
      processAlive: true,
      activitySummary: "alive",
      walHighWatermarks: [],
      sentAt: 1,
    }),
  );
  await waitFor(
    () => harness.plane.attachments.current(harness.runId)?.lastHeartbeatAt !== undefined,
    "heartbeat on new session",
  );
  await harness.bridge.close();
});

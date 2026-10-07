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

function createFakeSocket() {
  const sent: string[] = [];
  let messageHandler: ((data: string) => void) | undefined;
  let closeHandler: (() => void) | undefined;
  let closed: { code?: number; reason?: string } | undefined;
  const socket = {
    send: (data: string) => sent.push(data),
    close: (code?: number, reason?: string) => {
      if (closed) return;
      closed = { code, reason };
      closeHandler?.();
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
}

/**
 * 端到端装配：app 平面的 attachment 端口就是 bridge 通道；沙箱侧由 fake relay 应答。
 * 走真实接纳事务 → create worker → bridge hello（welcome + bootstrap.config）→ ready。
 */
async function setupReadyRun(): Promise<RelayHarness> {
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

  const fake = createFakeSocket();
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
    const response = (await Promise.race([
      channel.call("readFile", { path: "/workspace/demo/a.txt" }),
      new Promise<never>((_resolve, reject) =>
        // 有界等待：转发链路未通时给出明确失败，而不是让用例挂住。
        setTimeout(() => reject(new Error("browser rpc call timed out")), 3_000),
      ),
    ])) as { command?: string };
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

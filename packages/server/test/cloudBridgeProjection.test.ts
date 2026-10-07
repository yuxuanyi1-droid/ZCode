/**
 * W6 投影 WAL / exporter 与 RPC 转接用例（specs/cloud-agent 02 §7、§11 B-08/B-09、§0）。
 *
 * 关键点：断言的是「ACK 丢失后重投幂等、同 key 不同 hash 是一致性 fault、缺口不跳 cursor、
 * 崩溃后用已导出水位续传」，而不是复述实现。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ChannelClient, Emitter, VSBuffer, type IChannel } from "@zcode/rpc";
import type { CloudRpcFrame } from "@zcode/shared";
import { createProjectionExporter } from "../src/cloud/execution/app/projectionExporter.js";
import type {
  ConversationTopicSource,
  ProjectionExporter,
  TopicDeliveryFrame,
} from "../src/cloud/execution/app/projectionExporter.js";
import { createRpcRelay } from "../src/cloud/execution/app/rpcRelay.js";
import { createCloudCommandTransport } from "../src/cloud/execution/app/commandTransport.js";
import type { AttachmentContext } from "../src/cloud/execution/app/ports.js";
import { testLogger } from "./cloudBridgeFakes.js";
import { createProjectionFake } from "./cloudExecutionFakes.js";

const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const RUN_ID = "1f14e45f-ceea-467a-9a1e-1f0d3b2a4c52";
const SESSION_INDEX_TOPIC = `sessions-index/cloud-task:${TASK_ID}`;
const CONVERSATION_TOPIC = "conversation/session-1";

interface SourceFake extends ConversationTopicSource {
  readonly subscriptions: { topic: string; base?: { logEpoch: string; seq: number } }[];
  readonly unsubscribed: string[];
  emit(frame: TopicDeliveryFrame): void;
}

function createSourceFake(): SourceFake {
  const listeners = new Set<(frame: TopicDeliveryFrame) => void>();
  const subscriptions: { topic: string; base?: { logEpoch: string; seq: number } }[] = [];
  const unsubscribed: string[] = [];
  let counter = 0;
  return {
    subscriptions,
    unsubscribed,
    async subscribe(params) {
      subscriptions.push({ topic: params.topic, ...(params.base ? { base: params.base } : {}) });
      counter += 1;
      return {
        subscriptionId: `sub-${counter}`,
        mode: params.base ? ("resume" as const) : ("snapshot" as const),
        logEpoch: "epoch-1",
      };
    },
    async unsubscribe(subscriptionId) {
      unsubscribed.push(subscriptionId);
    },
    onFrame(listener) {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    emit(frame) {
      for (const listener of Array.from(listeners)) listener(frame);
    },
  };
}

function snapshotFrame(topic: string, toSeq: number, marker: string): TopicDeliveryFrame {
  return {
    topic,
    subscriptionId: "sub-1",
    fromSeq: 0,
    toSeq,
    sentAt: { wallMs: 1, monoMs: 1 },
    payload: { kind: "snapshot", snapshot: { marker } },
  };
}

function deltasFrame(
  topic: string,
  fromSeq: number,
  toSeq: number,
  marker: string,
): TopicDeliveryFrame {
  return {
    topic,
    subscriptionId: "sub-1",
    fromSeq,
    toSeq,
    sentAt: { wallMs: 1, monoMs: 1 },
    payload: { kind: "deltas", deltas: [{ marker }] },
  };
}

function buildExporter(options: {
  source: SourceFake;
  walStore: ReturnType<typeof createProjectionFake>["store"];
  faults?: { code: string; message: string; retryable: boolean }[];
}): ProjectionExporter {
  return createProjectionExporter({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    runtimeIncarnation: "runtime-1",
    sessionIndexTopic: SESSION_INDEX_TOPIC,
    extractSessionIds: (frame) => {
      const snapshot = frame.payload.snapshot as
        | { sessions?: { sessionId?: string }[] }
        | undefined;
      return (snapshot?.sessions ?? [])
        .map((entry) => entry.sessionId)
        .filter((id): id is string => typeof id === "string");
    },
    source: options.source,
    walStore: options.walStore,
    logger: testLogger(),
    ...(options.faults ? { reportFault: (fault) => options.faults!.push(fault) } : {}),
  });
}

async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await new Promise((resolve) => setImmediate(resolve));
}

test("B-08：ACK 丢失后重投幂等，同 key 不同 hash 报一致性 fault", async () => {
  const source = createSourceFake();
  const projection = createProjectionFake();
  const faults: { code: string; message: string; retryable: boolean }[] = [];
  const exporter = buildExporter({ source, walStore: projection.store, faults });
  await exporter.start();
  // sessions-index 只做话题发现：导出面是 conversation topic（02 §7.4）。
  source.emit({
    topic: SESSION_INDEX_TOPIC,
    subscriptionId: "sub-index",
    fromSeq: 0,
    toSeq: 1,
    sentAt: null,
    payload: { kind: "snapshot", snapshot: { sessions: [{ sessionId: "session-1" }] } },
  });
  await flush();
  assert.deepEqual(
    source.subscriptions.map((entry) => entry.topic),
    [SESSION_INDEX_TOPIC, CONVERSATION_TOPIC],
    "会话索引发现后必须订阅对应 conversation topic",
  );

  // 首帧 snapshot(0→3)：作为新流的屏障接收。
  source.emit(snapshotFrame(CONVERSATION_TOPIC, 3, "first"));
  await flush();

  // ACK 丢失：控制面已提交但 bridge 未收到 ack，于是重投同一帧 → 幂等，不重复落盘。
  source.emit(snapshotFrame(CONVERSATION_TOPIC, 3, "first"));
  await flush();
  let batch = await exporter.drain(10);
  assert.equal("records" in batch ? batch.records.length : -1, 1, "同 key 同 hash 必须幂等");

  // 同 key 不同内容（同一 sourceSeq 的另一份内容）：一致性 fault，不静默覆盖。
  source.emit(deltasFrame(CONVERSATION_TOPIC, 3, 3, "conflicting"));
  await flush();
  assert.equal(faults.length, 1, "同 key 不同 hash 必须上报 fault");
  assert.equal(faults[0]!.code, "protocol_incompatible");
  assert.equal(faults[0]!.retryable, false);

  // 收到持久 ACK 后 WAL 才清理；ACK 只覆盖匹配源流的连续水位。
  await exporter.onAck({
    topic: CONVERSATION_TOPIC,
    logEpoch: "epoch-1",
    lastContiguousSourceSeq: 3,
  });
  batch = await exporter.drain(10);
  assert.equal("records" in batch ? batch.records.length : -1, 0, "ACK 后 WAL 必须清空");
  await exporter.stop();
});

test("B-08：ACK 来自未知源流或更低水位时不清空 WAL（不作本地下标）", async () => {
  const source = createSourceFake();
  const projection = createProjectionFake();
  const exporter = buildExporter({ source, walStore: projection.store });
  await exporter.start();
  source.emit({
    topic: SESSION_INDEX_TOPIC,
    subscriptionId: "sub-index",
    fromSeq: 0,
    toSeq: 1,
    sentAt: null,
    payload: { kind: "snapshot", snapshot: { sessions: [{ sessionId: "session-1" }] } },
  });
  await flush();
  source.emit(snapshotFrame(CONVERSATION_TOPIC, 2, "a"));
  source.emit(deltasFrame(CONVERSATION_TOPIC, 2, 4, "b"));
  await flush();
  await exporter.onAck({
    topic: "conversation/other",
    logEpoch: "epoch-1",
    lastContiguousSourceSeq: 99,
  });
  let batch = await exporter.drain(10);
  assert.equal("records" in batch ? batch.records.length : -1, 2, "未知源流的 ACK 不得清空 WAL");
  await exporter.stop();
});

test("B-09：runtime commit 与 WAL 写入之间崩溃——用已导出水位续传，缺口先 snapshot 不跳 cursor", async () => {
  const source = createSourceFake();
  const projection = createProjectionFake();
  const first = buildExporter({ source, walStore: projection.store });
  await first.start();
  source.emit({
    topic: SESSION_INDEX_TOPIC,
    subscriptionId: "sub-index",
    fromSeq: 0,
    toSeq: 1,
    sentAt: null,
    payload: { kind: "snapshot", snapshot: { sessions: [{ sessionId: "session-1" }] } },
  });
  await flush();
  source.emit(snapshotFrame(CONVERSATION_TOPIC, 3, "start"));
  await flush();
  // 已收到 ACK 到 3（持久水位），随后 runtime 又提交并导出 5（WAL 未 ACK）→ 进程崩溃。
  await first.onAck({ topic: CONVERSATION_TOPIC, logEpoch: "epoch-1", lastContiguousSourceSeq: 3 });
  source.emit(deltasFrame(CONVERSATION_TOPIC, 3, 5, "delta-4-5"));
  await flush();
  assert.equal(projection.store.present().length, 1, "崩溃前待 ACK 的记录必须已落 WAL");

  // 重启：新的 exporter 从同一 store 恢复，续传 base 必须是已导出水位 5（不是 ACK 水位 3）。
  const source2 = createSourceFake();
  const restarted = buildExporter({ source: source2, walStore: projection.store });
  await restarted.start();
  source2.emit({
    topic: SESSION_INDEX_TOPIC,
    subscriptionId: "sub-index",
    fromSeq: 0,
    toSeq: 1,
    sentAt: null,
    payload: { kind: "snapshot", snapshot: { sessions: [{ sessionId: "session-1" }] } },
  });
  await flush();
  const conversationSubscription = source2.subscriptions.find(
    (entry) => entry.topic === CONVERSATION_TOPIC,
  );
  assert.deepEqual(
    conversationSubscription?.base,
    { logEpoch: "epoch-1", seq: 5 },
    "重连必须声明已导出水位（ACK 水位 + 未 ACK 的尾部），否则会把已导出区间算成缺口",
  );

  // 缺口（跳过 6，直接来 7）：重订一次拿 snapshot，不跳跃确认、不制造假逐事件 seq。
  source2.emit(deltasFrame(CONVERSATION_TOPIC, 7, 7, "skipped-6"));
  await flush();
  assert.equal(
    source2.subscriptions.filter((entry) => entry.topic === CONVERSATION_TOPIC).length,
    2,
    "检测到缺口必须重订（先 snapshot 屏障再 delta）",
  );
  source2.emit(snapshotFrame(CONVERSATION_TOPIC, 7, "barrier"));
  await flush();
  const batch = await restarted.drain(10);
  const records = "records" in batch ? batch.records : [];
  const seqs = records.map((record) => (record as { sourceSeq: number }).sourceSeq);
  assert.deepEqual(seqs, [7], "屏障后的 WAL 只应保留新屏障，不残留被取代的旧尾部");
  await restarted.stop();
  await first.stop();
});

test("rpcRelay：浏览器 ChannelClient 经 rpc.* 帧往返，旧代际帧不转发", async () => {
  const responses: CloudRpcFrame[] = [];
  const localChannels = new Map<string, IChannel>();
  localChannels.set("file", {
    call: (command) => Promise.resolve({ command, ok: true }),
    listen: () => () => undefined,
  });
  // 本地 runtime 侧确实有这个通道（supervisor 的安装器要用）；浏览器仍不得经 attachment 拿到。
  localChannels.set("provider-provisioning-target", {
    call: (command) => Promise.resolve({ command, ok: true }),
    listen: () => () => undefined,
  });
  const relay = createRpcRelay({
    channel: (name) => localChannels.get(name) ?? null,
    send: (frame) => responses.push(frame),
    logger: testLogger(),
  });
  const context: AttachmentContext = {
    address: {
      taskId: TASK_ID,
      runId: RUN_ID,
      runGeneration: 1,
      workspaceIdentity: `cloud-task:${TASK_ID}`,
      workspacePath: "/workspace/demo",
      remoteSessionId: RUN_ID,
    },
    connectionEpoch: 7,
    runGeneration: 1,
  };
  const streamId = "2f14e45f-ceea-467a-9a1e-1f0d3b2a4c53";
  const frameFor = (
    type: "rpc.open" | "rpc.request" | "rpc.close",
    payload?: string,
  ): CloudRpcFrame =>
    ({
      protocolVersion: 1,
      type,
      runId: RUN_ID,
      runGeneration: 1,
      connectionEpoch: 7,
      streamId,
      ...(payload === undefined ? {} : { payload }),
    }) as CloudRpcFrame;

  // 浏览器侧：真实 ChannelClient，字节经 rpc.request/rpc.response 往返。
  const browserInbound = new Emitter<VSBuffer>();
  const browser = new ChannelClient({
    send: (buffer) =>
      relay.handle(frameFor("rpc.request", Buffer.from(buffer.buffer).toString("base64")), context),
    onMessage: browserInbound.event,
  });
  relay.handle(frameFor("rpc.open"), context);
  // 控制面的 Initialize 响应：转成 rpc.response 后交回浏览器。
  const deliverResponses = () => {
    for (const frame of responses.splice(0)) {
      if (frame.type === "rpc.response") {
        browserInbound.fire(VSBuffer.wrap(new Uint8Array(Buffer.from(frame.payload, "base64"))));
      }
    }
  };
  await new Promise((resolve) => setTimeout(resolve, 5));
  deliverResponses();

  const call = browser.getChannel<IChannel>("file").call("readFile", { path: "/tmp/x" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  deliverResponses();
  assert.deepEqual(await call, { command: "readFile", ok: true }, "本地 channel 调用必须原样往返");

  // 账号域/凭据族即使本地可达，也不得经浏览器 attachment 暴露（03 §7.1、12 §5）：
  // 拒绝名单由 relay 注册，与 localRpcOwner 是否放行无关。
  const denied = browser
    .getChannel<IChannel>("provider-provisioning-target")
    .call("apply", { syncId: "s" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  deliverResponses();
  await assert.rejects(
    () => denied,
    /not available/,
    "浏览器不得经 attachment 调用 provider provisioning target",
  );

  // 旧 epoch 帧：不转发、不产生响应。
  const before = responses.length;
  relay.handle({ ...frameFor("rpc.request", ""), connectionEpoch: 6 } as CloudRpcFrame, context);
  assert.equal(responses.length, before, "旧代际帧不得转发到本地 runtime");
  // 连接释放：清网络侧会话，保留 stdio（本地 channel 仍在，不重启 runtime）。
  relay.releaseAll("disconnect");
  assert.deepEqual(
    responses.filter((frame) => frame.type === "rpc.close").length,
    0,
    "释放按设计不向浏览器回 close（连接已断）",
  );
  browser.dispose();
});

test("命令传输缝：CloudCommandTransport 经同一 rpc.* 通路投递与查询（超时 fail-closed）", async () => {
  // 沙箱侧：真实 relay + 本地 channel 假件（与浏览器路径共用同一 ChannelServer）。
  const sandboxOut: CloudRpcFrame[] = [];
  const localChannels = new Map<string, IChannel>();
  const ack = {
    commandId: "5f14e45f-ceea-467a-9a1e-1f0d3b2a4c56",
    status: "accepted" as const,
    reason: "admitted" as const,
  };
  localChannels.set("zcode-agent", {
    // 假件必须与真实通道同形：`IChannel.call(command, args)` 的 args 是**参数数组**
    // （`ProxyChannel.fromService` 把 args 展开成实参）。传裸对象的旧写法会让真实的
    // runtime 收到 undefined，这里按真实约定取值，避免假件掩盖调用约定错误。
    call: (command, args) => {
      const [arg] = (args ?? []) as [unknown];
      if (command === "sendConversationCommandV4") {
        const params = arg as { workspacePath: string; workspaceIdentity: string };
        assert.equal(params.workspacePath, "/workspace/demo", "沙箱侧用本地 workspace target");
        assert.equal(params.workspaceIdentity, `cloud-task:${TASK_ID}`);
        return Promise.resolve(ack);
      }
      if (command === "queryConversationCommandsV4") {
        return Promise.resolve({ commands: [{ commandId: ack.commandId, ack }] });
      }
      return Promise.reject(new Error(`unexpected command ${command}`));
    },
    listen: () => () => undefined,
  });
  const context: AttachmentContext = {
    address: {
      taskId: TASK_ID,
      runId: RUN_ID,
      runGeneration: 1,
      workspaceIdentity: `cloud-task:${TASK_ID}`,
      workspacePath: "/workspace/demo",
      remoteSessionId: RUN_ID,
    },
    connectionEpoch: 11,
    runGeneration: 1,
  };
  const relay = createRpcRelay({
    channel: (name) => localChannels.get(name) ?? null,
    send: (frame) => sandboxOut.push(frame),
    logger: testLogger(),
  });

  // 控制面侧：命令传输把 rpc.* 写进同一连接（此处用内存直通模拟 W5 的 socket）。
  const delivered: unknown[] = [];
  const acks: unknown[] = [];
  let connected = true;
  const transport = createCloudCommandTransport({
    logger: testLogger(),
    streamId: "6f14e45f-ceea-467a-9a1e-1f0d3b2a4c57",
    send: (frame) => {
      if (!connected) return false;
      delivered.push(frame);
      return true;
    },
    resolveContext: () =>
      connected
        ? {
            runId: RUN_ID,
            runGeneration: 1,
            connectionEpoch: 11,
            workspacePath: "/workspace/demo",
            workspaceIdentity: `cloud-task:${TASK_ID}`,
            remoteSessionId: RUN_ID,
          }
        : null,
    onRuntimeAck: async (input) => {
      acks.push(input.ack);
    },
    timeoutMs: 50,
  });

  // 双向接线：CP→沙箱交 relay；沙箱回投的 rpc.response 交回传输。
  const pump = async () => {
    for (const frame of sandboxOut.splice(0)) {
      transport.handleResponse(frame as CloudRpcFrame);
    }
    for (const frame of delivered.splice(0)) {
      relay.handle(frame, context);
    }
  };
  const send = transport.sendCommand({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    commandId: ack.commandId,
    envelope: { commandId: ack.commandId, type: "sendText" },
  });
  for (let i = 0; i < 20; i += 1) {
    await pump();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.deepEqual(await send, { status: "sent" }, "命令必须经同一 relay 通路送达");
  assert.equal(
    acks.length,
    1,
    "runtime ACK 必须交回控制面落库（经 onRuntimeAck，不冒充 admission）",
  );
  assert.equal((acks[0] as { status: string }).status, "accepted");

  const queried = transport.queryCommand({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    commandId: ack.commandId,
  });
  for (let i = 0; i < 20; i += 1) {
    await pump();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.deepEqual(await queried, { status: "found", ack });

  // 断线：不伪造 sent，返回可对账的 closed。
  connected = false;
  transport.release("disconnect");
  const offline = await transport.sendCommand({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    commandId: "7f14e45f-ceea-467a-9a1e-1f0d3b2a4c58",
    envelope: {},
  });
  assert.deepEqual(offline, {
    status: "rejected",
    code: "attachment_unavailable",
    reason: "no-attachment",
  });
  transport.dispose();
});

test("命令传输释放只作用于关闭的那条连接：其它 run / 新 epoch 不被毒化（回归 2026-10-07）", async () => {
  // 回归现场：单例 transport 的 released 一位置 true 永不复位——任意一条 bridge 连接
  // 关闭（60s 命令超时 / 旧 run 重连被拒）之后，之后所有 run 的投递一律
  // attachment_unavailable:closed，输入永远停在 accepted。
  const sentFrames: { type: string; runId: string; connectionEpoch: number }[] = [];
  let context: {
    runId: string;
    runGeneration: number;
    connectionEpoch: number;
    workspacePath: string;
    workspaceIdentity: string;
  } | null = null;
  const mk = (runId: string, epoch: number) => ({
    runId,
    runGeneration: 1,
    connectionEpoch: epoch,
    workspacePath: "/workspace/demo",
    workspaceIdentity: `cloud-task:${runId}`,
  });
  const transport = createCloudCommandTransport({
    logger: testLogger(),
    streamId: "stream-release-scope",
    send: (frame) => {
      sentFrames.push(frame as { type: string; runId: string; connectionEpoch: number });
      return true;
    },
    resolveContext: () => context,
    onRuntimeAck: async () => {},
    timeoutMs: 50,
  });

  // run A（epoch 1）开流成功。
  context = mk("run-a", 1);
  const a1 = await transport.sendCommand({
    taskId: TASK_ID,
    runId: "run-a",
    runGeneration: 1,
    commandId: "cmd-a1",
    envelope: {},
  });
  // 无应答方：开流成功但调用超时——code 是 network_unknown 而不是 attachment_unavailable。
  assert.equal(a1.status, "rejected");
  assert.equal((a1 as { code?: string }).code, "network_unknown", "开流成功后只允许超时，不允许 closed");
  assert.ok(
    sentFrames.some((frame) => frame.type === "rpc.open" && frame.runId === "run-a"),
    "run A 必须已发 rpc.open",
  );

  // run A 的连接关闭：释放按连接记账。
  transport.release("bridge-socket-closed", mk("run-a", 1));
  const a2 = await transport.sendCommand({
    taskId: TASK_ID,
    runId: "run-a",
    runGeneration: 1,
    commandId: "cmd-a2",
    envelope: {},
  });
  assert.deepEqual(
    { status: a2.status, code: (a2 as { code?: string }).code },
    { status: "rejected", code: "attachment_unavailable" },
    "同一上下文（同 run 同 epoch）释放后必须仍被拒",
  );

  // 另一个 run B 或同 run 的新 epoch：必须重新开流并可用，而不是被 A 的关闭毒化。
  for (const [label, next] of [["run-b", mk("run-b", 1)], ["run-a 新 epoch", mk("run-a", 2)]] as const) {
    const openedBefore = sentFrames.filter((frame) => frame.type === "rpc.open").length;
    context = next;
    const result = await transport.sendCommand({
      taskId: TASK_ID,
      runId: next.runId,
      runGeneration: 1,
      commandId: `cmd-${next.runId}-${next.connectionEpoch}`,
      envelope: {},
    });
    assert.notEqual(
      (result as { code?: string }).code,
      "attachment_unavailable",
      `${label} 不得被旧连接的释放毒化（允许超时，不允许 closed）`,
    );
    assert.equal(
      sentFrames.filter((frame) => frame.type === "rpc.open").length,
      openedBefore + 1,
      `${label} 必须对新连接重发 rpc.open`,
    );
  }
  transport.dispose();
});

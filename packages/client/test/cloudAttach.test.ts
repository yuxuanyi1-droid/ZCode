/**
 * W7 attachment 用例（specs/cloud-agent/W7 §6/§8、07 §9、02 §2 不变量 4/§7.3、04 §9 W-08）。
 *
 * 先固定「断连=释放订阅、不释放沙箱、不重发输入」的用例，再验证实现：
 * 断连时在途请求 fail-closed 且不被重放，重连只重建订阅并用声明水位续接，
 * 无法续接时显式上抛 resync。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ServiceChannels } from "@zcode/shared";
import {
  CloudResyncRequiredError,
  createCloudAttachClient,
  isCloudApiError,
  isCloudResyncRequiredError,
  type CloudAttachClient,
  type CloudAttachState,
} from "../src/index.js";
import {
  createFakeAttachConnector,
  type FakeAttachCall,
  type FakeAttachConnector,
} from "./cloudAttachServer.js";

const ORIGIN = "https://cloud.example.test";
const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";

// 通道/命令名来自冻结服务契约：channel 用 shared `ServiceChannels` 常量（不硬编码字符串），
// 命令/帧事件名沿用既有 V4 面，由服务契约（W6/W8）提供。
const CHANNEL = ServiceChannels.ZCodeAgent;
const SUBSCRIBE_COMMAND = "subscribeConversationV4";
const FRAME_EVENT = "onDynamicConversationFrame";
const FILE_CHANNEL = ServiceChannels.File;
const TOPIC = "conversation/session-1";

function subscribeAck(mode: "snapshot" | "resume", logEpoch: string) {
  return { ok: true as const, data: { ack: { subscriptionId: "sub-1", mode, logEpoch } } };
}

function waitForState(
  attach: CloudAttachClient,
  target: CloudAttachState,
  timeoutMs = 3000,
): Promise<void> {
  if (attach.state === target) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      listener.dispose();
      reject(new Error(`timed out waiting for attach state ${target}`));
    }, timeoutMs);
    const listener = attach.onDidChangeState((change) => {
      if (change.state !== target) return;
      clearTimeout(timer);
      listener.dispose();
      resolve();
    });
  });
}

function tick(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 等一个可观察条件（订阅重建立是异步的，不能用固定 sleep 猜时序）。 */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await tick(2);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function createAttach(
  connector: FakeAttachConnector,
  options: { taskId?: string } = {},
): CloudAttachClient {
  return createCloudAttachClient({
    origin: ORIGIN,
    taskId: options.taskId ?? TASK_ID,
    auth: { mode: "cookie" },
    connector: connector.connector,
    connectTimeoutMs: 1000,
    reconnect: { initialDelayMs: 1, maxDelayMs: 4 },
  });
}

test("connect opens the frozen attachment path and waits for channel initialize", async () => {
  const connector = createFakeAttachConnector();
  const attach = createAttach(connector);
  const states: CloudAttachState[] = [];
  attach.onDidChangeState((change) => states.push(change.state));

  assert.equal(attach.state, "idle");
  await attach.connect();
  assert.equal(attach.state, "connected");
  assert.deepEqual(states, ["connecting", "connected"]);
  assert.deepEqual(connector.urls, [`wss://cloud.example.test/ws/cloud/tasks/${TASK_ID}`]);
  assert.equal(connector.urls[0]?.includes("token"), false);
  attach.close();
});

test("attachment requires a taskId and fails closed without one", async () => {
  const connector = createFakeAttachConnector();
  const attach = createAttach(connector, { taskId: "  " });
  const error = await attach
    .connect()
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(error));
  assert.equal(error.source, "configuration");
  assert.equal(error.code, "validation_failed");
  assert.equal(connector.connections.length, 0);
  attach.close();
});

test("channel proxies fail closed while disconnected and work after connect", async () => {
  const connector = createFakeAttachConnector({
    onCall: (call: FakeAttachCall) =>
      call.channel === FILE_CHANNEL
        ? { ok: true, data: { path: "/workspace/task/a.ts" } }
        : undefined,
  });
  const attach = createAttach(connector);
  const files = attach.getChannel<{
    call: <T>(command: string, arg?: unknown) => Promise<T>;
  }>(FILE_CHANNEL);

  const offline = await files
    .call("readFile", { path: "a.ts" })
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(offline));
  assert.equal(offline.code, "attachment_unavailable");
  assert.equal(offline.retryable, true);
  assert.equal(connector.frames.length, 0, "disconnected calls must not be queued or sent");

  await attach.connect();
  const content = await files.call<{ path: string }>("readFile", { path: "a.ts" });
  assert.equal(content.path, "/workspace/task/a.ts");
  attach.close();
});

test("subscribe resumes from the declared watermark and delivers frames", async () => {
  const connector = createFakeAttachConnector({
    onCall: (call) =>
      call.command === SUBSCRIBE_COMMAND ? subscribeAck("resume", "epoch-1") : undefined,
  });
  const attach = createAttach(connector);
  const frames: unknown[] = [];
  const handle = await attach.subscribe(
    {
      channel: CHANNEL,
      subscribeCommand: SUBSCRIBE_COMMAND,
      subscribeParams: { topic: TOPIC, base: { logEpoch: "epoch-1", seq: 4 } },
      frameEvent: FRAME_EVENT,
      frameParams: { subscriptionId: "sub-1" },
    },
    { onFrame: (frame) => frames.push(frame) },
  );
  assert.equal(handle.state, "active");
  assert.equal(handle.ack?.mode, "resume");
  assert.deepEqual(handle.watermark, { logEpoch: "epoch-1", seq: 4 });

  // 订阅水位随 call 帧上送；listen 只带调用方给的帧过滤参数。
  await waitFor(() => connector.connections[0]?.server.listens().length === 1, "listen frame");
  const subscribeCall = connector.frames.find(
    (frame) => frame.kind === "call" && frame.command === SUBSCRIBE_COMMAND,
  );
  assert.deepEqual(subscribeCall?.arg, { topic: TOPIC, base: { logEpoch: "epoch-1", seq: 4 } });
  const listen = connector.connections[0]?.server.listens()[0];
  assert.equal(listen?.channel, CHANNEL);
  assert.equal(listen?.event, FRAME_EVENT);
  assert.deepEqual(listen?.arg, { subscriptionId: "sub-1" });

  connector.connections[0]?.server.fire(CHANNEL, FRAME_EVENT, { kind: "delta", seq: 5 });
  await tick();
  assert.deepEqual(frames, [{ kind: "delta", seq: 5 }]);
  attach.close();
});

test("subscribe rejects unknown params fields and unknown ack shapes", async () => {
  const connector = createFakeAttachConnector({
    onCall: (call) =>
      call.command === SUBSCRIBE_COMMAND ? { ok: true, data: { ack: {} } } : undefined,
  });
  const attach = createAttach(connector);
  await attach.connect();
  const invalidParams = await attach
    .subscribe(
      {
        channel: CHANNEL,
        subscribeCommand: SUBSCRIBE_COMMAND,
        subscribeParams: { topic: TOPIC, unexpected: true } as never,
        frameEvent: FRAME_EVENT,
      },
      { onFrame: () => {} },
    )
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(invalidParams));
  assert.equal(invalidParams.code, "validation_failed");

  const invalidAck = await attach
    .subscribe(
      {
        channel: CHANNEL,
        subscribeCommand: SUBSCRIBE_COMMAND,
        subscribeParams: { topic: TOPIC },
        frameEvent: FRAME_EVENT,
      },
      { onFrame: () => {} },
    )
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(invalidAck));
  assert.equal(invalidAck.code, "protocol_incompatible");
  attach.close();
});

test("a claimed watermark that the server cannot resume raises resync-required", async () => {
  const connector = createFakeAttachConnector({
    onCall: (call) =>
      call.command === SUBSCRIBE_COMMAND ? subscribeAck("snapshot", "epoch-2") : undefined,
  });
  const attach = createAttach(connector);
  const error = await attach
    .subscribe(
      {
        channel: CHANNEL,
        subscribeCommand: SUBSCRIBE_COMMAND,
        subscribeParams: { topic: TOPIC, base: { logEpoch: "epoch-1", seq: 9 } },
        frameEvent: FRAME_EVENT,
      },
      { onFrame: () => {} },
    )
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudResyncRequiredError(error));
  assert.equal(error.reason, "log-epoch-changed");
  assert.equal(error.topic, TOPIC);
  assert.equal(error.logEpoch, "epoch-1");
  assert.equal(connector.connections[0]?.server.listens().length, 0, "no live listen after resync");
  attach.close();
});

test("a fresh subscribe without a watermark accepts a snapshot ack", async () => {
  const connector = createFakeAttachConnector({
    onCall: (call) =>
      call.command === SUBSCRIBE_COMMAND ? subscribeAck("snapshot", "epoch-1") : undefined,
  });
  const attach = createAttach(connector);
  const handle = await attach.subscribe(
    {
      channel: CHANNEL,
      subscribeCommand: SUBSCRIBE_COMMAND,
      subscribeParams: { topic: TOPIC },
      frameEvent: FRAME_EVENT,
    },
    { onFrame: () => {} },
  );
  assert.equal(handle.ack?.mode, "snapshot");
  assert.equal(handle.watermark, undefined);
  attach.close();
});

test("disconnect releases subscriptions, rejects in-flight calls and replays no input", async () => {
  const subscribes: unknown[] = [];
  const connector = createFakeAttachConnector({
    onCall: (call) => {
      if (call.command === SUBSCRIBE_COMMAND) {
        subscribes.push(call.arg);
        return subscribeAck("resume", "epoch-1");
      }
      // 文件读永远不回应：制造在途请求。
      return undefined;
    },
  });
  const attach = createAttach(connector);
  const states: CloudAttachState[] = [];
  attach.onDidChangeState((change) => states.push(change.state));

  const handle = await attach.subscribe(
    {
      channel: CHANNEL,
      subscribeCommand: SUBSCRIBE_COMMAND,
      subscribeParams: { topic: TOPIC, base: { logEpoch: "epoch-1", seq: 4 } },
      frameEvent: FRAME_EVENT,
    },
    { onFrame: () => {} },
  );
  // 调用方应用帧后回填水位（SDK 不解析 payload）。
  handle.updateWatermark({ logEpoch: "epoch-1", seq: 7 });

  const files = attach.getChannel<{ call: <T>(command: string, arg?: unknown) => Promise<T> }>(
    FILE_CHANNEL,
  );
  const inFlight = files.call("readFile", { path: "a.ts" }).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  await tick();

  connector.dropLast();
  const dropError = await inFlight;
  assert.ok(isCloudApiError(dropError), "in-flight call must fail closed on disconnect");
  assert.equal(dropError.code, "attachment_unavailable");
  assert.equal(handle.state, "released");
  assert.equal(attach.state, "reconnecting");

  await waitForState(attach, "connected");
  await waitFor(() => handle.state === "active", "resubscribed handle");
  assert.equal(handle.state, "active");
  assert.equal(connector.connections.length, 2);

  // 重连只重建订阅：用调用方声明的最新水位续接。
  await waitFor(() => subscribes.length === 2, "second subscribe");
  assert.deepEqual(subscribes[1], { topic: TOPIC, base: { logEpoch: "epoch-1", seq: 7 } });

  // 线上事实：断开后没有任何请求被重放（尤其没有输入类命令）。
  const callFrames = connector.frames.filter((frame) => frame.kind === "call");
  assert.deepEqual(
    callFrames.map((frame) => `${frame.connection}:${frame.channel}:${frame.command}`),
    [
      `0:${CHANNEL}:${SUBSCRIBE_COMMAND}`,
      `0:${FILE_CHANNEL}:readFile`,
      `1:${CHANNEL}:${SUBSCRIBE_COMMAND}`,
    ],
  );
  assert.equal(
    callFrames.some((frame) => /submit|input|command/i.test(frame.command)),
    false,
  );

  // 新连接上的帧仍然送达。
  const frames: unknown[] = [];
  const second = await attach.subscribe(
    {
      channel: CHANNEL,
      subscribeCommand: SUBSCRIBE_COMMAND,
      subscribeParams: { topic: TOPIC, base: { logEpoch: "epoch-1", seq: 7 } },
      frameEvent: FRAME_EVENT,
    },
    { onFrame: (frame) => frames.push(frame) },
  );
  assert.equal(second.state, "active");
  await waitFor(
    () => (connector.connections[1]?.server.listens().length ?? 0) >= 2,
    "listen frames on the new connection",
  );
  connector.connections[1]?.server.fire(CHANNEL, FRAME_EVENT, { kind: "delta", seq: 8 });
  await tick();
  assert.deepEqual(frames, [{ kind: "delta", seq: 8 }]);

  assert.deepEqual(states, ["connecting", "connected", "reconnecting", "connected"]);
  attach.close();
});

test("background resubscribe that cannot resume surfaces resync and closes the handle", async () => {
  let resumeAllowed = true;
  const connector = createFakeAttachConnector({
    onCall: (call) =>
      call.command === SUBSCRIBE_COMMAND
        ? subscribeAck(resumeAllowed ? "resume" : "snapshot", resumeAllowed ? "epoch-1" : "epoch-2")
        : undefined,
  });
  const attach = createAttach(connector);
  const resyncs: CloudResyncRequiredError[] = [];
  attach.onDidRequireResync((error) => resyncs.push(error));

  const handle = await attach.subscribe(
    {
      channel: CHANNEL,
      subscribeCommand: SUBSCRIBE_COMMAND,
      subscribeParams: { topic: TOPIC, base: { logEpoch: "epoch-1", seq: 4 } },
      frameEvent: FRAME_EVENT,
    },
    { onFrame: () => {} },
  );
  assert.equal(handle.state, "active");

  resumeAllowed = false;
  connector.dropLast();
  await waitForState(attach, "connected");
  await waitFor(() => resyncs.length === 1, "resync requirement");

  assert.equal(resyncs.length, 1);
  assert.equal(resyncs[0]?.reason, "log-epoch-changed");
  assert.equal(handle.state, "closed");
  attach.close();
});

test("channels outside the frozen attachment allowlist are refused before any request", async () => {
  const connector = createFakeAttachConnector({
    onCall: () => ({ ok: true, data: undefined }),
  });
  const attach = createAttach(connector);
  await attach.connect();

  // 账号域 channel 只在 host /ws 暴露（03 §7.1）：沙箱通道不得借用。
  const denied = await attach
    .getChannel<{ call: <T>(command: string) => Promise<T> }>(ServiceChannels.OAuth)
    .call("status")
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(denied));
  assert.equal(denied.code, "unauthorized");
  assert.equal(denied.source, "configuration");

  // 不在白名单里的通道同样在发出请求前拒绝。
  const unlisted = await attach
    .subscribe(
      {
        channel: ServiceChannels.ConversationShare,
        subscribeCommand: SUBSCRIBE_COMMAND,
        subscribeParams: { topic: TOPIC },
        frameEvent: FRAME_EVENT,
      },
      { onFrame: () => {} },
    )
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(unlisted));
  assert.equal(unlisted.code, "unauthorized");

  assert.equal(connector.frames.length, 0, "a non-allowlisted channel must not reach the wire");
  attach.close();
});

test("a closed attachment rejects calls and delivers no late frames", async () => {
  const connector = createFakeAttachConnector({
    onCall: (call) =>
      call.command === SUBSCRIBE_COMMAND ? subscribeAck("resume", "epoch-1") : undefined,
  });
  const attach = createAttach(connector);
  const frames: unknown[] = [];
  const handle = await attach.subscribe(
    {
      channel: CHANNEL,
      subscribeCommand: SUBSCRIBE_COMMAND,
      subscribeParams: { topic: TOPIC, base: { logEpoch: "epoch-1", seq: 4 } },
      frameEvent: FRAME_EVENT,
    },
    { onFrame: (frame) => frames.push(frame) },
  );
  await waitFor(() => connector.connections[0]?.server.listens().length === 1, "listen frame");

  attach.close();
  // 旧 tuple 的迟到帧不得再进入客户端（04 §5、W-07）。
  connector.connections[0]?.server.fire(CHANNEL, FRAME_EVENT, { kind: "delta", seq: 99 });
  await tick(10);
  assert.deepEqual(frames, []);
  assert.equal(handle.state, "closed");

  const error = await attach
    .getChannel<{ call: <T>(command: string) => Promise<T> }>(FILE_CHANNEL)
    .call("readFile")
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(error));
  assert.equal(error.code, "attachment_unavailable");
});

test("close is terminal: no reconnect attempts and pending handles are released", async () => {
  const connector = createFakeAttachConnector({
    onCall: (call) =>
      call.command === SUBSCRIBE_COMMAND ? subscribeAck("resume", "epoch-1") : undefined,
  });
  const attach = createAttach(connector);
  const handle = await attach.subscribe(
    {
      channel: CHANNEL,
      subscribeCommand: SUBSCRIBE_COMMAND,
      subscribeParams: { topic: TOPIC, base: { logEpoch: "epoch-1", seq: 4 } },
      frameEvent: FRAME_EVENT,
    },
    { onFrame: () => {} },
  );
  attach.close();
  assert.equal(attach.state, "closed");
  assert.equal(handle.state, "closed");

  connector.dropLast();
  await tick(20);
  assert.equal(attach.state, "closed");
  assert.equal(connector.connections.length, 1);

  const reopened = await attach
    .connect()
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(reopened));
  assert.equal(reopened.code, "attachment_unavailable");
});

/**
 * M8 控制面 RPC 通道（ws 层）验收（specs/cloud-agent 14 §4.2/§4.6）。
 *
 * 用**真实 ChannelClient × 真实 ChannelServer**（与 W6 的 rpcRelay 同一机制）跑完整字节回路：
 * - `rpc.open` 必带 `serviceScope:"control-plane"`（分面由控制面写，沙箱据此选白名单）；
 * - 同一 Run 一条流（streamId 隔离）、代际围栏、无连接/未 ready 即 fail-closed；
 * - 浏览器流的分面固定 `"client"`（浏览器不能自报 scope）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ChannelServer,
  Emitter,
  Event,
  VSBuffer,
  type IMessagePassingProtocol,
  type IServerChannel,
} from "@zcode/rpc";
import { CLOUD_RPC_PROTOCOL_VERSION, ServiceChannels, type CloudRpcFrame } from "@zcode/shared";
import { createControlPlaneRpcChannel } from "../src/cloud/adapters/ws/controlPlaneRpcChannel.js";
import { createBrowserRpcMultiplexer } from "../src/cloud/adapters/ws/browserStreams.js";
import { createAttachmentRegistry } from "../src/cloud/app/attachments/registry.js";
import { sessionFromAddress } from "../src/cloud/app/attachments/registry.js";

const RUN_ID = "00000000-0000-4000-8000-0000000000c1";
const TASK_ID = "00000000-0000-4000-8000-0000000000c2";

/** 沙箱侧替身：`rpc.open/request` → 真实 ChannelServer；回投 `rpc.response`。 */
function createFakeSandboxSyncRelay(input: { emit: (frame: CloudRpcFrame) => void }) {
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
  const opens: CloudRpcFrame[] = [];
  const calls: { channel: string; method: string; arg: unknown }[] = [];

  function syncChannel(): IServerChannel {
    return {
      call: (_context, command, arg) => {
        // ChannelServer 约定：`arg` 是**参数数组**（ProxyChannel.fromService 的 apply 语义）。
        calls.push({ channel: ServiceChannels.SettingsSync, method: command, arg });
        if (command === "writeUserAgentsFile") {
          return Promise.resolve({
            path: "/root/.zcode/AGENTS.md",
            bytes: 8,
            sha256: "b".repeat(64),
          });
        }
        return Promise.reject(new Error(`unknown command ${command}`));
      },
      listen: () => Event.None,
    };
  }

  return {
    opens,
    calls,
    handle(frame: CloudRpcFrame): void {
      switch (frame.type) {
        case "rpc.open": {
          opens.push(frame);
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
          server.registerChannel(ServiceChannels.SettingsSync, syncChannel());
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
  };
}

function readySession(connectionEpoch = 1) {
  return sessionFromAddress({
    address: {
      taskId: TASK_ID,
      runId: RUN_ID,
      runGeneration: 1,
      workspaceIdentity: `cloud-task:${TASK_ID}`,
      workspacePath: "/workspace/demo",
      connectionEpoch,
    },
    at: 1_700_000_000_000,
  });
}

function setup(input: { ready?: boolean; connectionEpoch?: number } = {}) {
  const registry = createAttachmentRegistry();
  const frames: CloudRpcFrame[] = [];
  const session = readySession(input.connectionEpoch ?? 1);
  session.ready = input.ready ?? true;
  registry.register(session);
  const relay = createFakeSandboxSyncRelay({
    emit: (frame) => {
      frames.push(frame);
      channel.handleResponse(frame);
    },
  });
  const channel = createControlPlaneRpcChannel({
    registry,
    sendFrame: (frame) => {
      relay.handle(frame);
      return true;
    },
    newStreamId: () => "stream-control-plane-1",
    timeoutMs: 2_000,
  });
  return { channel, relay, frames, registry };
}

test("控制面调用：rpc.open 带 serviceScope=control-plane，调用与响应经同一 streamId 回投", async () => {
  const { channel, relay, frames } = setup();
  const result = await channel.port.call({
    runId: RUN_ID,
    runGeneration: 1,
    connectionEpoch: 1,
    channel: ServiceChannels.SettingsSync,
    method: "writeUserAgentsFile",
    args: [{ content: "# AGENTS" }],
  });
  assert.deepEqual(result, {
    status: "ok",
    result: { path: "/root/.zcode/AGENTS.md", bytes: 8, sha256: "b".repeat(64) },
  });
  assert.equal(relay.opens.length, 1);
  assert.equal(
    (relay.opens[0] as unknown as { serviceScope?: string }).serviceScope,
    "control-plane",
    "控制面信封唯一构造方写分面（14 §4.2）",
  );
  assert.equal(relay.opens[0]?.runId, RUN_ID);
  assert.equal(relay.opens[0]?.connectionEpoch, 1);
  assert.deepEqual(relay.calls, [
    {
      channel: ServiceChannels.SettingsSync,
      method: "writeUserAgentsFile",
      arg: [{ content: "# AGENTS" }],
    },
  ]);
  // 响应帧按同一 streamId 回投（控制面侧按 streamId 路由）。
  assert.equal(frames.length > 0, true);
  assert.equal(
    frames.every((frame) => frame.streamId === "stream-control-plane-1"),
    true,
  );

  // 同一 Run 的第二次调用复用同一条流（不重复 rpc.open，14 §4.2「单流顺序调用」）。
  const second = await channel.port.call({
    runId: RUN_ID,
    runGeneration: 1,
    connectionEpoch: 1,
    channel: ServiceChannels.SettingsSync,
    method: "writeUserAgentsFile",
    args: [{ content: "# AGENTS 2" }],
  });
  assert.equal(second.status, "ok");
  assert.equal(relay.opens.length, 1, "同一 Run 复用同一流");
});

test("门控：无连接 / 未 ready / 代际不符 ⇒ fail-closed，不发出帧", async () => {
  const noSession = setup({ ready: false });
  // 先移除 session 模拟"无连接"。
  noSession.registry.detach({ runId: RUN_ID, at: 2, reason: "test" });
  const disconnected = await noSession.channel.port.call({
    runId: RUN_ID,
    runGeneration: 1,
    connectionEpoch: 1,
    channel: ServiceChannels.SettingsSync,
    method: "writeUserAgentsFile",
    args: [{ content: "x" }],
  });
  assert.equal(disconnected.status, "failed");
  if (disconnected.status === "failed") assert.equal(disconnected.reason, "no-attachment");
  assert.equal(noSession.relay.opens.length, 0, "无连接不发出任何帧");

  const notReady = setup({ ready: false });
  const pending = await notReady.channel.port.call({
    runId: RUN_ID,
    runGeneration: 1,
    connectionEpoch: 1,
    channel: ServiceChannels.SettingsSync,
    method: "writeUserAgentsFile",
    args: [{ content: "x" }],
  });
  assert.equal(pending.status, "failed");
  if (pending.status === "failed") assert.equal(pending.reason, "not-ready");
  assert.equal(notReady.relay.opens.length, 0);

  const stale = setup({ connectionEpoch: 2 });
  const mismatched = await stale.channel.port.call({
    runId: RUN_ID,
    runGeneration: 1,
    connectionEpoch: 1,
    channel: ServiceChannels.SettingsSync,
    method: "writeUserAgentsFile",
    args: [{ content: "x" }],
  });
  assert.equal(mismatched.status, "failed");
  if (mismatched.status === "failed") assert.equal(mismatched.reason, "stale");
  assert.equal(stale.relay.opens.length, 0, "旧代际不发出帧");
});

test("沙箱拒绝/未知命令 ⇒ failed（结论未知不伪装成功）", async () => {
  const { channel } = setup();
  const result = await channel.port.call({
    runId: RUN_ID,
    runGeneration: 1,
    connectionEpoch: 1,
    channel: ServiceChannels.SettingsSync,
    method: "copyClaudeAgentsFileToZcodeAgentsFile",
    args: [],
  });
  assert.equal(result.status, "failed");
  if (result.status === "failed") {
    assert.equal(result.reason, "closed");
    assert.ok(result.message.includes("unknown command"));
  }
});

test("浏览器流分面固定为 client（浏览器不能自报 scope）", () => {
  const sent: CloudRpcFrame[] = [];
  const multiplexer = createBrowserRpcMultiplexer({
    sendFrame: (frame) => {
      sent.push(frame);
      return true;
    },
    newStreamId: () => "browser-stream-1",
  });
  const stream = multiplexer.open({
    runId: RUN_ID,
    runGeneration: 1,
    connectionEpoch: 1,
    deliver: () => undefined,
    onClosed: () => undefined,
  });
  assert.ok(stream);
  assert.equal(sent.length, 1);
  const open = sent[0] as unknown as { type: string; serviceScope?: string };
  assert.equal(open.type, "rpc.open");
  assert.equal(open.serviceScope, "client", "控制面为浏览器流固定写 client 分面");
});

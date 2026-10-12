/**
 * rpcRelay `serviceScope` 分面准入用例（specs/cloud-agent 14 §4.2；W11 §13C；02 §0）。
 *
 * 分面规则（2026-10-11 C 批定夺，实现在 `app/rpcRelay.ts`）：
 * - `scope === "client"`（浏览器转发）：通道必须在 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`；
 * - `scope === "control-plane"`（控制面发起）：通道必须在
 *   `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST ∪ CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST`（并集）；
 * - 未知 scope 的 `rpc.open` 被拒绝（不建会话）；未列出的通道名一律**不注册**，
 *   调用停在 ChannelServer 的未注册通道路径（挂起至超时错误），不回落 host 执行域。
 *
 * 用**真实 ChannelClient × 真实 relay（ChannelServer）**跑完整字节回路：断言不是类型兼容，
 * 而是"本地 channel 假件是否真的被调用"这一可观察事实。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { ChannelClient, Emitter, VSBuffer, type IChannel } from "@zcode/rpc";
import {
  CLOUD_ATTACHMENT_SERVICE_ALLOWLIST,
  CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST,
  ServiceChannels,
  type CloudRpcFrame,
  type CloudRpcServiceScope,
} from "@zcode/shared";
import {
  CLOUD_CONTROL_PLANE_SERVICE_REACHABLE_CHANNELS,
  createRpcRelay,
  serviceAllowlistForScope,
} from "../src/cloud/execution/app/rpcRelay.js";
import type { AttachmentContext } from "../src/cloud/execution/app/ports.js";
import { testLogger } from "./cloudBridgeFakes.js";

const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const RUN_ID = "1f14e45f-ceea-467a-9a1e-1f0d3b2a4c52";
const CONTEXT: AttachmentContext = {
  address: {
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    workspaceIdentity: `cloud-task:${TASK_ID}`,
    workspacePath: "/workspace/demo",
    remoteSessionId: RUN_ID,
  },
  connectionEpoch: 9,
  runGeneration: 1,
};

/** 本地 runtime 侧通道假件：记录被调用的 command，调用即证明字节穿透到了本地服务面。 */
interface LocalChannelFake {
  calls: string[];
  channel: IChannel;
}

function localChannel(): LocalChannelFake {
  const calls: string[] = [];
  return {
    calls,
    channel: {
      call: (command) => {
        calls.push(command);
        return Promise.resolve({ command, ok: true });
      },
      listen: () => () => undefined,
    },
  };
}

/** 一个 relay + 每条流一个真实 ChannelClient 的完整字节回路（控制面字节 ↔ 本地 channel 假件）。 */
function createHarness() {
  const locals = new Map<string, LocalChannelFake>();
  const localChannels = new Map<string, IChannel>();
  const forChannel = (name: string): LocalChannelFake => {
    let fake = locals.get(name);
    if (!fake) {
      fake = localChannel();
      locals.set(name, fake);
      localChannels.set(name, fake.channel);
    }
    return fake;
  };
  for (const channelName of CLOUD_CONTROL_PLANE_SERVICE_REACHABLE_CHANNELS) forChannel(channelName);

  const outbound: CloudRpcFrame[] = [];
  // 每条流的浏览器侧入站口：响应按 streamId 路由（与 relay 的真实出站帧一致）。
  const inboundByStream = new Map<string, Emitter<VSBuffer>>();
  let deliverScheduled = false;
  const deliver = (): void => {
    for (const frame of outbound.splice(0)) {
      if (frame.type !== "rpc.response") continue;
      inboundByStream
        .get(frame.streamId)
        ?.fire(VSBuffer.wrap(new Uint8Array(Buffer.from(frame.payload, "base64"))));
    }
  };
  // 响应经事件循环异步回投（与真实 socket 同语义），避免在 relay.handle 内重入。
  const scheduleDeliver = (): void => {
    if (deliverScheduled) return;
    deliverScheduled = true;
    setImmediate(() => {
      deliverScheduled = false;
      deliver();
    });
  };

  const relay = createRpcRelay({
    channel: (name) => localChannels.get(name) ?? null,
    // 沙箱 → 控制面方向的每个字节都进同一个出站队列并触发回投（含 ChannelServer 的
    // Initialize 与未注册通道的超时错误响应）。
    send: (frame) => {
      outbound.push(frame);
      scheduleDeliver();
    },
    logger: testLogger(),
  });

  const clients: ChannelClient[] = [];
  let streamCounter = 0;

  return {
    locals,
    forChannel,
    relay,
    outbound,
    /** 打开一条流：返回该流的通道访问面（通道字节真经 rpc.request/rpc.response 往返）。 */
    open(scope: CloudRpcServiceScope | string): (name: string) => IChannel {
      streamCounter += 1;
      const streamId = `stream-${streamCounter}`;
      const inbound = new Emitter<VSBuffer>();
      inboundByStream.set(streamId, inbound);
      const client = new ChannelClient({
        send: (buffer) => {
          relay.handle(
            {
              protocolVersion: 1,
              type: "rpc.request",
              runId: RUN_ID,
              runGeneration: 1,
              connectionEpoch: CONTEXT.connectionEpoch,
              streamId,
              payload: Buffer.from(buffer.buffer).toString("base64"),
            } as CloudRpcFrame,
            CONTEXT,
          );
          scheduleDeliver();
        },
        onMessage: inbound.event,
      });
      clients.push(client);
      outbound.length = 0;
      relay.handle(
        {
          protocolVersion: 1,
          type: "rpc.open",
          serviceScope: scope,
          runId: RUN_ID,
          runGeneration: 1,
          connectionEpoch: CONTEXT.connectionEpoch,
          streamId,
        } as CloudRpcFrame,
        CONTEXT,
      );
      // ChannelServer 的 Initialize 响应：交给浏览器侧 ChannelClient 完成握手。
      scheduleDeliver();
      return (name: string) => client.getChannel<IChannel>(name);
    },
    dispose: () => {
      for (const client of clients) client.dispose();
      clients.length = 0;
      inboundByStream.clear();
    },
  };
}

test("分面常量：client = 浏览器白名单；control-plane = 并集（能力 ⊇ 浏览器）", () => {
  assert.deepEqual(serviceAllowlistForScope("client"), [...CLOUD_ATTACHMENT_SERVICE_ALLOWLIST]);
  const controlPlane = serviceAllowlistForScope("control-plane");
  assert.ok(controlPlane);
  for (const channel of CLOUD_ATTACHMENT_SERVICE_ALLOWLIST) {
    assert.ok(controlPlane.includes(channel), `并集必须含浏览器面通道 ${channel}`);
  }
  for (const channel of CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST) {
    assert.ok(controlPlane.includes(channel), `并集必须含控制面面通道 ${channel}`);
  }
  assert.equal(
    controlPlane.length,
    CLOUD_ATTACHMENT_SERVICE_ALLOWLIST.length + CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST.length,
    "两份白名单互不相交（并集 = 两表直和）",
  );
  // 未知 scope：无任何允许集 → open 必然被拒。
  assert.equal(serviceAllowlistForScope(undefined), null);
  assert.equal(serviceAllowlistForScope("browser" as never), null);
});

test("client 分面：浏览器白名单通道可用，控制面专用 sync 通道被拒（本地服务从未被调用）", async () => {
  const harness = createHarness();
  try {
    const channel = harness.open("client");
    // 浏览器面通道照旧可用（既有行为不变）。
    assert.deepEqual(await channel(ServiceChannels.File).call("readFile", { path: "/tmp/x" }), {
      command: "readFile",
      ok: true,
    });
    assert.deepEqual(harness.forChannel(ServiceChannels.File).calls, ["readFile"]);

    // 控制面专用通道（mcp-sync）在 client 分面不注册：调用被拒（未注册 → 超时错误），
    // 且本地 mcp-sync 服务一次都没被调用——白名单是唯一注册面，没有第二条回落路径。
    await assert.rejects(
      () => channel(ServiceChannels.McpSync).call("importMcpServers", [{ name: "x" }]),
      /Unknown channel|timed out/,
      "client 流不得触达控制面专用 sync 通道",
    );
    assert.deepEqual(
      harness.forChannel(ServiceChannels.McpSync).calls,
      [],
      "被拒的调用不得落到本地 sync 服务",
    );
  } finally {
    harness.dispose();
  }
});

test("control-plane 分面：6 个控制面通道与浏览器面 zcode-agent 都通过（并集语义）", async () => {
  const harness = createHarness();
  try {
    const channel = harness.open("control-plane");
    // 控制面专用 6 通道（14 §4.2 的 CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST）。
    for (const name of CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST) {
      assert.deepEqual(
        await channel(name).call("ping", []),
        { command: "ping", ok: true },
        `control-plane 流必须能调 ${name}`,
      );
      assert.deepEqual(harness.forChannel(name).calls, ["ping"]);
    }
    // 并集语义：命令投递走的 zcode-agent 属浏览器面，控制面流同样可达（14 §4.2 定夺）。
    assert.deepEqual(await channel(ServiceChannels.ZCodeAgent).call("query", []), {
      command: "query",
      ok: true,
    });
    assert.deepEqual(harness.forChannel(ServiceChannels.ZCodeAgent).calls, ["query"]);
  } finally {
    harness.dispose();
  }
});

test("未知通道与 denylist 通道在两侧分面都被拒（不注册/不代理）", async () => {
  const harness = createHarness();
  try {
    // denylist（账号域/host 本体能力）对两面都生效：显式拒绝，且本地通道未被调用。
    for (const scope of ["client", "control-plane"] as const) {
      const channel = harness.open(scope);
      await assert.rejects(
        () => channel(ServiceChannels.Credential).call("list", []),
        /not available/,
        `${scope} 流不得触达 denylist 通道`,
      );
      assert.deepEqual(harness.forChannel(ServiceChannels.Credential).calls, []);
    }
    // 两份白名单都没有的名字：同样不注册、不代理（挂起至超时错误）。
    const channel = harness.open("control-plane");
    await assert.rejects(
      () => channel("totally-unknown-channel").call("x", []),
      /Unknown channel|timed out/,
      "未知通道不得被代理",
    );
  } finally {
    harness.dispose();
  }
});

test("未知 serviceScope 的 rpc.open 被拒：不建会话（后续 request 不产生任何响应）", () => {
  const harness = createHarness();
  try {
    // 未知 scope（未经 shared schema 校验的原始帧兜底）：open 被拒、不建会话。
    harness.open("browser");
    assert.deepEqual(
      harness.outbound
        .splice(0)
        .filter((frame) => frame.type === "rpc.response" || frame.type === "rpc.close"),
      [],
      "被拒的 rpc.open 不得产生任何会话响应（Initialize 也不会发出）",
    );
    // 未 open 的流：request 帧按既有行为丢弃（挂起语义，不由 relay 伪造响应）。
    harness.relay.handle(
      {
        protocolVersion: 1,
        type: "rpc.request",
        runId: RUN_ID,
        runGeneration: 1,
        connectionEpoch: CONTEXT.connectionEpoch,
        streamId: "stream-1",
        payload: "",
      } as CloudRpcFrame,
      CONTEXT,
    );
    assert.deepEqual(harness.outbound.splice(0), [], "未 open 的流不得转发任何字节");
  } finally {
    harness.dispose();
  }
});

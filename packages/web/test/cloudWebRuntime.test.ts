/**
 * W9 云启动编排用例（specs/cloud-agent/modules/W9 §3/§4/§6；12 §4/§5；03 §7.1；04 §2）。
 *
 * 断言调用目标（W10 验收前置）：账号域 base 只走同源 host `/ws`，执行域只走当前 Run 的
 * `/ws/cloud/tasks/:taskId`；任何失败都停在失败面，不出现「回落本机 / 开发机」的分支。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  createCloudClient,
  cloudTransportError,
  type CloudAttachConnector,
  type CloudClient,
  type CloudHttpAuth,
  type CreateCloudClientOptions,
} from "@zcode/client";
import { CLOUD_SERVICE_CHANNEL_FACETS, type CapabilitiesResponse } from "@zcode/shared";
import { bootstrapCloudRuntime } from "../src/cloud/cloudRuntime.js";
import { createCloudAttachmentProvider } from "../src/cloud/cloudAttachment.js";
import type {
  CloudUiBootstrapInput,
  CloudUiComposition,
  HostServiceAccessor,
} from "../src/cloud/cloudUi.js";

const RUNTIME_ORIGIN = "https://cloud.example.com";
const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";

const CLOUD_CAPABILITIES: CapabilitiesResponse = {
  principalId: "3c8a6d2b-0e4f-4a9b-8c1d-2e3f4a5b6c7d",
  mode: "cloud",
  providers: [],
  features: ["durable-input", "replayable-history"],
  protocolVersion: 1,
  taskOwnedAttachments: false,
};

interface ClientCall {
  readonly origin: string;
  readonly auth: CloudHttpAuth | undefined;
  readonly taskId: string | undefined;
  readonly raw: CreateCloudClientOptions;
}

const BOOTSTRAP: CloudUiBootstrapInput = {
  controlPlaneOrigin: RUNTIME_ORIGIN,
  taskId: TASK_ID,
};

/** W8 组合的替身：只有接缝形状，渲染由 W8 的真实 provider 负责。 */
function fakeUi(bootstrap: CloudUiBootstrapInput | null = BOOTSTRAP): CloudUiComposition {
  return {
    createBootstrap: () => bootstrap,
    WorkspaceProvider: (() => null) as unknown as CloudUiComposition["WorkspaceProvider"],
  };
}

function createHarness(options?: {
  getCapabilities?: (() => Promise<CapabilitiesResponse>) | undefined;
  connectError?: Error | undefined;
}) {
  const clientCalls: ClientCall[] = [];
  const channelUrls: string[] = [];
  const attachCloses: string[] = [];
  const channelCloses: string[] = [];
  const hostAccessor = { kind: "host-accessor" } as unknown as HostServiceAccessor;

  const createClient = (createOptions: CreateCloudClientOptions): CloudClient => {
    clientCalls.push({
      origin: createOptions.origin,
      auth: createOptions.auth,
      taskId: createOptions.taskId,
      raw: createOptions,
    });
    return {
      origin: createOptions.origin,
      controlPlane: {
        origin: createOptions.origin,
        getCapabilities: options?.getCapabilities ?? (() => Promise.resolve(CLOUD_CAPABILITIES)),
      } as unknown as CloudClient["controlPlane"],
      attach: {
        taskId: createOptions.taskId,
        connect: () => Promise.resolve(),
        close: () => attachCloses.push(createOptions.taskId ?? "host-client"),
        onDidChangeState: () => ({ dispose: () => {} }),
      } as unknown as CloudClient["attach"],
    };
  };

  const connectHostChannel = (wsUrl: string) => {
    channelUrls.push(wsUrl);
    if (options?.connectError) {
      return Promise.reject(options.connectError);
    }
    return Promise.resolve({
      accessor: hostAccessor,
      close: () => channelCloses.push(wsUrl),
    });
  };

  return {
    clientCalls,
    channelUrls,
    attachCloses,
    channelCloses,
    hostAccessor,
    createClient,
    connectHostChannel,
  };
}

test("call targets: account domain dials host /ws, execution domain dials the task attachment", async () => {
  const attachmentFacet = CLOUD_SERVICE_CHANNEL_FACETS.taskAttachment;
  const expectedAttachmentUrl = `wss://cloud.example.com${attachmentFacet?.upgradePath.replace(
    ":taskId",
    TASK_ID,
  )}`;
  assert.equal(expectedAttachmentUrl, `wss://cloud.example.com/ws/cloud/tasks/${TASK_ID}`);

  // 执行域：真实 SDK 客户端 + 记录型 connector（SDK 决定路径，W9 只给 taskId）。
  const dialed: string[] = [];
  const connector: CloudAttachConnector = (input) => {
    dialed.push(input.url);
    return Promise.reject(new Error("no socket in test"));
  };
  const provider = createCloudAttachmentProvider({
    origin: RUNTIME_ORIGIN,
    createClient: (options) => createCloudClient({ ...options, connector }),
  });
  const accessor = await provider.open(TASK_ID);
  // 连不上就是 unavailable：不造空 channel，也不回落本机执行域。
  assert.equal(accessor, null);
  assert.deepEqual(dialed, [expectedAttachmentUrl]);

  // 账号域：启动流程只连同源 host `/ws`。
  const harness = createHarness();
  const result = await bootstrapCloudRuntime(
    { mode: "cloud", origin: RUNTIME_ORIGIN, taskId: TASK_ID },
    {
      ui: fakeUi(),
      createClient: harness.createClient,
      connectHostChannel: harness.connectHostChannel,
    },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(harness.channelUrls, ["wss://cloud.example.com/ws"]);
  assert.notEqual(harness.channelUrls[0], expectedAttachmentUrl);
});

test("cloud boot probes capabilities, then connects the host /ws accessor and hands it to W8", async () => {
  const harness = createHarness();
  const result = await bootstrapCloudRuntime(
    { mode: "cloud", origin: RUNTIME_ORIGIN, token: "lite-token-value", taskId: TASK_ID },
    {
      ui: fakeUi(),
      createClient: harness.createClient,
      connectHostChannel: harness.connectHostChannel,
    },
  );

  assert.equal(result.ok, true);
  // 客户端：显式 origin + 同源 cookie 鉴权，token 正文不下发给客户端（12 §5、03 §3）。
  assert.deepEqual(harness.clientCalls[0]?.auth, { mode: "cookie" });
  assert.equal(harness.clientCalls[0]?.origin, RUNTIME_ORIGIN);
  assert.equal(harness.clientCalls[0]?.taskId, TASK_ID);
  assert.equal("token" in (harness.clientCalls[0]?.raw ?? {}), false);
  assert.equal(result.ok && result.runtime.hostAccessor, harness.hostAccessor);
  assert.deepEqual(result.ok ? result.runtime.bootstrap : null, BOOTSTRAP);

  if (result.ok) {
    result.runtime.dispose();
  }
  // dispose 收掉 host 通道与未使用的 attachment，不留悬挂连接。
  assert.deepEqual(harness.channelCloses, ["wss://cloud.example.com/ws"]);
  assert.deepEqual(harness.attachCloses, [TASK_ID]);
});

test("attachment provider opens one cookie-authenticated client per task and releases it locally", async () => {
  const harness = createHarness();
  const provider = createCloudAttachmentProvider({
    origin: RUNTIME_ORIGIN,
    createClient: harness.createClient,
  });

  const accessor = await provider.open(TASK_ID);
  assert.equal(accessor?.taskId, TASK_ID);
  assert.deepEqual(harness.clientCalls[0]?.auth, { mode: "cookie" });
  assert.equal(harness.clientCalls[0]?.taskId, TASK_ID);
  assert.equal(harness.clientCalls[0]?.origin, RUNTIME_ORIGIN);

  provider.close(TASK_ID);
  assert.deepEqual(harness.attachCloses, [TASK_ID]);
});

test("failures are classified and never fall back to a local workspace bootstrap", async () => {
  const transport = createHarness({
    getCapabilities: () => Promise.reject(cloudTransportError("fetch failed")),
  });
  const unreachable = await bootstrapCloudRuntime(
    { mode: "cloud", origin: RUNTIME_ORIGIN },
    {
      ui: fakeUi(),
      createClient: transport.createClient,
      connectHostChannel: transport.connectHostChannel,
    },
  );
  assert.equal(!unreachable.ok && unreachable.failure.reason, "backend-unreachable");
  // 探测失败后不再去连 host，更不会走本机入口。
  assert.deepEqual(transport.channelUrls, []);

  const mismatched = createHarness({
    getCapabilities: () => Promise.resolve({ ...CLOUD_CAPABILITIES, mode: "local" }),
  });
  const notConfigured = await bootstrapCloudRuntime(
    { mode: "cloud", origin: RUNTIME_ORIGIN },
    {
      ui: fakeUi(),
      createClient: mismatched.createClient,
      connectHostChannel: mismatched.connectHostChannel,
    },
  );
  assert.equal(!notConfigured.ok && notConfigured.failure.reason, "not-configured");
  assert.deepEqual(mismatched.channelUrls, []);

  const noChannel = createHarness({ connectError: new Error("websocket upgrade failed") });
  const channelFailed = await bootstrapCloudRuntime(
    { mode: "cloud", origin: RUNTIME_ORIGIN },
    {
      ui: fakeUi(),
      createClient: noChannel.createClient,
      connectHostChannel: noChannel.connectHostChannel,
    },
  );
  assert.equal(!channelFailed.ok && channelFailed.failure.reason, "host-channel-unavailable");
});

test("an unbuildable session route or an unconstructable client fails loudly instead of guessing", async () => {
  const withoutRoute = createHarness();
  const noRoute = await bootstrapCloudRuntime(
    { mode: "cloud", origin: RUNTIME_ORIGIN },
    {
      ui: fakeUi(null),
      createClient: withoutRoute.createClient,
      connectHostChannel: withoutRoute.connectHostChannel,
    },
  );
  assert.equal(!noRoute.ok && noRoute.failure.reason, "bootstrap-unavailable");
  assert.deepEqual(withoutRoute.channelCloses, ["wss://cloud.example.com/ws"]);

  const harness = createHarness();
  const result = await bootstrapCloudRuntime(
    { mode: "cloud", origin: RUNTIME_ORIGIN },
    {
      ui: fakeUi(),
      createClient: () => {
        throw new Error("cloud origin must use http(s)");
      },
      connectHostChannel: harness.connectHostChannel,
    },
  );
  assert.equal(!result.ok && result.failure.reason, "not-configured");
  assert.deepEqual(harness.channelUrls, []);
});

/**
 * host `/ws` 通道的真实链路用例
 * （specs/cloud-agent/modules/W5-cloud-entry.md §6「host 通道」与「边界」；03 §7.1、CP-01）。
 *
 * 用真实 HTTP + WebSocket 客户端跑：`?token=` lite-token 放行 → 账号域 RPC 成功；
 * 同一连接上请求本机执行域频道（file/terminal/agent）被拒绝；`/ws/host`
 * （trusted-host-relay）在云入口根本不存在。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelClient, SocketProtocol, type IChannel } from "@zcode/rpc";
import {
  IFileService,
  ISettingService,
  ITerminalService,
  IZCodeAgentService,
  ServiceCollection,
} from "@zcode/services";
import WebSocket from "ws";
import {
  startCloudServer,
  type CloudControlPlane,
  type CloudServerHandle,
} from "../src/cloud/adapters/entry-cloud-server.js";
import type { CloudEntryConfig } from "../src/cloud/adapters/entry-cloud-config.js";
import type { CloudDeploymentSecrets } from "../src/cloud/adapters/entry-cloud-secrets.js";
import type { SandboxDriverRegistryPort } from "../src/cloud/app/ports/sandboxDriverRegistryPort.js";
import { wrapWebSocket } from "../src/rpcChannelServer.js";

const AUTH_TOKEN = "cloud-host-channel-token";

/** 注入用部署秘密；秘密读取本身由 `cloudEntryConfig.test.ts` 覆盖（W4 loader）。 */
function testSecrets(): CloudDeploymentSecrets {
  return {
    authToken: AUTH_TOKEN,
    principalId: "deployment-principal",
    describe: () => ({
      principalId: "deployment-principal",
      authMode: "token",
      authToken: "configured",
      credentialSecret: "absent",
      gitHubApp: "absent",
    }),
  };
}

const fakeRegistry: SandboxDriverRegistryPort = {
  resolve: async () => null,
  listProviders: async () => [],
};

function idleLoop(name: string) {
  return { name, start: () => {}, stop: async () => {} };
}

function createControlPlane(): CloudControlPlane {
  return {
    principalId: "deployment-principal",
    registerRoutes: () => {},
    loops: { delivery: idleLoop("delivery"), lifecycle: idleLoop("lifecycle") },
    close: async () => {},
  };
}

function createHostServices(): ServiceCollection {
  const setting = { get: async () => ({ locale: "en-US" }), update: async () => undefined };
  const file = { readFile: async () => "deployment-machine-secret" };
  const terminal = { create: async () => ({ terminalId: "t" }) };
  const agent = { sendCommand: async () => ({ accepted: true }) };
  return new ServiceCollection()
    .register(ISettingService, setting as unknown as ISettingService)
    .register(IFileService, file as unknown as IFileService)
    .register(ITerminalService, terminal as unknown as ITerminalService)
    .register(IZCodeAgentService, agent as unknown as IZCodeAgentService);
}

async function startHarness(webDir?: string): Promise<{
  handle: CloudServerHandle;
  dataDir: string;
  baseUrl: string;
}> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cloud-host-channel-"));
  const config: CloudEntryConfig = {
    mode: "cloud",
    authMode: "token",
    publicOrigin: "http://127.0.0.1:0",
    listenPort: 0,
    dataDir,
    providers: ["e2b"],
    allowUnverifiedProviders: [],
    maxConcurrentRuns: 1,
    ...(webDir ? { webDir } : {}),
  };
  const handle = await startCloudServer({
    config,
    secrets: testSecrets(),
    drivers: fakeRegistry,
    hostServices: createHostServices(),
    controlPlane: createControlPlane(),
    listenPort: 0,
    listenHost: "127.0.0.1",
  });
  return { handle, dataDir, baseUrl: `http://127.0.0.1:${handle.port}` };
}

async function connectChannel(url: string): Promise<{ socket: WebSocket; client: ChannelClient }> {
  const socket = new WebSocket(url);
  // 协议栈必须在 open 之前订阅：upgrade 响应与 ChannelServer 的 Initialize 帧可能
  // 落在同一个 tick，等 open 之后再订阅会丢掉初始化帧（测试客户端专有约束）。
  const client = new ChannelClient(new SocketProtocol(wrapWebSocket(socket)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return { socket, client };
}

function callChannel(client: ChannelClient, channelName: string) {
  return client.getChannel<IChannel>(channelName);
}

test("云 host /ws：经 ?token= 完成一次账号域 RPC，同一连接上执行域频道被拒绝", async () => {
  const { handle, dataDir, baseUrl } = await startHarness();
  const wsUrl = `ws://127.0.0.1:${handle.port}/ws?token=${AUTH_TOKEN}`;
  const { socket, client } = await connectChannel(wsUrl);
  try {
    // 账号域：setting 是 host 自带能力，零新增装配即可用（12 §4）。
    const setting = callChannel(client, ISettingService.channelName);
    assert.deepEqual(await setting.call("get"), { locale: "en-US" });

    // 执行域：立即得到结构化拒绝，而不是挂起或落到部署机文件系统（03 §2、CP-01）。
    for (const descriptor of [IFileService, ITerminalService, IZCodeAgentService]) {
      const execution = callChannel(client, descriptor.channelName);
      await assert.rejects(
        () => execution.call("readFile", {}),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes("not available in cloud mode") &&
          (error as Error & { code?: unknown }).code === "unauthorized",
        `${descriptor.channelName} 在云入口必须被拒绝`,
      );
    }

    // 受保护路径鉴权仍然生效：无 token 的 HTTP 请求拿不到任何东西。
    const unauthorized = await fetch(`${baseUrl}/api/server-info`, { cache: "no-store" });
    assert.equal(unauthorized.status, 401);
  } finally {
    socket.close();
    await handle.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("云 host /ws：无 token 的连接被拒；/ws/host（trusted host）在云入口不存在", async () => {
  const { handle, dataDir } = await startHarness();
  try {
    await assert.rejects(
      () => connectChannel(`ws://127.0.0.1:${handle.port}/ws`),
      (error: unknown) => error instanceof Error && /401/.test(error.message),
    );

    await assert.rejects(
      () => connectChannel(`ws://127.0.0.1:${handle.port}/ws/host?token=${AUTH_TOKEN}`),
      (error: unknown) => error instanceof Error && /404/.test(error.message),
      "云客户端不得升格为 trusted-host-relay（03 §3）",
    );
  } finally {
    await handle.close();
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("静态层不吞 /api/* 与 /ws/*：未注册路径 404，SPA 路由回 index.html", async () => {
  const webDir = await mkdtemp(path.join(tmpdir(), "cloud-web-"));
  await writeFile(path.join(webDir, "index.html"), "<html>cloud-spa</html>");
  const { handle, dataDir, baseUrl } = await startHarness(webDir);
  try {
    const query = `?token=${AUTH_TOKEN}`;
    const spa = await fetch(`${baseUrl}/tasks/whatever${query}`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /cloud-spa/);

    const unknownApi = await fetch(`${baseUrl}/api/cloud/not-registered${query}`);
    assert.equal(unknownApi.status, 404, "静态层不得把 /api/* 变成 index.html");
    assert.doesNotMatch(await unknownApi.text(), /cloud-spa/);

    const unknownWs = await fetch(`${baseUrl}/ws/cloud/not-registered${query}`);
    assert.equal(unknownWs.status, 404, "静态层不得把 /ws/* 变成 index.html");

    // 豁免 lite-token 的 bridge 路径也不例外：普通 GET 不得掉进 SPA fallback。
    const bridgeGet = await fetch(
      `${baseUrl}/ws/cloud/bridge/00000000-0000-4000-8000-0000000000c1`,
    );
    assert.equal(bridgeGet.status, 404);
    assert.doesNotMatch(await bridgeGet.text(), /cloud-spa/);
  } finally {
    await handle.close();
    await rm(dataDir, { recursive: true, force: true });
    await rm(webDir, { recursive: true, force: true });
  }
});

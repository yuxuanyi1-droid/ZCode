/**
 * local 模式回归（specs/cloud-agent/modules/W5-cloud-entry.md §5/§6）：
 * `http.ts` 的 `/ws` 暴露逻辑与 lite-token 校验被抽到 `rpcChannelServer.ts` 后，
 * 本地入口的行为必须与抽取前一致——这是「纯搬移」的行为证据。
 *
 * 逐项核对抽取点：lite-token 三条放行/拒绝路径、`/api/*` 与 `/ws/*` 不被静态层吞掉、
 * `/ws` 普通通道仍以 `web-remote-replayable` 暴露服务、`/ws/host` 仍要求一次性能力票。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ChannelClient, SocketProtocol, type IChannel } from "@zcode/rpc";
import { ISettingService, ServiceCollection } from "@zcode/services";
import { ZCODE_RPC_HOST_CAPABILITY_HEADER } from "@zcode/shared";
import type { Server } from "node:http";
import WebSocket from "ws";
import { createHttpServer } from "../src/http.js";
import { wrapWebSocket } from "../src/rpcChannelServer.js";

const AUTH_TOKEN = "local-regression-token";

function localServices(): ServiceCollection {
  return new ServiceCollection().register(ISettingService, {
    get: async () => ({ locale: "zh-CN" }),
  } as unknown as ISettingService);
}

async function waitForListening(server: Server): Promise<number> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));
  }
  const address = server.address();
  return typeof address === "object" && address ? address.port : 0;
}

async function connectChannel(
  url: string,
  headers?: Record<string, string>,
): Promise<{ socket: WebSocket; client: ChannelClient }> {
  const socket = new WebSocket(url, headers ? { headers } : undefined);
  // 协议栈先于 open 订阅（同 cloudHostChannel 用例）：首帧与 upgrade 响应可能同 tick 到达。
  const client = new ChannelClient(new SocketProtocol(wrapWebSocket(socket)));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  return { socket, client };
}

async function withLocalServer<T>(
  run: (context: { port: number; baseUrl: string; webDir: string; server: Server }) => Promise<T>,
): Promise<T> {
  const webDir = await mkdtemp(path.join(tmpdir(), "cloud-entry-local-web-"));
  await writeFile(path.join(webDir, "index.html"), "<html>local-spa</html>");
  const server = createHttpServer(localServices(), 0, {
    host: "127.0.0.1",
    authToken: AUTH_TOKEN,
    staticRoot: webDir,
    spaFallback: true,
    workspaces: [{ path: "/local/workspace", label: "local" }],
  });
  try {
    const port = await waitForListening(server);
    return await run({ port, baseUrl: `http://127.0.0.1:${port}`, webDir, server });
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(webDir, { recursive: true, force: true });
  }
}

test("local 入口：lite-token 判定与抽取前一致（无 token 401、?token= 下发 cookie、cookie 放行）", async () => {
  await withLocalServer(async ({ baseUrl }) => {
    const denied = await fetch(`${baseUrl}/api/server-info`);
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: "Unauthorized" });

    const allowed = await fetch(`${baseUrl}/api/server-info?token=${AUTH_TOKEN}`);
    assert.equal(allowed.status, 200);
    assert.match(allowed.headers.get("set-cookie") ?? "", /zcode_lite_token=/);
    const info = (await allowed.json()) as {
      capabilities: { desktopContinuous?: boolean };
      workspaces: { path: string }[];
    };
    assert.equal(info.capabilities.desktopContinuous, true);
    assert.deepEqual(info.workspaces, [{ path: "/local/workspace", label: "local" }]);

    const viaCookie = await fetch(`${baseUrl}/api/server-info`, {
      headers: { cookie: `zcode_lite_token=${AUTH_TOKEN}` },
    });
    assert.equal(viaCookie.status, 200);

    const wrongToken = await fetch(`${baseUrl}/api/server-info?token=wrong`);
    assert.equal(wrongToken.status, 401);
  });
});

test("local 入口：/ws 普通通道仍暴露服务（web-remote-replayable），未命中路径仍 404", async () => {
  await withLocalServer(async ({ port, baseUrl }) => {
    const { socket, client } = await connectChannel(
      `ws://127.0.0.1:${port}/ws?token=${AUTH_TOKEN}`,
    );
    try {
      const setting = client.getChannel<IChannel>(ISettingService.channelName);
      assert.deepEqual(await setting.call("get"), { locale: "zh-CN" });
    } finally {
      socket.close();
    }

    await assert.rejects(
      () => connectChannel(`ws://127.0.0.1:${port}/ws`),
      (error: unknown) => error instanceof Error && /401/.test(error.message),
    );

    // 静态层继续不吃 /api/*（SPA fallback 只回 index.html）。
    const unknownApi = await fetch(`${baseUrl}/api/does-not-exist?token=${AUTH_TOKEN}`);
    assert.equal(unknownApi.status, 404);
    assert.doesNotMatch(await unknownApi.text(), /local-spa/);
    const spa = await fetch(`${baseUrl}/tasks/anything?token=${AUTH_TOKEN}`);
    assert.equal(spa.status, 200);
    assert.match(await spa.text(), /local-spa/);

    // `/ws/cloud/bridge/*` 在共享判定里豁免了 lite-token（执行节点自带 run-scoped 鉴权）。
    // 本地入口没有该路由：无 token 打过去应当是 404，而不是 401 或 index.html。
    const bridge = await fetch(`${baseUrl}/ws/cloud/bridge/00000000-0000-4000-8000-0000000000c1`);
    assert.equal(bridge.status, 404);
    assert.doesNotMatch(await bridge.text(), /local-spa/);
  });
});

test("local 入口：/ws/host 仍是一次性能力票保护的受信通道", async () => {
  await withLocalServer(async ({ port, baseUrl }) => {
    await assert.rejects(
      () => connectChannel(`ws://127.0.0.1:${port}/ws/host?token=${AUTH_TOKEN}`),
      (error: unknown) => error instanceof Error && /401/.test(error.message),
      "缺少能力头时必须拒绝",
    );

    const issued = await fetch(`${baseUrl}/api/rpc-host-capability?token=${AUTH_TOKEN}`, {
      method: "POST",
    });
    assert.equal(issued.status, 200);
    const capability = (await issued.json()) as { capability: string };
    assert.ok(capability.capability);

    const { socket, client } = await connectChannel(
      `ws://127.0.0.1:${port}/ws/host?token=${AUTH_TOKEN}`,
      { [ZCODE_RPC_HOST_CAPABILITY_HEADER]: capability.capability },
    );
    try {
      const setting = client.getChannel<IChannel>(ISettingService.channelName);
      assert.deepEqual(await setting.call("get"), { locale: "zh-CN" });
    } finally {
      socket.close();
    }
  });
});

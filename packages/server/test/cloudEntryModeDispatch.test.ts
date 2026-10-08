/**
 * 单一入口的模式分派与本地模式探测端点（specs/cloud-agent/04 §2.1、07 §12 修订记录、W5 §3.1/§4）。
 *
 * 三件事必须成立：
 * 1) `entry-http` 的模式读取是三态的——`local`（含未设置）走本地行为、`cloud` 走云入口、
 *    其它取值 fail-closed 退出（不隐式切 local）；
 * 2) 本地分支**无鉴权**回答 `GET /api/cloud/capabilities`（mode=local、空能力集），
 *    否则 Web 启动探测会把它当成「云入口需要凭据」；
 * 3) 该豁免只作用于这一条探测路径：其余 `/api/cloud/*` 仍由 lite-token 保护，本地分支不装配
 *    任何 cloud 路由。
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";
import { ISettingService, ServiceCollection } from "@zcode/services";
import { createLocalCapabilitiesResponse, localCapabilitiesResponseSchema } from "@zcode/shared";
import type { Server } from "node:http";
import { createHttpServer } from "../src/http.js";
import { readZCodeServerModeFromEnv } from "../src/cloud/adapters/entry-cloud-config.js";

const execFileAsync = promisify(execFile);
const AUTH_TOKEN = "mode-dispatch-token";
const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));

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

test("模式读取三态：未设置/local 为本地，cloud 为云入口，其它取值非法", () => {
  assert.deepEqual(readZCodeServerModeFromEnv({}), { mode: "local" });
  assert.deepEqual(readZCodeServerModeFromEnv({ ZCODE_SERVER_MODE: "  " }), { mode: "local" });
  assert.deepEqual(readZCodeServerModeFromEnv({ ZCODE_SERVER_MODE: "local" }), { mode: "local" });
  assert.deepEqual(readZCodeServerModeFromEnv({ ZCODE_SERVER_MODE: " cloud " }), { mode: "cloud" });
  // 非法取值不隐式当 local（W5 §5）：由入口 fail-closed 退出，取值原样报出来便于排障。
  assert.deepEqual(readZCodeServerModeFromEnv({ ZCODE_SERVER_MODE: "clod" }), { invalid: "clod" });
  assert.deepEqual(readZCodeServerModeFromEnv({ ZCODE_SERVER_MODE: "CLOUD" }), {
    invalid: "CLOUD",
  });
});

test("本地模式：无鉴权回答模式探测端点，且不暴露任何 cloud 路由", async () => {
  const webDir = await mkdtemp(path.join(tmpdir(), "cloud-entry-mode-web-"));
  await writeFile(path.join(webDir, "index.html"), "<html>local-spa</html>");
  const server = createHttpServer(localServices(), 0, {
    host: "127.0.0.1",
    authToken: AUTH_TOKEN,
    staticRoot: webDir,
    spaFallback: true,
  });
  try {
    const port = await waitForListening(server);
    const baseUrl = `http://127.0.0.1:${port}`;

    // 探测：无 token、无 cookie 也必须 200（否则客户端只能把它当「云入口要凭据」）。
    const probe = await fetch(`${baseUrl}/api/cloud/capabilities`, { cache: "no-store" });
    assert.equal(probe.status, 200);
    const payload: unknown = await probe.json();
    const parsed = localCapabilitiesResponseSchema.safeParse(payload);
    assert.equal(parsed.success, true);
    assert.deepEqual(payload, createLocalCapabilitiesResponse());
    assert.equal(
      localCapabilitiesResponseSchema.safeParse({ ...payload, principalId: "x" }).success,
      false,
    );

    // 带一个错 token 也走同一条无鉴权探测路径（探测不带凭据，凭据只用于握手后的通道）。
    const withWrongToken = await fetch(`${baseUrl}/api/cloud/capabilities?token=wrong`);
    assert.equal(withWrongToken.status, 200);

    // 豁免只作用于探测端点：本地入口没有其他 cloud 路由，且 /api/* 仍要 token。
    const cloudRoute = await fetch(`${baseUrl}/api/cloud/tasks/anything`);
    assert.equal(cloudRoute.status, 401);
    const serverInfo = await fetch(`${baseUrl}/api/server-info`);
    assert.equal(serverInfo.status, 401);
    const serverInfoWithToken = await fetch(`${baseUrl}/api/server-info?token=${AUTH_TOKEN}`);
    assert.equal(serverInfoWithToken.status, 200);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(webDir, { recursive: true, force: true });
  }
});

test("入口分派：非法 ZCODE_SERVER_MODE fail-closed 退出，不启动任何服务", async () => {
  const home = await mkdtemp(path.join(tmpdir(), "cloud-entry-mode-home-"));
  try {
    const failure = await execFileAsync(
      process.execPath,
      ["--import", "tsx", "src/entry-http.ts"],
      {
        cwd: PACKAGE_ROOT,
        env: { ...process.env, ZCODE_SERVER_MODE: "clod", HOME: home },
        timeout: 60_000,
      },
    ).then(
      () => null,
      (error: unknown) => error as { code?: number; stderr?: string; stdout?: string },
    );
    assert.notEqual(failure, null, "非法模式必须以非零码退出");
    assert.equal(failure?.code, 1);
    assert.match(`${failure?.stderr ?? ""}${failure?.stdout ?? ""}`, /mode_invalid/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

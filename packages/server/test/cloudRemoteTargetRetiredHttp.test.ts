// R-04 HTTP 入口回归（specs/cloud-agent/06 §3.1）：
// 直接构造旧 Docker/WSL target 的请求必须稳定返回 remote.targetRetired，
// 且不执行 docker/wsl 命令、不转成 SSH 或本机路径执行。
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { REMOTE_TARGET_RETIRED_ERROR_CODE } from "@zcode/shared";
import { createHttpServer } from "../src/http.js";
import type { ServiceCollection } from "@zcode/services";

// 该测试只覆盖退役拒绝分支：它在任何 services 访问之前返回，因此这里用最小替身，
// 避免为了一个 400 响应装配完整服务集合。
const minimalServices = {
  getOptional: () => undefined,
  get: () => {
    throw new Error("retired target path must not touch services");
  },
} as unknown as ServiceCollection;

async function withServer(run: (baseUrl: string) => Promise<void>): Promise<void> {
  const server = createHttpServer(minimalServices, 0, {
    authRequired: false,
    spaFallback: false,
    // 显式绑定 IPv4，避免 localhost 解析到 ::1 而测试按 127.0.0.1 连接时被拒。
    host: "127.0.0.1",
  });
  await new Promise<void>((resolve) => {
    if (server.listening) {
      resolve();
      return;
    }
    server.once("listening", () => resolve());
  });
  const address = server.address() as AddressInfo;
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("R-04: HTTP 构造 WSL target 返回 remote.targetRetired，不执行远端命令", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/connect-remote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "wsl", distro: "Ubuntu", user: "dev" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: string; retiredKind?: string };
    assert.equal(body.error, REMOTE_TARGET_RETIRED_ERROR_CODE);
    assert.equal(body.retiredKind, "wsl");
  });
});

test("R-04: HTTP 构造 Docker target 返回 remote.targetRetired，不转成 SSH/本地", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/connect-remote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "docker", container: "zcode-dev" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: string; retiredKind?: string };
    assert.equal(body.error, REMOTE_TARGET_RETIRED_ERROR_CODE);
    assert.equal(body.retiredKind, "docker");
  });
});

test("R-04: 非法活跃 target 仍是普通校验失败，不是退役码", async () => {
  await withServer(async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/connect-remote`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "ssh", host: "", username: "" }),
    });
    assert.equal(response.status, 400);
    const body = (await response.json()) as { error?: string };
    assert.match(body.error ?? "", /Invalid request body/);
    assert.equal(body.error?.includes(REMOTE_TARGET_RETIRED_ERROR_CODE), false);
  });
});

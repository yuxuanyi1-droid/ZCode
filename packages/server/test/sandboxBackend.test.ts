import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxConnectOptions } from "@zcode/shared";
import { SandboxBackend } from "../src/remote/sandbox-backend.js";
import { createRemoteBackend } from "../src/remote/create-backend.js";

function buildSandboxTarget(overrides?: Partial<SandboxConnectOptions>): SandboxConnectOptions {
  return {
    kind: "sandbox",
    provider: "modal",
    sandboxId: "sbx-42",
    ssh: { transport: { kind: "tcp", host: "127.0.0.1", port: 2222 }, username: "dev" },
    ...overrides,
  };
}

test("createRemoteBackend dispatches a sandbox target to SandboxBackend", async () => {
  const backend = await createRemoteBackend(buildSandboxTarget());

  assert.ok(backend instanceof SandboxBackend);
  assert.equal(backend.provider, "modal");
  assert.equal(backend.sandboxId, "sbx-42");
  // 断开事件必须透传，否则上层会把半开连接当成存活连接。
  assert.equal(typeof backend.onDidDisconnect, "function");

  backend.dispose();
});

test("SandboxBackend never exposes a sandbox-destroying API (Plan A: lifecycle belongs to the provisioner)", async () => {
  const backend = (await createRemoteBackend(buildSandboxTarget())) as unknown as Record<
    string,
    unknown
  >;

  // 沙箱由外部 provisioner 创建/销毁；后端一旦长出 destroy/kill 这类方法，
  // 上层就可能在重连补偿路径上误删沙箱。这里把「不存在」钉成契约。
  for (const forbidden of ["destroy", "destroyAndWait", "kill", "terminate", "stop", "remove"]) {
    assert.equal(forbidden in backend, false, `SandboxBackend must not expose ${forbidden}()`);
  }

  // WSL 专属的可选方法不应泄漏到 sandbox 后端。
  assert.equal("resolveRuntimeProxy" in backend, false);
  assert.equal("disposeAndWait" in backend, false);

  backend.dispose();
});

test("SandboxBackend.dispose only tears down the local connection and is idempotent", async () => {
  const backend = await createRemoteBackend(buildSandboxTarget());

  // 从未连接过就 dispose 也必须安全：重连补偿会在握手失败后直接回收后端。
  backend.dispose();
  backend.dispose();
});

test("createRemoteBackend reads the attach private key relative to the home directory", async () => {
  // 不存在的 key 必须让创建失败，而不是静默降级成无凭据连接。
  await assert.rejects(
    createRemoteBackend(
      buildSandboxTarget({
        ssh: {
          transport: { kind: "tcp", host: "127.0.0.1" },
          username: "dev",
          privateKeyPath: "/definitely/not/a/real/key",
        },
      }),
    ),
  );
});

test("createRemoteBackend prefers the inline private key over privateKeyPath", async () => {
  // provisioner 的一次性私钥只能内联下发；此时即使同时带了一个不存在（或本机不适用）的
  // privateKeyPath，也不能去读盘失败——否则远端沙箱永远连不上。
  const backend = await createRemoteBackend(
    buildSandboxTarget({
      ssh: {
        transport: { kind: "tcp", host: "127.0.0.1" },
        username: "dev",
        privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nnot-a-real-key\n",
        privateKeyPath: "/definitely/not/a/real/key",
      },
    }),
  );

  assert.ok(backend instanceof SandboxBackend);
  backend.dispose();
});

test("createRemoteBackend builds a WebSocket-transport sandbox without dialing at construction time", async () => {
  // E2B 只有 WSS 入口。构造阶段不能真的去握手：地址不存在也要能建出后端，
  // 由第一次 exec/detect 才触发连接（否则连接向导会在无法预检的地址上直接失败）。
  const backend = await createRemoteBackend(
    buildSandboxTarget({
      provider: "e2b",
      sandboxId: "sbx-ws",
      ssh: {
        transport: { kind: "websocket", url: "wss://8081-sbx.e2b.app" },
        username: "dev",
      },
    }),
  );

  assert.ok(backend instanceof SandboxBackend);
  assert.equal(backend.provider, "e2b");
  backend.dispose();
});

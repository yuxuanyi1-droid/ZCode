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
    ssh: { host: "127.0.0.1", port: 2222, username: "dev" },
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
          host: "127.0.0.1",
          username: "dev",
          privateKeyPath: "/definitely/not/a/real/key",
        },
      }),
    ),
  );
});

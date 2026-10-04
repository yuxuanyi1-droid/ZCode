import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxConnectOptions } from "../src/remoteTarget.js";
import { stripRemoteTargetSecrets } from "../src/remoteTarget.js";
import { buildRemoteEnvironmentKey } from "../src/remoteEnvironmentKey.js";
import { buildRemoteWorkspaceIdentity } from "../src/remote-workspace-identity.js";
import { remoteTargetSchema } from "../src/validation.js";

function buildSandboxTarget(overrides?: Partial<SandboxConnectOptions>): SandboxConnectOptions {
  return {
    kind: "sandbox",
    provider: "modal",
    sandboxId: "sbx-42",
    ssh: { host: "10.0.0.7", port: 2222, username: "dev" },
    ...overrides,
  };
}

test("sandbox environment key is provider + sandboxId, independent of the ssh attach", () => {
  const key = buildRemoteEnvironmentKey(buildSandboxTarget());

  assert.equal(key, "sandbox:modal:sbx-42");
  // attach 换个端口不该换出新的 Environment：同一个沙箱的唯一身份是 provider + sandboxId。
  assert.equal(
    buildRemoteEnvironmentKey(buildSandboxTarget({ ssh: { host: "10.0.0.9", username: "dev" } })),
    key,
  );
});

test("sandbox workspace identity carries provider and sandboxId in the authority segment", () => {
  assert.equal(
    buildRemoteWorkspaceIdentity("/workspace/repo", buildSandboxTarget()),
    "remote:sandbox:modal:sbx-42:/workspace/repo",
  );
  // 不同 provider 的同名 sandboxId 必须是不同 identity，否则历史会话会串。
  assert.notEqual(
    buildRemoteWorkspaceIdentity("/workspace/repo", buildSandboxTarget({ provider: "e2b" })),
    buildRemoteWorkspaceIdentity("/workspace/repo", buildSandboxTarget()),
  );
});

test("stripRemoteTargetSecrets removes secrets nested under ssh and keeps the attach entry", () => {
  const stripped = stripRemoteTargetSecrets(
    buildSandboxTarget({
      ssh: {
        host: "10.0.0.7",
        port: 2222,
        username: "dev",
        password: "hunter2",
        privateKeyPassphrase: "passphrase",
      },
    }),
  );

  assert.equal(stripped.kind, "sandbox");
  assert.equal("password" in stripped, false);
  if (stripped.kind === "sandbox") {
    assert.equal("password" in stripped.ssh, false);
    assert.equal("privateKeyPassphrase" in stripped.ssh, false);
    assert.equal(stripped.ssh.host, "10.0.0.7");
    assert.equal(stripped.ssh.port, 2222);
    assert.equal(stripped.ssh.username, "dev");
  }
});

test("sandbox target schema accepts an attach entry without credentials", () => {
  const parsed = remoteTargetSchema.parse({
    kind: "sandbox",
    provider: "daytona",
    sandboxId: "ws_01.abc-2",
    ssh: { host: "sandbox.internal", username: "root" },
  });

  assert.equal(parsed.kind, "sandbox");
});

test("sandbox target schema rejects an unknown provider", () => {
  const result = remoteTargetSchema.safeParse({
    kind: "sandbox",
    provider: "fly",
    sandboxId: "sbx-42",
    ssh: { host: "10.0.0.7", username: "dev" },
  });

  assert.equal(result.success, false);
});

test("sandbox target schema rejects a sandboxId smuggling a separator", () => {
  // sandboxId 会进 identity/env key 的冒号分段，也可能拼进 URL 路径段：
  // 允许 ':' 或 '/' 会让不同沙箱塌缩成同一个 key。
  for (const sandboxId of ["a:b", "a/b", ""]) {
    const result = remoteTargetSchema.safeParse({
      kind: "sandbox",
      provider: "modal",
      sandboxId,
      ssh: { host: "10.0.0.7", username: "dev" },
    });

    assert.equal(result.success, false, `expected sandboxId ${JSON.stringify(sandboxId)} to fail`);
  }
});

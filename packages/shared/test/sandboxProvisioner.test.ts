import assert from "node:assert/strict";
import test from "node:test";
import { toSandboxConnectOptions } from "../src/sandboxProvisioner.js";
import { sandboxProvisionRequestSchema, sandboxProvisionResultSchema } from "../src/validation.js";

function buildProvisionRequest(overrides?: Record<string, unknown>) {
  return {
    provider: "modal",
    repository: { owner: "yuxuanyi1-droid", name: "ZCode" },
    branch: "main",
    ...overrides,
  };
}

test("provision request accepts a nested GitLab-style owner", () => {
  const parsed = sandboxProvisionRequestSchema.parse(
    buildProvisionRequest({ repository: { owner: "group/subgroup", name: "repo" } }),
  );

  assert.equal(parsed.repository.owner, "group/subgroup");
});

test("provision request rejects a repository name that is not a single path segment", () => {
  // name 是 checkout 目录名，含 "/" 会逃出 workspace 根。
  const result = sandboxProvisionRequestSchema.safeParse(
    buildProvisionRequest({ repository: { owner: "owner", name: "a/b" } }),
  );

  assert.equal(result.success, false);
});

test("provision request requires a branch and rejects an unknown provider", () => {
  assert.equal(
    sandboxProvisionRequestSchema.safeParse(buildProvisionRequest({ branch: "" })).success,
    false,
  );
  assert.equal(
    sandboxProvisionRequestSchema.safeParse(buildProvisionRequest({ provider: "fly" })).success,
    false,
  );
});

test("provision request only accepts a positive integer sandbox timeout", () => {
  assert.equal(
    sandboxProvisionRequestSchema.safeParse(buildProvisionRequest({ timeoutSeconds: 3600 }))
      .success,
    true,
  );
  for (const timeoutSeconds of [0, -1, 1.5]) {
    assert.equal(
      sandboxProvisionRequestSchema.safeParse(buildProvisionRequest({ timeoutSeconds })).success,
      false,
      `expected timeoutSeconds ${timeoutSeconds} to fail`,
    );
  }
});

test("provision result requires an attach entry and a workspace path", () => {
  const parsed = sandboxProvisionResultSchema.parse({
    sandboxId: "sbx-42",
    ssh: { transport: { kind: "tcp", host: "10.0.0.7", port: 2222 }, username: "dev" },
    workspacePath: "/workspace/ZCode",
  });

  assert.equal(parsed.workspacePath, "/workspace/ZCode");
  assert.equal(
    sandboxProvisionResultSchema.safeParse({
      sandboxId: "sbx-42",
      ssh: { transport: { kind: "tcp", host: "10.0.0.7" }, username: "dev" },
    }).success,
    false,
  );
});

test("provision result rejects a sandboxId that breaks the identity key", () => {
  // 外部服务塞进来的 id 也必须过同一道闸；否则它可以直接污染 workspace identity。
  const result = sandboxProvisionResultSchema.safeParse({
    sandboxId: "modal:sbx-42",
    ssh: { transport: { kind: "tcp", host: "10.0.0.7" }, username: "dev" },
    workspacePath: "/workspace/ZCode",
  });

  assert.equal(result.success, false);
});

test("toSandboxConnectOptions takes the provider from the request and copies the attach entry", () => {
  const result = {
    sandboxId: "sbx-42",
    ssh: { transport: { kind: "tcp", host: "10.0.0.7", port: 2222 }, username: "dev" },
    workspacePath: "/workspace/ZCode",
  };

  const target = toSandboxConnectOptions("e2b", result);

  assert.deepEqual(target, {
    kind: "sandbox",
    provider: "e2b",
    sandboxId: "sbx-42",
    ssh: { transport: { kind: "tcp", host: "10.0.0.7", port: 2222 }, username: "dev" },
  });
  // 必须是拷贝：响应对象此后可能被复用/改写，不能顺着 target 漏进去。
  assert.notEqual(target.ssh, result.ssh);
  // 传输层同样要拷贝，否则后续改写 tunnel 端点会穿透到底层连接。
  assert.notEqual(target.ssh.transport, result.ssh.transport);
});

test("provision result accepts a websocket attach entry and carries the inline one-off key", () => {
  // E2B 的 attach 只能走 WSS，且私钥由 provisioner 每次生成后内联下发（本机没有该文件）。
  const parsed = sandboxProvisionResultSchema.parse({
    sandboxId: "sbx-ws",
    workspacePath: "/workspace/ZCode",
    ssh: {
      transport: { kind: "websocket", url: "wss://8081-sbx.e2b.app" },
      username: "dev",
      privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\n...\n",
    },
  });

  assert.deepEqual(parsed.ssh.transport, { kind: "websocket", url: "wss://8081-sbx.e2b.app" });
  assert.equal(typeof parsed.ssh.privateKey, "string");
});

test("provision result rejects an attach entry with no transport", () => {
  const result = sandboxProvisionResultSchema.safeParse({
    sandboxId: "sbx-42",
    workspacePath: "/workspace/ZCode",
    ssh: { username: "dev" },
  });

  assert.equal(result.success, false);
});

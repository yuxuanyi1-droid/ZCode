import assert from "node:assert/strict";
import test from "node:test";
import type { SandboxProvider, SandboxProvisionRequest } from "@zcode/shared";
import { ProvisionerError } from "../src/errors.js";
import { PROVIDER_MAX_TIMEOUT_SECONDS, provisionSandbox } from "../src/provision.js";
import type {
  ProvisionedSandbox,
  SandboxDriverContext,
  SandboxProviderDriver,
} from "../src/providers/types.js";

interface FakeDriverOptions {
  provider?: SandboxProvider;
  configured?: boolean;
  result?: Partial<ProvisionedSandbox>;
}

function createFakeDriver(options: FakeDriverOptions = {}): {
  driver: SandboxProviderDriver;
  calls: SandboxDriverContext[];
} {
  const calls: SandboxDriverContext[] = [];
  const driver: SandboxProviderDriver = {
    provider: options.provider ?? "modal",
    isConfigured: () => options.configured ?? true,
    async create(ctx) {
      calls.push(ctx);
      return {
        sandboxId: "sandbox-abc123",
        transport: { kind: "tcp", host: "sandbox.modal.run", port: 22 },
        username: "root",
        ...options.result,
      };
    },
  };

  return { driver, calls };
}

function createDeps(driver: SandboxProviderDriver) {
  return {
    drivers: new Map<SandboxProvider, SandboxProviderDriver>([[driver.provider, driver]]),
    gitBaseUrl: "https://github.com",
    log: { info() {}, warn() {} },
  };
}

const request: SandboxProvisionRequest = {
  provider: "modal",
  repository: { owner: "octocat", name: "ZCode" },
  branch: "main",
};

test("provisionSandbox assembles an attachable result with a one-off key", async () => {
  const { driver, calls } = createFakeDriver();

  const result = await provisionSandbox(request, createDeps(driver));

  assert.equal(result.sandboxId, "sandbox-abc123");
  assert.deepEqual(result.ssh.transport, { kind: "tcp", host: "sandbox.modal.run", port: 22 });
  assert.equal(result.ssh.username, "root");
  assert.equal(result.workspacePath, "/workspace/ZCode");
  // 私钥随响应内联下发，公钥写进沙箱——两者必须是同一把。
  assert.match(result.ssh.privateKey ?? "", /BEGIN OPENSSH PRIVATE KEY/);
  assert.match(calls[0]?.publicKey ?? "", /^ssh-ed25519 AAAA/);
});

test("provisionSandbox hands the driver a checkout derived from the git base URL", async () => {
  const { driver, calls } = createFakeDriver();

  await provisionSandbox(request, createDeps(driver));

  assert.equal(calls[0]?.checkout.cloneUrl, "https://github.com/octocat/ZCode.git");
  assert.equal(calls[0]?.checkout.checkoutRef, "main");
  assert.equal(calls[0]?.checkout.detached, false);
});

test("provisionSandbox clamps the requested timeout to the provider limit", async () => {
  const { driver, calls } = createFakeDriver();

  await provisionSandbox(
    { ...request, timeoutSeconds: 10 * 365 * 24 * 60 * 60 },
    createDeps(driver),
  );

  // 请求 10 年但 Modal 上限是 14 天：必须收敛，否则 expiresAt 是谎话。
  assert.equal(calls[0]?.timeoutSeconds, PROVIDER_MAX_TIMEOUT_SECONDS.modal);
});

test("provisionSandbox rejects an unknown provider before touching any driver", async () => {
  const { driver, calls } = createFakeDriver();

  await assert.rejects(
    () => provisionSandbox({ ...request, provider: "nope" as SandboxProvider }, createDeps(driver)),
    (error: unknown) => error instanceof ProvisionerError && error.status === 400,
  );
  assert.equal(calls.length, 0);
});

test("provisionSandbox reports an unconfigured provider as 503, not 500", async () => {
  const { driver, calls } = createFakeDriver({ configured: false });

  await assert.rejects(
    () => provisionSandbox(request, createDeps(driver)),
    (error: unknown) => error instanceof ProvisionerError && error.status === 503,
  );
  assert.equal(calls.length, 0);
});

test("provisionSandbox rejects a workspace path outside /workspace without creating anything", async () => {
  const { driver, calls } = createFakeDriver();

  await assert.rejects(
    () => provisionSandbox({ ...request, workspacePath: "/workspace/../etc" }, createDeps(driver)),
    (error: unknown) => error instanceof ProvisionerError && error.status === 400,
  );
  // 关键：路径校验必须在开沙箱之前失败，不留半成品要清理。
  assert.equal(calls.length, 0);
});

test("provisionSandbox turns an unusable sandbox id into a 502", async () => {
  // ':' 会破坏 remote workspace identity；自检要在发出响应前挡下，而不是让客户端 400。
  const { driver } = createFakeDriver({ result: { sandboxId: "project:123" } });

  await assert.rejects(
    () => provisionSandbox(request, createDeps(driver)),
    (error: unknown) =>
      error instanceof ProvisionerError &&
      error.status === 502 &&
      /unusable sandbox descriptor/.test(error.message),
  );
});

test("provisionSandbox passes through the provider expiry when it has one", async () => {
  const expiresAt = Date.now() + 60_000;
  const { driver } = createFakeDriver({ result: { expiresAt } });

  const result = await provisionSandbox(request, createDeps(driver));

  assert.equal(result.expiresAt, expiresAt);
});

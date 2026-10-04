import assert from "node:assert/strict";
import test from "node:test";
import {
  SANDBOX_HEALTH_PATH,
  SANDBOX_PROVISION_PATH,
  type SandboxProvider,
  type SandboxProvisionRequest,
} from "@zcode/shared";
import { createProvisionerApp } from "../src/server.js";
import type {
  ProvisionedSandbox,
  SandboxDriverContext,
  SandboxProviderDriver,
} from "../src/providers/types.js";

const TOKEN = "s3cret-token";

function createDriver(
  overrides: {
    provider?: SandboxProvider;
    configured?: boolean;
    result?: Partial<ProvisionedSandbox>;
  } = {},
): SandboxProviderDriver {
  return {
    provider: overrides.provider ?? "modal",
    isConfigured: () => overrides.configured ?? true,
    async create(_ctx: SandboxDriverContext): Promise<ProvisionedSandbox> {
      return {
        sandboxId: "sandbox-abc123",
        transport: { kind: "tcp", host: "sandbox.modal.run", port: 22 },
        username: "root",
        ...overrides.result,
      };
    },
  };
}

function createApp(options: { driver?: SandboxProviderDriver; token?: string } = {}) {
  const driver = options.driver ?? createDriver();
  const warnings: Array<Record<string, unknown> | undefined> = [];
  const app = createProvisionerApp({
    drivers: new Map<SandboxProvider, SandboxProviderDriver>([[driver.provider, driver]]),
    gitBaseUrl: "https://github.com",
    ...(options.token ? { token: options.token } : {}),
    log: {
      info() {},
      warn(_message, fields) {
        warnings.push(fields);
      },
    },
  });

  return { app, warnings };
}

const validRequest: SandboxProvisionRequest = {
  provider: "modal",
  repository: { owner: "octocat", name: "ZCode" },
  branch: "main",
};

function provision(
  app: ReturnType<typeof createProvisionerApp>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request(SANDBOX_PROVISION_PATH, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

test("healthz reports each provider and whether it is configured", async () => {
  const { app } = createApp({ driver: createDriver({ configured: false }) });

  const response = await app.request(SANDBOX_HEALTH_PATH);
  const body = (await response.json()) as { ok: boolean; providers: unknown[] };

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(body.providers, [{ provider: "modal", configured: false }]);
});

test("provision returns 201 with the sandbox descriptor", async () => {
  const { app } = createApp();

  const response = await provision(app, validRequest);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 201);
  assert.equal(body.sandboxId, "sandbox-abc123");
  assert.equal(body.workspacePath, "/workspace/ZCode");
  assert.ok(typeof (body.ssh as { privateKey?: string }).privateKey === "string");
});

test("a configured token is required on provision but not on healthz", async () => {
  const { app } = createApp({ token: TOKEN });

  // healthz 是给负载均衡/探针用的，不带凭据也要能答。
  assert.equal((await app.request(SANDBOX_HEALTH_PATH)).status, 200);

  assert.equal((await provision(app, validRequest)).status, 401);
  assert.equal((await provision(app, validRequest, { authorization: "Bearer wrong" })).status, 401);
  assert.equal(
    (await provision(app, validRequest, { authorization: `Bearer ${TOKEN}` })).status,
    201,
  );
});

test("a deployment without a token accepts unauthenticated provision requests", async () => {
  const { app } = createApp();

  assert.equal((await provision(app, validRequest)).status, 201);
});

test("an invalid body is rejected before any provider is contacted", async () => {
  const { app } = createApp();

  assert.equal((await provision(app, { ...validRequest, provider: "nope" })).status, 400);
  assert.equal((await provision(app, "{ not json")).status, 400);
});

test("a provider-level failure is mapped to its status code and logged", async () => {
  const { app, warnings } = createApp({ driver: createDriver({ configured: false }) });

  const response = await provision(app, validRequest);

  assert.equal(response.status, 503);
  assert.equal(warnings.length, 1);
  // 未配置 provider 是预期内错误：告警里不该带堆栈。
  assert.equal("stack" in (warnings[0] ?? {}), false);
});

test("an unexpected error leaks no detail to the caller but keeps it in the log", async () => {
  const exploding: SandboxProviderDriver = {
    provider: "modal",
    isConfigured: () => true,
    create: async () => {
      throw new Error("/srv/secret/path exploded");
    },
  };
  const { app, warnings } = createApp({ driver: exploding });

  const response = await provision(app, validRequest);
  const body = (await response.json()) as { error: string };

  assert.equal(response.status, 500);
  assert.doesNotMatch(body.error, /secret/);
  assert.match(String(warnings[0]?.message), /exploded/);
  assert.equal(typeof warnings[0]?.stack, "string");
});

test("unknown routes answer 404 as JSON", async () => {
  const { app } = createApp();

  const response = await app.request("/nope");

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "not found" });
});

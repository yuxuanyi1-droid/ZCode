/**
 * 沙箱运行时账号设置用例（specs/cloud-agent/01 §4.3/§5.1 修订 2026-10-08、12 §2 修订）。
 *
 * 覆盖三段：
 * 1. host 端口解析矩阵：设置覆盖 / env 基线 / min 收敛 / key 回退顺序 / 读失败回落；
 * 2. capabilities 投影：`apiKeyConfigured` 与 env 核实上限透出（不暴露 key 本体）；
 * 3. driver 装配胶水：binding context 接端口后 create 按解析值发请求（key 换源、
 *    超时收敛），能力声明保持静态 env 核实值。
 *
 * 全部走 fake services / fake fetch，不发起任何真实网络请求或数据目录写入。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  ICredentialService,
  ISettingService,
  type ServiceCollection,
  type ServiceDescriptor,
} from "@zcode/services";
import type { AppSettings } from "@zcode/shared";
import type { CloudAdapterLogger } from "../src/cloud/adapters/sandbox/adapterError.js";
import { createE2bSandboxDriver } from "../src/cloud/adapters/sandbox/e2bDriver.js";
import {
  createSandboxDriverBindings,
  type SandboxDriverBindingContext,
} from "../src/cloud/adapters/sandbox/providers.js";
import {
  createHostSandboxRuntimeSettings,
  type HostSandboxRuntimeSettingsOptions,
} from "../src/cloud/adapters/sandbox/sandboxRuntimeSettings.js";
import { assembleCloudControlPlane } from "../src/cloud/app/assembleCloudControlPlane.js";
import type {
  EffectiveSandboxRuntimeConfig,
  SandboxRuntimeSettingsPort,
} from "../src/cloud/app/ports/sandboxRuntimeSettingsPort.js";
import type { SandboxCreateInput } from "../src/cloud/app/ports/sandboxDriverPort.js";
import type {
  SandboxFetch,
  SandboxFetchResponse,
} from "../src/cloud/adapters/sandbox/sandboxRest.js";
import {
  FakeClock,
  FakeHash,
  FakeIds,
  createFakeAttachmentPort,
  createFakeDriverRegistry,
  createFakeGitHub,
  createFakeOutbox,
  createFakeRuntimeCommands,
  createFakeSandboxDriver,
  createFakeStorage,
} from "./cloudCoreFakes.js";

const NOW = 1_800_000_000_000;

const silentLogger: CloudAdapterLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** 捕获 warn 的 logger：断言「读失败回落 env 基线」确实留了证据。 */
function capturingLogger(): CloudAdapterLogger & { warns: unknown[][] } {
  const warns: unknown[][] = [];
  return {
    debug: () => {},
    info: () => {},
    error: () => {},
    warn: (...args: unknown[]) => {
      warns.push(args);
    },
    warns,
  };
}

// ── fake host 服务图（结构兼容 ServiceCollection，getOptional 按 channel 分发） ──

interface FakeAccountStores {
  settings?: { get(): Promise<AppSettings> };
  credentials?: { load(key: string): Promise<string | null> };
}

function fakeHostServices(stores: FakeAccountStores): ServiceCollection {
  return {
    getOptional: (descriptor: ServiceDescriptor<unknown>) => {
      if (descriptor.channelName === ISettingService.channelName) {
        return stores.settings;
      }
      if (descriptor.channelName === ICredentialService.channelName) {
        return stores.credentials;
      }
      return undefined;
    },
  } as unknown as ServiceCollection;
}

function portOptions(
  stores: FakeAccountStores,
  overrides: Partial<HostSandboxRuntimeSettingsOptions> = {},
): HostSandboxRuntimeSettingsOptions {
  return {
    getServices: () => fakeHostServices(stores),
    envMaxLifetimeSeconds: { e2b: 3600 },
    envApiKeys: { e2b: "env-e2b-key" },
    logger: silentLogger,
    ...overrides,
  };
}

test("端口解析：env 基线 → 生效超时取 env 核实上限，key 取 env 部署值", async () => {
  const port = createHostSandboxRuntimeSettings(
    portOptions({
      settings: { get: async () => ({}) },
      credentials: { load: async () => null },
    }),
  );
  assert.deepEqual(await port.readEffectiveSandboxConfig("e2b"), {
    envMaxLifetimeSeconds: 3600,
    timeoutSeconds: 3600,
    timeoutSource: "deployment-env",
    apiKey: "env-e2b-key",
    apiKeyConfigured: true,
  });
});

test("端口解析：账号设置覆盖 → 生效超时 = min(设置值, env 核实上限)", async () => {
  const port = createHostSandboxRuntimeSettings(
    portOptions({
      settings: {
        get: async () => ({
          cloudRuntime: { sandboxTimeoutSeconds: { e2b: 3300 } },
        }),
      },
      credentials: { load: async () => null },
    }),
  );
  const effective = await port.readEffectiveSandboxConfig("e2b");
  assert.equal(effective.timeoutSeconds, 3300);
  assert.equal(effective.timeoutSource, "account-setting");

  // 设置值高于 env 核实上限：env 是硬上界，不得放大（hobby 1h 事故的防线）。
  const exceeding = createHostSandboxRuntimeSettings(
    portOptions({
      settings: {
        get: async () => ({
          cloudRuntime: { sandboxTimeoutSeconds: { e2b: 7200 } },
        }),
      },
      credentials: { load: async () => null },
    }),
  );
  const clamped = await exceeding.readEffectiveSandboxConfig("e2b");
  assert.equal(clamped.timeoutSeconds, 3600);
  assert.equal(clamped.timeoutSource, "account-setting");
});

test("端口解析：生效 key = credential 存储值 ?? env 部署值；两侧皆缺则未配置", async () => {
  const port = createHostSandboxRuntimeSettings(
    portOptions({
      settings: { get: async () => ({}) },
      credentials: {
        load: async (key) => (key === "cloud-sandbox/e2b" ? "acct-key" : null),
      },
    }),
  );
  const override = await port.readEffectiveSandboxConfig("e2b");
  assert.equal(override.apiKey, "acct-key");
  assert.equal(override.apiKeyConfigured, true);

  const fallback = createHostSandboxRuntimeSettings(
    portOptions({
      settings: { get: async () => ({}) },
      credentials: { load: async () => null },
    }),
  );
  assert.equal((await fallback.readEffectiveSandboxConfig("e2b")).apiKey, "env-e2b-key");

  const neither = createHostSandboxRuntimeSettings(
    portOptions(
      {
        settings: { get: async () => ({}) },
        credentials: { load: async () => null },
      },
      { envApiKeys: {} },
    ),
  );
  const unconfigured = await neither.readEffectiveSandboxConfig("e2b");
  assert.equal(unconfigured.apiKey, undefined);
  assert.equal(unconfigured.apiKeyConfigured, false);
});

test("端口解析：host 服务图缺失或读取失败 → 回落 env 基线并留 warn，不抛错", async () => {
  const notReady = createHostSandboxRuntimeSettings({
    getServices: () => undefined,
    envMaxLifetimeSeconds: { e2b: 3600 },
    envApiKeys: { e2b: "env-e2b-key" },
    logger: silentLogger,
  });
  assert.equal((await notReady.readEffectiveSandboxConfig("e2b")).apiKey, "env-e2b-key");

  const logger = capturingLogger();
  const failing = createHostSandboxRuntimeSettings(
    portOptions(
      {
        settings: {
          get: async () => {
            throw new Error("setting store offline");
          },
        },
        credentials: {
          load: async () => {
            throw new Error("credential store offline");
          },
        },
      },
      { logger },
    ),
  );
  const effective = await failing.readEffectiveSandboxConfig("e2b");
  assert.equal(effective.timeoutSeconds, 3600);
  assert.equal(effective.timeoutSource, "deployment-env");
  assert.equal(effective.apiKey, "env-e2b-key");
  assert.equal(effective.apiKeyConfigured, true);
  assert.equal(logger.warns.length, 2, "设置与凭据读失败各留一条 warn");
});

// ── capabilities 投影 ──

function staticPort(effective: Partial<EffectiveSandboxRuntimeConfig>): SandboxRuntimeSettingsPort {
  return {
    async readEffectiveSandboxConfig() {
      return {
        timeoutSource: "deployment-env",
        apiKeyConfigured: false,
        ...effective,
      };
    },
  };
}

function buildPlane(runtimeSettings?: SandboxRuntimeSettingsPort) {
  const clock = new FakeClock();
  const outbox = createFakeOutbox();
  return assembleCloudControlPlane({
    storage: createFakeStorage(clock, outbox),
    operations: outbox,
    github: createFakeGitHub(),
    drivers: createFakeDriverRegistry(createFakeSandboxDriver()),
    ...(runtimeSettings ? { sandboxRuntimeSettings: runtimeSettings } : {}),
    attachments: createFakeAttachmentPort(),
    runtimeCommands: createFakeRuntimeCommands(),
    clock,
    ids: new FakeIds(),
    hash: new FakeHash(),
  });
}

test("capabilities 投影：透出 apiKeyConfigured 与 env 核实上限，不含 key 本体", async () => {
  const providers = await buildPlane(
    staticPort({
      envMaxLifetimeSeconds: 3600,
      timeoutSeconds: 3300,
      timeoutSource: "account-setting",
      apiKey: "acct-key",
      apiKeyConfigured: true,
    }),
  ).providers();
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.provider, "e2b");
  assert.equal(providers[0]?.apiKeyConfigured, true);
  assert.equal(providers[0]?.maxLifetimeSeconds, 3600);
  // key 本体不得出现在投影里（01 §7.1）。
  assert.equal(JSON.stringify(providers).includes("acct-key"), false);

  const unconfigured = await buildPlane(
    staticPort({ envMaxLifetimeSeconds: 3600, apiKeyConfigured: false }),
  ).providers();
  assert.equal(unconfigured[0]?.apiKeyConfigured, false);
});

test("capabilities 投影：未接端口时按 env 装配校验事实处理（apiKeyConfigured=true）", async () => {
  const providers = await buildPlane(undefined).providers();
  assert.equal(providers.length, 1);
  assert.equal(providers[0]?.apiKeyConfigured, true);
  assert.equal(providers[0]?.maxLifetimeSeconds, 3600);
});

// ── driver 装配胶水（providers.ts → e2bDriver） ──

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

function response(status: number, body: unknown): SandboxFetchResponse {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body ?? "")),
  };
}

function scriptedFetch(handler: (call: FetchCall) => SandboxFetchResponse): {
  fetch: SandboxFetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  const fetchImpl: SandboxFetch = async (url, init) => {
    const call: FetchCall = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body,
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch: fetchImpl, calls };
}

function createInput(requestedDeadline: number): SandboxCreateInput {
  return {
    operationKey: "op-1",
    runId: "run-1",
    runGeneration: 1,
    bootstrapAddress: {
      taskId: "8f1b0f9e-3b1a-4c2d-9e6f-0a1b2c3d4e5f",
      workspacePath: "/workspace/zcode-repo",
    },
    imageRef: "zcode-sandbox-template@1.0.0",
    resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
    requestedDeadline,
    publicControlPlaneUrl: "https://control.example.test",
    bootstrapTicket: "ticket-secret-value",
    labels: {},
    signal: new AbortController().signal,
  };
}

test("driver 装配：binding context 接端口后 create 按解析值发请求，能力声明保持 env 核实值", async () => {
  const { fetch, calls } = scriptedFetch(() =>
    response(200, { sandboxID: "sbx-e2b-1", templateRevision: "rev-7" }),
  );
  const runtimeSettings = staticPort({
    envMaxLifetimeSeconds: 3600,
    timeoutSeconds: 3300,
    timeoutSource: "account-setting",
    apiKey: "acct-e2b-key",
    apiKeyConfigured: true,
  });
  const [binding] = createSandboxDriverBindings(
    // fetch 经部署配置注入（与生产 baseUrl 覆盖同缝）：测试绝不触达真实 provider API。
    { e2b: { apiKey: "env-e2b-key", maxLifetimeSeconds: 3600, fetch } },
    { logger: silentLogger },
  );
  assert.ok(binding);
  const context: SandboxDriverBindingContext = {
    provider: "e2b",
    readSecret: () => "env-e2b-key",
    logger: silentLogger,
    runtimeSettings,
  };
  const driver = binding.createDriver(context);

  // 能力声明是部署事实：账号覆盖只收敛请求，不改 maxLifetimeSeconds 投影。
  const capabilities = await driver.describeCapabilities();
  assert.equal(capabilities.maxLifetimeSeconds, 3600);

  // 请求超时 4h，但生效预算 3300s（min(设置, env 核实上限)）必须收敛进 provider 请求。
  const handle = await driver.create(createInput(NOW + 4 * 3_600_000));
  assert.equal(handle.sandboxId, "sbx-e2b-1");
  const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body["timeout"], 3300);
  // key 生效值 = credential ?? env：请求头使用账号覆盖 key。
  assert.equal(calls[0]?.headers["X-API-Key"], "acct-e2b-key");
  // 生产绑定不注入 now（真实时钟）：按漂移窗口断言期限 = now + 3300s。
  const drift = Math.abs(handle.providerDeadline - (Date.now() + 3_300_000));
  assert.ok(drift < 5_000, `providerDeadline should be now+3300s (drift ${drift}ms)`);
});

test("driver 装配：未接端口时保持 env 静态值（既有行为不回归）", async () => {
  const { fetch, calls } = scriptedFetch(() => response(200, { sandboxID: "sbx-e2b-2" }));
  const driver = createE2bSandboxDriver({
    apiKey: () => "env-e2b-key",
    maxLifetimeSeconds: 3600,
    fetch,
    now: () => NOW,
    logger: silentLogger,
  });
  await driver.create(createInput(NOW + 4 * 3_600_000));
  const body = JSON.parse(calls[0]?.body ?? "{}") as Record<string, unknown>;
  assert.equal(body["timeout"], 3600);
  assert.equal(calls[0]?.headers["X-API-Key"], "env-e2b-key");
});

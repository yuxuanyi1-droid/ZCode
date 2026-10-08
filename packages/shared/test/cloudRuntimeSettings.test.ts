// Cloud 沙箱运行时账号设置契约用例（specs/cloud-agent/01 §4.3/§5.1 修订 2026-10-08、
// 12 §2 修订）：capabilities 的 apiKeyConfigured 投影、AppSettings.cloudRuntime section
// 的严格校验与读取容错、凭据标识约定。
import assert from "node:assert/strict";
import test from "node:test";
import { appSettingsPatchSchema, appSettingsSchema } from "../src/validationAppSettings.js";
import {
  CLOUD_SANDBOX_SINGLE_KEY_PROVIDERS,
  CLOUD_SANDBOX_TIMEOUT_SECONDS_MAX,
  CLOUD_SANDBOX_TIMEOUT_SECONDS_MIN,
  capabilitiesResponseSchema,
  cloudRuntimeSettingsSchema,
  cloudSandboxCredentialKey,
  sandboxProviderCapabilitiesSchema,
} from "../src/index.js";

const PRINCIPAL_ID = "3c8a6d2b-0e4f-4a9b-8c1d-2e3f4a5b6c7d";

function providerFixture(overrides: Record<string, unknown> = {}) {
  return {
    provider: "e2b",
    createOperationLookup: "metadata-search",
    canInspect: true,
    canExtendDeadline: true,
    canConfirmTermination: true,
    // 2026-10-09 生命周期 v2（additive）：分级暂停/恢复能力；实测解禁前部署上报 none。
    pauseResume: "none",
    deadlineSource: "provider",
    supportsOutboundWss: true,
    apiKeyConfigured: true,
    ...overrides,
  };
}

test("sandbox provider capabilities: apiKeyConfigured is required and stays a boolean projection", () => {
  assert.equal(sandboxProviderCapabilitiesSchema.safeParse(providerFixture()).success, true);
  // 缺 apiKeyConfigured 即拒绝：客户端不得把「未知」当「未配置」猜。
  assert.equal(
    sandboxProviderCapabilitiesSchema.safeParse(providerFixture({ apiKeyConfigured: undefined }))
      .success,
    false,
  );
  assert.equal(
    sandboxProviderCapabilitiesSchema.safeParse(providerFixture({ apiKeyConfigured: "yes" }))
      .success,
    false,
  );
  // key 本体不得借字段外泄：布尔之外的形态（值/来源细节）一律拒绝。
  assert.equal(
    sandboxProviderCapabilitiesSchema.safeParse(
      providerFixture({ apiKeyConfigured: true, apiKey: "e2b-key" }),
    ).success,
    false,
  );
  // maxLifetimeSeconds 仍可选：env 未核实的部署不虚构上限（01 §4.2）。
  const withoutCap = providerFixture();
  delete (withoutCap as Partial<typeof withoutCap>).maxLifetimeSeconds;
  assert.equal(sandboxProviderCapabilitiesSchema.safeParse(withoutCap).success, true);
});

test("capabilities response carries the apiKeyConfigured projection per provider", () => {
  const capabilities = capabilitiesResponseSchema.parse({
    mode: "cloud",
    principalId: PRINCIPAL_ID,
    providers: [providerFixture({ apiKeyConfigured: false, maxLifetimeSeconds: 3600 })],
    features: [],
    protocolVersion: 1,
    taskOwnedAttachments: false,
  });
  assert.equal(capabilities.mode, "cloud");
  if (capabilities.mode !== "cloud") return;
  assert.equal(capabilities.providers[0]?.apiKeyConfigured, false);
  assert.equal(capabilities.providers[0]?.maxLifetimeSeconds, 3600);
});

test("cloudRuntime settings schema bounds provider timeout seconds", () => {
  assert.equal(
    cloudRuntimeSettingsSchema.safeParse({
      sandboxTimeoutSeconds: { e2b: 3300 },
    }).success,
    true,
  );
  // 取值域（01 §4.3 修订）：正整数、有下限（60s）与上界（7d）。
  for (const bad of [0, -1, 3_600.5, CLOUD_SANDBOX_TIMEOUT_SECONDS_MAX + 1]) {
    assert.equal(
      cloudRuntimeSettingsSchema.safeParse({
        sandboxTimeoutSeconds: { e2b: bad },
      }).success,
      false,
      `seconds=${bad} must be rejected`,
    );
  }
  assert.equal(
    cloudRuntimeSettingsSchema.safeParse({
      sandboxTimeoutSeconds: { "": 3300 },
    }).success,
    false,
  );
});

test("app settings accept cloudRuntime and tolerate a corrupted section on read", () => {
  const base = { localePreference: "system" as const };
  const parsed = appSettingsSchema.parse({
    ...base,
    cloudRuntime: { sandboxTimeoutSeconds: { e2b: 3300, daytona: 7200 } },
  });
  assert.deepEqual(parsed.cloudRuntime?.sandboxTimeoutSeconds, {
    e2b: 3300,
    daytona: 7200,
  });

  // 读取容错：坏 cloudRuntime 只回落 env 基线（字段被丢弃），不拖垮整份设置。
  const sanitized = appSettingsSchema.parse({
    ...base,
    cloudRuntime: { sandboxTimeoutSeconds: { e2b: "later" } },
  });
  assert.equal(sanitized.cloudRuntime, undefined);

  // patch 写入保持严格：非法秒数直接拒绝，不产生新的坏数据。
  assert.equal(
    appSettingsPatchSchema.safeParse({
      cloudRuntime: { sandboxTimeoutSeconds: { e2b: 0 } },
    }).success,
    false,
  );
  assert.equal(
    appSettingsPatchSchema.safeParse({
      cloudRuntime: { sandboxTimeoutSeconds: { e2b: 3600 } },
    }).success,
    true,
  );
});

test("sandbox credential key convention is single-sourced", () => {
  assert.equal(cloudSandboxCredentialKey("e2b"), "cloud-sandbox/e2b");
  assert.equal(cloudSandboxCredentialKey("daytona"), "cloud-sandbox/daytona");
  // 单 key 型 provider 清单（Modal 是 token 对，不走 credential 覆盖通道）。
  assert.deepEqual([...CLOUD_SANDBOX_SINGLE_KEY_PROVIDERS], ["e2b", "daytona"]);
  assert.equal(
    CLOUD_SANDBOX_TIMEOUT_SECONDS_MIN < 3300 && 3300 < CLOUD_SANDBOX_TIMEOUT_SECONDS_MAX,
    true,
  );
});

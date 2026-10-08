/**
 * 设置页「Cloud 运行时」沙箱配置纯逻辑用例（specs/cloud-agent/01 §4.3 修订 2026-10-08、
 * 12 §2 修订）：生效超时收敛（min(设置值, env 核实上限)）、来源标注、草稿→设置记录的
 * 合并/清除/上限 clamp。渲染与保存调用由组件承担，这里固化可复算的决策规则。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cloudSandboxCredentialKey } from "@zcode/shared";
import {
  resolveEffectiveSandboxTimeout,
  resolveSandboxTimeoutDraft,
} from "../src/settings/cloudSandboxSettingsLogic.js";

test("effective timeout converges to min(account setting, env-verified cap)", () => {
  const provider = { provider: "e2b", maxLifetimeSeconds: 3600 };

  // 部署基线：无账号设置 → env 核实上限即生效值。
  assert.deepEqual(resolveEffectiveSandboxTimeout(provider, undefined), {
    seconds: 3600,
    source: "deployment-env",
  });
  // 设置覆盖低于上限：按设置值生效。
  assert.deepEqual(resolveEffectiveSandboxTimeout(provider, 3300), {
    seconds: 3300,
    source: "account-setting",
  });
  // 设置高于 env 核实上限（hobby 1h 事故形态）：env 是硬上界，不得放大。
  assert.deepEqual(resolveEffectiveSandboxTimeout(provider, 7200), {
    seconds: 3600,
    source: "account-setting",
  });
  // 部署未核实上限：账号设置单独生效，不虚构 env 上限。
  assert.deepEqual(
    resolveEffectiveSandboxTimeout({ provider: "e2b", maxLifetimeSeconds: undefined }, 3300),
    { seconds: 3300, source: "account-setting" },
  );
  assert.deepEqual(
    resolveEffectiveSandboxTimeout({ provider: "e2b", maxLifetimeSeconds: undefined }, undefined),
    { seconds: undefined, source: "deployment-env" },
  );
});

test("timeout draft clamps to the shared bounds and env-verified cap", () => {
  // 低于共享下限（60s）→ 收敛到下限；高于 env 核实上限 → 收敛到上限。
  assert.deepEqual(
    resolveSandboxTimeoutDraft({
      existing: undefined,
      provider: "e2b",
      draft: "10",
      maxLifetimeSeconds: 3600,
    }),
    { kind: "set", seconds: 60, record: { e2b: 60 } },
  );
  assert.deepEqual(
    resolveSandboxTimeoutDraft({
      existing: undefined,
      provider: "e2b",
      draft: "14400",
      maxLifetimeSeconds: 3600,
    }),
    { kind: "set", seconds: 3600, record: { e2b: 3600 } },
  );
  // hobby 计划推荐值：3300 秒原样保留。
  assert.deepEqual(
    resolveSandboxTimeoutDraft({
      existing: undefined,
      provider: "e2b",
      draft: "3300",
      maxLifetimeSeconds: 3600,
    }),
    { kind: "set", seconds: 3300, record: { e2b: 3300 } },
  );
  // 非法输入（非数字）不产生记录。
  assert.equal(
    resolveSandboxTimeoutDraft({
      existing: undefined,
      provider: "e2b",
      draft: "soon",
      maxLifetimeSeconds: 3600,
    }).kind,
    "invalid",
  );
});

test("timeout draft preserves other providers and clear restores the deployment baseline", () => {
  const existing = { e2b: 3300, daytona: 7200 };
  // 保存 e2b 覆盖时不动 daytona 的既有覆盖（patch 语义是整组记录）。
  assert.deepEqual(
    resolveSandboxTimeoutDraft({
      existing,
      provider: "e2b",
      draft: "3000",
      maxLifetimeSeconds: 3600,
    }),
    { kind: "set", seconds: 3000, record: { e2b: 3000, daytona: 7200 } },
  );
  // 清空 e2b → 只移除该 provider 的键，恢复部署基线而不清空别人的。
  assert.deepEqual(
    resolveSandboxTimeoutDraft({ existing, provider: "e2b", draft: "", maxLifetimeSeconds: 3600 }),
    { kind: "clear", record: { daytona: 7200 } },
  );
  assert.deepEqual(
    resolveSandboxTimeoutDraft({
      existing: { e2b: 3300 },
      provider: "e2b",
      draft: "  ",
      maxLifetimeSeconds: 3600,
    }),
    { kind: "clear", record: {} },
  );
});

test("credential key convention matches the server port", () => {
  // UI 写入与 server create 读取必须命中同一凭据标识（shared 单一事实源）。
  assert.equal(cloudSandboxCredentialKey("e2b"), "cloud-sandbox/e2b");
  assert.equal(cloudSandboxCredentialKey("daytona"), "cloud-sandbox/daytona");
});

/**
 * 云执行节点偏好快照读取与落值用例（specs/cloud-agent 14 §6/§9.3、U-07）。
 *
 * 覆盖：v2 快照五键实值应答、`user-execution` scope 才带 Shell、缺键回落默认值、
 * env 未注入/文件缺失/JSON 损坏/版本不符/枚举非法一律回落且不抛（warn 回调收到原因，
 * 诊断不带值正文）、v1 文件同样回落且不误读。
 */
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ZCODE_APPLIED_POLICY_SNAPSHOT_ENV_KEY } from "@zcode/shared";
import {
  mergeRuntimePreferences,
  readRuntimePreferencesSnapshot,
  type RuntimePreferencesDefaults,
} from "../src/runtimePreferencesSnapshot.js";

const DEFAULTS: RuntimePreferencesDefaults = {
  askUserQuestionAutoResolutionEnabled: true,
  nativeSearchEnhancementsEnabled: true,
  memoryEnabled: false,
  modelContextBudgetStrategy: "legacy",
  integratedTerminalShell: { mode: "auto" },
};

async function writeSnapshot(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "prefs-snapshot-"));
  const path = join(dir, "applied-policy.json");
  await writeFile(path, content, { mode: 0o600 });
  return path;
}

function snapshotContent(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 2,
    policyVersion: "cloud-policy-1",
    configVersion: "prefs-1234abcd",
    preferences: {
      askUserQuestionAutoResolutionEnabled: false,
      nativeSearchEnhancementsEnabled: false,
      memoryEnabled: true,
      modelContextBudgetStrategy: "preflight-v1",
      integratedTerminalShell: {
        mode: "shell",
        dialect: "git-bash",
        id: "bash",
        label: "Git Bash",
        path: "/usr/bin/bash",
      },
    },
    ...overrides,
  });
}

test("v2 快照：读出五键实值与 configVersion；env 未注入时静默回落", async () => {
  const path = await writeSnapshot(snapshotContent());
  const warnings: string[] = [];
  const snapshot = await readRuntimePreferencesSnapshot({
    env: { [ZCODE_APPLIED_POLICY_SNAPSHOT_ENV_KEY]: path },
    onWarning: (warning) => warnings.push(warning.reason),
  });
  assert.ok(snapshot);
  assert.equal(snapshot!.configVersion, "prefs-1234abcd");
  assert.deepEqual(snapshot!.values, {
    askUserQuestionAutoResolutionEnabled: false,
    nativeSearchEnhancementsEnabled: false,
    memoryEnabled: true,
    modelContextBudgetStrategy: "preflight-v1",
    integratedTerminalShell: {
      mode: "shell",
      dialect: "git-bash",
      id: "bash",
      label: "Git Bash",
      path: "/usr/bin/bash",
    },
  });
  assert.deepEqual(warnings, []);

  // env 未注入（非云节点/未接线）：静默 null，不算损坏。
  assert.equal(await readRuntimePreferencesSnapshot({ env: {} }), null);
  assert.deepEqual(warnings, []);
});

test("落值：快照实值优先、缺键回落沙箱默认；Shell 只对 user-execution 生效", async () => {
  const path = await writeSnapshot(
    JSON.stringify({
      version: 2,
      policyVersion: "cloud-policy-1",
      configVersion: "prefs-partial",
      preferences: {
        memoryEnabled: true,
        integratedTerminalShell: {
          mode: "shell",
          dialect: "git-bash",
          id: "bash",
          label: "Git Bash",
          path: "/usr/bin/bash",
        },
      },
    }),
  );
  const snapshot = await readRuntimePreferencesSnapshot({
    env: { [ZCODE_APPLIED_POLICY_SNAPSHOT_ENV_KEY]: path },
  });

  const withSnapshot = mergeRuntimePreferences({
    defaults: DEFAULTS,
    snapshot,
    scope: "user-execution",
  });
  assert.deepEqual(withSnapshot, {
    askUserQuestionAutoResolutionEnabled: true,
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: true,
    modelContextBudgetStrategy: "legacy",
    integratedTerminalShell: {
      mode: "shell",
      dialect: "git-bash",
      id: "bash",
      label: "Git Bash",
      path: "/usr/bin/bash",
    },
  });

  // 非 user-execution：不消费 Shell（沿用既有 responder 口径）。
  const shared = mergeRuntimePreferences({ defaults: DEFAULTS, snapshot, scope: "shared-host" });
  assert.equal("integratedTerminalShell" in shared, false);
  assert.equal(shared.memoryEnabled, true);

  // 无快照：完全走默认值（user-execution 时带默认 Shell）。
  const fallback = mergeRuntimePreferences({
    defaults: DEFAULTS,
    snapshot: null,
    scope: "user-execution",
  });
  assert.deepEqual(fallback, {
    askUserQuestionAutoResolutionEnabled: true,
    nativeSearchEnhancementsEnabled: true,
    memoryEnabled: false,
    modelContextBudgetStrategy: "legacy",
    integratedTerminalShell: { mode: "auto" },
  });
});

test("损坏与旧版一律回落（不抛、不崩）：文件缺失、非法 JSON、v1、枚举非法、非对象", async () => {
  const cases: { label: string; content?: string; expectedReason: string }[] = [
    { label: "文件缺失", expectedReason: "snapshot-file-unreadable" },
    { label: "非法 JSON", content: "{not json", expectedReason: "snapshot-not-json" },
    {
      label: "v1（无 preferences 块）",
      content: JSON.stringify({ version: 1, policyVersion: "cloud-policy-1" }),
      expectedReason: "snapshot-shape-invalid",
    },
    {
      label: "枚举非法",
      content: snapshotContent({
        preferences: { modelContextBudgetStrategy: "some-future-strategy" },
      }),
      expectedReason: "snapshot-shape-invalid",
    },
    {
      label: "非对象",
      content: JSON.stringify(["nope"]),
      expectedReason: "snapshot-shape-invalid",
    },
  ];
  for (const item of cases) {
    const dir = await mkdtemp(join(tmpdir(), "prefs-bad-"));
    const path = join(dir, "applied-policy.json");
    if (item.content !== undefined) await writeFile(path, item.content);
    const warnings: { reason: string; path: string }[] = [];
    const snapshot = await readRuntimePreferencesSnapshot({
      env: { [ZCODE_APPLIED_POLICY_SNAPSHOT_ENV_KEY]: path },
      onWarning: (warning) => warnings.push(warning),
    });
    assert.equal(snapshot, null, `${item.label}: 必须回落`);
    assert.equal(warnings.length, 1, `${item.label}: 只记一条 warn`);
    assert.equal(warnings[0]!.reason, item.expectedReason, item.label);
    assert.equal(warnings[0]!.path, path, "诊断只带路径，不带值正文");
  }

  // 未知键（前向兼容）：剥离即可，不影响已知键。
  const path = await writeSnapshot(snapshotContent());
  const parsed = JSON.parse(snapshotContent()) as { preferences: Record<string, unknown> };
  parsed.preferences["futureKey"] = { anything: true };
  await writeFile(path, JSON.stringify(parsed));
  const snapshot = await readRuntimePreferencesSnapshot({
    env: { [ZCODE_APPLIED_POLICY_SNAPSHOT_ENV_KEY]: path },
  });
  assert.ok(snapshot);
  assert.equal(snapshot!.values.memoryEnabled, true);
  assert.equal("futureKey" in snapshot!.values, false);
});

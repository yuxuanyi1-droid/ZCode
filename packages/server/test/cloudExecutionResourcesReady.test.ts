/**
 * M8 沙箱侧 ready 门控 / bootstrap 集成用例（specs/cloud-agent 14 §6/§4.8/§9.5；W6 §6
 * 「未满足的真实证据条件不得写死 true」）。
 *
 * 2026-10-11 简化改造（W11 §13C）：自举期资源安装整体退役——原 `resources-installed` 条件位、
 * `installing-resources` 相位与"资源收齐/安装/失败"用例随安装器删除（14 §4.8 U-13）；
 * 本文件保留并改写为两块：
 * - **退役断言**：ready 条件集不含 `resources-installed`（恢复 6 条）、`installing-resources`
 *   不再是合法相位；
 * - **偏好快照链**（保留链路）：`bootstrap.config.preferences` → `applied-policy.json` v2，
 *   真实落盘版本驱动 `preferences-installed` 与 `bridge.ready.configVersion`（无快照块维持
 *   policyVersion 的旧版语义，v1 状态文件兼容读）。
 *
 * 连接期用户资源同步（控制面经 bridge relay 调沙箱既有 sync 服务）的用例属控制面侧
 * （`cloudUserProfileSync.test.ts`）；沙箱侧的分面准入用例见 `cloudBridgeProjection.test.ts`
 * 的 rpcRelay 族。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLOUD_BRIDGE_PROTOCOL_VERSION, type CloudBootstrapPreferences } from "@zcode/shared";
import { createBootstrap, type Bootstrap } from "../src/cloud/execution/app/bootstrap.js";
import { createProjectionExporter } from "../src/cloud/execution/app/projectionExporter.js";
import { createSandboxGit } from "../src/cloud/execution/app/sandboxGit.js";
import {
  createPolicySnapshotInstaller,
  appliedPolicySnapshotPath,
} from "../src/cloud/execution/adapters/provisioningInstaller.js";
import {
  READY_CONDITIONS,
  evaluateReady,
  parseBootstrapPhase,
  type ReadyChecklist,
} from "../src/cloud/execution/domain/readyGate.js";
import { testLogger } from "./cloudBridgeFakes.js";
import {
  createGitGrantFake,
  createGitRunnerFake,
  createLocalRpcFake,
  createProjectionFake,
  createRuntimeFake,
} from "./cloudExecutionFakes.js";

const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const RUN_ID = "1f14e45f-ceea-467a-9a1e-1f0d3b2a4c52";
const PREFS: CloudBootstrapPreferences = {
  configVersion: "prefs-abc123def456",
  values: {
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
};

function configFrame(preferences?: CloudBootstrapPreferences) {
  return {
    protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
    type: "bootstrap.config" as const,
    taskId: TASK_ID,
    workspacePath: "/workspace/demo",
    clone: {
      repositoryId: 42,
      repositoryFullName: "octo/demo",
      baseSha: "a".repeat(40),
      taskBranch: "zcode/task-1",
    },
    provisioningEnvelopeJson: JSON.stringify({ version: 1, providers: [] }),
    credentialGeneration: 3,
    policyVersion: "policy-7",
    ...(preferences ? { preferences } : {}),
  };
}

async function buildBootstrap(options: {
  policy?: ReturnType<typeof createPolicySnapshotInstaller>;
}) {
  // 默认用**真实** policy 安装器（落盘 v2 快照并返回实际应用版本）：configVersion 上报
  // 必须有真实来源，不用"假件恰好返回对了"来证明。
  const policyStateDir = await mkdtemp(join(tmpdir(), "m8-ready-policy-"));

  const projection = createProjectionFake();
  const exporter = createProjectionExporter({
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    runtimeIncarnation: "runtime-1",
    sessionIndexTopic: `sessions-index/cloud-task:${TASK_ID}`,
    extractSessionIds: () => [],
    source: {
      subscribe: async () => ({ subscriptionId: "s1", mode: "snapshot" as const, logEpoch: "e1" }),
      unsubscribe: async () => undefined,
      onFrame: () => ({ dispose: () => undefined }),
    },
    walStore: projection.store,
    logger: testLogger(),
  });
  const bootstrap: Bootstrap = createBootstrap({
    git: createSandboxGit({
      runner: createGitRunnerFake(),
      grants: createGitGrantFake(),
      logger: testLogger(),
    }),
    runtime: createRuntimeFake(),
    localRpc: createLocalRpcFake(),
    provisioning: { appliedGeneration: async () => null, install: async () => undefined },
    policy:
      options.policy ??
      createPolicySnapshotInstaller({ logger: testLogger(), stateDir: policyStateDir }),
    workspace: { ensure: async () => undefined, exists: async () => false },
    exporter: {
      ...exporter,
      start: async () => undefined,
      ready: () => ({ exporterReady: true, walReady: true }),
    },
    logger: testLogger(),
    workspaceRoot: "/workspace",
  });
  return bootstrap;
}

test("ready 门控：`resources-installed` 已退役（节点侧条件回到 5 项），偏好快照仍是独立真实证据条件", () => {
  assert.equal(
    (READY_CONDITIONS as readonly string[]).includes("resources-installed"),
    false,
    "自举期资源安装退役后，ready 条件不得再含 resources-installed（14 §4.8 U-13）",
  );
  assert.deepEqual(
    [...READY_CONDITIONS],
    [
      "local-runtime-handshake",
      "provisioning-installed",
      "preferences-installed",
      "exporter-ready",
      "reconciliation-done",
    ],
  );

  const base: ReadyChecklist = {
    localRuntimeHandshake: true,
    provisioningInstalled: true,
    preferencesInstalled: true,
    exporterReady: true,
    walReady: true,
    reconciliationDone: true,
    previousFacadeReleased: true,
  };
  assert.deepEqual(evaluateReady(base), { ready: true });
  // 未安装的偏好快照独立拦截（真实证据条件，不写死 true）。
  const noPrefs = evaluateReady({ ...base, preferencesInstalled: false });
  assert.equal(noPrefs.ready, false);
  if (!noPrefs.ready) {
    assert.equal(noPrefs.blockedBy, "preferences-installed");
    assert.equal(noPrefs.detail, "policy-snapshot-missing");
  }
});

test("阶段枚举与 shared 冻结帧同步：`installing-resources` 已移除，其余相位仍可解析", () => {
  assert.equal(
    parseBootstrapPhase("installing-resources"),
    null,
    "退役相位不得可解析/可上报（14 §4.8）",
  );
  assert.equal(parseBootstrapPhase("installing-config"), "installing-config");
  assert.equal(parseBootstrapPhase("exporter-starting"), "exporter-starting");
  assert.equal(parseBootstrapPhase("nonsense"), null);
});

test("bootstrap：就绪阶段顺序为 6 条（无 resources 相位），configVersion 用偏好快照版本", async () => {
  const bootstrap = await buildBootstrap({});
  const phases: string[] = [];
  bootstrap.onPhase((phase) => phases.push(phase.phase));
  const report = await bootstrap.run(configFrame(PREFS));

  assert.deepEqual(phases, [
    "registering",
    "cloning",
    "handshaking",
    "installing-config",
    "exporter-starting",
    "reconciling",
  ]);
  assert.equal(report.configVersion, "prefs-abc123def456", "有偏好块时必须上报快照 configVersion");
  assert.ok(report.executionCapabilities.includes("stdio-rpc"));
});

test("bootstrap：无偏好块时 configVersion 维持 policyVersion（旧版语义）", async () => {
  const bootstrap = await buildBootstrap({});
  const report = await bootstrap.run(configFrame());
  assert.equal(report.configVersion, "policy-7");
});

test("偏好快照安装：v2 落盘实值 + configVersion，applied() 可读；v1 兼容读", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "m8-policy-"));
  const policy = createPolicySnapshotInstaller({ logger: testLogger(), stateDir });
  const applied = await policy.install({ policyVersion: "policy-7", preferences: PREFS });
  assert.deepEqual(applied, { configVersion: PREFS.configVersion });
  const path = appliedPolicySnapshotPath(stateDir);
  const written = JSON.parse(
    await import("node:fs/promises").then((fs) => fs.readFile(path, "utf8")),
  ) as Record<string, unknown>;
  assert.deepEqual(written, {
    version: 2,
    policyVersion: "policy-7",
    configVersion: PREFS.configVersion,
    preferences: PREFS.values,
  });
  assert.deepEqual(await policy.applied(), { configVersion: PREFS.configVersion });

  // v1（旧版语义）仍可读：applied() 回落 policyVersion。
  const legacyDir = await mkdtemp(join(tmpdir(), "m8-policy-v1-"));
  await mkdir(legacyDir, { recursive: true });
  await writeFile(
    appliedPolicySnapshotPath(legacyDir),
    JSON.stringify({ version: 1, policyVersion: "policy-legacy" }),
  );
  const legacy = createPolicySnapshotInstaller({ logger: testLogger(), stateDir: legacyDir });
  assert.deepEqual(await legacy.applied(), { configVersion: "policy-legacy" });
  // 损坏文件：applied() 视为无记录（不崩、不猜）。
  await writeFile(appliedPolicySnapshotPath(legacyDir), "{not json");
  assert.equal(await legacy.applied(), null);
});

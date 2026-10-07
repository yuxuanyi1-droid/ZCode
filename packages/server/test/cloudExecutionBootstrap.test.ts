/**
 * W6 bootstrap / sandbox git / checkpoint 用例（specs/cloud-agent 01 §6.2/§7.2/§8、
 * 02 §5.3 ready 门控、§11 「bootstrap 与 checkpoint」验收段）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBootstrap, type Bootstrap } from "../src/cloud/execution/app/bootstrap.js";
import { createCheckpoint } from "../src/cloud/execution/app/checkpoint.js";
import { createProjectionExporter } from "../src/cloud/execution/app/projectionExporter.js";
import { createSandboxGit, gitCredentialEnv } from "../src/cloud/execution/app/sandboxGit.js";
import {
  isSafeRef,
  parseLsRemoteSha,
  planClone,
  planPush,
} from "../src/cloud/execution/domain/gitPlan.js";
import {
  createPolicySnapshotInstaller,
  createSandboxWorkspace,
} from "../src/cloud/execution/adapters/provisioningInstaller.js";
import {
  readSupervisorConfig,
  bridgeUrl,
} from "../src/cloud/execution/adapters/supervisorConfig.js";
import { testLogger } from "./cloudBridgeFakes.js";
import {
  createBootstrapFake,
  createGitGrantFake,
  createGitRunnerFake,
  createLocalRpcFake,
  createProjectionFake,
  createRuntimeFake,
  type RuntimeFake,
} from "./cloudExecutionFakes.js";

const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const RUN_ID = "1f14e45f-ceea-467a-9a1e-1f0d3b2a4c52";
const BASE_SHA = "a".repeat(40);

function configFrame() {
  return {
    protocolVersion: 1 as const,
    type: "bootstrap.config" as const,
    taskId: TASK_ID,
    workspacePath: "/workspace/demo",
    clone: {
      repositoryId: 42,
      repositoryFullName: "octo/demo",
      baseSha: BASE_SHA,
      taskBranch: "zcode/task-1",
    },
    provisioningEnvelopeJson: JSON.stringify({ version: 1, providers: [] }),
    credentialGeneration: 3,
    policyVersion: "policy-7",
  };
}

function buildBootstrap(options: {
  runtime?: RuntimeFake;
  runner?: ReturnType<typeof createGitRunnerFake>;
  walWritable?: boolean;
  appliedGeneration?: number | null;
  /** 启动后立即死亡：start 仍成功，但 facts() 已无 PID。 */
  deadAfterStart?: boolean;
}): { bootstrap: Bootstrap; runner: ReturnType<typeof createGitRunnerFake>; runtime: RuntimeFake } {
  const baseRuntime = options.runtime ?? createRuntimeFake();
  const runtime: RuntimeFake = options.deadAfterStart
    ? { ...baseRuntime, facts: () => ({ pid: null, incarnation: "runtime-dead" }) }
    : baseRuntime;
  const runner = options.runner ?? createGitRunnerFake();
  const projection = createProjectionFake();
  if (options.walWritable === false) {
    projection.ready = () => ({ exporterReady: true, walReady: false });
  }
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
  const git = createSandboxGit({ runner, grants: createGitGrantFake(), logger: testLogger() });
  const workspace = {
    ensure: async () => undefined,
    exists: async () => false,
  };
  const bootstrap = createBootstrap({
    git,
    runtime,
    localRpc: createLocalRpcFake(),
    provisioning: {
      appliedGeneration: async () => options.appliedGeneration ?? null,
      install: async () => undefined,
    },
    policy: { install: async () => undefined },
    workspace,
    exporter: {
      ...exporter,
      // 直接复用真实 exporter，但把 start 换成可观察的空实现，避免测试依赖 V4 订阅假件。
      start: async () => undefined,
      ready: () =>
        options.walWritable === false
          ? { exporterReady: true, walReady: false }
          : { exporterReady: true, walReady: true },
    },
    logger: testLogger(),
    workspaceRoot: "/workspace",
  });
  return { bootstrap, runner, runtime };
}

test("bootstrap：阶段顺序、clone 事实固定 baseSha/taskBranch、ready 门控不过不假 ready", async () => {
  const { bootstrap, runner } = buildBootstrap({});
  const phases: string[] = [];
  bootstrap.onPhase((phase) => phases.push(phase.phase));
  const report = await bootstrap.run(configFrame());

  assert.deepEqual(phases, [
    "registering",
    "cloning",
    "handshaking",
    "installing-config",
    "exporter-starting",
    "reconciling",
  ]);
  assert.equal(report.configVersion, "policy-7");
  const cloneCall = runner.calls[0]!;
  assert.deepEqual(cloneCall.argv.slice(0, 4), [
    "clone",
    "--no-tags",
    "--",
    "https://github.com/octo/demo.git",
  ]);
  assert.equal(cloneCall.argv[4], "/workspace/demo");
  // 固定 SHA checkout + 建 taskBranch（argv 形式，不拼 shell）。
  assert.deepEqual(runner.calls[1]!.argv, ["checkout", "--detach", BASE_SHA]);
  assert.deepEqual(runner.calls[2]!.argv, ["switch", "-c", "zcode/task-1"]);
});

test("bootstrap：WAL 不可写与 runtime 死亡时明确失败，不进入 ready", async () => {
  const notWritable = buildBootstrap({ walWritable: false });
  await assert.rejects(
    () => notWritable.bootstrap.run(configFrame()),
    /projection WAL is not writable/,
  );

  // runtime 启动后立即死亡（进程存在过但 facts().pid 已为 null）：reconcile 阶段拒绝 ready。
  const dead = buildBootstrap({ deadAfterStart: true });
  await assert.rejects(() => dead.bootstrap.run(configFrame()), /runtime-not-alive|not_ready/);
});

test("git 凭据只经 env：token 不进 argv、不进 clone URL；helper 清空", async () => {
  const runner = createGitRunnerFake();
  const git = createSandboxGit({
    runner,
    grants: createGitGrantFake("grant"),
    logger: testLogger(),
  });
  const cloned = await git.cloneAtBase(
    {
      repositoryId: 42,
      repositoryFullName: "octo/demo",
      baseSha: BASE_SHA,
      taskBranch: "zcode/task-1",
    },
    "/workspace/demo",
    "/workspace",
  );
  assert.equal(cloned.ok, true);
  const env = runner.calls[0]!.env!;
  assert.ok(env.GIT_CONFIG_VALUE_1?.startsWith("Authorization: Basic "), "认证只能经 env 头");
  assert.equal(env["GIT_CONFIG_KEY_0"], "credential.helper", "必须清空继承的 credential helper");
  assert.equal(env.GIT_CONFIG_VALUE_0, "");
  assert.equal(env.GIT_TERMINAL_PROMPT, "0");
  // argv 与 URL 中不得出现 token（.git/config 里的 origin 因此是干净的）。
  for (const call of runner.calls) {
    assert.equal(
      call.argv.some((arg) => arg.includes("grant-")),
      false,
      "token 不得出现在 argv",
    );
  }
  assert.equal(runner.calls[0]!.argv.at(-2), "https://github.com/octo/demo.git");
  // 预置 git 配置里带 Basic，形态与 GitHub App installation token 一致。
  assert.match(
    gitCredentialEnv("t")["GIT_CONFIG_VALUE_1"]!,
    /^Authorization: Basic [A-Za-z0-9+/=]+$/,
  );
});

test("git plan：非法 ref/SHA 在发命令前拒绝（不拼 shell、不猜）", () => {
  assert.equal(isSafeRef("zcode/task-1"), true);
  assert.equal(isSafeRef("bad..ref"), false);
  assert.equal(isSafeRef("bad ref"), false);
  assert.equal(
    planClone(
      { repositoryId: 1, repositoryFullName: "octo/demo", baseSha: "zz", taskBranch: "b" },
      "/w",
    ).ok,
    false,
  );
  assert.equal(planPush("bad..ref").ok, false);
  assert.equal(
    parseLsRemoteSha(`${BASE_SHA}\trefs/heads/zcode/task-1\n`, "zcode/task-1"),
    BASE_SHA,
  );
  assert.equal(parseLsRemoteSha("", "zcode/task-1"), null);
});

test("checkpoint：无变更不建空提交、push 以远端 SHA 为准、operationId 重放复用结果", async () => {
  const runner = createGitRunnerFake();
  const git = createSandboxGit({ runner, grants: createGitGrantFake(), logger: testLogger() });
  const checkpoint = createCheckpoint({
    git,
    quiesce: {
      quiesce: async () => ({ ok: true as const }),
      release: async () => undefined,
    },
    checkout: () => ({ workspacePath: "/workspace/demo", taskBranch: "zcode/task-1" }),
    logger: testLogger(),
    clock: { now: () => 0, wait: async () => undefined },
  });

  // 工作区干净 → committed=false、hadNewCommits=false；push 仍走远端核验。
  runner.responses = [
    { code: 0, stdout: "", stderr: "" }, // status --porcelain
    { code: 0, stdout: "", stderr: "" }, // push
    { code: 0, stdout: `${BASE_SHA}\trefs/heads/zcode/task-1\n`, stderr: "" }, // ls-remote
  ];
  const request = {
    protocolVersion: 1 as const,
    type: "checkpoint.request" as const,
    operationId: "3f14e45f-ceea-467a-9a1e-1f0d3b2a4c54",
    runId: RUN_ID,
    runGeneration: 1,
    connectionEpoch: 4,
    purpose: "stop" as const,
  };
  const saved = await checkpoint.run(request);
  assert.equal(saved.status, "saved");
  assert.equal(saved.hadNewCommits, false, "无变更必须上报 hadNewCommits=false");
  assert.equal(saved.remoteSha, BASE_SHA);
  assert.deepEqual(runner.calls[0]!.argv, ["status", "--porcelain", "--untracked-files=normal"]);
  assert.ok(
    runner.calls.every(
      (call) => call.argv.includes("push") === false || call.argv.includes("--force") === false,
    ),
    "push 禁止 force",
  );

  // operationId 重放：复用结果，不再执行任何 git 命令。
  const beforeReplay = runner.calls.length;
  const replay = await checkpoint.run(request);
  assert.deepEqual(replay, saved);
  assert.equal(runner.calls.length, beforeReplay, "重放不得重做 commit/push");
});

test("checkpoint：远端无对应 HEAD 时不报 saved（不伪造保存事实）", async () => {
  const runner = createGitRunnerFake();
  const git = createSandboxGit({ runner, grants: createGitGrantFake(), logger: testLogger() });
  const checkpoint = createCheckpoint({
    git,
    quiesce: { quiesce: async () => ({ ok: true as const }), release: async () => undefined },
    checkout: () => ({ workspacePath: "/workspace/demo", taskBranch: "zcode/task-1" }),
    logger: testLogger(),
    clock: { now: () => 0, wait: async () => undefined },
  });
  runner.responses = [
    { code: 0, stdout: " M src/a.ts\n", stderr: "" }, // 有变更
    { code: 0, stdout: "", stderr: "" }, // git add
    { code: 0, stdout: "", stderr: "" }, // git commit
    { code: 1, stdout: "", stderr: "rejected" }, // push 失败
    { code: 0, stdout: "", stderr: "" }, // ls-remote 查不到
  ];
  const result = await checkpoint.run({
    protocolVersion: 1,
    type: "checkpoint.request",
    operationId: "4f14e45f-ceea-467a-9a1e-1f0d3b2a4c55",
    runId: RUN_ID,
    runGeneration: 1,
    connectionEpoch: 1,
    purpose: "stop",
  });
  assert.notEqual(result.status, "saved");
  assert.equal(result.remoteSha, undefined);
  assert.equal(result.errorCode, "non_fast_forward");
});

test("workspace 准备：拒绝越界 path 与 symlink 逃逸", async () => {
  const root = await mkdtemp(join(tmpdir(), "w6-workspace-"));
  const workspace = createSandboxWorkspace({ workspaceRoot: root, logger: testLogger() });
  await assert.rejects(
    () => workspace.ensure("/etc/passwd"),
    /escapes the configured workspace root/,
  );
  await assert.rejects(
    () => workspace.ensure(join(root, "..", "etc")),
    /escapes the configured workspace root/,
  );
  await workspace.ensure(join(root, "demo"));
  // symlink 越界：真实路径必须仍在 root 内。
  const { symlink, mkdir } = await import("node:fs/promises");
  await mkdir(join(root, "outside-target"), { recursive: true });
  await symlink("/tmp", join(root, "escape"));
  await assert.rejects(
    () => workspace.ensure(join(root, "escape")),
    /escapes the configured workspace root/,
  );
  assert.equal(await workspace.exists(join(root, "demo")), false, "没有 .git 的目录不算已 clone");
});

test("自举配置：缺 taskId/workspacePath 时 fail closed，不编造占位身份", async () => {
  const missing = await readSupervisorConfig({
    ZCODE_CLOUD_PUBLIC_ORIGIN: "https://cloud.example.test",
    ZCODE_CLOUD_RUN_ID: RUN_ID,
    ZCODE_CLOUD_RUN_GENERATION: "1",
    ZCODE_CLOUD_BOOTSTRAP_TICKET: "ticket",
    ZCODE_CLOUD_OPERATION_KEY: "op",
  });
  assert.equal(missing.ok, false);
  assert.deepEqual(missing.ok === false ? missing.missing : [], [
    "ZCODE_CLOUD_TASK_ID",
    "ZCODE_CLOUD_WORKSPACE_PATH",
  ]);

  const stateDir = await mkdtemp(join(tmpdir(), "w6-bootstrap-"));
  const ok = await readSupervisorConfig(
    {
      ZCODE_CLOUD_PUBLIC_ORIGIN: "https://cloud.example.test",
      ZCODE_CLOUD_RUN_ID: RUN_ID,
      ZCODE_CLOUD_RUN_GENERATION: "2",
      ZCODE_CLOUD_BOOTSTRAP_TICKET: "ticket",
      ZCODE_CLOUD_OPERATION_KEY: "op",
      ZCODE_CLOUD_TASK_ID: TASK_ID,
      ZCODE_CLOUD_WORKSPACE_PATH: "/workspace/demo",
    },
    stateDir,
  );
  assert.equal(ok.ok, true);
  assert.equal(ok.ok === true ? ok.value.runGeneration : 0, 2);
  assert.equal(
    bridgeUrl("https://cloud.example.test", RUN_ID),
    `wss://cloud.example.test/ws/cloud/bridge/${RUN_ID}`,
  );
  assert.equal(
    bridgeUrl("http://127.0.0.1:8787", RUN_ID),
    `ws://127.0.0.1:8787/ws/cloud/bridge/${RUN_ID}`,
  );
});

test("policy snapshot 安装：落盘版本化摘要，可被后续读取", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "w6-policy-"));
  const policy = createPolicySnapshotInstaller({ logger: testLogger(), stateDir });
  await policy.install("policy-9");
  const raw = await readFile(join(stateDir, "applied-policy.json"), "utf8");
  assert.deepEqual(JSON.parse(raw), { version: 1, policyVersion: "policy-9" });
});

test("bootstrap 端口与假件保持接口一致（防止测试假件漂移）", () => {
  const fake = createBootstrapFake();
  assert.equal(typeof fake.run, "function");
  assert.equal(typeof fake.onPhase, "function");
  assert.equal(typeof fake.runtimeFacts, "function");
});

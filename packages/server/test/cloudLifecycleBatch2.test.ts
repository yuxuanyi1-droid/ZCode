/**
 * 生命周期 v2 第 2 批验收：paused 状态机与 resume 通路
 * （specs/cloud-agent/01 §4、03 §6、08 §3.2 的 2026-10-09 修订 + 定稿附录 A-7/B-4/B-6/D-1/E-1）。
 *
 * 覆盖：
 * - 状态机四条边与占槽（纯 domain）+ Task 能力投影（send-input/complete/reopen/archive）；
 * - 迁移 0007（E-1 表重建）：fresh 与增量同构、0001 冻结不被改写、paused CHECK、
 *   部分唯一索引对 paused 生效（3 个 paused 占「唯一有效写 run」名额）；
 * - 能力门禁（A-7）：pauseResume 按 SANDBOX_PAUSE_RESUME_GATES 实测门禁收敛（e2b 已于
 *   2026-10-09 真实账号实测解禁为 memory 级）；未实测 provider 一律 none、pause/resume
 *   路径不可达（本地能力错误，不发起 provider 请求）；paused 观测态归一；
 * - resume 通路（03 §6 修订）：paused append 接受（202）、dispatcher wait run-paused、
 *   自驱 resume → 续租 → ready；失败退避；预算耗尽拒绝（budget_exhausted）且按用户
 *   意图闭环停旧 run + checkpoint 重开（08 §7 修订 2026-10-09 第二批，串联失败降级）；
 *   能力 none 跳过（fail-closed）；暂停中停止推进（屏障复用 → draining → stopped）；
 * - keepalive liveness：paused→保持不收口；notFound→expired+释放槽；startup paused→保持；
 * - 行为表（08 §3.2 修订 2026-10-10）：complete=拒绝、archive=自动推进停止后归档
 *   （dataAtRisk 如实落库；terminate 未确认 → 409 重试）、reopen=recovery_required；
 *   markReady 幂等 ready；
 * - pause 助手（B-4 顺序冻结）：provider 未确认不写 paused；确认后 detach→CAS；
 * - 凭据续展（B-6）：extendForRun 只外推不内缩、已撤销不复活。
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  canTransitionRun,
  mayPauseRun,
  occupiesQuotaSlot,
  resumeBudgetExhausted,
  RUN_STATUS_TRANSITIONS,
} from "../src/cloud/domain/taskRunState.js";
import { deriveTaskActions } from "../src/cloud/domain/taskActions.js";
import { makeRun, buildTestPlane, attachReadySession } from "./cloudCoreFakes.js";
import { CLOUD_CORE_DEFAULTS } from "../src/cloud/app/config.js";
import type { TestPlane } from "./cloudCoreFakes.js";
import type { CloudTaskRecord } from "@zcode/shared";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";

// ── A. 状态机与占槽（纯 domain，08 §3.2 修订四条边、§6 占槽）──

test("paused 四条边进迁移表：ready→paused、paused→ready/draining/expired（08 §3.2 修订）", () => {
  assert.ok(canTransitionRun("ready", "paused"));
  assert.ok(canTransitionRun("paused", "ready"));
  assert.ok(canTransitionRun("paused", "draining"));
  assert.ok(canTransitionRun("paused", "expired"));
  // 负例：paused 不是 ready 的别名——没有 paused→stopped（停止必须先过 draining）、
  // provisioning 不进 paused（只有分级能力 provider 的 ready run 暂停）、终态不复活。
  assert.equal(canTransitionRun("paused", "stopped"), false);
  assert.equal(canTransitionRun("paused", "failed"), false);
  assert.equal(canTransitionRun("provisioning", "paused"), false);
  assert.equal(canTransitionRun("disconnected", "paused"), false);
  assert.equal(canTransitionRun("draining", "paused"), false);
  assert.equal(canTransitionRun("stopped", "paused"), false);
  // 词表完整性：每个状态都有迁移行（含 paused）。
  for (const status of Object.keys(RUN_STATUS_TRANSITIONS)) {
    assert.ok(Array.isArray(RUN_STATUS_TRANSITIONS[status as keyof typeof RUN_STATUS_TRANSITIONS]));
  }
});

test("paused 占配额槽（D-1）：quota_released_at 保持 NULL、并发 409 为预期", () => {
  assert.equal(occupiesQuotaSlot("paused"), true);
  assert.equal(occupiesQuotaSlot("stopped"), false);
  assert.equal(occupiesQuotaSlot("expired"), false);
});

test("pause 准入（08 §3.2 修订）：仅分级能力 provider 的 ready 且无停止意图 run", () => {
  const ready = makeRun({ taskId: "t", runId: "r", status: "ready" });
  const stoppedIntent = makeRun({ taskId: "t", runId: "r", status: "ready", stopRequested: true });
  assert.equal(mayPauseRun({ run: ready, pauseResume: "memory" }), true);
  assert.equal(mayPauseRun({ run: ready, pauseResume: "disk" }), true);
  assert.equal(mayPauseRun({ run: ready, pauseResume: "none" }), false);
  assert.equal(mayPauseRun({ run: stoppedIntent, pauseResume: "memory" }), false);
  assert.equal(
    mayPauseRun({
      run: makeRun({ taskId: "t", runId: "r", status: "paused" }),
      pauseResume: "memory",
    }),
    false,
  );
});

test("resume 预算判定（03 §6 修订）：暂停预算（硬期限）耗尽 → 拒绝 budget_exhausted", () => {
  const now = 10_000;
  assert.equal(
    resumeBudgetExhausted({
      run: makeRun({ taskId: "t", runId: "r", hardDeadlineAt: 9_999 }),
      now,
    }),
    true,
  );
  assert.equal(
    resumeBudgetExhausted({
      run: makeRun({ taskId: "t", runId: "r", hardDeadlineAt: 10_000 }),
      now,
    }),
    true,
  );
  assert.equal(
    resumeBudgetExhausted({
      run: makeRun({ taskId: "t", runId: "r", hardDeadlineAt: 10_001 }),
      now,
    }),
    false,
  );
  // 无硬期限事实时不猜（保持可 resume；liveness 兜底终局）。
  assert.equal(resumeBudgetExhausted({ run: makeRun({ taskId: "t", runId: "r" }), now }), false);
});

test("Task 能力投影（paused）：send-input/stop 可用、archive 放行、complete/reopen 不投影（08 §3.2 修订 2026-10-10 同表）", () => {
  const task = {
    taskId: "t1",
    status: "active",
    revision: 3,
    workspaceIdentity: "cloud-task:t1",
    baseSha: "a".repeat(40),
    taskBranch: "cloud/t1",
  } as CloudTaskRecord;
  const pausedRun = makeRun({ taskId: "t1", runId: "r1", status: "paused" });
  const actions = deriveTaskActions({
    task,
    activeRun: pausedRun,
    unsettledInputCount: 0,
    artifact: null,
  });
  assert.ok(actions.includes("send-input"));
  assert.ok(actions.includes("stop"));
  assert.ok(actions.includes("force-stop"));
  assert.ok(
    actions.includes("archive"),
    "paused 投影 archive（归档是用户结束任务的显式意图，2026-10-10 修订）",
  );
  assert.equal(
    actions.includes("complete"),
    false,
    "complete 拒绝不变：须先 resume 或完成停止收口",
  );
  assert.equal(actions.includes("reopen"), false);
});

// ── B. 迁移 0007（E-1：表重建；0001 冻结不被改写）──

test("0001 冻结：status CHECK 词表不含 paused（E-1 原地改写否决）", async () => {
  const { CLOUD_MIGRATIONS } = await import("../src/cloud/adapters/storage/sqlite/schema.js");
  const initial = CLOUD_MIGRATIONS.find((migration) => migration.id.startsWith("0001"));
  assert.ok(initial);
  assert.equal(
    initial.statements.some((statement) => statement.includes("'paused'")),
    false,
    "0001 已应用即冻结：paused 只能由 0007 落地",
  );
  const migration0007 = CLOUD_MIGRATIONS.find(
    (migration) => migration.id === "0007_run_status_paused",
  );
  assert.ok(migration0007, "0007_run_status_paused 在迁移链上");
});

test("0007 表重建：fresh 与增量（0006 前缀）同构，paused CHECK 与部分索引落地", async () => {
  const { openTestStorage, removeTestRoot } = await import("./cloudStorageHarness.js");
  const { openStorageDatabase, closeStorageDatabase } =
    await import("../src/cloud/adapters/storage/sqlite/database.js");
  const { runCloudMigrations, readCloudMigrationFacts } =
    await import("../src/cloud/adapters/storage/sqlite/migrations.js");
  const handle = await openTestStorage();
  try {
    const freshPath = path.join(handle.dataDir, "b2-fresh.db");
    const fresh = openStorageDatabase({ path: freshPath });
    try {
      runCloudMigrations(fresh, { now: 1 });
      const facts = readCloudMigrationFacts(fresh);
      assert.equal(facts.schemaVersion, 7);
      assert.deepEqual(facts.pendingMigrationIds, []);
      const runsDdl = String(
        fresh.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs'").get()?.["sql"],
      );
      assert.ok(runsDdl.includes("'paused'"), "runs CHECK 含 paused");
      const writerIndex = String(
        fresh.db
          .prepare("SELECT sql FROM sqlite_master WHERE name = 'runs_single_active_writer'")
          .get()?.["sql"],
      );
      assert.ok(writerIndex.includes("'paused'"), "唯一有效写 run 部分索引含 paused");
      const scanIndex = String(
        fresh.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs_recovery_scan'").get()?.[
          "sql"
        ],
      );
      assert.ok(scanIndex.includes("'paused'"), "恢复扫描部分索引含 paused");
      // paused 行可写入新 CHECK。
      fresh.db.exec(
        `INSERT INTO principals (principal_id, created_at, updated_at) VALUES ('p1', 1, 1);
         INSERT INTO projects (project_id, owner_principal_id, kind, repository_id, repo_owner, repo_name, revision, created_at, updated_at)
           VALUES ('pr1', 'p1', 'github-repo', 1, 'o', 'n', 0, 1, 1);
         INSERT INTO tasks (task_id, owner_principal_id, project_id, title, status, creation_key, workspace_identity, next_run_generation, revision, created_at, updated_at)
           VALUES ('t1', 'p1', 'pr1', 'T', 'active', 'ck1', 'cloud-task:t1', 2, 1, 1, 1);
         INSERT INTO runs (run_id, task_id, run_generation, execution_kind, provider, status, connection_epoch, data_at_risk, created_at, updated_at)
           VALUES ('r1', 't1', 1, 'sandbox', 'e2b', 'paused', 1, 0, 1, 1);`,
      );
      // paused 占「唯一有效写 run」名额：同 task 第二个活动状态写入被部分唯一索引拒绝。
      assert.throws(() => {
        fresh.db.exec(
          `INSERT INTO runs (run_id, task_id, run_generation, execution_kind, provider, status, connection_epoch, data_at_risk, created_at, updated_at)
           VALUES ('r2', 't1', 2, 'sandbox', 'e2b', 'ready', 1, 0, 1, 1);`,
        );
      });
    } finally {
      closeStorageDatabase(fresh);
    }

    // 增量路径（旧二进制的 0006 库）补 0007 后同一 schema：既有 ready 行数据保留。
    const incrementalPath = path.join(handle.dataDir, "b2-incremental.db");
    const incremental = openStorageDatabase({ path: incrementalPath });
    try {
      const { SCHEMA_MIGRATIONS_DDL, migrationChecksum } =
        await import("../src/cloud/adapters/storage/sqlite/migrations.js");
      const { CLOUD_MIGRATIONS, RETIRED_MIGRATIONS } =
        await import("../src/cloud/adapters/storage/sqlite/schema.js");
      incremental.db.exec(SCHEMA_MIGRATIONS_DDL);
      const timeline = [
        ...CLOUD_MIGRATIONS.map((migration) => ({ id: migration.id, migration })),
        ...RETIRED_MIGRATIONS.map((entry) => ({ id: entry.id, migration: null })),
      ].sort((left, right) => (left.id < right.id ? -1 : 1));
      for (const entry of timeline) {
        if (entry.id >= "0007") break;
        incremental.db
          .prepare(
            "INSERT INTO schema_migrations (id, ordinal, checksum, retired, applied_at) VALUES (?, ?, ?, ?, 1)",
          )
          .run(
            entry.id,
            Number.parseInt(entry.id.slice(0, 4), 10),
            entry.migration ? migrationChecksum(entry.migration) : "retired",
            entry.migration ? 0 : 1,
          );
        if (entry.migration) {
          for (const statement of entry.migration.statements) incremental.db.exec(statement);
        }
      }
      incremental.db.exec(
        `INSERT INTO principals (principal_id, created_at, updated_at) VALUES ('p1', 1, 1);
         INSERT INTO projects (project_id, owner_principal_id, kind, repository_id, repo_owner, repo_name, revision, created_at, updated_at)
           VALUES ('pr1', 'p1', 'github-repo', 1, 'o', 'n', 0, 1, 1);
         INSERT INTO tasks (task_id, owner_principal_id, project_id, title, status, creation_key, workspace_identity, next_run_generation, revision, created_at, updated_at)
           VALUES ('t1', 'p1', 'pr1', 'T', 'active', 'ck1', 'cloud-task:t1', 2, 1, 1, 1);
         INSERT INTO runs (run_id, task_id, run_generation, execution_kind, provider, status, connection_epoch, data_at_risk, created_at, updated_at)
           VALUES ('r1', 't1', 1, 'sandbox', 'e2b', 'ready', 1, 0, 1, 1);`,
      );
      runCloudMigrations(incremental, { now: 2 });
      const rebuilt = incremental.db
        .prepare("SELECT status, stop_requested, data_at_risk FROM runs WHERE run_id = 'r1'")
        .get();
      // better-sqlite3 行是 null-prototype 对象：逐字段断言（数据经重建不丢）。
      assert.equal(rebuilt?.["status"], "ready");
      assert.equal(rebuilt?.["stop_requested"], 0);
      assert.equal(rebuilt?.["data_at_risk"], 0);
      assert.equal(
        String(
          incremental.db.prepare("SELECT sql FROM sqlite_master WHERE name = 'runs'").get()?.[
            "sql"
          ],
        ).includes("'paused'"),
        true,
      );
    } finally {
      closeStorageDatabase(incremental);
    }
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

// ── C. 能力门禁（A-7）：未实测一律 none，pause/resume 路径不可达 ──

test("A-7 门禁：能力声明按门禁常量收敛（e2b 已实测解禁、daytona 未实测保持 none）；未实测 provider 的 pause/resume 抛能力错误且不触网", async () => {
  const { createE2bSandboxDriver } = await import("../src/cloud/adapters/sandbox/e2bDriver.js");
  const { createDaytonaSandboxDriver } =
    await import("../src/cloud/adapters/sandbox/daytonaDriver.js");
  const { CloudAdapterError } = await import("../src/cloud/adapters/sandbox/adapterError.js");
  const { resolvePauseResumeCapability } =
    await import("../src/cloud/adapters/sandbox/capabilities.js");
  const calls: string[] = [];
  const fetchSpy = (async () => {
    calls.push("provider-request");
    throw new Error("provider must not be reached while gated");
  }) as unknown as Parameters<typeof createE2bSandboxDriver>[0]["fetch"];
  assert.ok(fetchSpy);
  const handle = { provider: "e2b", sandboxId: "sbx-1" };

  const e2b = createE2bSandboxDriver({
    apiKey: async () => "key",
    fetch: fetchSpy,
    now: () => 1_800_000_000_000,
  });
  // 能力声明与门禁常量同源（不硬编码分级）：describeCapabilities 经 resolvePauseResumeCapability 收敛。
  const e2bLevel = resolvePauseResumeCapability("e2b");
  assert.equal((await e2b.describeCapabilities()).pauseResume, e2bLevel);
  if (e2bLevel === "none") {
    await assert.rejects(
      () => e2b.pause(handle),
      (error: unknown) =>
        error instanceof CloudAdapterError &&
        error.code === "resource_unsupported" &&
        error.message.includes("capability-not-enabled"),
    );
    await assert.rejects(
      () => e2b.resume(handle, 1_800_000_000_000 + 60_000),
      (error: unknown) =>
        error instanceof CloudAdapterError && error.code === "resource_unsupported",
    );
  } else {
    // 已实测解禁：路径可达——pause/resume 真正发起 provider 请求；本测试的 fetch 桩
    // 失败被 wire 层归一为 unknown 观察（而不是本地能力错误），证明门禁不再拦截。
    const paused = await e2b.pause(handle);
    assert.equal(
      paused.status,
      "unknown",
      "门禁开启后 pause 到达 provider 通路（桩失败归 unknown）",
    );
    const resumed = await e2b.resume(handle, 1_800_000_000_000 + 60_000);
    assert.equal(
      resumed.status,
      "unknown",
      "门禁开启后 resume 到达 provider 通路（桩失败归 unknown）",
    );
  }

  const daytona = createDaytonaSandboxDriver({
    apiKey: async () => "key",
    fetch: fetchSpy,
    now: () => 1_800_000_000_000,
  });
  assert.equal(
    (await daytona.describeCapabilities()).pauseResume,
    resolvePauseResumeCapability("daytona"),
  );
  assert.equal(resolvePauseResumeCapability("daytona"), "none", "daytona 未实测，门禁保持关闭");
  await assert.rejects(() => daytona.pause(handle), CloudAdapterError);
  await assert.rejects(() => daytona.resume(handle, 1_800_000_000_000 + 60_000), CloudAdapterError);
  // 全部 provider 请求来自已解禁的 e2b 通路（未实测时为 0）；daytona 门禁本地拦截，绝不触网。
  assert.equal(calls.length, e2bLevel === "none" ? 0 : 2, "daytona 门禁拦截不产生 provider 请求");
});

test("paused 观测态归一：e2b/daytona 的 provider paused 不再归 stopped（N-P1）", async () => {
  const { mapE2bSandboxState } = await import("../src/cloud/adapters/sandbox/e2bRest.js");
  const { mapDaytonaSandboxState } = await import("../src/cloud/adapters/sandbox/daytonaRest.js");
  assert.equal(mapE2bSandboxState("paused"), "paused");
  assert.equal(mapE2bSandboxState("running"), "running");
  assert.equal(mapE2bSandboxState("stopped"), "stopped");
  assert.equal(mapDaytonaSandboxState("paused"), "paused");
  assert.equal(mapDaytonaSandboxState("pausing"), "paused");
  assert.equal(mapDaytonaSandboxState("stopped"), "stopped");
  assert.equal(mapDaytonaSandboxState("destroyed"), "notFound");
});

// ── D. 控制面通路（03 §6 修订：append/dispatcher/resume/停止/keepalive/startup）──

/** 走完 start → create → ready，再转入 paused（默认经 pause 助手，同时覆盖 B-4）。 */
async function pausedRun(
  context: TestPlane,
  options: { index?: number; viaHelper?: boolean } = {},
): Promise<{ taskId: string; runId: string; runGeneration: number }> {
  const index = options.index ?? 1;
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Paused flow",
    creationKey: `ck-paused-${index}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-0000000000d${index}`,
      prompt: "first prompt",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  const runId = submit.value.runId ?? "";
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  await attachReadySession(context, {
    taskId: task.value.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
  });
  const ready = await context.plane.runs.markReady({
    taskId: task.value.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.ok(ready.ok);

  if (options.viaHelper === false) {
    // 直接 CAS（绕过助手，用于能力门禁关闭场景：none provider 不该走 pause 助手）。
    const paused = await context.storage.runs.transitionStatus({
      runId: run.runId,
      runGeneration: run.runGeneration,
      from: ["ready"],
      to: "paused",
      endReason: "test-pause",
      now: context.clock.now(),
    });
    assert.ok(paused);
  } else {
    assert.equal(
      context.driver.pauseResume,
      "none",
      "fake 缺省关闭；生产 provider 分级由门禁常量决定",
    );
    context.driver.pauseResume = "memory";
    const paused = await context.plane.lifecycle.pauseResume.pauseRun({
      taskId: task.value.taskId,
      runId: run.runId,
      reason: "idle-pause",
    });
    assert.ok(paused.ok, `pauseRun 失败：${paused.ok === false ? paused.reason : ""}`);
  }
  const after = await context.storage.runs.get(runId);
  assert.equal(after?.status, "paused");
  return { taskId: task.value.taskId, runId: run.runId, runGeneration: run.runGeneration };
}

test("paused append 接受（03 §6 修订）：202 持久接收、同 run 同 generation、delivery 保持 accepted", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  const task = await context.storage.tasks.get(session.taskId);
  assert.ok(task);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId: "00000000-0000-4000-8000-0000000000e1",
      prompt: "continue please",
      expectedRunGeneration: session.runGeneration,
    },
  });
  assert.ok(submit.ok, `append 被拒：${submit.ok === false ? submit.reason : ""}`);
  assert.equal(submit.value.runId, session.runId, "同 run：不换代、不重开");
  const input = await context.storage.inputs.get(session.taskId, submit.value.commandId);
  assert.equal(input?.deliveryStatus, "accepted");
});

test("dispatcher 对 paused 维持 wait（reason=run-paused），投递屏障不解（03 §6 修订）", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId: "00000000-0000-4000-8000-0000000000e2",
      prompt: "continue please",
      expectedRunGeneration: session.runGeneration,
    },
  });
  const report = await context.plane.delivery.dispatchTask(session.taskId);
  assert.equal(report.outcomes.length, 1);
  assert.equal(report.outcomes[0]?.result, "wait");
  assert.equal(report.outcomes[0]?.reason, "run-paused");
  // 首条（start）输入同样不投递：暂停态无 attachment。
  const firstInput = await context.storage.inputs.get(
    session.taskId,
    "00000000-0000-4000-8000-0000000000d1",
  );
  assert.ok(firstInput);
});

test("自驱 resume：deliverable 输入 + memory 能力 → resume → 续租 → paused→ready CAS（B-6）", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId: "00000000-0000-4000-8000-0000000000e3",
      prompt: "wake up",
      expectedRunGeneration: session.runGeneration,
    },
  });
  context.driver.pauseResume = "memory";
  const before = await context.storage.runs.get(session.runId);
  assert.ok(before);
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.resumed, 1);
  assert.equal(context.driver.resumeCalls, 1);
  assert.ok(context.driver.lastResumeDeadline, "resume 携带请求寿命（01 §4.1 修订签名）");
  const after = await context.storage.runs.get(session.runId);
  assert.equal(after?.status, "ready", "paused→ready CAS 落地");
  // B-6 续租：expiresAt 收敛到 min(now+预算, hardDeadlineAt)。
  const expectedDeadline = Math.min(
    context.clock.now() + 4 * 60 * 60 * 1000,
    before.hardDeadlineAt ?? Number.POSITIVE_INFINITY,
  );
  assert.equal(after?.expiresAt, expectedDeadline);
});

test("resume 失败停留 paused 退避重试；notFound 交 keepalive liveness（不写终态）", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId: "00000000-0000-4000-8000-0000000000e4",
      prompt: "wake up",
      expectedRunGeneration: session.runGeneration,
    },
  });
  context.driver.pauseResume = "memory";
  context.driver.resumeObservationStatus = "unknown";
  const first = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(first.resumed, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
  // 退避窗口内不重复打 provider。
  const second = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(second.resumed, 0);
  assert.equal(context.driver.resumeCalls, 1);
  // notFound：同样不写终态（唯一收口入口是 keepalive liveness / settleTerminal）。
  context.driver.resumeObservationStatus = "notFound";
  await context.clock.advance(60_000);
  const third = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(third.resumed, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
});

test("resume × 预算耗尽 + 用户显式输入：停旧 run → 以该消息 checkpoint 重开（08 §7 修订第二批）", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId: "00000000-0000-4000-8000-0000000000e5",
      prompt: "too late",
      expectedRunGeneration: session.runGeneration,
    },
  });
  context.driver.pauseResume = "memory";
  const run = await context.storage.runs.get(session.runId);
  assert.ok(run?.hardDeadlineAt, "start 接纳事务已落硬期限（D4-7）");
  context.clock.set(run.hardDeadlineAt + 1);
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.budgetExhausted, 1);
  assert.equal(context.driver.resumeCalls, 0, "预算耗尽不再发起 resume");
  // 用户意图闭环（08 §7 修订 2026-10-09 第二批）：停旧 run → 串联 reopen，输入不丢。
  assert.equal(report.budgetExhaustedReopened, 1);
  const closed = await context.storage.runs.get(session.runId);
  assert.equal(closed?.status, "stopped", "旧 run 经暂停中停止推进收口终态");
  assert.equal(closed?.stopRequested, true, "复用持久停止屏障（08 §8.1）");
  assert.ok(context.driver.terminateCalls >= 1, "暂停态直接 terminate（无 checkpoint 前置）");
  // 原输入：内容已由 reopen 承接，终态扫口如实收口 cancelled（不静默丢弃）。
  const oldInput = await context.storage.inputs.get(
    session.taskId,
    "00000000-0000-4000-8000-0000000000e5",
  );
  assert.equal(oldInput?.deliveryStatus, "cancelled");
  // 新 run：同一 durable gateway 的 reopen input，prompt=用户消息（checkpoint 恢复语义
  // 按持久事实自动选：无 checkpoint → restart-from-base）。
  const deliverable = await context.storage.inputs.listDeliverable(session.taskId);
  const reopenInput = deliverable.find((input) => input.intent === "reopen");
  assert.ok(reopenInput, "串联 reopen input 已被同一 gateway 接纳");
  assert.equal(reopenInput.deliveryStatus, "accepted");
  const payload = await context.storage.payloads.readInputPayload({
    taskId: session.taskId,
    commandId: reopenInput.commandId,
  });
  assert.equal(payload?.prompt, "too late", "用户消息原文随 reopen 首条投递");
  assert.notEqual(reopenInput.commandId, "00000000-0000-4000-8000-0000000000e5");
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created", "新 run 已进入 provisioning");
});

test("预算耗尽闭环串联失败降级：run 已终态，reopen 被拒不重试（reopenable 投影接管）", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId: "00000000-0000-4000-8000-0000000000e7",
      prompt: "too late",
      expectedRunGeneration: session.runGeneration,
    },
  });
  context.driver.pauseResume = "memory";
  // 让 reopen 预检失败：清掉冻结基线（task-baseline-not-frozen）。
  const staleBaseline = context.storage.tasksById.get(session.taskId);
  assert.ok(staleBaseline);
  const degradedTask: CloudTaskRecord = { ...staleBaseline };
  delete (degradedTask as Partial<CloudTaskRecord>).baseSha;
  delete (degradedTask as Partial<CloudTaskRecord>).taskBranch;
  context.storage.tasksById.set(session.taskId, degradedTask);
  const run = await context.storage.runs.get(session.runId);
  assert.ok(run?.hardDeadlineAt);
  context.clock.set(run.hardDeadlineAt + 1);
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.budgetExhausted, 1);
  assert.equal(report.budgetExhaustedReopened, 0, "串联被拒不计数、不重试");
  assert.equal((await context.storage.runs.get(session.runId))?.status, "stopped");
  // 新输入不存在：终态后 UI 以 reopenable 投影 + 手动重开接管。
  const deliverable = await context.storage.inputs.listDeliverable(session.taskId);
  assert.equal(
    deliverable.some((input) => input.intent === "reopen"),
    false,
  );
});

test("能力门禁关闭（pauseResume=none）：resume 路径不可达（fail-closed，gatedSkipped）", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context, { viaHelper: false });
  await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    source: "http",
    request: {
      intent: "append",
      commandId: "00000000-0000-4000-8000-0000000000e6",
      prompt: "wake up",
      expectedRunGeneration: session.runGeneration,
    },
  });
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.resumed, 0);
  assert.ok(report.gatedSkipped >= 1);
  assert.equal(context.driver.resumeCalls, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
});

test("暂停中停止即时推进（第 2 批遗留 1）：stop 受理即 terminate → stopped，不等生命周期拍", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  // stop 受理：beginDrain 写屏障并推进 paused→draining，随后与 pauseResume 拍共用同一
  // 推进实现（advancePausedStop）直接 terminate + 收口——HTTP 响应即反映终态推进。
  const result = await context.plane.commands.stop.stopTask({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.ok(result.ok);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.stopRequested, true);
  assert.ok(run?.stopOperationId, "持久屏障已写（复用 stopOperationId）");
  assert.equal(run?.status, "stopped", "受理路径即时推进，不再等 ≤30s tick");
  assert.ok(context.driver.terminateCalls >= 1, "暂停态直接 terminate（无 checkpoint 前置）");
  assert.equal(
    run?.dataAtRisk,
    true,
    "暂停态无运行时写入可收口：checkpoint 未能执行，如实标 dataAtRisk（08 §8.2）",
  );
  assert.ok(context.storage.quotaReleases.includes(session.runId), "provider 确认终止后释放槽");
  // 保存通路未启动：暂停态对 checkpoint 通道零请求（无「永不结算的 checkpoint 意图」）。
  assert.equal(context.attachmentPort.checkpoints.length, 0);
});

test("暂停中停止 tick 兜底：屏障先行（未经 stopTask）时 sweep 用同一实现推进", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  // 只写持久屏障（模拟 stop 受理后进程重启、推进未完成的形态）。
  await context.storage.runs.requestStop({
    taskId: session.taskId,
    operationId: "00000000-0000-4000-8000-0000000000b9",
    now: context.clock.now(),
  });
  const report = await context.plane.lifecycle.pauseResume.sweep();
  assert.equal(report.stopAdvanced, 1);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "stopped");
  assert.ok(context.driver.terminateCalls >= 1);
});

test("keepalive liveness：paused 观察 → 保持 paused 不收口；notFound → expired + 释放槽（终局）", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  context.driver.inspectStatus = "paused";
  const keepReport = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(keepReport.instancesLost, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
  assert.equal(context.storage.quotaReleases.length, 0);

  // 保留期尽：provider 确认实例不存在 → expired 并释放占槽（03 §6 修订终局）。
  context.driver.inspectStatus = "notFound";
  await context.clock.advance(120_000);
  const lostReport = await context.plane.lifecycle.keepalive.sweep();
  assert.equal(lostReport.instancesLost, 1);
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "expired");
  assert.equal(run?.dataAtRisk, true);
  assert.ok(context.storage.quotaReleases.includes(session.runId));
});

test("startup 对账：paused 观察 → 保持 paused（不收口、不标 disconnected）", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  context.driver.inspectStatus = "paused";
  const summary = await context.plane.reconciler.reconcileOnStartup();
  assert.equal(summary.alive, 1);
  assert.equal(summary.settled, 0);
  assert.equal((await context.storage.runs.get(session.runId))?.status, "paused");
});

test("行为表（08 §3.2 修订 2026-10-10）：paused 的 complete=拒绝；archive=自动推进停止后归档（dataAtRisk 如实落库）；reopen=recovery_required", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  const completed = await context.plane.commands.taskLifecycle.completeTask({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.equal(completed.ok, false);
  assert.equal(completed.ok === false && completed.reason, "run-paused-resume-or-stop-required");
  // complete 拒绝不得启动保存通路（暂停态无 checkpoint 前置可执行）。
  assert.equal(context.attachmentPort.checkpoints.length, 0);

  // paused（未终态、占槽）拒绝重开：行为表 reopen 行不变（08 §9 修订 2026-10-09）。
  const pausedTask = await context.storage.tasks.get(session.taskId);
  assert.ok(pausedTask);
  const reopenPaused = await context.plane.commands.reopen.verifyReopenEligibility(pausedTask);
  assert.equal(reopenPaused.ok, false);
  assert.equal(
    reopenPaused.ok === false && reopenPaused.code,
    "recovery_required",
    "旧 run 未终态：拒绝重开（不换代）",
  );

  // 归档 = 用户结束任务的显式意图：自动推进暂停中停止（屏障 + terminate + stopped 收口）
  // 后完成归档，HTTP 响应返回归档完成后的任务详情（03 §6 修订 2026-10-10）。
  const archived = await context.plane.commands.taskLifecycle.archiveTask({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.ok(archived.ok, `paused 归档应成功：${archived.ok === false ? archived.code : ""}`);
  assert.equal(
    archived.ok === true && archived.value.task.status,
    "archived",
    "响应即归档完成后的任务详情",
  );
  assert.ok(
    (archived.ok === true ? archived.value.actions : []).includes("archive") === false,
    "归档后 actions 不再含 archive",
  );
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.stopRequested, true, "归档驱动停止写持久屏障");
  assert.ok(run?.stopOperationId, "屏障复用 stopOperationId（08 §8.1）");
  assert.equal(run?.status, "stopped", "暂停中停止推进完成（paused→draining→stopped）");
  assert.equal(
    run?.dataAtRisk,
    true,
    "暂停态无运行时写入可收口：checkpoint 未能执行，dataAtRisk 如实落库（08 §8.2）",
  );
  assert.ok(context.driver.terminateCalls >= 1, "暂停态直接 terminate（无 checkpoint 前置）");
  assert.equal(context.attachmentPort.checkpoints.length, 0, "归档驱动的停止不走保存通路");
  assert.ok(context.storage.quotaReleases.includes(session.runId), "provider 确认终止后释放槽");

  // 归档后的详情投影（同库事实）：无活动 run、actions 不再含 archive。
  const detail = await context.plane.taskDetail.getDetail({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.ok(detail.ok);
  assert.equal(detail.ok === true && detail.value.actions.includes("archive"), false);
});

test("行为表（08 §3.2 修订 2026-10-10）：paused 归档时 terminate 未确认 → 409 让 UI 重试，run 留 draining", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  // provider 明确拒绝终止（如 403/402）：advancePausedStop 拿不到 terminated 确认。
  context.driver.terminateStatus = "notTerminated";
  const archived = await context.plane.commands.taskLifecycle.archiveTask({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.equal(archived.ok, false, "terminate 未确认：归档不完成");
  assert.equal(archived.ok === false && archived.code, "not_ready");
  assert.equal(archived.ok === false && archived.reason, "task-has-active-run");
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "draining", "run 留 draining 占槽，由 stop/compensation sweep 收口");
  assert.equal(run?.stopRequested, true, "屏障已写（重试时复用同一 stopOperationId）");
  const task = await context.storage.tasks.get(session.taskId);
  assert.equal(task?.status, "active", "task 未被归档（UI 重试路径）");
});

test("markReady 幂等 ready（resume 后 bridge.ready 重发不回 fault）：直接 ok 且 registry ready", async () => {
  const context = buildTestPlane();
  const session = await pausedRun(context);
  // pause 助手已 detach registry；模拟 resume 后沙箱回连（新 epoch 注册 + bootstrap 下发）。
  context.driver.pauseResume = "memory";
  await context.plane.lifecycle.pauseResume.sweep();
  const run = await context.storage.runs.get(session.runId);
  assert.equal(run?.status, "ready");
  await attachReadySession(context, {
    taskId: session.taskId,
    runId: session.runId,
    runGeneration: session.runGeneration,
    connectionEpoch: run?.connectionEpoch ?? 1,
  });
  const republished = await context.plane.runs.markReady({
    taskId: session.taskId,
    runId: session.runId,
    runGeneration: session.runGeneration,
    connectionEpoch: run?.connectionEpoch ?? 1,
  });
  assert.ok(
    republished.ok,
    `已 ready 的重发应幂等成功：${republished.ok === false ? republished.reason : ""}`,
  );
});

// ── E. pause 助手（B-4 顺序冻结）──

test("B-4：provider 未确认 paused → 不写 run=paused（fail-closed）；确认后 detach + CAS", async () => {
  const context = buildTestPlane();
  await pausedRun(context, { viaHelper: false });
  // 上一段已把 run 置 paused；再建一条 ready run 验证助手。
  const context2 = buildTestPlane();
  context2.driver.pauseResume = "memory";
  context2.driver.pauseObservationStatus = "unknown";
  const ready = await readyRunInContext(context2, 2);
  const failed = await context2.plane.lifecycle.pauseResume.pauseRun({
    taskId: ready.taskId,
    runId: ready.runId,
    reason: "idle-pause",
  });
  assert.equal(failed.ok, false, "观察 unknown 且无 paused 确认：不得写 run=paused");
  assert.equal((await context2.storage.runs.get(ready.runId))?.status, "ready");
  assert.equal(context2.plane.attachments.current(ready.runId)?.ready, true, "registry 未被误摘");

  // 确认分支：paused 观察 → detach registry → CAS ready→paused。
  context2.driver.pauseObservationStatus = "paused";
  const okResult = await context2.plane.lifecycle.pauseResume.pauseRun({
    taskId: ready.taskId,
    runId: ready.runId,
    reason: "idle-pause",
  });
  assert.ok(okResult.ok);
  assert.equal((await context2.storage.runs.get(ready.runId))?.status, "paused");
  assert.equal(
    context2.plane.attachments.current(ready.runId),
    null,
    "B-4：CAS 前 detach registry",
  );
  assert.equal(context2.driver.pauseCalls >= 1, true);
});

async function readyRunInContext(context: TestPlane, index: number) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "B4 helper",
    creationKey: `ck-b4-${index}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-0000000000f${index}`,
      prompt: "work",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  const runId = submit.value.runId ?? "";
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "created");
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  await attachReadySession(context, {
    taskId: task.value.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
  });
  const ready = await context.plane.runs.markReady({
    taskId: task.value.taskId,
    runId: run.runId,
    runGeneration: run.runGeneration,
    connectionEpoch: run.connectionEpoch,
  });
  assert.ok(ready.ok);
  return { taskId: task.value.taskId, runId: run.runId, runGeneration: run.runGeneration };
}

// ── F. 凭据续展（B-6，SQLite 真实 repo）──

test("extendForRun（B-6）：只外推不内缩；已撤销不复活；无凭据返回 false", async () => {
  const { openTestStorage, removeTestRoot, seedDraftTask, seedActiveRun, newUuid } =
    await import("./cloudStorageHarness.js");
  const handle = await openTestStorage();
  try {
    const seeded = await seedDraftTask(handle.storage);
    const run = await seedActiveRun(handle.storage, seeded);
    const credentials = handle.storage.storage.credentials;
    const initialExpires = 5_000;
    await credentials.saveInitial({
      runId: run.runId,
      runGeneration: 1,
      credentialHash: "c".repeat(64),
      expiresAt: initialExpires,
      bootstrapOperationId: newUuid(),
    });
    // 外推：新期限更晚 → 生效。
    assert.equal(await credentials.extendForRun({ runId: run.runId, expiresAt: 9_000 }), true);
    // 内缩被拒：更早的值不缩短现值（MAX 口径）。
    assert.equal(await credentials.extendForRun({ runId: run.runId, expiresAt: 1_000 }), true);
    // 撤销后续展不复活凭据。
    await credentials.revokeRun({ runId: run.runId, reason: "test" });
    assert.equal(await credentials.extendForRun({ runId: run.runId, expiresAt: 99_000 }), false);
    // 无凭据 run。
    assert.equal(await credentials.extendForRun({ runId: newUuid(), expiresAt: 1 }), false);
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

// ── G. 对账锚点（C-3 追加项）：readiness/startup 的 findCreateResult 必须传持久锚点 ──

/** start 后让 create 结果未知（资源可能已建）：run 停在 provisioning 且无 handle。 */
async function provisioningWithoutHandle(context: TestPlane, index: number) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Anchor flow",
    creationKey: `ck-anchor-${index}`,
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: `00000000-0000-4000-8000-0000000000a${index}`,
      prompt: "work",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  context.driver.createOutcome = "throw-unknown";
  // create 抛错后的即时对账先回 unknown（对账窗口内不判 notFound——01 §4.1）。
  context.driver.findCreateResultOutcome = "unknown";
  const created = await context.plane.provisioning.create.runCreateOnce();
  assert.equal(created?.outcome, "unknown");
  const runId = submit.value.runId ?? "";
  const run = await context.storage.runs.get(runId);
  assert.equal(run?.providerHandle, undefined, "create 结果未知：handle 未落地");
  return { taskId: task.value.taskId, runId };
}

test("C-3 锚点：readiness 对账传 create op 的持久 createdAt；op 缺失时不传（保守 unknown）", async () => {
  const context = buildTestPlane();
  const session = await provisioningWithoutHandle(context, 1);
  const createOperation = await context.outbox.findByKey(`create:${session.runId}`);
  assert.ok(createOperation);
  context.driver.findCreateResultOutcome = "notFound";
  // 越过 readiness soft timeout（默认 120s）触发对账（create 抛错时已对账过一次）。
  context.clock.advance(CLOUD_CORE_DEFAULTS.readinessSoftTimeoutMs + 1_000);
  const callsBeforeReadiness = context.driver.findCreateResultCalls;
  await context.plane.provisioning.readiness.sweep();
  assert.equal(context.driver.findCreateResultCalls, callsBeforeReadiness + 1);
  assert.equal(
    context.driver.lastFindCreateResultOptions?.operationAttemptedAtMs,
    createOperation.createdAt,
    "锚点 = 持久 operation 行的 createdAt（跨实例可判 notFound）",
  );

  // op 缺失：不传锚点，findCreateResult 保守回 unknown（不猜「未创建」）。
  const context2 = buildTestPlane();
  const session2 = await provisioningWithoutHandle(context2, 2);
  const op2 = await context2.outbox.findByKey(`create:${session2.runId}`);
  assert.ok(op2);
  context2.outbox.records.delete(op2.operationId);
  context2.driver.findCreateResultOutcome = "notFound";
  context2.clock.advance(CLOUD_CORE_DEFAULTS.readinessSoftTimeoutMs + 1_000);
  const callsBeforeReadiness2 = context2.driver.findCreateResultCalls;
  await context2.plane.provisioning.readiness.sweep();
  assert.equal(context2.driver.findCreateResultCalls, callsBeforeReadiness2 + 1);
  assert.equal(
    context2.driver.lastFindCreateResultOptions?.operationAttemptedAtMs,
    undefined,
    "op 缺失时不传锚点",
  );
});

test("C-3 锚点：startup 对账同样传 create op 的持久 createdAt（跨重启可用）", async () => {
  const context = buildTestPlane();
  const session = await provisioningWithoutHandle(context, 3);
  const createOperation = await context.outbox.findByKey(`create:${session.runId}`);
  assert.ok(createOperation);
  context.driver.findCreateResultOutcome = "notFound";
  const callsBeforeStartup = context.driver.findCreateResultCalls;
  const summary = await context.plane.reconciler.reconcileOnStartup();
  assert.equal(context.driver.findCreateResultCalls, callsBeforeStartup + 1);
  assert.equal(
    context.driver.lastFindCreateResultOptions?.operationAttemptedAtMs,
    createOperation.createdAt,
  );
  assert.equal(summary.settled, 1, "锚点在手 + 查无资源：可安全判 notFound 并收口");
});

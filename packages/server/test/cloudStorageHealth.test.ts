/**
 * 存储健康门、worker 传输与故障路径验收（W2 §4/§6、03 §4/§8、10 §6 B07、CP-02）。
 *
 * 断言：真实 worker 线程与进程内传输跑同一语义；写竞争由数据库裁决（只有一个有效写
 * run）；磁盘满 / worker 故障 / 只读目录都 fail closed —— 不返回 accepted、不留下
 * 输入行与 provider 创建意图。另含 `synchronous=FULL` 与 `NORMAL` 的吞吐实测输出
 * （W2 §8 风险项的真实数据来自本用例）。
 */
import assert from "node:assert/strict";
import { chmod } from "node:fs/promises";
import test from "node:test";
import {
  fakeGitSha,
  fakeSha256,
  newUuid,
  nextNow,
  openTestStorage,
  removeTestRoot,
  seedDraftTask,
  TEST_NOW,
} from "./cloudStorageHarness.js";
import { createCloudStorage } from "../src/cloud/adapters/storage/cloudStorageClient.js";
import {
  closeStorageDatabase,
  openStorageDatabase,
  withWriteTransaction,
} from "../src/cloud/adapters/storage/sqlite/database.js";
import { runCloudMigrations } from "../src/cloud/adapters/storage/sqlite/migrations.js";
import path from "node:path";
import { isCloudStorageError } from "../src/cloud/adapters/storage/cloudStorageError.js";
import { deriveReadiness, isNetworkFilesystemType } from "../src/cloud/adapters/storage/health.js";
import {
  storageWorkerEntryPath,
  storageWorkerExecArgv,
} from "../src/cloud/adapters/storage/storageTransport.js";

function acceptRequest(taskId: string, now: number, expectedTaskRevision = 0) {
  return {
    taskId,
    commandId: newUuid(),
    intent: "start" as const,
    payloadHash: fakeSha256("w"),
    prompt: "worker 路径首条工作",
    start: { baseBranch: "main", provider: "daytona" },
    expectedTaskRevision,
    runRecipe: {
      provider: "daytona",
      resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
      firstCommandConfig: {},
      baseSha: fakeGitSha("w-base"),
    },
    taskBranch: "cloud/worker-branch",
    createOperationId: newUuid(),
    quota: { maxConcurrentRuns: 8 },
    now,
  };
}

test("worker 入口路径与启动参数按模块扩展名解析（源码 .ts / 构建 .js）", () => {
  const entry = storageWorkerEntryPath(import.meta.url);
  assert.match(entry, /storageWorkerMain\.ts$/);
  assert.deepEqual(storageWorkerExecArgv(entry), ["--import", "tsx"], "源码形态需要 tsx 解析 TS");
  assert.deepEqual(
    storageWorkerExecArgv("/opt/zcode/cloud/adapters/storage/storageWorkerMain.js"),
    [],
    "构建产物不需要 tsx，且不得把测试运行器参数传给 worker",
  );
});

test("worker 入口缺失时启动失败（打包部署必须显式指定入口）", async () => {
  const handle = await openTestStorage();
  try {
    await assert.rejects(
      createCloudStorage({
        dataDir: `${handle.root}/data`,
        attachmentsDir: `${handle.root}/attachments`,
        transportMode: "worker",
        workerEntryPath: `${handle.root}/missing/storageWorkerMain.js`,
      }),
      (error: unknown) =>
        isCloudStorageError(error) &&
        error.reason === "worker-unavailable" &&
        error.message.includes("worker 入口不存在"),
    );
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("worker 子进程承载全部持久语义", async () => {
  const handle = await openTestStorage({ transportMode: "worker" });
  try {
    const seeded = await seedDraftTask(handle.storage);
    const accepted = await handle.storage.storage.acceptInput(
      acceptRequest(seeded.taskId, nextNow(1)),
    );
    assert.equal(accepted.status, "accepted");
    const task = await handle.storage.storage.tasks.get(seeded.taskId);
    assert.equal(task?.status, "active");
    const runs = await handle.storage.storage.runs.listNonTerminal();
    assert.equal(runs.length, 1);

    const readiness = await handle.storage.readiness();
    // 0007_run_status_paused（2026-10-09 生命周期 v2，E-1 表重建）入链后链头为 7。
    assert.equal(readiness.schemaVersion, 7);
    assert.equal(readiness.writable, true);
    assert.equal(readiness.attachmentsWritable, true);
    assert.equal(readiness.lastAppliedMigrationId, "0007_run_status_paused");

    await handle.close();
    await assert.rejects(
      handle.storage.storage.tasks.get(seeded.taskId),
      (error: unknown) => isCloudStorageError(error) && error.reason === "worker-unavailable",
      "worker 关闭后不得静默返回旧数据",
    );
  } finally {
    await handle.close().catch(() => undefined);
    await removeTestRoot(handle.root);
  }
});

test("两个 worker 并发预约同一个 Task 的 run：只有一个成功", async () => {
  const handle = await openTestStorage({ transportMode: "worker" });
  const second = await openTestStorage({ root: handle.root, transportMode: "worker" });
  try {
    const seeded = await seedDraftTask(handle.storage);
    const results = await Promise.allSettled([
      handle.storage.storage.runs.reserveRun({
        taskId: seeded.taskId,
        runId: newUuid(),
        executionRecipe: {
          provider: "daytona",
          resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
          firstCommandConfig: {},
        },
        quota: { maxConcurrentRuns: 8 },
        now: nextNow(1),
      }),
      second.storage.storage.runs.reserveRun({
        taskId: seeded.taskId,
        runId: newUuid(),
        executionRecipe: {
          provider: "daytona",
          resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
          firstCommandConfig: {},
        },
        quota: { maxConcurrentRuns: 8 },
        now: nextNow(1),
      }),
    ]);
    const fulfilled = results.filter((result) => result.status === "fulfilled");
    assert.equal(fulfilled.length, 1, "唯一有效写 run 由数据库约束分配（08 §4.2）");
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected && rejected.status === "rejected");
    assert.equal(rejected.reason.code, "stale");
    assert.equal(rejected.reason.reason, "active-write-run-exists");
    const runs = await handle.storage.storage.runs.listNonTerminal();
    assert.equal(runs.length, 1);
  } finally {
    await handle.close().catch(() => undefined);
    await second.close().catch(() => undefined);
    await removeTestRoot(handle.root);
  }
});

test("磁盘满（SQLITE_FULL）：不返回 accepted，也不留输入与 create 意图", async () => {
  const seedHandle = await openTestStorage();
  const seeded = await seedDraftTask(seedHandle.storage);
  await seedHandle.close();

  const capped = await createCloudStorage({
    dataDir: `${seedHandle.root}/data`,
    attachmentsDir: `${seedHandle.root}/attachments`,
    transportMode: "in-process",
    capDatabasePages: true,
  });
  try {
    // 大正文需要新页：页数上限已冻结为当前大小，写入必然以 SQLITE_FULL 失败。
    const request = { ...acceptRequest(seeded.taskId, nextNow(50)), prompt: "x".repeat(150_000) };
    await assert.rejects(
      capped.storage.acceptInput(request),
      (error: unknown) =>
        isCloudStorageError(error) &&
        error.code === "recovery_required" &&
        error.reason === "database-error",
      "写失败必须如实上报，不得伪造 accepted（CP-02）",
    );
    assert.deepEqual((await capped.storage.inputs.list(seeded.taskId, { limit: 10 })).items, []);
    assert.deepEqual(await capped.operations.listUnsettled(), [], "不允许留下 provider 创建意图");
    assert.deepEqual(await capped.storage.runs.listNonTerminal(), []);
  } finally {
    await capped.close();
    await removeTestRoot(seedHandle.root);
  }
});

test("故障注入：DB 错误不产生半截事实（W10 故障点）", async () => {
  const handle = await openTestStorage({
    faults: [{ method: "storage.acceptInput", message: "injected db failure" }],
  });
  try {
    const seeded = await seedDraftTask(handle.storage);
    await assert.rejects(
      handle.storage.storage.acceptInput(acceptRequest(seeded.taskId, nextNow(1))),
      (error: unknown) => isCloudStorageError(error) && error.reason === "fault-injected",
    );
    const task = await handle.storage.storage.tasks.get(seeded.taskId);
    assert.equal(task?.status, "draft", "失败不得推进 Task 状态");
    assert.equal(task?.activeRunId, undefined);
    assert.deepEqual(
      (await handle.storage.storage.inputs.list(seeded.taskId, { limit: 10 })).items,
      [],
    );
    assert.deepEqual(await handle.storage.operations.listUnsettled(), []);
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("附件目录不可写时启动门拒绝服务", async () => {
  const handle = await openTestStorage();
  const attachmentsDir = handle.attachmentsDir;
  try {
    await chmod(attachmentsDir, 0o500);
    const report = await handle.storage.health();
    assert.equal(report.attachmentsDirWritable, false);
    assert.equal(report.readiness.attachmentsWritable, false);
    await assert.rejects(
      handle.storage.assertReady(),
      (error: unknown) => isCloudStorageError(error) && error.code === "not_ready",
    );
  } finally {
    await chmod(attachmentsDir, 0o700).catch(() => undefined);
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("共享网络文件系统与磁盘空间都参与就绪判定", () => {
  const base = {
    db: {
      lastAppliedMigrationId: "0006_attachment_objects",
      schemaVersion: 6,
      writable: true,
      locked: false,
      pendingMigrationIds: [],
    },
    dataDirWritable: true,
    attachmentsDirWritable: true,
    dataDirFreeBytes: 1_000_000_000,
    attachmentsDirFreeBytes: 1_000_000_000,
    sharedFilesystem: false,
    diskSpaceOk: true,
    migrationsReady: true,
  };
  assert.equal(deriveReadiness(base).writable, true);
  assert.equal(
    deriveReadiness({ ...base, sharedFilesystem: true }).writable,
    false,
    "03 §4：不把库放共享网络盘",
  );
  assert.equal(deriveReadiness({ ...base, diskSpaceOk: false }).writable, false);
  assert.equal(deriveReadiness({ ...base, dataDirWritable: false }).attachmentsWritable, true);
  assert.equal(
    deriveReadiness({ ...base, db: { ...base.db, locked: true } }).writable,
    false,
    "写锁被其他进程占用时不得服务",
  );
  assert.equal(isNetworkFilesystemType(0x6969), true);
  assert.equal(isNetworkFilesystemType(0xef53), false, "ext4 是本地文件系统");
  assert.equal(isNetworkFilesystemType(0), false);
});

test("synchronous 取舍实测：单条写事务吞吐（隔离同步成本）", async () => {
  const results: Record<string, number> = {};
  for (const synchronous of ["FULL", "NORMAL"] as const) {
    const handle = await openTestStorage();
    const context = openStorageDatabase({
      path: path.join(handle.dataDir, "sync-bench.db"),
      synchronous,
    });
    try {
      runCloudMigrations(context, { now: TEST_NOW });
      const iterations = 200;
      const insert = context.db.prepare(
        "INSERT INTO principals (principal_id, disabled, created_at, updated_at) VALUES (?, 0, ?, ?)",
      );
      const started = process.hrtime.bigint();
      for (let index = 0; index < iterations; index += 1) {
        withWriteTransaction(context, () => insert.run(`principal-${index}`, TEST_NOW, TEST_NOW));
      }
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      results[synchronous] = (iterations / elapsedMs) * 1000;
      assert.ok(results[synchronous] > 5, `${synchronous} 写入吞吐异常低`);
    } finally {
      closeStorageDatabase(context);
      await handle.close();
      await removeTestRoot(handle.root);
    }
  }
  process.stdout.write(
    `[cloud-storage 实测] 单条写事务吞吐 FULL=${results["FULL"]?.toFixed(0)}/s NORMAL=${results["NORMAL"]?.toFixed(0)}/s\n`,
  );
});

test("synchronous 取舍实测：FULL 与 NORMAL 的提交吞吐（W2 §8 风险项）", async () => {
  const measurements: Record<string, number> = {};
  for (const synchronous of ["FULL", "NORMAL"] as const) {
    const handle = await openTestStorage({ transportMode: "worker", synchronous });
    try {
      const seeded = await seedDraftTask(handle.storage);
      const iterations = 40;
      const started = process.hrtime.bigint();
      for (let index = 0; index < iterations; index += 1) {
        await handle.storage.storage.acceptInput(
          acceptRequest(seeded.taskId, nextNow(100 + index)),
        );
        if (index < iterations - 1) {
          // 同一 Task 只有一个有效写 run：每轮释放后再预约，模拟连续接纳路径。
          const active = await handle.storage.storage.runs.activeOfTask(seeded.taskId);
          if (active) {
            await handle.storage.storage.runs.transitionStatus({
              runId: active.runId,
              runGeneration: active.runGeneration,
              from: ["provisioning"],
              to: "stopped",
              endReason: "benchmark",
              now: nextNow(500 + index),
            });
            await handle.storage.storage.runs.releaseQuota({
              runId: active.runId,
              reason: "benchmark",
              now: nextNow(600 + index),
            });
          }
        }
      }
      const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
      measurements[synchronous] = (iterations / elapsedMs) * 1000;
      // eslint 断言只做下界，真实数值由 stdout 记录（不把测量值当性能承诺）。
      assert.ok(measurements[synchronous] > 5, `${synchronous} 吞吐异常低`);
    } finally {
      await handle.close();
      await removeTestRoot(handle.root);
    }
  }
  process.stdout.write(
    `[cloud-storage 实测] 接纳事务吞吐 FULL=${measurements["FULL"]?.toFixed(1)}/s NORMAL=${measurements["NORMAL"]?.toFixed(1)}/s\n`,
  );
});

test("就绪报告带出迁移与空间事实（启动日志用）", async () => {
  const handle = await openTestStorage({ thresholds: { minFreeBytes: 1 } });
  try {
    const report = await handle.storage.assertReady();
    assert.equal(report.readiness.writable, true);
    assert.ok(report.dataDirFreeBytes > 1);
    assert.equal(report.sharedFilesystem, false);
    assert.deepEqual(report.db.pendingMigrationIds, []);
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("低空间阈值触发启动门拒绝（磁盘空间检测）", async () => {
  const handle = await openTestStorage({ thresholds: { minFreeBytes: Number.MAX_SAFE_INTEGER } });
  try {
    const report = await handle.storage.health();
    assert.equal(report.diskSpaceOk, false);
    assert.equal(report.readiness.writable, false);
    await assert.rejects(
      handle.storage.assertReady(),
      (error: unknown) => isCloudStorageError(error) && error.reason === "storage-not-ready",
    );
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

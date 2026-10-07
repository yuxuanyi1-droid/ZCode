/**
 * 迁移链验收（W2 §6「迁移链 fresh-DB 与增量一致」、10 §7 additive/版本校验/降级阻止）。
 *
 * 断言：全新库一次性迁移 与 「旧库账本 + 当前二进制补齐」得到同一 schema 与同一账本；
 * 已应用迁移被改写（checksum 不匹配）或账本出现更高版本编号时启动失败；退役的 0004
 * 只留墓碑、不复用编号。
 */
import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { openTestStorage, removeTestRoot } from "./cloudStorageHarness.js";
import {
  closeStorageDatabase,
  openStorageDatabase,
  withWriteTransaction,
} from "../src/cloud/adapters/storage/sqlite/database.js";
import type { StorageContext } from "../src/cloud/adapters/storage/sqlite/database.js";
import {
  migrationChecksum,
  SCHEMA_MIGRATIONS_DDL,
  readCloudMigrationFacts,
  runCloudMigrations,
} from "../src/cloud/adapters/storage/sqlite/migrations.js";
import {
  CLOUD_MIGRATIONS,
  RETIRED_MIGRATIONS,
} from "../src/cloud/adapters/storage/sqlite/schema.js";
import { isCloudStorageError } from "../src/cloud/adapters/storage/cloudStorageError.js";
import { assertStorageHealthy, deriveReadiness } from "../src/cloud/adapters/storage/health.js";

const MIGRATION_NOW = 1_760_000_000_000;

function schemaDump(context: StorageContext): string {
  return context.db
    .prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name")
    .all()
    .map((row) => `${String(row["type"])} ${String(row["name"])} ${String(row["sql"])}`)
    .join("\n");
}

function appliedLedger(context: StorageContext): string {
  return context.db
    .prepare("SELECT id, checksum, retired FROM schema_migrations ORDER BY id")
    .all()
    .map((row) => `${String(row["id"])} ${String(row["checksum"])} ${String(row["retired"])}`)
    .join("\n");
}

/**
 * 模拟「旧二进制留下的库」：按目标编号应用前缀迁移并写账本。
 * 复用生产代码的 checksum 与语句序列，只重放账本写入（生产 runner 不做部分应用）。
 */
function applyPrefix(context: StorageContext, upToId: string): void {
  context.db.exec(SCHEMA_MIGRATIONS_DDL);
  const timeline = [
    ...CLOUD_MIGRATIONS.map((migration) => ({ id: migration.id, migration })),
    ...RETIRED_MIGRATIONS.map((entry) => ({ id: entry.id, migration: null })),
  ].sort((left, right) => (left.id < right.id ? -1 : 1));
  for (const entry of timeline) {
    if (entry.id > upToId) break;
    withWriteTransaction(context, () => {
      if (entry.migration) {
        for (const statement of entry.migration.statements) context.db.exec(statement);
      }
      context.db
        .prepare(
          "INSERT INTO schema_migrations (id, ordinal, checksum, retired, applied_at) VALUES (?, ?, ?, ?, ?)",
        )
        .run(
          entry.id,
          Number.parseInt(entry.id.slice(0, 4), 10),
          entry.migration ? migrationChecksum(entry.migration) : "retired",
          entry.migration ? 0 : 1,
          MIGRATION_NOW,
        );
    });
  }
}

test("fresh-DB 迁移与增量迁移得到同一 schema 与账本", async () => {
  const handle = await openTestStorage();
  try {
    const incrementalPath = path.join(handle.dataDir, "incremental.db");
    const freshPath = path.join(handle.dataDir, "fresh.db");

    const incremental = openStorageDatabase({ path: incrementalPath });
    try {
      applyPrefix(incremental, "0005_task_input_interaction_decisions");
      const factsBefore = readCloudMigrationFacts(incremental);
      assert.equal(factsBefore.schemaVersion, 5);
      assert.deepEqual(factsBefore.pendingMigrationIds, ["0006_attachment_objects"]);
      runCloudMigrations(incremental, { now: MIGRATION_NOW });
    } finally {
      closeStorageDatabase(incremental);
    }

    const fresh = openStorageDatabase({ path: freshPath });
    try {
      runCloudMigrations(fresh, { now: MIGRATION_NOW });
    } finally {
      closeStorageDatabase(fresh);
    }

    const reopenedIncremental = openStorageDatabase({ path: incrementalPath });
    const reopenedFresh = openStorageDatabase({ path: freshPath });
    try {
      assert.equal(schemaDump(reopenedIncremental), schemaDump(reopenedFresh));
      assert.equal(appliedLedger(reopenedIncremental), appliedLedger(reopenedFresh));
      const facts = readCloudMigrationFacts(reopenedFresh);
      assert.equal(facts.schemaVersion, 6);
      assert.deepEqual(facts.pendingMigrationIds, []);
    } finally {
      closeStorageDatabase(reopenedIncremental);
      closeStorageDatabase(reopenedFresh);
    }
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("全新库账本包含退役 0004 墓碑且重复迁移幂等", async () => {
  const handle = await openTestStorage();
  try {
    const databasePath = path.join(handle.dataDir, "repeat.db");
    const first = openStorageDatabase({ path: databasePath });
    let ledgerAfterFirst: string;
    try {
      runCloudMigrations(first, { now: MIGRATION_NOW });
      runCloudMigrations(first, { now: MIGRATION_NOW + 1000 });
      ledgerAfterFirst = appliedLedger(first);
    } finally {
      closeStorageDatabase(first);
    }
    assert.match(ledgerAfterFirst, /0004_external_operations_ssh_attach retired 1/);
    assert.match(ledgerAfterFirst, /0006_attachment_objects/);
    assert.ok(!ledgerAfterFirst.includes("0004_external_operations_ssh_attach retired 0"));
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("已应用迁移被改写时启动失败（checksum 不匹配）", async () => {
  const handle = await openTestStorage();
  try {
    const databasePath = path.join(handle.dataDir, "tampered.db");
    const context = openStorageDatabase({ path: databasePath });
    try {
      runCloudMigrations(context, { now: MIGRATION_NOW });
      context.db
        .prepare("UPDATE schema_migrations SET checksum = ? WHERE id = ?")
        .run("deadbeef", "0002_run_credentials");
      assert.throws(
        () => runCloudMigrations(context, { now: MIGRATION_NOW }),
        (error: unknown) =>
          isCloudStorageError(error) && error.reason === "migration-checksum-mismatch",
      );
    } finally {
      closeStorageDatabase(context);
    }
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("账本出现更高版本编号时阻止降级启动", async () => {
  const handle = await openTestStorage();
  try {
    const databasePath = path.join(handle.dataDir, "downgrade.db");
    const context = openStorageDatabase({ path: databasePath });
    try {
      runCloudMigrations(context, { now: MIGRATION_NOW });
      context.db
        .prepare(
          "INSERT INTO schema_migrations (id, ordinal, checksum, retired, applied_at) VALUES (?, ?, ?, 0, ?)",
        )
        .run("0007_future_change", 7, "future", MIGRATION_NOW);
      assert.throws(
        () => runCloudMigrations(context, { now: MIGRATION_NOW }),
        (error: unknown) =>
          isCloudStorageError(error) && error.reason === "migration-downgrade-blocked",
      );
    } finally {
      closeStorageDatabase(context);
    }
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("迁移未就绪时启动门拒绝服务", async () => {
  const handle = await openTestStorage();
  try {
    const databasePath = path.join(handle.dataDir, "pending.db");
    const context = openStorageDatabase({ path: databasePath });
    let pending: readonly string[];
    try {
      applyPrefix(context, "0003_git_grants");
      pending = readCloudMigrationFacts(context).pendingMigrationIds;
    } finally {
      closeStorageDatabase(context);
    }
    assert.deepEqual(pending, ["0005_task_input_interaction_decisions", "0006_attachment_objects"]);
    const report = {
      db: {
        lastAppliedMigrationId: "0003_git_grants",
        schemaVersion: 3,
        writable: true,
        locked: false,
        pendingMigrationIds: pending,
      },
      dataDirWritable: true,
      attachmentsDirWritable: true,
      dataDirFreeBytes: 1_000_000_000,
      attachmentsDirFreeBytes: 1_000_000_000,
      sharedFilesystem: false,
      diskSpaceOk: true,
      migrationsReady: pending.length === 0,
    };
    assert.throws(
      () =>
        assertStorageHealthy({
          ...report,
          readiness: deriveReadiness(report),
        }),
      (error: unknown) =>
        isCloudStorageError(error) &&
        error.code === "not_ready" &&
        error.message.includes("0006_attachment_objects"),
    );
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("迁移链建出全部表族对象（防止语句在拆分/修订中丢失）", async () => {
  const handle = await openTestStorage();
  try {
    const databasePath = path.join(handle.dataDir, "objects.db");
    const context = openStorageDatabase({ path: databasePath });
    try {
      runCloudMigrations(context, { now: MIGRATION_NOW });
      const objects = context.db
        .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all()
        .map((row) => `${String(row["type"])}:${String(row["name"])}`);
      for (const expected of [
        "table:principals",
        "table:projects",
        "table:tasks",
        "table:runs",
        "table:task_inputs",
        "table:external_operations",
        "table:projection_events",
        "table:projection_ingest_cursors",
        "table:projection_snapshots",
        "table:checkpoints",
        "table:task_artifacts",
        "table:account_installations",
        "table:webhook_inbox",
        "table:run_credentials",
        "table:git_grants",
        "table:task_input_interaction_decisions",
        "table:task_input_interaction_cancel_intents",
        "table:attachment_objects",
        "table:schema_migrations",
        "index:runs_single_active_writer",
        "index:task_inputs_acceptance_seq",
        "index:external_operations_business_key",
        "index:git_grants_run_purpose",
        "index:task_input_interaction_decisions_status",
        "index:task_input_interaction_decisions_delivery_command",
        "index:attachment_objects_sweep",
      ]) {
        assert.ok(objects.includes(expected), `缺少 ${expected}`);
      }
      // external_operations 必须同时容纳 provider 与 GitHub effect 两个分面的 kind。
      const kinds = context.db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'external_operations'")
        .get();
      for (const kind of ["publish-pr", "pull-request", "check", "comment", "token-revoke"]) {
        assert.ok(String(kinds?.["sql"]).includes(`'${kind}'`), `kind CHECK 缺少 ${kind}`);
      }
    } finally {
      closeStorageDatabase(context);
    }
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

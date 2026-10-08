/**
 * 迁移链与账本（10 §7「数据与发布迁移」、03 §8 启动顺序、W2 §8 编号纪律）。
 *
 * 规则：
 * - 账本按 id 记录 name/checksum；已应用 id 的内容被改写（checksum 不匹配）时启动
 *   失败，不「自动修好」历史（10 §7：schema 版本校验）。
 * - 账本里出现本二进制不认识的 id ⇒ 更高版本写过的库，阻止降级启动（10 §7）。
 * - `0004` 永久退役：只写墓碑，不执行 DDL，不做 checksum 校验，保证全新库与旧库
 *   增量的账本 id 集合一致（W2 §8）。
 * - 表重建迁移（`preStatements`/`postStatements` 非空）走 rebuild 专用通道：事务外
 *   关 FK、提交前 `foreign_key_check` 必须为空、结束后恢复 FK=ON，见 `applyMigration`
 *   与 CONTRACT.md「表重建迁移专用通道」。
 * - 迁移失败不开始 provider 操作（03 §8）：错误向上抛出，调用方 fail closed。
 */
import { createHash } from "node:crypto";
import { CLOUD_MIGRATIONS, CLOUD_SCHEMA_VERSION, RETIRED_MIGRATIONS } from "./schema.js";
import type { CloudMigration } from "./schema.js";
import { withWriteTransaction } from "./database.js";
import type { StorageContext } from "./database.js";
import { CloudStorageError } from "../cloudStorageError.js";

export interface CloudMigrationFacts {
  /** 账本中最大的已应用 id（含墓碑），未迁移时为 null。 */
  lastAppliedMigrationId: string | null;
  /** 已应用的本链最大编号；全新库为 0。 */
  schemaVersion: number;
  appliedMigrationIds: readonly string[];
  /** 尚未应用的迁移 id（非空时不得开始服务）。 */
  pendingMigrationIds: readonly string[];
}

interface LedgerRow {
  id: string;
  checksum: string;
  retired: number;
}

export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id TEXT PRIMARY KEY,
  ordinal INTEGER NOT NULL,
  checksum TEXT NOT NULL,
  retired INTEGER NOT NULL DEFAULT 0 CHECK (retired IN (0, 1)),
  applied_at INTEGER NOT NULL
) STRICT;
`;

/** 迁移内容指纹：id + 语句序列；只由内容决定，不含时间与运行环境。 */
export function migrationChecksum(migration: CloudMigration): string {
  return createHash("sha256")
    .update(`${migration.id}\n${migration.statements.join(";\n")}`)
    .digest("hex");
}

function ordinalOf(id: string): number {
  const prefix = Number.parseInt(id.slice(0, 4), 10);
  return Number.isFinite(prefix) ? prefix : 0;
}

function readLedger(context: StorageContext): LedgerRow[] {
  return context.db
    .prepare("SELECT id, checksum, retired FROM schema_migrations ORDER BY id")
    .all()
    .map((row) => ({
      id: String(row["id"]),
      checksum: String(row["checksum"]),
      retired: Number(row["retired"]),
    }));
}

/**
 * 执行（或校验）迁移链。全新库与增量库走同一实现，保证两条路径结果一致。
 */
export function runCloudMigrations(
  context: StorageContext,
  options: { now: number },
): CloudMigrationFacts {
  // 声明版本必须先与迁移链头一致：新增 0007 却忘记改 CLOUD_SCHEMA_VERSION 时
  // fail closed，而不是让降级检查悄悄放行（10 §7 schema 版本校验）。
  const chainHead = CLOUD_MIGRATIONS.reduce(
    (highest, migration) => Math.max(highest, ordinalOf(migration.id)),
    0,
  );
  if (chainHead !== CLOUD_SCHEMA_VERSION) {
    throw new CloudStorageError({
      code: "not_ready",
      reason: "migration-failed",
      message: `迁移链头 ${chainHead} 与声明版本 ${CLOUD_SCHEMA_VERSION} 不一致`,
    });
  }
  context.db.exec(SCHEMA_MIGRATIONS_DDL);
  const applied = new Map(readLedger(context).map((row) => [row.id, row]));
  const known = new Map(CLOUD_MIGRATIONS.map((migration) => [migration.id, migration]));
  const retired = new Set(RETIRED_MIGRATIONS.map((entry) => entry.id));

  // 1) 先校验已有账本：校验失败不得继续应用后续迁移。
  for (const row of applied.values()) {
    if (managedChecksumMismatch(row, known, retired)) {
      throw new CloudStorageError({
        code: "recovery_required",
        reason: "migration-checksum-mismatch",
        message: `迁移 ${row.id} 的 checksum 与账本不一致`,
      });
    }
    if (!known.has(row.id) && row.retired === 0) {
      throw new CloudStorageError({
        code: "recovery_required",
        reason: "migration-downgrade-blocked",
        message: `账本中存在本版本不认识的迁移 ${row.id}，拒绝降级启动`,
      });
    }
  }

  // 2) 按编号顺序补齐：墓碑与真实迁移同序处理，保证 id 集合在两条路径下一致。
  const timeline = [
    ...CLOUD_MIGRATIONS.map((migration) => ({ id: migration.id, migration })),
    ...RETIRED_MIGRATIONS.map((entry) => ({ id: entry.id, migration: null })),
  ].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));

  for (const entry of timeline) {
    if (applied.has(entry.id)) continue;
    if (entry.migration === null) {
      withWriteTransaction(context, () => {
        insertLedgerRow(context, {
          id: entry.id,
          checksum: "retired",
          retired: 1,
          now: options.now,
        });
      });
      continue;
    }
    applyMigration(context, entry.migration, options.now);
  }

  return readCloudMigrationFacts(context);
}

/**
 * 应用单个真实迁移。
 *
 * - 普通迁移（无事务外钩子）：保持历史路径——单事务内「语句 + 账本」原子提交。
 * - 表重建迁移（`preStatements`/`postStatements` 非空，如 0007 重建被
 *   `run_credentials`/`projection_*` 等表 REFERENCES 的 `runs`）：走 SQLite 官方表
 *   重建 recipe（lang_altertable）。FK 开启时 `DROP TABLE` 对子表残留行立即失败
 *   （2026-10-09 生产事故），而 `PRAGMA foreign_keys` 在事务内是 no-op，只能先在
 *   事务外关闭。事件顺序（所有者：迁移执行器，同步单连接）：
 *
 *   事务外 preStatements（FK=OFF）
 *     → BEGIN IMMEDIATE
 *     → 重建语句（create-new/copy/drop/rename/索引）
 *     → PRAGMA foreign_key_check：非空 ⇒ 抛错回滚（FK 关闭期间无即时约束检查，
 *       这是唯一的完整性闸门；该 pragma 在 FK OFF 时仍扫描全部外键）
 *     → 账本入账（与 DDL 同事务，applied 原子）
 *     → COMMIT
 *   finally postStatements（FK=ON）：失败路径也必须恢复，不得把 FK 关闭泄漏给
 *   后续普通写事务。
 */
function applyMigration(context: StorageContext, migration: CloudMigration, now: number): void {
  const rebuild =
    (migration.preStatements?.length ?? 0) > 0 || (migration.postStatements?.length ?? 0) > 0;
  if (!rebuild) {
    withWriteTransaction(context, () => {
      for (const statement of migration.statements) context.db.exec(statement);
      insertLedgerRow(context, {
        id: migration.id,
        checksum: migrationChecksum(migration),
        retired: 0,
        now,
      });
    });
    return;
  }
  for (const statement of migration.preStatements ?? []) context.db.exec(statement);
  try {
    withWriteTransaction(context, () => {
      for (const statement of migration.statements) context.db.exec(statement);
      const violations = context.db.prepare("PRAGMA foreign_key_check").all();
      if (violations.length > 0) {
        throw new CloudStorageError({
          code: "recovery_required",
          // 复用既有 reason：checksum/降级单独成 reason 是调用方需要分支区分，
          // FK 违规与普通迁移失败同样只需 fail closed，细节在 message 里。
          reason: "migration-failed",
          message: `迁移 ${migration.id} 重建表后 foreign_key_check 发现 ${violations.length} 行违规`,
        });
      }
      insertLedgerRow(context, {
        id: migration.id,
        checksum: migrationChecksum(migration),
        retired: 0,
        now,
      });
    });
  } finally {
    for (const statement of migration.postStatements ?? []) context.db.exec(statement);
  }
}

function managedChecksumMismatch(
  row: LedgerRow,
  known: ReadonlyMap<string, CloudMigration>,
  retired: ReadonlySet<string>,
): boolean {
  if (row.retired === 1 || retired.has(row.id)) return false;
  const migration = known.get(row.id);
  if (!migration) return false;
  return migrationChecksum(migration) !== row.checksum;
}

function insertLedgerRow(
  context: StorageContext,
  input: { id: string; checksum: string; retired: number; now: number },
): void {
  context.db
    .prepare(
      "INSERT INTO schema_migrations (id, ordinal, checksum, retired, applied_at) VALUES (?, ?, ?, ?, ?)",
    )
    .run(input.id, ordinalOf(input.id), input.checksum, input.retired, input.now);
}

/** 只读事实：迁移是否就绪、schema 版本、是否落后于当前二进制（启动门用）。 */
export function readCloudMigrationFacts(context: StorageContext): CloudMigrationFacts {
  const exists = context.db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!exists) {
    return {
      lastAppliedMigrationId: null,
      schemaVersion: 0,
      appliedMigrationIds: [],
      pendingMigrationIds: CLOUD_MIGRATIONS.map((migration) => migration.id),
    };
  }
  const rows = readLedger(context);
  const appliedIds = new Set(rows.map((row) => row.id));
  const pending = CLOUD_MIGRATIONS.filter((migration) => !appliedIds.has(migration.id)).map(
    (migration) => migration.id,
  );
  const appliedKnown = CLOUD_MIGRATIONS.filter((migration) => appliedIds.has(migration.id));
  const schemaVersion = appliedKnown.reduce(
    (highest, migration) => Math.max(highest, ordinalOf(migration.id)),
    0,
  );
  return {
    lastAppliedMigrationId: rows.length > 0 ? (rows[rows.length - 1] as LedgerRow).id : null,
    schemaVersion,
    appliedMigrationIds: rows.map((row) => row.id),
    pendingMigrationIds: pending,
  };
}

/**
 * SQLite 打开与事务封装（03 §4 持久数据与约束、§8 启动顺序、W2 §4）。
 *
 * 本文件只在 storage worker 内被调用：同步 SQL 不进 HTTP 事件循环。所有写入
 * 事务使用 `BEGIN IMMEDIATE`——控制面是单进程多请求模型，IMMEDIATE 让写锁在
 * 事务开始时取得，避免「读到旧值 → 升级锁失败 → 重试」造成 CAS 假阴性。
 * `synchronous=FULL` 是默认（03 §4 关键提交的崩溃承诺）；测得的吞吐取舍见
 * W2 §8 与迁移说明。
 */
import { DatabaseSync } from "node:sqlite";

export type StorageSynchronousMode = "FULL" | "NORMAL";

export interface StorageDatabaseOptions {
  /** 主库路径；必须位于本地持久卷，不得放在多进程共享网络盘（03 §4、10 §7）。 */
  path: string;
  /** 03 §4「建议关键提交 synchronous=FULL」，默认 FULL。 */
  synchronous?: StorageSynchronousMode;
  /** 锁等待上限：写竞争时让 SQLite 自己等待，不用超时掩盖同步问题。 */
  busyTimeoutMs?: number;
  /** 测试/恢复工具用：只读打开（不建文件、不迁移）。 */
  readOnly?: boolean;
}

/** 容量护栏：把数据库页数上限固定为当前大小，后续需要新页的写入会以 SQLITE_FULL 失败。 */
export function capDatabasePages(context: StorageContext): number {
  const current = context.db.prepare("PRAGMA page_count").get();
  const pages = Number(Object.values(current ?? {})[0] ?? 0);
  context.db.exec(`PRAGMA max_page_count = ${Math.max(1, pages)}`);
  const applied = context.db.prepare("PRAGMA max_page_count").get();
  return Number(Object.values(applied ?? {})[0] ?? 0);
}

export interface StorageContext {
  readonly db: DatabaseSync;
  readonly path: string;
  readonly synchronous: StorageSynchronousMode;
}

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;

export function openStorageDatabase(options: StorageDatabaseOptions): StorageContext {
  const db = new DatabaseSync(options.path, {
    timeout: options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS,
    readOnly: options.readOnly ?? false,
    enableForeignKeyConstraints: true,
  });
  const synchronous = options.synchronous ?? "FULL";
  if (!(options.readOnly ?? false)) {
    // WAL：读不阻塞写；FULL 让提交刷到磁盘后再返回（03 §4 崩溃恢复承诺）。
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`PRAGMA synchronous = ${synchronous}`);
    // 外键在 node:sqlite 构造参数里开启，这里再显式确认一次启动事实。
    db.exec("PRAGMA foreign_keys = ON");
  }
  return { db, path: options.path, synchronous };
}

export function closeStorageDatabase(context: StorageContext): void {
  context.db.close();
}

/**
 * 写事务：`BEGIN IMMEDIATE` → fn → COMMIT；fn 抛错则 ROLLBACK 后原样抛出。
 * 单有效写 run、acceptanceSeq、CAS 都在该事务内完成（03 §4）。
 */
export function withWriteTransaction<T>(context: StorageContext, run: () => T): T {
  const { db } = context;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ROLLBACK 失败说明连接已不可用（例如磁盘/句柄错误）：保留原错误，由启动门
      // 与错误路径判断存储不可用，不在这里掩盖成第二个异常。
    }
    throw error;
  }
}

export interface WriteLockProbe {
  /** 取得 RESERVED 写锁并成功回滚。 */
  acquired: boolean;
  /** 失败原因是锁竞争（另一写入者），而不是只读/损坏。 */
  busy: boolean;
  /** 失败原因是文件只读或无法写入。 */
  readOnly: boolean;
  message?: string;
}

/**
 * 可写性/锁检测（03 §4「数据库与附件目录启动时检测可写性/锁/空间」）：
 * 能在短时间内取得 RESERVED 写锁并立即回滚，才认为本进程持有唯一写权。
 * 另一个控制面实例正在写同一文件时必须 false，不得继续服务。只读文件系统与
 * 锁竞争要区分开：前者需要运维处理，后者会随对方退出而消失。
 */
export function probeWriteLock(context: StorageContext, probeTimeoutMs = 250): WriteLockProbe {
  const { db } = context;
  try {
    db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.trunc(probeTimeoutMs))}`);
    db.exec("BEGIN IMMEDIATE");
    db.exec("ROLLBACK");
    return { acquired: true, busy: false, readOnly: false };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // 未进入事务时 ROLLBACK 会报错，忽略即可。
    }
    const message = error instanceof Error ? error.message : String(error);
    const busy = /busy|locked/i.test(message);
    return {
      acquired: false,
      busy,
      readOnly: !busy && /readonly/i.test(message),
      message: message.slice(0, 200),
    };
  } finally {
    db.exec(`PRAGMA busy_timeout = ${DEFAULT_BUSY_TIMEOUT_MS}`);
  }
}

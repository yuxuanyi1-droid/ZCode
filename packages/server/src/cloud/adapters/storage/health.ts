/**
 * 启动健康检测与迁移就绪门（03 §4「数据库与附件目录启动时检测可写性/锁/空间」、
 * §8 启动顺序、10 §7/§8 fail-closed）。
 *
 * 分工：数据库侧的锁与迁移事实由 worker 内的连接探测（sqlite/database.ts、
 * sqlite/migrations.ts）；文件系统侧的可写性/空间/网络盘由本模块异步探测。
 * 任一项不满足 ⇒ `assertStorageHealthy` 抛结构化错误，上层不得开始 provider
 * 操作、不得返回 accepted（03 §4「数据库失败、磁盘满或迁移未就绪时…不返回已接受」）。
 */
import { constants } from "node:fs";
import { access, mkdtemp, rm, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { StorageReadiness } from "../../app/ports/storagePort.js";
import { CloudStorageError } from "./cloudStorageError.js";

export interface StorageHealthThresholds {
  /** 数据目录与附件目录的最小可用空间；低于该值拒绝启动并拒绝新写入。 */
  minFreeBytes: number;
  /** 允许把库/附件放在共享网络盘？默认 false（03 §4、10 §7）。 */
  allowSharedFilesystem: boolean;
}

export const DEFAULT_STORAGE_HEALTH_THRESHOLDS: StorageHealthThresholds = {
  minFreeBytes: 64 * 1024 * 1024,
  allowSharedFilesystem: false,
};

/** worker 侧只回答数据库自己的事实；附件目录与空间由调用进程异步补齐。 */
export interface StorageDbReadiness {
  lastAppliedMigrationId: string | null;
  schemaVersion: number;
  /** 能取得写事务（BEGIN IMMEDIATE 成功并回滚）。 */
  writable: boolean;
  /** 另一写入者持有写锁（不得并行服务同一文件）。 */
  locked: boolean;
  /** 尚未应用的迁移；非空即未就绪（03 §8）。 */
  pendingMigrationIds: readonly string[];
}

export interface StorageHealthFacts {
  db: StorageDbReadiness;
  dataDirWritable: boolean;
  attachmentsDirWritable: boolean;
  dataDirFreeBytes: number;
  attachmentsDirFreeBytes: number;
  /** 数据目录或附件目录位于网络/共享文件系统。 */
  sharedFilesystem: boolean;
  diskSpaceOk: boolean;
  migrationsReady: boolean;
}

export interface StorageHealthReport extends StorageHealthFacts {
  readiness: StorageReadiness;
}

/** 常见网络/共享文件系统 magic（Linux statfs.f_type）；0 表示平台未提供。 */
const NETWORK_FILESYSTEM_TYPES = new Set([
  0x6969, // NFS
  0x517b, // SMB
  0xff534d42, // CIFS
  0xfe534d42, // SMB2
  0x01021997, // 9p（WSL drvfs 等跨主机挂载）
]);

export function isNetworkFilesystemType(type: number): boolean {
  return NETWORK_FILESYSTEM_TYPES.has(type);
}

export interface DirectoryProbe {
  writable: boolean;
  freeBytes: number;
  filesystemType: number;
}

/** 真实写探针：建临时目录 + 写文件 + 删目录，权限/EACCES/EROFS/磁盘满都如实暴露。 */
async function probeDirectory(directory: string): Promise<DirectoryProbe> {
  let freeBytes = 0;
  let filesystemType = 0;
  try {
    const stats = await statfs(directory);
    freeBytes = Number(stats.bavail) * Number(stats.bsize);
    filesystemType = Number(stats.type);
  } catch {
    // 目录不存在/平台不支持 statfs：空间与类型事实缺失，按 0 处理，但不掩盖写探针结果。
  }

  let probeRoot: string;
  try {
    await access(directory, constants.W_OK);
    probeRoot = await mkdtemp(path.join(directory, ".zcode-cloud-probe-"));
  } catch {
    return { writable: false, freeBytes, filesystemType };
  }
  try {
    await writeFile(path.join(probeRoot, `${randomUUID()}.probe`), "probe", { flag: "wx" });
    return { writable: true, freeBytes, filesystemType };
  } catch {
    return { writable: false, freeBytes, filesystemType };
  } finally {
    await rm(probeRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

export interface CollectStorageHealthRequest {
  db: StorageDbReadiness;
  dataDir: string;
  attachmentsDir: string;
  thresholds?: Partial<StorageHealthThresholds>;
}

/** 汇总 DB 事实与文件系统探针，得出 `StoragePort.readiness()` 的形状。 */
export async function collectStorageHealth(
  request: CollectStorageHealthRequest,
): Promise<StorageHealthReport> {
  const thresholds = { ...DEFAULT_STORAGE_HEALTH_THRESHOLDS, ...request.thresholds };
  const [dataDir, attachmentsDir] = await Promise.all([
    probeDirectory(request.dataDir),
    probeDirectory(request.attachmentsDir),
  ]);
  const sharedFilesystem =
    isNetworkFilesystemType(dataDir.filesystemType) ||
    isNetworkFilesystemType(attachmentsDir.filesystemType);
  const facts: StorageHealthFacts = {
    db: request.db,
    dataDirWritable: dataDir.writable,
    attachmentsDirWritable: attachmentsDir.writable,
    dataDirFreeBytes: dataDir.freeBytes,
    attachmentsDirFreeBytes: attachmentsDir.freeBytes,
    sharedFilesystem,
    diskSpaceOk:
      dataDir.freeBytes >= thresholds.minFreeBytes &&
      attachmentsDir.freeBytes >= thresholds.minFreeBytes,
    migrationsReady: request.db.pendingMigrationIds.length === 0,
  };
  return { ...facts, readiness: deriveReadiness(facts, thresholds) };
}

export function deriveReadiness(
  facts: StorageHealthFacts,
  thresholds: StorageHealthThresholds = DEFAULT_STORAGE_HEALTH_THRESHOLDS,
): StorageReadiness {
  const baseOk =
    facts.db.writable &&
    !facts.db.locked &&
    facts.dataDirWritable &&
    facts.migrationsReady &&
    (thresholds.allowSharedFilesystem || !facts.sharedFilesystem);
  return {
    lastAppliedMigrationId: facts.db.lastAppliedMigrationId,
    schemaVersion: facts.db.schemaVersion,
    writable: baseOk && facts.diskSpaceOk,
    attachmentsWritable: facts.attachmentsDirWritable && facts.diskSpaceOk,
  };
}

/**
 * 启动门（03 §8）：不健康即抛错，调用方必须 fail closed —— 不监听认证入口、
 * 不开始 provider 操作。错误码用 `not_ready`（启动前置未满足），原因见 reason。
 */
export function assertStorageHealthy(
  report: StorageHealthReport,
  thresholds: StorageHealthThresholds = DEFAULT_STORAGE_HEALTH_THRESHOLDS,
): void {
  if (!report.migrationsReady) {
    throw new CloudStorageError({
      code: "not_ready",
      reason: "storage-not-ready",
      message: `迁移未就绪：${report.db.pendingMigrationIds.join(",")}`,
    });
  }
  if (report.sharedFilesystem && !thresholds.allowSharedFilesystem) {
    throw new CloudStorageError({
      code: "not_ready",
      reason: "storage-not-ready",
      message: "数据目录位于共享网络文件系统，拒绝服务（03 §4、10 §7）",
    });
  }
  if (!report.db.writable || report.db.locked) {
    throw new CloudStorageError({
      code: "not_ready",
      reason: "storage-not-ready",
      message: report.db.locked ? "数据库写锁被其他进程占用" : "数据库不可写",
    });
  }
  if (!report.dataDirWritable) {
    throw new CloudStorageError({
      code: "not_ready",
      reason: "storage-not-ready",
      message: "数据目录不可写",
    });
  }
  if (!report.attachmentsDirWritable) {
    throw new CloudStorageError({
      code: "not_ready",
      reason: "storage-not-ready",
      message: "附件目录不可写",
    });
  }
  if (!report.diskSpaceOk) {
    throw new CloudStorageError({
      code: "not_ready",
      reason: "storage-not-ready",
      message: "磁盘可用空间低于启动阈值",
    });
  }
}

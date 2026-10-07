/**
 * storage worker 运行时（W2 §3/§4）：同步 SQL 的唯一执行点。
 *
 * 组合所有 repository handler，负责打开数据库、跑迁移、按方法表派发请求，并提供
 * 数据库侧就绪事实。它可以被真实 worker 线程（storageWorkerMain）或进程内传输
 * （测试/嵌入式装配）复用——两条路径跑的是同一份 SQL 语义。
 */
import { createServiceLogger } from "@zcode/services/node";
import {
  capDatabasePages,
  closeStorageDatabase,
  openStorageDatabase,
  probeWriteLock,
} from "./sqlite/database.js";
import type { StorageContext } from "./sqlite/database.js";
import { readCloudMigrationFacts, runCloudMigrations } from "./sqlite/migrations.js";
import type { StorageDbReadiness } from "./health.js";
import { CloudStorageError } from "./cloudStorageError.js";
import { projectRepoHandlers } from "./repositories/projectRepo.js";
import { taskRepoHandlers } from "./repositories/taskRepo.js";
import { runRepoHandlers } from "./repositories/runRepo.js";
import { inputRepoHandlers } from "./repositories/inputRepo.js";
import { projectionRepoHandlers } from "./repositories/projectionRepo.js";
import { credentialRepoHandlers } from "./repositories/credentialRepo.js";
import { operationOutboxHandlers } from "./repositories/operationOutboxRepo.js";
import { principalRepoHandlers } from "./repositories/principalRepo.js";
import { attachmentRepoHandlers } from "./repositories/attachmentRepo.js";
import { gitGrantRepoHandlers } from "./repositories/gitGrantRepo.js";
import { githubEffectRepoHandlers } from "./repositories/githubEffectRepo.js";
import { interactionRepoHandlers } from "./repositories/interactionRepo.js";
import { acceptInputHandlers } from "./repositories/acceptInput.js";
import type {
  StorageHandlerTable,
  StorageMethodName,
  StorageWorkerInit,
} from "./workerProtocol.js";

const logger = createServiceLogger("cloud-storage-worker");

export interface StorageWorkerRuntime {
  /** 派发一条方法调用；未知方法与故障注入都在这里拒绝。 */
  handle(method: string, params: unknown): unknown;
  readiness(): StorageDbReadiness;
  /** 迁移账本事实（启动握手用）。 */
  facts(): { schemaVersion: number; lastAppliedMigrationId: string | null };
  close(): void;
}

export interface CreateStorageWorkerRuntimeOptions extends StorageWorkerInit {
  /** 迁移账本的 applied_at；默认取真实时钟。 */
  now?: number;
}

export function createStorageWorkerRuntime(
  options: CreateStorageWorkerRuntimeOptions,
): StorageWorkerRuntime {
  const context = openStorageDatabase({
    path: options.databasePath,
    synchronous: options.synchronous,
    busyTimeoutMs: options.busyTimeoutMs,
  });
  try {
    return buildRuntime(context, options);
  } catch (error) {
    closeStorageDatabase(context);
    throw error;
  }
}

function buildRuntime(
  context: StorageContext,
  options: CreateStorageWorkerRuntimeOptions,
): StorageWorkerRuntime {
  // 迁移失败不开始 provider 操作（03 §8）：异常向上抛出，由装配方 fail closed。
  runCloudMigrations(context, { now: options.now ?? Date.now() });
  if (options.capDatabasePages) {
    const limit = capDatabasePages(context);
    logger.info(undefined, "存储页数上限已固定（容量护栏）", { maxPageCount: limit });
  }
  const faults = options.faults ?? [];
  const faultCounters = new Map<string, number>();

  const handlers: StorageHandlerTable = {
    ...projectRepoHandlers,
    ...taskRepoHandlers,
    ...runRepoHandlers,
    ...inputRepoHandlers,
    ...projectionRepoHandlers,
    ...credentialRepoHandlers,
    ...operationOutboxHandlers,
    ...principalRepoHandlers,
    ...attachmentRepoHandlers,
    ...gitGrantRepoHandlers,
    ...githubEffectRepoHandlers,
    ...interactionRepoHandlers,
    ...acceptInputHandlers,
    "storage.readiness": () => readDbReadiness(context),
  };

  function applyFaults(method: string): void {
    for (const rule of faults) {
      if (rule.method !== method) continue;
      const seen = (faultCounters.get(rule.method) ?? 0) + 1;
      faultCounters.set(rule.method, seen);
      if (rule.occurrence !== undefined && rule.occurrence !== seen) continue;
      throw new CloudStorageError({
        code: "recovery_required",
        reason: "fault-injected",
        message: rule.message ?? `注入故障：${method}`,
      });
    }
  }

  return {
    handle(method, params) {
      const handler = handlers[method as StorageMethodName] as
        | ((context: StorageContext, params: unknown) => unknown)
        | undefined;
      if (!handler) {
        throw new CloudStorageError({
          code: "validation_failed",
          reason: "unknown-method",
          message: `未知存储方法 ${method}`,
        });
      }
      applyFaults(method);
      return handler(context, params);
    },
    readiness: () => readDbReadiness(context),
    facts: () => {
      const facts = readCloudMigrationFacts(context);
      return {
        schemaVersion: facts.schemaVersion,
        lastAppliedMigrationId: facts.lastAppliedMigrationId,
      };
    },
    close() {
      closeStorageDatabase(context);
      logger.info(undefined, "storage worker 数据库已关闭", { path: context.path });
    },
  };
}

/**
 * 数据库侧就绪事实：迁移是否补齐 + 能否取得写事务（03 §4、§8）。
 * 只读文件系统与锁竞争分开上报：前者需要运维处理，后者随对方退出消失。
 */
function readDbReadiness(context: StorageContext): StorageDbReadiness {
  const facts = readCloudMigrationFacts(context);
  const probe = probeWriteLock(context);
  if (!probe.acquired) {
    logger.warn(undefined, "存储写探测失败", {
      busy: probe.busy,
      readOnly: probe.readOnly,
      message: probe.message,
    });
  }
  return {
    lastAppliedMigrationId: facts.lastAppliedMigrationId,
    schemaVersion: facts.schemaVersion,
    writable: probe.acquired,
    locked: probe.busy,
    pendingMigrationIds: facts.pendingMigrationIds,
  };
}

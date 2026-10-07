/**
 * storage worker 进程入口（W2 §3「worker 进程入口（同步 SQL 只在此）」）。
 *
 * 独立子进程承载：主进程（HTTP 事件循环）只通过 IPC 发消息，`node:sqlite` 的同步
 * 调用全部发生在这个进程里（03 §4「使用异步 repository 接口；同步 SQL 仅在 worker」）。
 * 初始化失败（迁移 checksum 不匹配、目录只读、被其他进程占锁）时上报 `init-error`，
 * 装配方据此 fail closed，不监听认证入口、不开始 provider 操作（03 §8）。
 *
 * 选择子进程而不是 worker 线程的原因：容器/打包后的加载器与模块解析按进程边界定义，
 * 线程内无法复用主进程的 TS 解析链；进程隔离也让数据库崩溃不影响 HTTP 进程。
 */
import { createStorageWorkerRuntime } from "./storageWorkerRuntime.js";
import type { StorageWorkerRuntime } from "./storageWorkerRuntime.js";
import { toCloudStorageErrorPayload } from "./cloudStorageError.js";
import type {
  StorageWorkerControlMessage,
  StorageWorkerInit,
  StorageWorkerMessage,
  StorageWorkerRequest,
} from "./workerProtocol.js";

function send(message: StorageWorkerMessage): void {
  process.send?.(message);
}

function main(): void {
  let runtime: StorageWorkerRuntime | undefined;

  process.on("message", (message: StorageWorkerControlMessage | StorageWorkerRequest) => {
    if (!message || typeof message !== "object") return;
    if (message.kind === "init") {
      if (runtime) return;
      try {
        runtime = createStorageWorkerRuntime(message.init as StorageWorkerInit);
      } catch (error) {
        send({ kind: "init-error", error: toCloudStorageErrorPayload(error) });
        return;
      }
      const facts = runtime.facts();
      send({
        kind: "ready",
        schemaVersion: facts.schemaVersion,
        lastAppliedMigrationId: facts.lastAppliedMigrationId,
      });
      return;
    }
    if (message.kind !== "request") return;
    if (!runtime) {
      send({
        kind: "response",
        id: message.id,
        ok: false,
        error: {
          code: "not_ready",
          reason: "database-closed",
          message: "storage worker 未初始化",
        },
      });
      return;
    }
    try {
      const result = runtime.handle(message.method, message.params);
      send({ kind: "response", id: message.id, ok: true, result });
    } catch (error) {
      send({
        kind: "response",
        id: message.id,
        ok: false,
        error: toCloudStorageErrorPayload(error),
      });
    }
  });

  // 父进程消失时随 IPC 断开退出，不留下孤儿写者（单写权由文件锁保证）。
  process.on("disconnect", () => {
    try {
      runtime?.close();
    } finally {
      process.exit(0);
    }
  });
}

main();

/**
 * storage 传输层（W2 §4）：把「方法名 + 参数」送到 SQLite 执行点。
 *
 * 两种传输跑同一份运行时（storageWorkerRuntime）：
 * - `worker`（默认）：独立子进程（W2 §3 worker 进程入口），HTTP 进程完全不接触
 *   `node:sqlite`；崩溃隔离，写锁仍由数据库文件裁决。
 * - `in-process`：同线程直接调用，供嵌入式装配与仓储集成测试使用，仍然是异步
 *   接口形状（同步异常一律转成 rejected promise），调用方无法据此写出同步用法。
 *
 * worker 初始化失败（迁移/锁/磁盘）通过首条 `init-error` 消息上报并转成
 * CloudStorageError：装配方必须 fail closed（03 §8）。
 */
import { fork } from "node:child_process";
import { existsSync } from "node:fs";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CloudStorageError,
  isCloudStorageError,
  toCloudStorageErrorPayload,
} from "./cloudStorageError.js";
import type { CloudStorageErrorPayload } from "./cloudStorageError.js";
import { createStorageWorkerRuntime } from "./storageWorkerRuntime.js";
import type { StorageWorkerRuntime } from "./storageWorkerRuntime.js";
import type { StorageWorkerInit, StorageWorkerMessage } from "./workerProtocol.js";

export type StorageTransportMode = "worker" | "in-process";

export interface StorageTransport {
  request(method: string, params: unknown): Promise<unknown>;
  close(): Promise<void>;
}

export interface StorageTransportOptions {
  init: StorageWorkerInit;
  mode?: StorageTransportMode;
  /** worker 初始化握手超时；超时视为启动失败，不无限等待。 */
  initTimeoutMs?: number;
  /**
   * worker 入口覆盖（默认取与 storageTransport 同目录、同扩展名的 storageWorkerMain）。
   * 打包部署（bundle）里入口文件不随源码目录结构输出时必须显式指定；缺失即 fail closed。
   */
  workerEntryPath?: string;
}

const DEFAULT_INIT_TIMEOUT_MS = 30_000;

export async function createStorageTransport(
  options: StorageTransportOptions,
): Promise<StorageTransport> {
  return (options.mode ?? "worker") === "in-process"
    ? createInProcessTransport(options.init)
    : createWorkerProcessTransport(options);
}

/** 与当前模块同目录、同扩展名的 worker 入口（源码下是 .ts，构建产物下是 .js）。 */
export function storageWorkerEntryPath(moduleUrl: string): string {
  const current = fileURLToPath(moduleUrl);
  return path.join(path.dirname(current), `storageWorkerMain${path.extname(current)}`);
}

/**
 * 子进程启动参数：源码形态（.ts）需要 tsx 解析 TS，构建产物（.js）不需要。
 * 不复用 `process.execArgv`——测试运行器参数（如 --test）不得泄漏给 worker。
 */
export function storageWorkerExecArgv(entryPath: string): string[] {
  return path.extname(entryPath) === ".ts" ? ["--import", "tsx"] : [];
}

function toStorageError(payload: CloudStorageErrorPayload): CloudStorageError {
  return new CloudStorageError({
    code: payload.code,
    reason: payload.reason,
    message: payload.message,
  });
}

function createInProcessTransport(init: StorageWorkerInit): StorageTransport {
  let runtime: StorageWorkerRuntime;
  try {
    runtime = createStorageWorkerRuntime(init);
  } catch (error) {
    // 与 worker 路径一致：初始化失败表现为 rejected promise，由装配方 fail closed。
    return {
      request: () => Promise.reject(error),
      close: () => Promise.resolve(),
    };
  }
  let closed = false;
  return {
    request: (method, params) => {
      if (closed) {
        return Promise.reject(
          new CloudStorageError({
            code: "not_ready",
            reason: "database-closed",
            message: "存储已关闭",
          }),
        );
      }
      // 同步执行包成 promise：同步异常不能让调用方绕过 async 端口语义。
      // 未归一的底层错误与 worker 路径一样转成 CloudStorageError（同一错误面）。
      return new Promise((resolve, reject) => {
        try {
          resolve(runtime.handle(method, params));
        } catch (error) {
          reject(
            isCloudStorageError(error) ? error : toStorageError(toCloudStorageErrorPayload(error)),
          );
        }
      });
    },
    close: () => {
      closed = true;
      runtime.close();
      return Promise.resolve();
    },
  };
}

function createWorkerProcessTransport(options: StorageTransportOptions): Promise<StorageTransport> {
  const entry = options.workerEntryPath ?? storageWorkerEntryPath(import.meta.url);
  if (!existsSync(entry)) {
    // 打包产物没有独立入口时必须显式配置，不能悄悄退回进程内同步 SQL（03 §4）。
    return Promise.reject(
      new CloudStorageError({
        code: "not_ready",
        reason: "worker-unavailable",
        message: `storage worker 入口不存在：${entry}（打包部署需把该入口输出为独立文件或用 workerEntryPath 指定）`,
      }),
    );
  }
  const child: ChildProcess = fork(entry, [], {
    execArgv: storageWorkerExecArgv(entry),
    stdio: ["ignore", "inherit", "inherit", "ipc"],
    serialization: "json",
  });
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: unknown) => void }
  >();
  let nextId = 1;
  let closed = false;
  let exited = false;

  const failAll = (error: unknown): void => {
    for (const entryPending of pending.values()) entryPending.reject(error);
    pending.clear();
  };

  return new Promise<StorageTransport>((resolveReady, rejectReady) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      rejectReady(
        new CloudStorageError({
          code: "not_ready",
          reason: "worker-unavailable",
          message: "storage worker 初始化超时",
        }),
      );
    }, options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS);
    timeout.unref?.();

    const transport: StorageTransport = {
      request: (method, params) => {
        if (closed) {
          return Promise.reject(
            new CloudStorageError({
              code: "not_ready",
              reason: "worker-unavailable",
              message: "storage worker 已关闭",
            }),
          );
        }
        const id = nextId++;
        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          child.send({ kind: "request", id, method, params });
        });
      },
      close: () =>
        new Promise<void>((resolve) => {
          closed = true;
          failAll(
            new CloudStorageError({
              code: "not_ready",
              reason: "worker-unavailable",
              message: "storage worker 已关闭",
            }),
          );
          if (exited) {
            resolve();
            return;
          }
          child.once("exit", () => resolve());
          child.kill();
        }),
    };

    child.on("message", (message: StorageWorkerMessage) => {
      if (message.kind === "ready") {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolveReady(transport);
        return;
      }
      if (message.kind === "init-error") {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.kill();
        rejectReady(toStorageError(message.error));
        return;
      }
      const entryPending = pending.get(message.id);
      if (!entryPending) return;
      pending.delete(message.id);
      if (message.ok) entryPending.resolve(message.result);
      else entryPending.reject(toStorageError(message.error));
    });

    child.on("error", (error: Error) => {
      const wrapped = new CloudStorageError({
        code: "not_ready",
        reason: "worker-unavailable",
        message: `storage worker 异常：${error.message}`,
      });
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectReady(wrapped);
        return;
      }
      failAll(wrapped);
    });

    child.on("exit", (code) => {
      closed = true;
      exited = true;
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectReady(
          new CloudStorageError({
            code: "not_ready",
            reason: "worker-unavailable",
            message: `storage worker 退出（code=${code}）`,
          }),
        );
        return;
      }
      if (code !== 0) {
        failAll(
          new CloudStorageError({
            code: "recovery_required",
            reason: "worker-unavailable",
            message: `storage worker 非正常退出（code=${code}）`,
          }),
        );
      }
    });

    child.send({ kind: "init", init: options.init });
  });
}

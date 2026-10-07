/**
 * storage worker 的请求协议（W2 §3/§4）。
 *
 * 分工：方法表与 handler 契约在下层 `storageMethodTypes.ts`（repositories 也要依赖
 * 它，放在这里会被反向引用成环）；本文件只保留进程间消息信封与 worker 启动参数，
 * 并原样再导出方法表——现有导入路径（`./workerProtocol.js`）保持不变。
 *
 * 故障注入（W2 §8、10 §6 B07）：`faults` 在方法派发前生效，用于验证「DB 操作失败
 * 不产生 accepted、不创建 provider 资源」的持久侧断言（CP-02）。
 */
export * from "./storageMethodTypes.js";

import type { CloudStorageErrorPayload } from "./cloudStorageError.js";
import type { StorageFaultRule } from "./storageMethodTypes.js";

// ── 消息信封 ──

export interface StorageWorkerInit {
  databasePath: string;
  synchronous: "FULL" | "NORMAL";
  busyTimeoutMs?: number;
  /**
   * 容量护栏：迁移完成后把页数上限固定为当前大小。生产用于限制单库增长，
   * 测试用于制造真实的 SQLITE_FULL（磁盘满/写入失败路径，CP-02）。
   */
  capDatabasePages?: boolean;
  faults?: readonly StorageFaultRule[];
}

export interface StorageWorkerRequest {
  kind: "request";
  id: number;
  method: string;
  params: unknown;
}

/** 父进程 → worker 的首条消息：worker 收到后才打开数据库（不在 argv/env 里传配置）。 */
export interface StorageWorkerInitMessage {
  kind: "init";
  init: StorageWorkerInit;
}

export type StorageWorkerControlMessage = StorageWorkerInitMessage;

export type StorageWorkerMessage =
  | { kind: "ready"; schemaVersion: number; lastAppliedMigrationId: string | null }
  | { kind: "init-error"; error: CloudStorageErrorPayload }
  | { kind: "response"; id: number; ok: true; result: unknown }
  | { kind: "response"; id: number; ok: false; error: CloudStorageErrorPayload };

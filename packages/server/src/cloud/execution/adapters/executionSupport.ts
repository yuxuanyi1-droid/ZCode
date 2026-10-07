/**
 * 执行节点适配层基础件：真实时钟与服务日志（AGENTS「日志」规范：
 * Agent/session/runtime 相关服务日志用 `createServiceLogger(scope)`；debug 只用于
 * 高频诊断且生产不落盘）。
 */
import { createServiceLogger } from "@zcode/services/node";
import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { ExecutionClock, ExecutionLogger } from "../app/ports.js";

/** 沙箱内日志文件上限（超过就重写，只保留最新一行，不让沙箱里长日志）。 */
const EXECUTION_LOG_MAX_BYTES = 256 * 1024;

function describeLogArg(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return "[unprintable]";
  }
}

/**
 * 落盘 sink（**2026-10-07 真实链路**：沙箱里 supervisor 的 stdout/stderr 由 provider 的
 * 后台命令会话持有，进程一退出就随之丢失——控制面只看到 socket 1006，只能进沙箱逐条翻
 * 状态文件猜死因）。这里把 info/warn/error 同时追加到状态目录，`debug` 明确不落盘
 * （AGENTS：debug 生产不落盘）。同步写是刻意的：崩溃路径没有机会 await，且频率低、有上限。
 */
export function createExecutionFileSink(path: string): {
  log: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug: (...args: unknown[]) => void;
} {
  function append(level: string, args: unknown[]): void {
    const line = `${new Date().toISOString()} ${level} ${args.map(describeLogArg).join(" ")}\n`;
    try {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      // 首次写入时文件还不存在：`statSync` 会抛 ENOENT，若把它算进"写失败"就永远不会建文件
      // （2026-10-07 实测：沙箱里连日志文件都没有，等于白加）。
      const size = existsSync(path) ? statSync(path).size : 0;
      if (size > EXECUTION_LOG_MAX_BYTES) writeFileSync(path, line, { mode: 0o600 });
      else appendFileSync(path, line, { mode: 0o600 });
    } catch {
      // 日志落盘失败绝不影响执行路径。
    }
  }
  return {
    log: (...args) => {
      console.log(...args);
      append("INFO", args);
    },
    warn: (...args) => {
      console.warn(...args);
      append("WARN", args);
    },
    error: (...args) => {
      console.error(...args);
      append("ERROR", args);
    },
    debug: (...args) => {
      console.debug?.(...args);
    },
  };
}

export function createExecutionLogger(
  scope: string,
  pid?: number,
  options?: { logFilePath?: string },
): ExecutionLogger {
  const logger = createServiceLogger(scope, {
    ...(pid === undefined ? {} : { pid }),
    ...(options?.logFilePath ? { sink: createExecutionFileSink(options.logFilePath) } : {}),
  });
  return Object.assign(logger, { scope });
}

export interface CancellableWait {
  cancelled(): boolean;
}

/** 真实定时器；`stop()` 后所有 pending wait 立即返回（供 supervisor 退出路径使用）。 */
export function createProcessClock(): ExecutionClock & { stop(): void } {
  let stopped = false;
  const pending = new Set<() => void>();
  return {
    now: () => Date.now(),
    wait(ms: number, signal?: CancellableWait) {
      if (stopped || signal?.cancelled()) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const finish = () => {
          pending.delete(finish);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, Math.max(0, ms));
        pending.add(finish);
      });
    },
    stop() {
      stopped = true;
      for (const finish of Array.from(pending)) finish();
    },
  };
}

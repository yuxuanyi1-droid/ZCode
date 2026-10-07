/**
 * 沙箱 supervisor 常驻进程入口（specs/cloud-agent 02 §3、01 §6.2 实施决议；W6 §3）。
 *
 * 由 `/opt/zcode/start-supervisor.sh`（flock 单例）exec 拉起，自举要素经 env 下发
 * （provider 命令通道，不进 argv/URL/日志；见 `adapters/sandbox/sandboxSupervisorStart.ts`）。
 *
 * 退出语义（**早期失败必须对控制面可见**——2026-10-05 真实 E2B 实测：状态目录不可写时
 * supervisor 只打印一行就退出，控制面只能等 120s 超时；因此这里把诊断固定成两路可见）：
 * - stderr：人类可读的一行（provider 命令通道会捕获）；
 * - stdout：一行有界 JSON（`{"type":"zcode-supervisor-failed",...}`），供 W3 的启动探测
 *   与运维按机器可读方式识别；不含凭据/prompt，只有阶段与错误码；
 * - 退出码：`2` = 自举要素缺失/目录不可写等**装配期**失败；`1` = 运行期不可恢复失败；
 * - SIGTERM/SIGINT → 走显式停止路径（关连接 + 释放 stdio），不是「断网」路径。
 *
 * 本文件是构建入口（W3 的 `build:sandbox-assets` 按此路径打包），保持实现薄、依赖收敛。
 */
import process from "node:process";
import { appendFileSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createExecutionLogger } from "../adapters/executionSupport.js";
import {
  createSandboxSupervisor,
  type SandboxSupervisor,
} from "../adapters/supervisorRuntime.js";
import { readSupervisorConfig } from "../adapters/supervisorConfig.js";
import { DEFAULT_RUNTIME_STATE_DIR } from "../adapters/credentialStateFile.js";

const EXECUTION_LOG_PATH = join(DEFAULT_RUNTIME_STATE_DIR, "supervisor.log");
const logger = createExecutionLogger("cloud-execution", process.pid, {
  logFilePath: EXECUTION_LOG_PATH,
});

/**
 * 落盘的失败证据（**2026-10-07 真实链路**：supervisor 在 sandbox 里退出后，进程没了、
 * stderr 随 envd 后台命令一起丢失、控制面只看到 socket 1006，只能进沙箱逐条翻状态文件猜原因）。
 * 退出路径没有机会 await 异步 IO，这里用同步追加是**刻意的例外**：文件小、一次性、
 * 且必须活到 `process.exit` 之后。超过上限就重写（保留最新一条，不让沙箱里长日志）。
 */
const CRASH_LOG_MAX_BYTES = 64 * 1024;

function writeCrashLog(stage: string, message: string): void {
  const line = `${new Date().toISOString()} FAILED stage=${stage} message=${message.slice(0, 512)}\n`;
  try {
    mkdirSync(DEFAULT_RUNTIME_STATE_DIR, { recursive: true, mode: 0o700 });
    const size = statSync(EXECUTION_LOG_PATH).size;
    if (size > CRASH_LOG_MAX_BYTES) writeFileSync(EXECUTION_LOG_PATH, line, { mode: 0o600 });
    else appendFileSync(EXECUTION_LOG_PATH, line, { mode: 0o600 });
  } catch {
    // 失败证据本身绝不能把进程带崩：文件写不进去就算了，还有 stderr/stdout 两路。
  }
}

/**
 * 机器可读的失败行：控制面/运维侧可据此区分「装配期失败」与「运行期失败」，
 * 不必解析人类可读文案（也避免把敏感值带出去）。
 */
function reportFailure(stage: string, message: string, missing?: readonly string[]): void {
  const line = JSON.stringify({
    type: "zcode-supervisor-failed",
    stage,
    message: message.slice(0, 512),
    ...(missing && missing.length > 0 ? { missing: [...missing] } : {}),
  });
  process.stdout.write(`${line}\n`);
  process.stderr.write(`zcode supervisor failed at ${stage}: ${message}\n`);
  writeCrashLog(stage, message);
}

async function main(): Promise<number> {
  const config = await readSupervisorConfig(process.env);
  if (!config.ok) {
    // 只打印缺失的变量名（值可能含票据，绝不回显）。
    reportFailure(
      "bootstrap-config",
      `bootstrap env incomplete; missing: ${config.missing.join(", ")}`,
      config.missing,
    );
    return 2;
  }

  const supervisor: SandboxSupervisor = createSandboxSupervisor({
    config: config.value,
    logger,
  });
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info(undefined, "supervisor shutting down", { signal, runId: config.value.runId });
    await supervisor.stop(signal).catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  // 未捕获异常/未处理拒绝在后台进程里是**静默消失**的主要来源：默认行为也会退出，但栈只写到
  // 随 envd 一起丢失的 stderr（2026-10-07 实测：进程没了、沙箱还在、控制面只有 1006）。
  // 这两条挂在最前面，先落盘再退出，不试图恢复——恢复语义归控制面（02 §8）。
  process.on("uncaughtException", (error: unknown) => {
    reportFailure(
      "uncaught-exception",
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
    process.exit(1);
  });
  process.on("unhandledRejection", (reason: unknown) => {
    reportFailure(
      "unhandled-rejection",
      reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
    );
    process.exit(1);
  });

  try {
    await supervisor.start();
  } catch (error) {
    // 装配期失败（状态目录不可写、凭据状态持久化失败等）：明确阶段 + 非 0 退出。
    reportFailure("startup", error instanceof Error ? error.message : String(error));
    return 2;
  }
  logger.info(undefined, "supervisor started", {
    runId: config.value.runId,
    runGeneration: config.value.runGeneration,
  });

  // 常驻：网络断开由会话内部重连（不是退出条件）；只有不可恢复的本地失败才收尾退出。
  const outcome = await Promise.race([
    supervisor.whenFatal().then((reason) => ({ fatal: true as const, reason })),
    new Promise<{ fatal: false }>(() => undefined),
  ]);
  if (outcome.fatal) {
    reportFailure("runtime", outcome.reason);
    await supervisor.stop("fatal-local-error").catch(() => undefined);
    return 1;
  }
  return 0;
}

main()
  .then((code) => {
    if (code !== 0) process.exit(code);
  })
  .catch((error: unknown) => {
    reportFailure("unhandled", error instanceof Error ? error.message : String(error));
    process.exit(1);
  });

/**
 * 沙箱内 zcode-server 的启动与生命周期（specs/cloud-agent/02 §3、07 §2.7 交互同构；
 * W6 §3「runtimeOwner.ts」）。
 *
 * 布局与 SSH 远端部署同构（`remote/deployShared.ts` 的 REMOTE_BASE）：
 *   <root>/node <root>/zcode-server.cjs
 * 由 `start-supervisor.sh` 幂等物化，本模块只按同一形状启动，不重建布局。
 *
 * 生命周期边界（02 §3）：
 * - 只有**显式停止**（生命周期操作）才 stop；网络断开永远不经过这里；
 * - 进程退出是真实事实（带上报），不能宣称换网络连接即可恢复。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Emitter, type Event } from "@zcode/rpc";
import {
  SERVICE_AUTHORITY_MODE_ENV,
  serviceAuthorityModes,
  type ServiceAuthorityMode,
} from "@zcode/shared";
import type { ExecutionLogger, RuntimeOwnerPort, RuntimeStdioStream } from "../app/ports.js";

/** SSH 同构部署根（`remote/deployShared.ts` REMOTE_BASE 的同名语义）。 */
export const DEFAULT_RUNTIME_ROOT = "~/.zcode/server";

export function resolveRuntimeRoot(root: string = DEFAULT_RUNTIME_ROOT): string {
  if (root.startsWith("~/")) return resolve(join(homedir(), root.slice(2)));
  return resolve(root);
}

/**
 * 执行节点 authority：**云执行节点模式**（07 §8 要求独立模式，不再复用 `standalone-server`）。
 * 该模式在 `@zcode/services` 侧的语义：本节点自己应答 runtime preferences/policy、开启
 * provider provisioning target、按远端口径裁剪 host 绑定工具面（见 services 的
 * `serviceAuthorityPolicy.ts`）。
 */
export const DEFAULT_EXECUTION_AUTHORITY = "cloud-execution-node" satisfies ServiceAuthorityMode;

export function parseExecutionAuthority(raw: string | undefined): ServiceAuthorityMode {
  const value = raw?.trim();
  if (!value) return DEFAULT_EXECUTION_AUTHORITY;
  // 云节点不得声明 Desktop 本机 authority（07 §8）：显式 desktop-local 一律拒绝并回落默认。
  if (value === "desktop-local") return DEFAULT_EXECUTION_AUTHORITY;
  if (value === DEFAULT_EXECUTION_AUTHORITY) return DEFAULT_EXECUTION_AUTHORITY;
  return (serviceAuthorityModes as readonly string[]).includes(value)
    ? (value as ServiceAuthorityMode)
    : DEFAULT_EXECUTION_AUTHORITY;
}

/** 启动命令（argv 形式，与 SSH 的 `<root>/node <root>/zcode-server.cjs` 同形）。 */
export function runtimeCommand(root: string): { command: string; args: string[] } {
  return { command: join(root, "node"), args: [join(root, "zcode-server.cjs")] };
}

export function runtimeEnv(
  root: string,
  extra: Record<string, string | undefined> = {},
): Record<string, string> {
  const env: Record<string, string> = {
    ZCODE_SERVER_RUNTIME_ROOT: root,
    // 沙箱 runtime 的唯一 authority 来源；显式选择云执行节点模式（07 §2.7 交互同构 + §8）。
    [SERVICE_AUTHORITY_MODE_ENV]: parseExecutionAuthority(extra[SERVICE_AUTHORITY_MODE_ENV]),
  };
  for (const [key, value] of Object.entries(extra)) {
    // authority 已在上方正则归一（拒绝 desktop-local）；额外 env 不得再把它覆盖回去。
    if (value === undefined || key === SERVICE_AUTHORITY_MODE_ENV) continue;
    env[key] = value;
  }
  return env;
}

export interface RuntimeOwnerOptions {
  logger: ExecutionLogger;
  root?: string;
  env?: Record<string, string | undefined>;
  /** 显式停止时的优雅退出预算（SIGTERM → SIGKILL）。 */
  stopGraceMs?: number;
  /** 进程工厂（测试注入）；默认真实 spawn。 */
  spawnProcess?: typeof spawn;
}

export interface RuntimeOwner extends RuntimeOwnerPort {
  /** 当前子进程 PID（未启动为 null）——B-02 断网不变量的断言锚点。 */
  pid(): number | null;
  exited: Event<{ code: number | null; signal: string | null }>;
}

export function createRuntimeOwner(options: RuntimeOwnerOptions): RuntimeOwner {
  const root = resolveRuntimeRoot(options.root);
  const spawnProcess = options.spawnProcess ?? spawn;
  const stopGraceMs = options.stopGraceMs ?? 5_000;
  let child: ChildProcess | null = null;
  let stream: RuntimeStdioStream | null = null;
  let incarnation: string | null = null;
  const exitEmitter = new Emitter<{ code: number | null; signal: string | null }>();

  function streamOf(process: ChildProcess): RuntimeStdioStream {
    const onClose = new Emitter<number>();
    const closeEvent: Event<number> = onClose.event;
    process.once("exit", (code) => onClose.fire(code ?? -1));
    process.once("error", () => onClose.fire(-1));
    if (!process.stdin || !process.stdout || !process.stderr) {
      throw new Error("runtime process stdio pipes missing");
    }
    return {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      onClose: closeEvent,
    };
  }

  return {
    async start() {
      if (child?.pid && stream) {
        return { pid: child.pid, incarnation: incarnation ?? `runtime-${child.pid}`, stream };
      }
      const { command, args } = runtimeCommand(root);
      const process_ = spawnProcess(command, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, ...runtimeEnv(root, options.env) },
        // 沙箱内 supervisor 不通过 shell 起进程：argv 形式，不经过 shell 解析。
        shell: false,
      });
      child = process_;
      stream = streamOf(process_);
      incarnation = `runtime-${process_.pid ?? "unknown"}-${Date.now()}`;
      // stderr 是限流脱敏诊断（02 §4）：只转发到本进程日志，不进会话投影。
      process_.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString("utf8").trimEnd();
        if (text.length > 0)
          options.logger.debug(undefined, "runtime stderr", { line: text.slice(0, 512) });
      });
      process_.once("exit", (code, signal) => {
        options.logger.warn(undefined, "sandbox runtime exited", { code, signal });
        exitEmitter.fire({ code, signal: signal ?? null });
      });
      if (!process_.pid) throw new Error("failed to spawn sandbox runtime");
      options.logger.info(undefined, "sandbox runtime process spawned", { pid: process_.pid });
      return { pid: process_.pid, incarnation: incarnation!, stream };
    },

    async stop(reason) {
      const process_ = child;
      if (!process_?.pid) return;
      options.logger.info(undefined, "stopping sandbox runtime", { pid: process_.pid, reason });
      await new Promise<void>((resolveStop) => {
        const timer = setTimeout(() => {
          process_.kill("SIGKILL");
          resolveStop();
        }, stopGraceMs);
        process_.once("exit", () => {
          clearTimeout(timer);
          resolveStop();
        });
        process_.kill("SIGTERM");
      });
      child = null;
      stream = null;
      incarnation = null;
    },

    facts() {
      return { pid: child?.pid ?? null, incarnation };
    },

    onExit(listener) {
      return exitEmitter.event(listener);
    },

    pid: () => child?.pid ?? null,
    exited: exitEmitter.event,
  };
}

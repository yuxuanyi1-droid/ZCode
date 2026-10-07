/**
 * E2B 沙箱内 supervisor 启动（specs/cloud-agent/01 §6.2 实施决议、§5.1、§9）。
 *
 * 通道：官方 JS SDK（`e2b`）的 envd 命令会话 —— `Sandbox.connect` +
 * `commands.run(SUPERVISOR_START_CMD, { background: true, envs })`。为什么必须用
 * SDK：模板的 `start_cmd` 是构建期启动、随快照恢复的进程，运行时 env 不进它的环境
 * （实测结论）；而运行中执行命令没有文档化的 REST 端点，envd 是 SDK 内部协议——
 * 手写该协议等于手写私有网关，禁止。
 *
 * **即时失败探测**（01 §5.1/§6.2：启动失败即补偿终止，不留静默孤儿）：
 * 后台命令拉起后在有界窗口内轮询退出码——窗口内已非 0 退出说明沙箱内启动失败（例如
 * 状态目录不可写），**立即**抛出带退出码与脱敏输出片段的确定错误，由控制面补偿终止，
 * 而不是把失败留给 readiness 超时（那会让用户看到"卡两分钟然后沙箱被销毁"且无原因）。
 * SDK 依据（`e2b` 2.52.1，`CommandHandle`）：构造时即开始消费事件流
 * （`this._wait = this.handleEvents()`），因此 `exitCode` / `stdout` / `stderr` 在没有
 * 任何回调、不调用 `wait()` 的情况下也会被填充——探测不需要额外通道或 `ps`。
 *
 * 自举要素（runId/runGeneration/ticket 等）只经 **命令 env** 下发：不进命令字符串
 * （argv）、不进 URL、不进 metadata/labels、不进日志（01 §4.1/§6.2）。
 * 启动失败 → 补偿终止（bootstrap_failed / provider_termination_unknown），
 * 语义与其余两家一致，公共契约在 sandboxSupervisorStart.ts。
 */
import { Sandbox } from "e2b";
import { createServiceLogger } from "@zcode/services/node";
import { CloudAdapterError, type CloudAdapterLogger } from "./adapterError.js";
import {
  startSupervisorOrTerminate,
  supervisorExitError,
  supervisorStartBackoffMs,
  supervisorStartEnv,
  SUPERVISOR_START_ATTEMPTS,
  SUPERVISOR_START_CMD,
  type SandboxTerminateProbe,
  type SupervisorStartInput,
  type SupervisorStarter,
} from "./sandboxSupervisorStart.js";

/**
 * 即时失败探测窗口（毫秒）：窗口内命令退出且非 0 → 确定失败；仍在运行 → 视为已拉起。
 * 3s 覆盖冷启动时的脚本/配置类失败；这是**有界启动信号，不是 readiness**（真正 ready
 * 由控制面按 bridge 握手裁决，02 §5.3）。按部署可调（`probeWindowMs`）。
 *
 * **可见性边界**：只有**窗口内**的失败能被这里看见并转成带原因的确定失败；晚于窗口才
 * 崩的 supervisor 这里观测不到，仍靠控制面的 readiness 看门狗兜底——探测不声称全时段可见。
 */
export const E2B_SUPERVISOR_PROBE_WINDOW_MS = 3_000;
export const E2B_SUPERVISOR_PROBE_POLL_MS = 250;

/**
 * supervisor 常驻进程的 provider 命令会话寿命。
 *
 * **修复依据（2026-10-07 真实链路）**：`commands.run` 的 `timeoutMs` 默认 60s，后台命令到点即被
 * 终止——两次实测 supervisor 分别在启动后 57s / 60s 消失、沙箱仍 `running`、进程全无、控制面
 * 只见 socket 1006（看起来像"断网"，实际是命令会话到点杀进程）。
 *
 * 取值 = E2B 沙箱上限（Hobby 1h / Pro 24h）。部署的沙箱寿命上限（01 §4.3 收敛）**必须 ≤ 该值**：
 * 命令会话寿命短于沙箱寿命时会先于沙箱被杀；更长则沙箱先到期，无副作用。Pro 账号要跑更久，
 * 通过 `commandTimeoutMs` 显式抬高。
 */
export const E2B_SUPERVISOR_COMMAND_TIMEOUT_MS = 60 * 60 * 1_000;

/**
 * 探测期需要的最小 handle 面：与官方 `CommandHandle` 结构兼容（其 `exitCode` 在运行中
 * 为 `undefined`，`stdout`/`stderr` 持续累积），测试可注入 fake。
 */
export interface E2bCommandHandle {
  readonly exitCode: number | undefined;
  readonly stdout: string;
  readonly stderr: string;
}

/** 后台命令通道（生产实现 = 官方 SDK envd；测试注入 fake，不触达 provider）。 */
export type E2bCommandRunner = (
  sandboxId: string,
  env: Record<string, string>,
) => Promise<E2bCommandHandle>;

export interface E2bSupervisorStarterOptions {
  /** provider API key 经注入读取；只传给 SDK，不进日志/env 载荷。 */
  apiKey: () => string | Promise<string>;
  requestTimeoutMs?: number;
  /** supervisor 命令会话寿命（缺省 1h，见 `E2B_SUPERVISOR_COMMAND_TIMEOUT_MS`）。 */
  commandTimeoutMs?: number;
  probeWindowMs?: number;
  probePollMs?: number;
  /** 测试注入的等待实现（缺省真实 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
  /** 测试注入的后台命令通道（缺省官方 SDK envd）。 */
  runCommand?: E2bCommandRunner;
  logger?: CloudAdapterLogger;
}

/** 生产通道：SDK connect + `commands.run(background)`，自举要素只经 envs。 */
export function createE2bCommandRunner(options: E2bSupervisorStarterOptions): E2bCommandRunner {
  return async (sandboxId, env) => {
    const apiKey = await options.apiKey();
    const sandbox = await Sandbox.connect(sandboxId, {
      apiKey,
      ...(options.requestTimeoutMs === undefined
        ? {}
        : { requestTimeoutMs: options.requestTimeoutMs }),
    });
    return await sandbox.commands.run(SUPERVISOR_START_CMD, {
      background: true,
      envs: env,
      // 不给 timeoutMs 就落到默认 60s：supervisor 会被命令会话到点杀掉（见常量注释）。
      timeoutMs: options.commandTimeoutMs ?? E2B_SUPERVISOR_COMMAND_TIMEOUT_MS,
    });
  };
}

/**
 * 有界轮询退出码：**先查再等**（立即失败不花任何等待），窗口内已退出即返回退出码；
 * 窗口结束时仍未退出（或恰好退出）→ 返回最后观测值。
 */
export async function probeSupervisorExit(
  handle: E2bCommandHandle,
  windowMs: number,
  pollMs: number,
  sleep: (ms: number) => Promise<void>,
): Promise<number | undefined> {
  for (let elapsed = 0; elapsed < windowMs; elapsed += pollMs) {
    if (handle.exitCode !== undefined) return handle.exitCode;
    await sleep(pollMs);
  }
  return handle.exitCode;
}

/**
 * 生产实现：SDK 后台拉起 + 即时失败探测。窗口内非 0 退出 → 确定失败（带原因）。
 * 退出码 0（flock 幂等分支）/ 仍在运行都视为已拉起。
 */
export function createE2bSupervisorStarter(
  options: E2bSupervisorStarterOptions,
): SupervisorStarter {
  const runner = options.runCommand ?? createE2bCommandRunner(options);
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const windowMs = options.probeWindowMs ?? E2B_SUPERVISOR_PROBE_WINDOW_MS;
  const pollMs = options.probePollMs ?? E2B_SUPERVISOR_PROBE_POLL_MS;

  async function startOnce(sandboxId: string, input: SupervisorStartInput): Promise<void> {
    const handle = await runner(sandboxId, supervisorStartEnv(input));
    const exitCode = await probeSupervisorExit(handle, windowMs, pollMs, sleep);
    // undefined = 仍在运行（期望状态）；0 = 脚本 flock 幂等分支（已有实例在跑，重试的正常
    // 结果）。两者都算已拉起；只有非 0 退出才是沙箱内启动失败。
    if (exitCode === undefined || exitCode === 0) return;
    // 输出片段脱敏（抹掉自举 ticket）后才有界化，绝不带整段 stdout/stderr 或 env。
    throw supervisorExitError({
      provider: "e2b",
      sandboxId,
      exitCode,
      stdout: handle.stdout,
      stderr: handle.stderr,
      secrets: [input.bootstrapTicket],
    });
  }

  return async (sandboxId, input) => {
    let lastError = "";
    for (let attempt = 1; attempt <= SUPERVISOR_START_ATTEMPTS; attempt += 1) {
      try {
        await startOnce(sandboxId, input);
        options.logger?.info(undefined, "e2b supervisor started via envd", { sandboxId, attempt });
        return;
      } catch (error) {
        // 沙箱内确定性失败（脚本/配置错误）重试无意义：立即上报，尽快补偿终止。
        if (error instanceof CloudAdapterError && error.code === "bootstrap_failed") throw error;
        // 其余（envd/网络抖动）保留有界重试语义。
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < SUPERVISOR_START_ATTEMPTS) {
          await sleep(supervisorStartBackoffMs(attempt));
        }
      }
    }
    throw new Error(
      `e2b supervisor start failed after ${SUPERVISOR_START_ATTEMPTS} attempts: ${lastError}`,
    );
  };
}

export interface E2bSupervisorLauncherOptions extends E2bSupervisorStarterOptions {
  /** 测试注入的 supervisor 启动器（缺省 SDK envd 通道 + 即时失败探测）。 */
  startSupervisor?: SupervisorStarter;
}

/**
 * create 成功路径调用（01 §5.1/§9）：启动 supervisor，失败即补偿终止并抛归一错误。
 */
export async function launchE2bSupervisor(
  options: E2bSupervisorLauncherOptions,
  terminateSandbox: SandboxTerminateProbe,
  sandboxId: string,
  input: SupervisorStartInput,
): Promise<void> {
  const logger = options.logger ?? createServiceLogger("cloud-sandbox-e2b");
  await startSupervisorOrTerminate(
    options.startSupervisor ?? createE2bSupervisorStarter({ ...options, logger }),
    terminateSandbox,
    sandboxId,
    input,
    logger,
    "e2b",
  );
}

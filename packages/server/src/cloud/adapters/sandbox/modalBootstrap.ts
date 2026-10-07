/**
 * Modal 沙箱内 supervisor 启动（specs/cloud-agent/01 §6.2 实施决议、§5.1、§9）。
 *
 * 通道：官方 Python SDK 子进程桥（modalSdkBridge.ts + modal/modal_bridge.py）的
 * `exec` op —— `sb.exec("/opt/zcode/start-supervisor.sh", env=自举env)`
 * 以 DEVNULL 流后台启动，再 `detach()`（官方 docstring：「Detaching doesn't terminate
 * or otherwise affect the remote Sandbox; it only cleans up client-side resources.」）。
 * 桥在启动后做 1s 即时失败探测，返回 exitCode：仍为 null = 期望状态；非 0 = 本次未拉起。
 *
 * 为什么不能没有通道：Modal 官方只提供 Python/JS/Go SDK（gRPC），没有文档化的
 * HTTP/REST 沙箱 API（研究证据与结论见 01 §6.2）。未注入桥时保留**门禁降级**：
 * 确定性拒绝（resource_unsupported），不假装成功、不静默留裸沙箱。
 *
 * 两条路径共用同一补偿语义（startSupervisorOrTerminate）：启动失败 → 补偿终止，
 * 已确认清理 → `bootstrap_failed`；未确认 → `provider_termination_unknown`。
 */
import { createServiceLogger } from "@zcode/services/node";
import { CloudAdapterError, type CloudAdapterLogger } from "./adapterError.js";
import type { ModalSdkBridge } from "./modalSdkBridge.js";
import {
  startSupervisorOrTerminate,
  SUPERVISOR_START_ATTEMPTS,
  SUPERVISOR_START_CMD,
  supervisorStartBackoffMs,
  supervisorStartEnv,
  type SandboxTerminateProbe,
  type SupervisorStartInput,
  type SupervisorStarter,
} from "./sandboxSupervisorStart.js";

/** 门禁拒绝的 bounded 说明（运营证据在 01 §6.2 与模块 README）。 */
export const MODAL_BOOTSTRAP_GATE_MESSAGE =
  "Modal has no documented HTTP sandbox exec API; runtime bootstrap is gated until the SDK bridge is configured";

/**
 * 门禁 starter：始终拒绝。错误码用错误码目录里的 resource_unsupported（不新增错误码）。
 */
export function createModalGatedSupervisorStarter(): SupervisorStarter {
  return async (sandboxId: string, input: SupervisorStartInput) => {
    throw new CloudAdapterError("resource_unsupported", MODAL_BOOTSTRAP_GATE_MESSAGE, {
      provider: "modal",
      sandboxId,
      operationKey: input.operationKey,
    });
  };
}

export interface ModalSdkSupervisorStarterOptions {
  bridge: ModalSdkBridge;
  /** 测试注入的退避等待（缺省真实 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
  logger?: CloudAdapterLogger;
}

/**
 * SDK 通道的 supervisor 启动器（01 §6.2）：自举要素只经 exec 的 env 注入，不进命令
 * 字符串、不进 provider tags。单次尝试失败 → 有界退避重试；重复拉起由镜像内
 * start-supervisor.sh 的 flock 单例兜底幂等（与 E2B/Daytona 同契约）。
 */
export function createModalSdkSupervisorStarter(
  options: ModalSdkSupervisorStarterOptions,
): SupervisorStarter {
  const logger = options.logger ?? createServiceLogger("cloud-sandbox-modal");
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  async function startOnce(sandboxId: string, input: SupervisorStartInput): Promise<void> {
    const outcome = await options.bridge.call("exec", {
      sandboxId,
      mode: "background",
      command: [SUPERVISOR_START_CMD],
      env: supervisorStartEnv(input),
    });
    if (!outcome.ok) {
      throw new Error(`supervisor exec failed: ${outcome.failure.reason}`);
    }
    const exitCode = outcome.result["exitCode"];
    // 桥在启动后等待 1s 做即时失败探测：已结束且非 0 = 本次未拉起（如布局物化失败），
    // 仍在运行（exitCode=null）= 期望状态。
    if (typeof exitCode === "number" && exitCode !== 0) {
      throw new Error(`supervisor exited immediately with code ${exitCode}`);
    }
  }

  return async (sandboxId, input) => {
    let lastError = "";
    for (let attempt = 1; attempt <= SUPERVISOR_START_ATTEMPTS; attempt += 1) {
      try {
        await startOnce(sandboxId, input);
        logger.info(undefined, "modal supervisor started via sdk exec channel", {
          sandboxId,
          attempt,
        });
        return;
      } catch (error) {
        // 有界、脱敏（不含 ticket/env 值）的失败原因，供补偿分类与运营核对。
        lastError = error instanceof Error ? error.message : String(error);
        if (attempt < SUPERVISOR_START_ATTEMPTS) {
          await sleep(supervisorStartBackoffMs(attempt));
        }
      }
    }
    throw new Error(
      `supervisor start failed after ${SUPERVISOR_START_ATTEMPTS} attempts: ${lastError}`,
    );
  };
}

export interface ModalSupervisorLauncherOptions {
  /** 测试注入的 supervisor 启动器（缺省按 bridge 有无选择 SDK 通道/门禁）。 */
  startSupervisor?: SupervisorStarter;
  /** SDK 子进程桥；未配置 → 门禁降级（确定性拒绝 + 补偿终止）。 */
  bridge?: ModalSdkBridge;
  /** 测试注入的退避等待（缺省真实 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
  logger?: CloudAdapterLogger;
}

/**
 * 控制面在 `persistHandle()` 之后经 `startSupervisor` 调用（01 §5.1/§9）：
 * 启动失败 → 补偿终止并抛归一错误。
 * 通道选择：显式注入的 startSupervisor → 配置了 bridge 走 SDK 通道 → 否则门禁降级。
 */
export async function launchModalSupervisor(
  options: ModalSupervisorLauncherOptions,
  terminateSandbox: SandboxTerminateProbe,
  sandboxId: string,
  input: SupervisorStartInput,
): Promise<void> {
  const logger = options.logger ?? createServiceLogger("cloud-sandbox-modal");
  const starter =
    options.startSupervisor ??
    (options.bridge
      ? createModalSdkSupervisorStarter({ bridge: options.bridge, sleep: options.sleep, logger })
      : createModalGatedSupervisorStarter());
  await startSupervisorOrTerminate(starter, terminateSandbox, sandboxId, input, logger, "modal");
}

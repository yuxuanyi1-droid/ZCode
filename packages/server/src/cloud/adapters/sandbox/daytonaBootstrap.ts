/**
 * Daytona 沙箱内 supervisor 启动（specs/cloud-agent/01 §6.2；Daytona 的通道实现）。
 *
 * 官方通道是 **toolbox API**（Daytona 官方 OpenAPI/SDK 契约，非推测）：
 * 1. toolbox 基址 = sandbox DTO 的 `toolboxProxyUrl` + `/{sandboxId}`
 *    （官方描述：`{toolboxProxyUrl}/{sandboxId}/{endpoint}`，Daytona Cloud 默认
 *    `https://proxy.app.daytona.io/toolbox/{sandboxId}`）；鉴权与主 API 同 Bearer key。
 * 2. env 注入：`POST /env` body `{set}`——写入 daemon 进程 env，之后 spawn 的进程
 *    （exec/sessions/PTY）继承它。`SessionExecuteRequest` 无 env 字段，因此自举要素
 *    **只经 /env 通道**，不进命令字符串。
 * 3. 后台执行：固定会话 + `POST /process/session/{id}/exec` `{command, runAsync:true}`，
 *    再 `GET …/command/{cmdId}` 做即时失败探测（exitCode）。
 *
 * 生命周期边界（如实声明，不假设额外能力）：后台命令是沙箱内进程，随 stop/销毁失效；
 * 控制面重启不会自动重拉（镜像内 start-supervisor.sh 的 flock 单例兜底幂等）；
 * 沙箱重启后会话是否恢复未实测。
 */
import { createServiceLogger } from "@zcode/services/node";
import type { CloudAdapterLogger } from "./adapterError.js";
import {
  createDaytonaRestClient,
  DAYTONA_DEFAULT_BASE_URL,
  DAYTONA_DEFAULT_REQUEST_TIMEOUT_MS,
  DAYTONA_GET_RETRY_ATTEMPTS,
  DAYTONA_PATH_SANDBOX,
} from "./daytonaRest.js";
import {
  assertSupervisorProcessAlive,
  startSupervisorOrTerminate,
  SUPERVISOR_START_ATTEMPTS,
  SUPERVISOR_START_CMD,
  supervisorStartBackoffMs,
  supervisorStartEnv,
  type SandboxTerminateProbe,
  type SupervisorStartInput,
  type SupervisorStarter,
} from "./sandboxSupervisorStart.js";
import {
  asRecord,
  asString,
  createSandboxRestClient,
  type SandboxFetch,
  type SandboxRestClient,
} from "./sandboxRest.js";

/** 会话名固定：重试/控制面重启复用同一会话（命令幂等由脚本 flock 保证）。 */
export const DAYTONA_SUPERVISOR_SESSION_ID = "zcode-supervisor";

export interface DaytonaSupervisorStarterOptions {
  /** provider API key（dtn_ 前缀）经注入读取；只进 Authorization header。 */
  apiKey: () => string | Promise<string>;
  /** 主 API base（解析 sandbox DTO）；缺省 Daytona Cloud。 */
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetch?: SandboxFetch;
  /** 测试注入的退避等待（缺省真实 setTimeout）。 */
  sleep?: (ms: number) => Promise<void>;
  logger?: CloudAdapterLogger;
}

export interface DaytonaSupervisorLauncherOptions {
  /** 测试注入的 supervisor 启动器（缺省 toolbox 会话通道）。 */
  startSupervisor?: SupervisorStarter;
  apiKey: () => string | Promise<string>;
  baseUrl?: string;
  requestTimeoutMs?: number;
  fetch?: SandboxFetch;
  logger?: CloudAdapterLogger;
}

/**
 * create 成功后按 01 §6.2 启动 supervisor，失败即补偿终止（01 §5.1/§9）。
 * 与 E2B 的差别只在通道：启动器 + 补偿终止 + 失败分类都收在 provider 的 bootstrap
 * 模块，driver 保持三分支语义的紧凑表达（共享契约 sandboxSupervisorStart.ts）。
 */
export async function launchDaytonaSupervisor(
  options: DaytonaSupervisorLauncherOptions,
  terminateSandbox: SandboxTerminateProbe,
  sandboxId: string,
  input: SupervisorStartInput,
): Promise<void> {
  const logger = options.logger ?? createServiceLogger("cloud-sandbox-daytona");
  await startSupervisorOrTerminate(
    options.startSupervisor ?? createDaytonaSupervisorStarter({ ...options, logger }),
    terminateSandbox,
    sandboxId,
    input,
    logger,
    "daytona",
  );
}

export function createDaytonaSupervisorStarter(
  options: DaytonaSupervisorStarterOptions,
): SupervisorStarter {
  const logger = options.logger ?? createServiceLogger("cloud-sandbox-daytona");
  const requestTimeoutMs = options.requestTimeoutMs ?? DAYTONA_DEFAULT_REQUEST_TIMEOUT_MS;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const mainRest = createDaytonaRestClient({
    apiKey: options.apiKey,
    baseUrl: options.baseUrl ?? DAYTONA_DEFAULT_BASE_URL,
    requestTimeoutMs,
    fetch: options.fetch,
    logger,
  });

  /** toolbox 基址来自 sandbox DTO（不从主 API base 猜测自托管/云默认值）。 */
  async function resolveToolboxBaseUrl(sandboxId: string): Promise<string> {
    const response = await mainRest.request(DAYTONA_PATH_SANDBOX(sandboxId), {
      method: "GET",
      attempts: DAYTONA_GET_RETRY_ATTEMPTS,
    });
    if (!response.ok) {
      throw new Error(`toolbox url lookup failed (http ${response.status})`);
    }
    const body = asRecord(await response.json().catch(() => null));
    const url = asString(body?.["toolboxProxyUrl"]);
    if (!url) {
      // DTO 无字段时 fail-closed：不拼接、不假定云默认，避免打错端点。
      throw new Error("sandbox DTO has no toolboxProxyUrl; cannot reach toolbox API");
    }
    return url.replace(/\/+$/, "");
  }

  function toolboxClient(toolboxBaseUrl: string, sandboxId: string): SandboxRestClient {
    return createSandboxRestClient({
      providerName: "daytona",
      buildHeaders: async () => ({ Authorization: `Bearer ${await options.apiKey()}` }),
      baseUrl: `${toolboxBaseUrl}/${encodeURIComponent(sandboxId)}`,
      requestTimeoutMs,
      fetch: options.fetch,
      logger,
    });
  }

  /** 单次尝试：注入自举 env → 幂等取得会话 → runAsync 后台执行 → 即时失败探测。 */
  async function startOnce(sandboxId: string, input: SupervisorStartInput): Promise<void> {
    const toolbox = toolboxClient(await resolveToolboxBaseUrl(sandboxId), sandboxId);
    // 1) 自举要素进 daemon env（会话/后续命令继承），不进命令字符串与 provider 记录。
    const envResponse = await toolbox.request("/env", {
      method: "POST",
      body: { set: supervisorStartEnv(input) },
    });
    if (!envResponse.ok) {
      throw new Error(`bootstrap env injection failed (http ${envResponse.status})`);
    }
    // 2) 会话幂等：GET 404 才创建（已存在的会话直接复用，重试不重复建会话）。
    const sessionId = DAYTONA_SUPERVISOR_SESSION_ID;
    const probe = await toolbox.request(`/process/session/${sessionId}`, { method: "GET" });
    if (probe.status === 404) {
      const created = await toolbox.request("/process/session", {
        method: "POST",
        body: { sessionId },
      });
      if (!created.ok) {
        throw new Error(`supervisor session create failed (http ${created.status})`);
      }
    } else if (!probe.ok) {
      throw new Error(`supervisor session probe failed (http ${probe.status})`);
    }
    // 3) runAsync 后台执行 start-supervisor.sh（长驻 supervisor；flock 单例幂等）。
    const exec = await toolbox.request(`/process/session/${sessionId}/exec`, {
      method: "POST",
      body: { command: SUPERVISOR_START_CMD, runAsync: true },
    });
    if (!exec.ok) {
      throw new Error(`supervisor session exec failed (http ${exec.status})`);
    }
    const cmdId = asString(asRecord(await exec.json().catch(() => null))?.["cmdId"]);
    if (!cmdId) {
      throw new Error("supervisor session exec returned no cmdId");
    }
    // 4) 即时失败探测（best-effort）：命令已结束且退出码非 0 = 本次未拉起。
    const command = await toolbox.request(`/process/session/${sessionId}/command/${cmdId}`, {
      method: "GET",
    });
    if (command.ok) {
      const exitCode = asRecord(await command.json().catch(() => null))?.["exitCode"];
      assertSupervisorProcessAlive(typeof exitCode === "number" ? exitCode : undefined, {
        provider: "daytona",
        sandboxId,
      });
    }
  }

  return async (sandboxId, input) => {
    let lastError = "";
    for (let attempt = 1; attempt <= SUPERVISOR_START_ATTEMPTS; attempt += 1) {
      try {
        await startOnce(sandboxId, input);
        logger.info(undefined, "daytona supervisor started via toolbox session", {
          sandboxId,
          attempt,
        });
        return;
      } catch (error) {
        // 单次尝试的失败原因（有界、脱敏）保留在最终错误里供补偿分类与运营核对。
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

/**
 * provider 无关的「沙箱内 supervisor 启动」自举契约（specs/cloud-agent/01 §6.2、
 * §5.1、§9；对 W6 的对外契约见 W3 §4）。
 *
 * 为什么需要命令通道：模板的 `start_cmd` 是**构建期启动、随快照恢复**的进程，
 * 运行时注入的 provider env（含 E2B envVars）不进它的环境（实测结论，01 §6.2
 * 实施决议）。因此自举要素（runId / runGeneration / bootstrap ticket 等）由控制面
 * 在 create 成功后经 **provider 原生命令会话通道**下发，拉起镜像内
 * `/opt/zcode/start-supervisor.sh`（flock 单例幂等，控制面重试/重启重复调用无副作用）。
 *
 * 三家 provider 共用同一契约，差异只在通道实现：
 * - E2B：SDK `commands.run(background:true, envs)`（e2bBootstrap.ts）
 * - Daytona：toolbox `/env` 注入 + 固定会话 `runAsync`（daytonaBootstrap.ts）
 * - Modal：SDK 桥 `sb.exec(..., env=...)` + detach（modalBootstrap.ts）
 *
 * 启动由 `SandboxDriverPort.startSupervisor(handle, input)` 承担，控制面在
 * `persistHandle()` **成功之后**调用（01 §5.1 第 3 条顺序：create 成功先持久 handle/deadline，
 * 再等 bridge；create 正常路径与对账恢复路径都要调）。失败 → 补偿终止，不留静默孤儿：
 * 已确认清理 → `bootstrap_failed`；未确认 → `provider_termination_unknown`
 * （保留计费槽与对账，01 §5.1、§9）。
 *
 * 边界（不冒充 ready）：本模块只保证「启动命令被 provider 接受且进程没有立即退出」。
 * 真正的 ready 是 bridge 握手 + clone + runtime handshake 之后的控制面判定
 * （02 §5.3），不在这里推断。
 */
import { cloudTaskIdSchema } from "@zcode/shared";
import type {
  SandboxCreateInput,
  SandboxSupervisorStartInput,
} from "../../app/ports/sandboxDriverPort.js";
import { CloudAdapterError, type CloudAdapterLogger } from "./adapterError.js";
import {
  classifyCompensationTermination,
  compensationErrorCode,
  type TerminationProbeResult,
} from "./reconcile.js";

/** 镜像内 supervisor 启动入口（provider 无关；flock 单例幂等）。 */
export const SUPERVISOR_START_CMD = "/opt/zcode/start-supervisor.sh";

/** 启动尝试上限：命令通道就绪抖动的有界重试（三家 provider 同一预算）。 */
export const SUPERVISOR_START_ATTEMPTS = 5;

/**
 * 自举 env 名映射（对 W6 的跨模块契约，名与语义都是冻结面）：
 * 三家 provider 必须注入同一组变量名，只有传输通道不同。**全部为自举要素与非秘密
 * run 地址**（7 项）；凭据（模型配置/provisioning envelope）不走这里，只走 bridge 认证通道
 * 的 `bootstrap.config` 帧（02 §4、01 §6.2、12 §6）——provider env 对 provider API 可见。
 * ticket 只经此通道（秘密注入），**不进 argv、URL、labels/tags 或日志**（01 §4.1/§6.2）。
 */
export const SUPERVISOR_START_ENV_NAMES = {
  /** 控制面公网 origin（出站回连 `/ws/cloud/bridge/:runId`）。 */
  publicOrigin: "ZCODE_CLOUD_PUBLIC_ORIGIN",
  runId: "ZCODE_CLOUD_RUN_ID",
  runGeneration: "ZCODE_CLOUD_RUN_GENERATION",
  /** 短效单次、绑定 run 的自举票据（无 App/provider key）。 */
  bootstrapTicket: "ZCODE_CLOUD_BOOTSTRAP_TICKET",
  /** 持久 operationId：sandbox 侧幂等/诊断关联用（不含业务内容）。 */
  operationKey: "ZCODE_CLOUD_OPERATION_KEY",
  /**
   * 任务 id：`bridge.hello.address` 的 `taskId`（身份 `cloud-task:<taskId>` 由冻结
   * helper 在沙箱侧派生，**不单独传 workspaceIdentity**）。supervisor 在连接之前就需要
   * 它，因此与自举要素同通道；非秘密。
   */
  taskId: "ZCODE_CLOUD_TASK_ID",
  /** 沙箱内 checkout 路径（01 §6.2 步骤 2 由控制面计算）；supervisor 据此 mkdir/clone。 */
  workspacePath: "ZCODE_CLOUD_WORKSPACE_PATH",
} as const;

/**
 * 自举输入 = 端口层冻结的 `SandboxSupervisorStartInput`（01 §5.1 第 3 条）：字段定义在
 * `app/ports/sandboxDriverPort.ts`，adapter 只做别名引用（避免 app/** 反向依赖 adapters）。
 * 其中 `taskId` → env `ZCODE_CLOUD_TASK_ID`、`workspacePath` → env `ZCODE_CLOUD_WORKSPACE_PATH`，
 * 两者来自 `SandboxCreateInput.bootstrapAddress`（非秘密、经创建期命令通道下发）。
 */
export type SupervisorStartInput = SandboxSupervisorStartInput;

/**
 * 由 create 输入构造自举输入。run 地址要素取 **`SandboxCreateInput.bootstrapAddress`**
 * （W0 冻结的显式字段；不经标签运输，provider labels/tags 只作对账键）。
 * 校验在 create 之前完成（01 §9）：任务 id 必须过冻结 schema、路径必须绝对且非空，
 * 否则抛 validation_failed，不发起 provider 请求、不占 quota。非法或缺席一律拒绝，
 * 不编造占位身份（编造的 taskId 会污染 attachment 地址与投影去重键）。
 */
export function buildSupervisorStartInput(input: SandboxCreateInput): SupervisorStartInput {
  const built: SupervisorStartInput = {
    operationKey: input.operationKey,
    runId: input.runId,
    runGeneration: input.runGeneration,
    publicControlPlaneUrl: input.publicControlPlaneUrl,
    bootstrapTicket: input.bootstrapTicket,
    taskId: input.bootstrapAddress?.taskId?.trim() ?? "",
    workspacePath: input.bootstrapAddress?.workspacePath?.trim() ?? "",
  };
  validateSupervisorStartInput(built);
  return built;
}

/**
 * 校验控制面传入的自举输入（create 之前与 `startSupervisor` 之前都走这一处）：
 * 任务 id 过冻结 schema、路径绝对、其余自举要素非空；非法即 `validation_failed`，
 * 不发起 provider 请求、也**不编造占位身份**（编造的 taskId 会污染 attachment 地址）。
 */
export function validateSupervisorStartInput(input: SupervisorStartInput): void {
  if (!cloudTaskIdSchema.safeParse(input.taskId ?? "").success) {
    throw new CloudAdapterError("validation_failed", "bootstrap taskId is not a valid task id", {
      field: SUPERVISOR_START_ENV_NAMES.taskId,
    });
  }
  if (!(input.workspacePath ?? "").startsWith("/")) {
    throw new CloudAdapterError(
      "validation_failed",
      "bootstrap workspacePath must be an absolute path",
      { field: SUPERVISOR_START_ENV_NAMES.workspacePath },
    );
  }
  const required: Array<[string, string]> = [
    [SUPERVISOR_START_ENV_NAMES.operationKey, input.operationKey],
    [SUPERVISOR_START_ENV_NAMES.runId, input.runId],
    [SUPERVISOR_START_ENV_NAMES.publicOrigin, input.publicControlPlaneUrl],
    [SUPERVISOR_START_ENV_NAMES.bootstrapTicket, input.bootstrapTicket],
  ];
  for (const [field, value] of required) {
    if (typeof value !== "string" || value.trim() === "") {
      throw new CloudAdapterError("validation_failed", `bootstrap ${field} must not be empty`, {
        field,
      });
    }
  }
  if (!Number.isInteger(input.runGeneration) || input.runGeneration <= 0) {
    throw new CloudAdapterError("validation_failed", "bootstrap runGeneration must be positive", {
      field: SUPERVISOR_START_ENV_NAMES.runGeneration,
    });
  }
}

/**
 * 自举 env 载荷（键名取 SUPERVISOR_START_ENV_NAMES；值不含凭据或用户内容）。
 * 7 项全部由自举输入给出（地址要素在 port 上是必填），因此本函数不做缺席分支——
 * 「缺失即不下发」的语义由 `buildSupervisorStartInput` 在 create 之前 fail-closed 保证。
 */
export function supervisorStartEnv(input: SupervisorStartInput): Record<string, string> {
  return {
    [SUPERVISOR_START_ENV_NAMES.publicOrigin]: input.publicControlPlaneUrl,
    [SUPERVISOR_START_ENV_NAMES.runId]: input.runId,
    [SUPERVISOR_START_ENV_NAMES.runGeneration]: String(input.runGeneration),
    [SUPERVISOR_START_ENV_NAMES.bootstrapTicket]: input.bootstrapTicket,
    [SUPERVISOR_START_ENV_NAMES.operationKey]: input.operationKey,
    [SUPERVISOR_START_ENV_NAMES.taskId]: input.taskId,
    [SUPERVISOR_START_ENV_NAMES.workspacePath]: input.workspacePath,
  };
}

/** 通道实现的启动器：把自举输入交给 provider 的命令会话拉起 supervisor。 */
export type SupervisorStarter = (sandboxId: string, input: SupervisorStartInput) => Promise<void>;

/** bootstrap 失败时的补偿终止探测：ok/status 是 provider 事实，不推测。 */
export type SandboxTerminateProbe = (sandboxId: string) => Promise<TerminationProbeResult>;

/** 有界退避：第 n 次失败后等待（封顶 6s）。 */
export function supervisorStartBackoffMs(attempt: number): number {
  return Math.min(attempt, 4) * 1_500;
}

/**
 * 启动后的即时失败探测（就绪探测的 provider 侧边界）：后台命令**已经结束且退出码
 * 非 0** 说明本次没有拉起（例如布局物化失败）；仍在运行（退出码为 null/undefined）
 * 是期望状态。不在此推断 bridge/runtime ready（02 §5.3 由控制面裁决）。
 *
 * 退出码 0 视为成功：`start-supervisor.sh` 的 flock 幂等分支（已有实例在跑）会立即
 * `exit 0`，那是重试的正常结果，不是失败。
 */
export function assertSupervisorProcessAlive(
  exitCode: number | null | undefined,
  context: { provider: string; sandboxId: string },
): void {
  if (typeof exitCode === "number" && exitCode !== 0) {
    throw new CloudAdapterError(
      "bootstrap_failed",
      `${context.provider} supervisor exited immediately with code ${exitCode}`,
      { provider: context.provider, sandboxId: context.sandboxId, exitCode },
    );
  }
}

/** supervisor 输出片段的上限（与 provider 拒绝原因同口径：01 §9 有界、脱敏）。 */
export const SUPERVISOR_OUTPUT_MAX_CHARS = 200;

/**
 * 归一 supervisor 的输出片段：先抹掉调用方注入的秘密（自举 ticket 等），再压成单行并
 * 截断到上限。**不得**把整段 stdout/stderr 或 env 内容带进错误/日志。
 */
export function boundSupervisorOutput(
  output: string | undefined,
  secrets: readonly string[],
): string | undefined {
  if (output === undefined) return undefined;
  let text = output;
  for (const secret of secrets) {
    const trimmed = secret.trim();
    if (trimmed !== "") text = text.split(trimmed).join("[redacted]");
  }
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine === "" ? undefined : singleLine.slice(0, SUPERVISOR_OUTPUT_MAX_CHARS);
}

/**
 * supervisor 自报失败行的类型标记。supervisor 在启动失败时会往 stdout 打一行
 * `{"type":"zcode-supervisor-failed","stage":…,"message":…}` 并以非 0 退出。
 * **它是命令通道的普通输出，不是协议帧**：解析必须容错，非该行/解析失败一律忽略，
 * 退回原始输出片段，绝不按帧语义消费。
 */
export const SUPERVISOR_FAILURE_MARKER = "zcode-supervisor-failed";

export interface SupervisorReportedFailure {
  stage?: string;
  message?: string;
}

/**
 * 从 supervisor 输出里解析结构化失败行（逐行找 JSON，容错；非该行不认）。
 * 只取 `stage`/`message` 两个有界字符串字段。
 */
export function parseSupervisorFailureLine(
  output: string | undefined,
): SupervisorReportedFailure | undefined {
  if (output === undefined) return undefined;
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.includes(SUPERVISOR_FAILURE_MARKER)) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record?.["type"] !== SUPERVISOR_FAILURE_MARKER) continue;
    const stage = typeof record["stage"] === "string" ? record["stage"] : undefined;
    const message = typeof record["message"] === "string" ? record["message"] : undefined;
    if (stage === undefined && message === undefined) continue;
    return {
      ...(stage === undefined ? {} : { stage }),
      ...(message === undefined ? {} : { message }),
    };
  }
  return undefined;
}

/**
 * 后台命令已非 0 退出 → **确定失败**（带退出码与脱敏后的原因）。
 * 原因优先取 supervisor 自报的结构化失败行（`stage` + `message`，信息量比裸输出大），
 * 没有则退回脱敏后的输出片段。调用方据此立即补偿终止，而不是等 readiness 超时
 * （01 §5.1/§6.2：启动失败即补偿终止，不留"看起来在 provisioning"的孤儿）。
 *
 * **边界（不声称全时段可见）**：探测只在有界窗口内观测；晚于窗口才发生的沙箱内失败
 * 这里看不见，仍由 readiness 看门狗（控制面）兜底。
 */
export function supervisorExitError(context: {
  provider: string;
  sandboxId: string;
  exitCode: number;
  stdout?: string | undefined;
  stderr?: string | undefined;
  /** 需要从输出里抹掉的秘密值（自举 ticket）。 */
  secrets?: readonly string[];
}): CloudAdapterError {
  const secrets = context.secrets ?? [];
  const stdout = boundSupervisorOutput(context.stdout, secrets);
  const stderr = boundSupervisorOutput(context.stderr, secrets);
  // 自报失败行优先（stage + message），否则退回输出片段（stderr 优先级更高）。
  const reported =
    parseSupervisorFailureLine(context.stdout) ?? parseSupervisorFailureLine(context.stderr);
  const reportedReason = boundSupervisorOutput(
    reported === undefined
      ? undefined
      : `${reported.stage === undefined ? "" : `${reported.stage}: `}${reported.message ?? ""}`,
    secrets,
  );
  const detail = reportedReason ?? stderr ?? stdout;
  return new CloudAdapterError(
    "bootstrap_failed",
    `${context.provider} supervisor exited immediately with code ${context.exitCode}${
      detail === undefined ? " (no output captured)" : ` [output: ${detail}]`
    }`,
    {
      provider: context.provider,
      sandboxId: context.sandboxId,
      exitCode: context.exitCode,
      ...(reported?.stage === undefined ? {} : { stage: reported.stage.slice(0, 64) }),
      ...(stdout === undefined ? {} : { stdout }),
      ...(stderr === undefined ? {} : { stderr }),
    },
  );
}

/**
 * 启动 + 失败补偿终止（01 §5.1：初始化失败执行补偿清理；§9：分类错误码）。
 * 成功即返回；失败先补偿 terminate，再按 provider 事实分类抛错。
 */
export async function startSupervisorOrTerminate(
  startSupervisor: SupervisorStarter,
  terminateSandbox: SandboxTerminateProbe,
  sandboxId: string,
  input: SupervisorStartInput,
  logger: CloudAdapterLogger,
  provider: string,
): Promise<void> {
  let failure: SupervisorStartFailure;
  try {
    // 输入非法与启动失败走同一条补偿路径：沙箱已建，不能因为调用方参数问题留孤儿。
    validateSupervisorStartInput(input);
    await startSupervisor(sandboxId, input);
    return;
  } catch (startError) {
    // 失败原因必须留在**抛出的错误**里，不能只进日志：它是用户可见 last_error 的唯一来源
    // （否则链路只能靠 readiness 超时收口，且用户看不到沙箱内到底哪一步失败）。
    failure = describeSupervisorStartFailure(startError);
    logger.warn(undefined, `${provider} supervisor start failed; compensating terminate`, {
      sandboxId,
      operationKey: input.operationKey,
      reason: failure.reason,
    });
  }
  const probe = await terminateSandbox(sandboxId).catch(
    (): TerminationProbeResult => ({ ok: false, status: 0 }),
  );
  const outcome = classifyCompensationTermination(probe);
  const suffix = ` [reason: ${failure.reason}]`;
  if (outcome === "terminated") {
    throw new CloudAdapterError(
      "bootstrap_failed",
      `sandbox created but supervisor start failed; sandbox terminated as compensation${suffix}`,
      { sandboxId, provider, ...failure.context },
    );
  }
  throw new CloudAdapterError(
    compensationErrorCode(outcome),
    `supervisor start failed and compensation terminate result unknown${suffix}`,
    { sandboxId, provider, ...failure.context },
  );
}

interface SupervisorStartFailure {
  /** 单行、有界（≤200 字符）的失败原因，用于错误消息与日志。 */
  reason: string;
  /** 原归因错误的有界上下文（退出码、输出片段等），透传给补偿错误。 */
  context: Record<string, string | number>;
}

/** 把启动失败归成「有界原因 + 上下文」；非归一错误只留 message。 */
function describeSupervisorStartFailure(error: unknown): SupervisorStartFailure {
  const raw = error instanceof Error ? error.message : String(error);
  return {
    reason: boundSupervisorOutput(raw, []) ?? "unknown",
    context: error instanceof CloudAdapterError ? { ...error.safeContext } : {},
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

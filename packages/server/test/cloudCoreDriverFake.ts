/**
 * provider driver fake（cloudCoreAdapterFakes 拆分，行数预算）：控制面 app 集成测试
 * 注入故障并断言三分支语义（01 §4.1），不发起任何网络请求。
 *
 * 能力与门禁对齐生产（A-7）：`pauseResume` 缺省 "none"——与未实测 provider 同构，
 * pause/resume 本地能力错误、路径不可达；测试 resume/pause 通路时显式开到 "memory"。
 * `lastFindCreateResultOptions` 记录对账入参（C-3 锚点断言：readiness/startup 必须
 * 传持久 attempt 时间）。
 */
import type {
  CreateReconciliation,
  ProviderObservation,
  ProviderSandboxHandle,
  SandboxCreateInput,
  SandboxDriverPort,
  TerminationObservation,
} from "../src/cloud/app/ports/sandboxDriverPort.js";

export interface FakeSandboxDriver extends SandboxDriverPort {
  createCalls: number;
  /** 最后一次 create 的入参（断言非秘密自举要素经此下发）。 */
  lastCreateInput?: SandboxCreateInput;
  createOutcome: "success" | "throw-unknown" | "throw-failed" | "throw-coded";
  /** `throw-coded` 时抛出的归一错误码（模拟 driver 的显式拒绝）。 */
  createErrorCode: string;
  /** findCreateResult 的结论（对账分支）。 */
  findCreateResultOutcome: CreateReconciliation["status"];
  /** 对账调用次数（确定失败不应触发对账）。 */
  findCreateResultCalls: number;
  /** 最后一次对账的 options（C-3 锚点断言：readiness/startup 必须传持久 attempt 时间）。 */
  lastFindCreateResultOptions?: { operationAttemptedAtMs?: number };
  /** startSupervisor 调用次数与最后一次入参（01 §5.1 第 3 条）。 */
  startSupervisorCalls: number;
  lastSupervisorStart?: {
    sandboxId: string;
    operationKey: string;
    runId: string;
    runGeneration: number;
    taskId: string;
    workspacePath: string;
    publicControlPlaneUrl: string;
    bootstrapTicket: string;
  };
  /** 令 startSupervisor 抛错（01 §9 补偿终止）。 */
  startSupervisorError?: string;
  /** terminate 调用次数（断言补偿）。 */
  terminateCalls: number;
  /** 能力声明：provider 上限（undefined = 未声明上限）。 */
  maxLifetimeSeconds?: number;
  /** 能力声明：期限来源（provider 确认 vs 只能估计）。 */
  deadlineSource: "provider" | "estimated";
  inspectStatus: ProviderObservation["status"];
  /** inspect 的调用次数与失败模式（provider 不可达/超时必须保留槽位）。 */
  inspectCalls: number;
  inspectOutcome: "status" | "throw";
  /**
   * 指定只对这些 sandboxId 抛错（sweep per-run 隔离回归用：第二个 run 抛错时，
   * 第一个与第三个仍须被处理）。
   */
  inspectThrowSandboxIds?: Set<string>;
  /** 指定只对这些 sandboxId 的 extendDeadline 抛错（keepalive 续期失败不穿透 sweep）。 */
  extendDeadlineThrowSandboxIds?: Set<string>;
  terminateStatus: TerminationObservation["status"];
  /** 能力声明：分级暂停/恢复（A-7 门禁下生产一律 none；测试显式开到 memory 验证通路）。 */
  pauseResume: "memory" | "disk" | "none";
  /** pause/resume 调用次数与最后一次请求寿命（B-6 续展断言用）。 */
  pauseCalls: number;
  resumeCalls: number;
  lastResumeDeadline?: number;
  /** pause 的返回观察（默认 paused 确认；可注入 unknown/running 模拟未确认）。 */
  pauseObservationStatus: ProviderObservation["status"];
  /** resume 的返回观察（默认 running 确认；可注入 unknown/notFound 模拟失败分支）。 */
  resumeObservationStatus: ProviderObservation["status"];
}

export function createFakeSandboxDriver(): FakeSandboxDriver {
  const driver: FakeSandboxDriver = {
    createCalls: 0,
    createOutcome: "success",
    createErrorCode: "unsupported_template",
    findCreateResultOutcome: "notFound",
    findCreateResultCalls: 0,
    startSupervisorCalls: 0,
    terminateCalls: 0,
    maxLifetimeSeconds: 3600,
    deadlineSource: "provider",
    inspectStatus: "running",
    inspectCalls: 0,
    inspectOutcome: "status",
    terminateStatus: "terminated",
    pauseResume: "none",
    pauseCalls: 0,
    resumeCalls: 0,
    pauseObservationStatus: "paused",
    resumeObservationStatus: "running",
    async describeCapabilities() {
      return {
        createOperationLookup: "native-key",
        canInspect: true,
        canExtendDeadline: true,
        canConfirmTermination: true,
        pauseResume: driver.pauseResume,
        ...(driver.maxLifetimeSeconds === undefined
          ? {}
          : { maxLifetimeSeconds: driver.maxLifetimeSeconds }),
        deadlineSource: driver.deadlineSource,
        supportsOutboundWss: true,
      };
    },
    async create(input): Promise<ProviderSandboxHandle> {
      driver.createCalls += 1;
      driver.lastCreateInput = input;
      if (driver.createOutcome === "throw-unknown") throw new Error("network timeout");
      if (driver.createOutcome === "throw-failed") throw new Error("create rejected");
      if (driver.createOutcome === "throw-coded") {
        // 与 W3 的 CloudAdapterError 同形：归一码 + 有界 message。
        throw Object.assign(new Error(`provider rejected: ${driver.createErrorCode}`), {
          name: "CloudAdapterError",
          code: driver.createErrorCode,
        });
      }
      return {
        provider: "e2b",
        sandboxId: `sandbox-${input.runId}`,
        providerDeadline: input.requestedDeadline,
      };
    },
    async findCreateResult(operationKey, options): Promise<CreateReconciliation> {
      driver.findCreateResultCalls += 1;
      driver.lastFindCreateResultOptions = options ? { ...options } : undefined;
      if (driver.findCreateResultOutcome === "unknown") {
        return { status: "unknown", errorCode: "provider_create_unknown" };
      }
      if (driver.findCreateResultOutcome === "created") {
        return { status: "created", handle: { provider: "e2b", sandboxId: "sandbox-reconciled" } };
      }
      return { status: "notFound" };
    },
    async inspect(input): Promise<ProviderObservation> {
      driver.inspectCalls += 1;
      if (
        driver.inspectOutcome === "throw" ||
        driver.inspectThrowSandboxIds?.has(input.sandboxId)
      ) {
        throw new Error("provider unreachable");
      }
      return { status: driver.inspectStatus, observedAt: 0, evidenceSource: "provider-api" };
    },
    async extendDeadline(input) {
      if (driver.extendDeadlineThrowSandboxIds?.has(input.sandboxId)) {
        throw new Error("extend deadline failed");
      }
      return { status: "confirmed", expiresAt: 0 };
    },
    async startSupervisor(handle, supervisorInput): Promise<void> {
      driver.startSupervisorCalls += 1;
      if (driver.startSupervisorError !== undefined) {
        throw Object.assign(new Error(driver.startSupervisorError), { code: "bootstrap_failed" });
      }
      driver.lastSupervisorStart = {
        sandboxId: handle.sandboxId,
        operationKey: supervisorInput.operationKey,
        runId: supervisorInput.runId,
        runGeneration: supervisorInput.runGeneration,
        taskId: supervisorInput.taskId,
        workspacePath: supervisorInput.workspacePath,
        publicControlPlaneUrl: supervisorInput.publicControlPlaneUrl,
        bootstrapTicket: supervisorInput.bootstrapTicket,
      };
    },
    async terminate(): Promise<TerminationObservation> {
      driver.terminateCalls += 1;
      return { status: driver.terminateStatus };
    },
    async pause(): Promise<ProviderObservation> {
      driver.pauseCalls += 1;
      // 能力门禁（A-7）：none 时本地能力错误，不产出观察（与生产 driver 同构）。
      if (driver.pauseResume === "none") {
        throw Object.assign(new Error("capability-not-enabled: fake pauseResume is none"), {
          name: "CloudAdapterError",
          code: "resource_unsupported",
        });
      }
      return {
        status: driver.pauseObservationStatus,
        observedAt: 0,
        evidenceSource: "provider-api",
      };
    },
    async resume(_handle, requestedDeadline): Promise<ProviderObservation> {
      driver.resumeCalls += 1;
      driver.lastResumeDeadline = requestedDeadline;
      if (driver.pauseResume === "none") {
        throw Object.assign(new Error("capability-not-enabled: fake pauseResume is none"), {
          name: "CloudAdapterError",
          code: "resource_unsupported",
        });
      }
      return {
        status: driver.resumeObservationStatus,
        observedAt: 0,
        evidenceSource: "provider-api",
      };
    },
  };
  return driver;
}

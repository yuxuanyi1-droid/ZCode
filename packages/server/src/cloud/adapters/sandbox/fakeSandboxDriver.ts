/**
 * 内存 fake SandboxDriver（specs/cloud-agent/01 §4.1）：供控制面 orchestration 测试注入
 * 故障并断言三分支语义，**不发起任何网络请求**。
 *
 * 与 E2B/Daytona/Modal 不同，fake 具备 native-key 幂等（理想 provider 形态）：同
 * operationKey 重复 create 返回同一沙箱句柄；故障开关用于模拟「资源已建但响应丢失」
 * 「在途挂起」「terminate 未确认」等真实 provider 会出现的分支。
 */
import type { CloudErrorCode } from "@zcode/shared";
import type {
  CreateReconciliation,
  DeadlineResult,
  ProviderObservation,
  ProviderSandboxHandle,
  SandboxCreateInput,
  SandboxDriverCapabilities,
  SandboxSupervisorStartInput,
  SandboxDriverPort,
  TerminationObservation,
} from "../../app/ports/sandboxDriverPort.js";
import { CloudAdapterError } from "./adapterError.js";

export interface FakeSandboxFaults {
  /** 创建成功但响应丢失：沙箱已存在，create 仍抛 provider_create_unknown。 */
  dropCreateResponse?: boolean;
  /** 挂起 create 直到调用方 abort（模拟在途请求；abort 后仍视为 unknown）。 */
  hangCreate?: boolean;
  createDelayMs?: number;
  /** 明确失败分支（模拟 4xx 类确定性拒绝），不创建资源。 */
  createFailure?: { code: CloudErrorCode; message: string };
  /** 清单查询失败：findCreateResult → unknown。 */
  listFailure?: boolean;
  /** inspect 失败：归为 unknown（非 notFound）。 */
  inspectFailure?: { errorCode: CloudErrorCode };
  /** terminate 已执行但响应丢失 → unknown（保留槽位对账）。 */
  dropTerminateResponse?: boolean;
  /** 迟到 handle：create 声称未知，但资源其实已建（对账应能命中它）。 */
  lateHandle?: boolean;
  /** supervisor 启动失败（01 §5.1 第 3 条：失败即补偿终止）。 */
  startSupervisorFailure?: { code: CloudErrorCode; message: string };
  /** pause 已受理但观察丢失：fake 回 unknown，控制面不得写 run=paused（B-4 fail-closed）。 */
  dropPauseObservation?: boolean;
  /** resume 已执行但观察丢失：fake 回 unknown，控制面停留 paused 退避重试。 */
  dropResumeObservation?: boolean;
  /** pause 时 provider 侧直接丢失实例（模拟保留期尽/回收）：inspect → notFound。 */
  loseOnPause?: boolean;
}

interface FakeSandboxEntry {
  sandboxId: string;
  /** paused 是独立观测态（01 §4.1 修订）：保留中的实例不归 stopped。 */
  state: "running" | "paused" | "stopped";
  labels: Record<string, string>;
  createdAt: number;
  expiresAt: number;
  terminated: boolean;
}

export interface FakeSandboxDriver extends SandboxDriverPort {
  /** 可变故障开关；测试直接修改以注入行为。 */
  readonly faults: FakeSandboxFaults;
  /** 已启动的 supervisor（自举要素，供用例断言）。 */
  readonly supervisorStarts: SandboxSupervisorStartInput[];
  /** 已发生的调用记录（脱敏：只有方法与键，无标签内容）。 */
  readonly requests: readonly string[];
  listSandboxes(): ProviderSandboxHandle[];
  entries(): ReadonlyArray<{
    sandboxId: string;
    state: string;
    labels: Record<string, string>;
    terminated: boolean;
  }>;
  reset(): void;
}

export function createFakeSandboxDriver(options?: {
  now?: () => number;
  newSandboxId?: (operationKey: string, index: number) => string;
  /**
   * fake 的分级能力声明（fake 对齐真实语义；01 §4.1 修订）。缺省 "none"：与生产
   * fail-closed 门禁同构——pause/resume 抛能力错误、路径不可达。测试 resume/pause
   * 通路时显式传 "memory"。
   */
  pauseResume?: "memory" | "disk" | "none";
}): FakeSandboxDriver {
  const now = options?.now ?? Date.now;
  const pauseResumeCapability = options?.pauseResume ?? "none";
  const newSandboxId =
    options?.newSandboxId ?? ((operationKey, index) => `fake-sbx-${operationKey}-${index}`);
  const sandboxes = new Map<string, FakeSandboxEntry>();
  const byOperationKey = new Map<string, string>();
  const requests: string[] = [];
  const faults: FakeSandboxFaults = {};
  const supervisorStarts: SandboxSupervisorStartInput[] = [];
  let created = 0;

  // 理想 provider 形态：原生幂等 + 可查 + 可续期 + 可确认终止（01 §4.1 的对照面）。
  const capabilities: SandboxDriverCapabilities = {
    createOperationLookup: "native-key",
    canInspect: true,
    canExtendDeadline: true,
    canConfirmTermination: true,
    pauseResume: pauseResumeCapability,
    deadlineSource: "provider",
    supportsOutboundWss: true,
  };

  function handleOf(entry: FakeSandboxEntry): ProviderSandboxHandle {
    return {
      provider: "fake",
      sandboxId: entry.sandboxId,
      providerDeadline: entry.expiresAt,
    };
  }

  function entryOf(handle: ProviderSandboxHandle): FakeSandboxEntry | undefined {
    return sandboxes.get(handle.sandboxId);
  }

  function register(input: SandboxCreateInput): FakeSandboxEntry {
    created += 1;
    const entry: FakeSandboxEntry = {
      sandboxId: newSandboxId(input.operationKey, created),
      state: "running",
      labels: {
        operationKey: input.operationKey,
        runId: input.runId,
        runGeneration: String(input.runGeneration),
        ...input.labels,
      },
      createdAt: now(),
      expiresAt: input.requestedDeadline,
      terminated: false,
    };
    sandboxes.set(entry.sandboxId, entry);
    byOperationKey.set(input.operationKey, entry.sandboxId);
    return entry;
  }

  const driver: FakeSandboxDriver = {
    faults,
    supervisorStarts,
    requests,

    async describeCapabilities(): Promise<SandboxDriverCapabilities> {
      return { ...capabilities };
    },

    async create(input: SandboxCreateInput): Promise<ProviderSandboxHandle> {
      requests.push(`create:${input.operationKey}`);
      // 幂等：同 operationKey 已有存活资源时返回同一句柄，不建第二个沙箱。
      const existing = byOperationKey.get(input.operationKey);
      if (existing !== undefined) {
        const entry = sandboxes.get(existing);
        if (entry && !entry.terminated) {
          return handleOf(entry);
        }
      }
      if (faults.createFailure) {
        throw new CloudAdapterError(faults.createFailure.code, faults.createFailure.message, {
          operationKey: input.operationKey,
        });
      }
      const entry = register(input);
      if (faults.hangCreate) {
        await waitForAbort(input.signal);
        // 调用方取消本地等待 ≠ provider 未创建：按 create unknown 对账。
        throw new CloudAdapterError(
          "provider_create_unknown",
          "fake create hung then aborted; result unknown",
          { operationKey: input.operationKey },
        );
      }
      if (faults.createDelayMs && faults.createDelayMs > 0) {
        await sleep(faults.createDelayMs, input.signal);
      }
      if (faults.dropCreateResponse) {
        throw new CloudAdapterError(
          "provider_create_unknown",
          "fake create response dropped; sandbox exists",
          { operationKey: input.operationKey },
        );
      }
      if (faults.lateHandle) {
        // 迟到 handle：本次 create 不知道资源已建（对账可命中），先按未知返回。
        throw new CloudAdapterError(
          "provider_create_unknown",
          "fake create returned late handle after unknown result",
          { operationKey: input.operationKey },
        );
      }
      return handleOf(entry);
    },

    async findCreateResult(operationKey: string): Promise<CreateReconciliation> {
      requests.push(`find:${operationKey}`);
      if (faults.listFailure) {
        return { status: "unknown", errorCode: "provider_create_unknown" };
      }
      const sandboxId = byOperationKey.get(operationKey);
      const entry = sandboxId !== undefined ? sandboxes.get(sandboxId) : undefined;
      if (entry && !entry.terminated) {
        return { status: "created", handle: handleOf(entry) };
      }
      return { status: "notFound" };
    },

    /** 控制面在 persistHandle 成功后调用（01 §5.1 第 3 条）；失败即补偿终止。 */
    async startSupervisor(
      handle: ProviderSandboxHandle,
      input: SandboxSupervisorStartInput,
    ): Promise<void> {
      requests.push(`supervisor:${handle.sandboxId}`);
      if (faults.startSupervisorFailure) {
        throw new CloudAdapterError(
          faults.startSupervisorFailure.code,
          faults.startSupervisorFailure.message,
        );
      }
      supervisorStarts.push(input);
    },

    async inspect(handle: ProviderSandboxHandle): Promise<ProviderObservation> {
      requests.push(`inspect:${handle.sandboxId}`);
      if (faults.inspectFailure) {
        return {
          status: "unknown",
          observedAt: now(),
          evidenceSource: "none",
          errorCode: faults.inspectFailure.errorCode,
        };
      }
      const entry = entryOf(handle);
      if (!entry || entry.terminated) {
        return { status: "notFound", observedAt: now(), evidenceSource: "provider-api" };
      }
      return { status: entry.state, observedAt: now(), evidenceSource: "provider-api" };
    },

    async extendDeadline(
      handle: ProviderSandboxHandle,
      requestedDeadlineMs: number,
    ): Promise<DeadlineResult> {
      requests.push(`extend:${handle.sandboxId}`);
      const entry = entryOf(handle);
      if (!entry || entry.terminated) {
        throw new CloudAdapterError("not_found", "fake sandbox not present", {
          sandboxId: handle.sandboxId,
        });
      }
      entry.expiresAt = requestedDeadlineMs;
      return { status: "confirmed", expiresAt: requestedDeadlineMs };
    },

    async terminate(handle: ProviderSandboxHandle): Promise<TerminationObservation> {
      requests.push(`terminate:${handle.sandboxId}`);
      const entry = entryOf(handle);
      if (entry) {
        entry.terminated = true;
        entry.state = "stopped";
      }
      if (faults.dropTerminateResponse) {
        return { status: "unknown", errorCode: "provider_termination_unknown" };
      }
      return { status: "terminated" };
    },

    /**
     * fake pause：与真实 driver 同一语义（01 §4.1 修订）——none 门禁下本地抛能力错误
     * （不触达 entries），memory 级确认后置 paused 观测。观察丢失/实例丢失用故障开关注入。
     */
    async pause(handle: ProviderSandboxHandle): Promise<ProviderObservation> {
      requests.push(`pause:${handle.sandboxId}`);
      if (pauseResumeCapability === "none") {
        // fail-closed：与生产 e2b/daytona 的门禁行为同构（路径不可达）。
        throw new CloudAdapterError(
          "resource_unsupported",
          "capability-not-enabled: fake pauseResume is none",
          { sandboxIdLen: handle.sandboxId.length },
        );
      }
      const entry = entryOf(handle);
      if (!entry || entry.terminated) {
        return { status: "notFound", observedAt: now(), evidenceSource: "provider-api" };
      }
      if (faults.loseOnPause) {
        entry.terminated = true;
        entry.state = "stopped";
        return { status: "notFound", observedAt: now(), evidenceSource: "provider-api" };
      }
      entry.state = "paused";
      if (faults.dropPauseObservation) {
        return {
          status: "unknown",
          observedAt: now(),
          evidenceSource: "none",
          errorCode: "provider_unreachable",
        };
      }
      return { status: "paused", observedAt: now(), evidenceSource: "provider-api" };
    },

    /** fake resume：paused → running；requestedDeadline 覆盖 TTL（与 keepalive 同语义）。 */
    async resume(
      handle: ProviderSandboxHandle,
      requestedDeadline: number,
    ): Promise<ProviderObservation> {
      requests.push(`resume:${handle.sandboxId}`);
      if (pauseResumeCapability === "none") {
        throw new CloudAdapterError(
          "resource_unsupported",
          "capability-not-enabled: fake pauseResume is none",
          { sandboxIdLen: handle.sandboxId.length },
        );
      }
      const entry = entryOf(handle);
      if (!entry || entry.terminated) {
        // 保留期尽/实例不存在：notFound（调用方交 keepalive liveness 收口 expired）。
        return { status: "notFound", observedAt: now(), evidenceSource: "provider-api" };
      }
      entry.expiresAt = requestedDeadline;
      if (faults.dropResumeObservation) {
        return {
          status: "unknown",
          observedAt: now(),
          evidenceSource: "none",
          errorCode: "provider_unreachable",
        };
      }
      entry.state = "running";
      return { status: "running", observedAt: now(), evidenceSource: "provider-api" };
    },

    listSandboxes(): ProviderSandboxHandle[] {
      return [...sandboxes.values()].filter((entry) => !entry.terminated).map(handleOf);
    },

    entries() {
      return [...sandboxes.values()].map((entry) => ({
        sandboxId: entry.sandboxId,
        state: entry.state,
        labels: { ...entry.labels },
        terminated: entry.terminated,
      }));
    },

    reset(): void {
      sandboxes.clear();
      byOperationKey.clear();
      requests.length = 0;
      created = 0;
      for (const key of Object.keys(faults) as Array<keyof FakeSandboxFaults>) {
        delete faults[key];
      }
    },
  };
  return driver;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

function waitForAbort(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}

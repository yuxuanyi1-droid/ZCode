/**
 * 外部依赖端口 fake：GitHub、provider driver（含能力声明与三分支结果）、attachment 传输、
 * runtime 命令查询（03 §5 三分支、01 §4.1、02 §6.1）。
 */
import type { GitHubPort, RepositoryRef } from "../src/cloud/app/ports/gitHubPort.js";
import type {
  CreateReconciliation,
  ProviderObservation,
  ProviderSandboxHandle,
  SandboxCreateInput,
  SandboxDriverPort,
  TerminationObservation,
} from "../src/cloud/app/ports/sandboxDriverPort.js";
import type {
  SandboxDriverRegistryPort,
  SandboxProviderEntry,
} from "../src/cloud/app/ports/sandboxDriverRegistryPort.js";
import type {
  AttachmentPort,
  AttachmentSendResult,
} from "../src/cloud/app/ports/attachmentPort.js";
import type { RuntimeCommandQueryPort } from "../src/cloud/app/ports/runtimeCommandQueryPort.js";
import type { ProvisioningEnvelopeSource } from "../src/cloud/app/ports/provisioningEnvelopePort.js";
import { canAdvanceDeliveryStatus } from "../src/cloud/domain/deliveryStatus.js";
import type {
  InteractionCancelIntent,
  InteractionDecisionRecord,
  InteractionDecisionRepo,
} from "../src/cloud/app/ports/inputPort.js";

export interface FakeGitHub extends GitHubPort {
  branches: Map<string, string>;
  repositories: Map<number, RepositoryRef>;
  publishedPrs: string[];
}

export function createFakeGitHub(): FakeGitHub {
  const repositories = new Map<number, RepositoryRef>();
  const branches = new Map<string, string>();
  const publishedPrs: string[] = [];
  repositories.set(101, {
    repositoryId: 101,
    installationId: 7,
    owner: "octo",
    name: "demo",
    defaultBranch: "main",
    availability: "available",
  });
  branches.set("101|main", "b".repeat(40));
  return {
    repositories,
    branches,
    publishedPrs,
    async listRepositories() {
      return { items: [...repositories.values()] };
    },
    async getRepository(repositoryId) {
      return repositories.get(repositoryId) ?? null;
    },
    async getBranchHead(request) {
      const sha = branches.get(`${request.repositoryId}|${request.branch}`);
      return sha ? { name: request.branch, sha, exists: true } : null;
    },
    async mintToken() {
      return { token: "ghs_test", expiresAt: 0, permissions: ["contents:read"] };
    },
    async getPullRequest() {
      return null;
    },
    async publishDraftPullRequest(request) {
      publishedPrs.push(request.idempotencyKey);
      return {
        repositoryId: request.repositoryId,
        prNumber: 1,
        prUrl: "https://example.invalid/pr/1",
        head: request.head,
        base: request.base,
        status: "draft",
      };
    },
    async enqueueEffect() {
      return { effectId: "effect-1" };
    },
  };
}

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
  terminateStatus: TerminationObservation["status"];
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
    async describeCapabilities() {
      return {
        createOperationLookup: "native-key",
        canInspect: true,
        canExtendDeadline: true,
        canConfirmTermination: true,
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
    async findCreateResult(): Promise<CreateReconciliation> {
      driver.findCreateResultCalls += 1;
      if (driver.findCreateResultOutcome === "unknown") {
        return { status: "unknown", errorCode: "provider_create_unknown" };
      }
      if (driver.findCreateResultOutcome === "created") {
        return { status: "created", handle: { provider: "e2b", sandboxId: "sandbox-reconciled" } };
      }
      return { status: "notFound" };
    },
    async inspect(): Promise<ProviderObservation> {
      driver.inspectCalls += 1;
      if (driver.inspectOutcome === "throw") throw new Error("provider unreachable");
      return { status: driver.inspectStatus, observedAt: 0, evidenceSource: "provider-api" };
    },
    async extendDeadline() {
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
  };
  return driver;
}

export function createFakeDriverRegistry(
  driver: SandboxDriverPort | null,
): SandboxDriverRegistryPort {
  const entries: SandboxProviderEntry[] = driver
    ? [
        {
          provider: "e2b",
          capabilities: {
            createOperationLookup: "native-key",
            canInspect: true,
            canExtendDeadline: true,
            canConfirmTermination: true,
            maxLifetimeSeconds: 3600,
            deadlineSource: "provider",
            supportsOutboundWss: true,
          },
        },
      ]
    : [];
  return {
    async resolve(provider) {
      return provider === "e2b" ? driver : null;
    },
    async listProviders() {
      return entries;
    },
  };
}

export interface FakeAttachmentPort extends AttachmentPort {
  readonly sent: { commandId: string; envelope: unknown }[];
  readonly drains: string[];
  readonly checkpoints: string[];
  readonly bootstrapConfigs: { runId: string; taskId: string; workspacePath: string }[];
  sendResult: AttachmentSendResult;
  /** 令 bootstrap.config 下发失败（fail-closed 路径测试）。 */
  bootstrapResult: AttachmentSendResult;
}

export function createFakeAttachmentPort(): FakeAttachmentPort {
  const sent: { commandId: string; envelope: unknown }[] = [];
  const drains: string[] = [];
  const checkpoints: string[] = [];
  const bootstrapConfigs: { runId: string; taskId: string; workspacePath: string }[] = [];
  return {
    sent,
    drains,
    checkpoints,
    bootstrapConfigs,
    sendResult: { status: "sent" },
    bootstrapResult: { status: "sent" },
    async sendBootstrapConfig(request) {
      if (this.bootstrapResult.status !== "sent") return this.bootstrapResult;
      bootstrapConfigs.push({
        runId: request.runId,
        taskId: request.taskId,
        workspacePath: request.config.workspacePath,
      });
      return { status: "sent" };
    },
    async sendCommand(request) {
      sent.push({ commandId: request.commandId, envelope: request.envelope });
      return this.sendResult;
    },
    async requestCheckpoint(request) {
      checkpoints.push(request.operationId);
      return { status: "sent" };
    },
    async requestDrain(request) {
      drains.push(request.operationId);
      return { status: "sent" };
    },
    async currentAddress() {
      return null;
    },
  };
}

export function createFakeRuntimeCommands(): RuntimeCommandQueryPort & {
  result: Awaited<ReturnType<RuntimeCommandQueryPort["queryCommand"]>>;
} {
  const fake = {
    result: { status: "unknown" } as Awaited<ReturnType<RuntimeCommandQueryPort["queryCommand"]>>,
    async queryCommand() {
      return fake.result;
    },
  };
  return fake;
}

/** 交互决定 fake（CR-3 冻结形状）：按 interactionId 唯一；取消意图按 commandId 记录。 */
export function createFakeInteractionDecisions(): InteractionDecisionRepo {
  const decisions = new Map<string, InteractionDecisionRecord>();
  const cancelIntents = new Map<string, InteractionCancelIntent>();
  const key = (taskId: string, interactionId: string) => `${taskId}:${interactionId}`;
  return {
    async recordDecision(request) {
      const existing = decisions.get(key(request.taskId, request.interactionId));
      if (existing) return existing;
      const record: InteractionDecisionRecord = {
        taskId: request.taskId,
        interactionId: request.interactionId,
        deliveryCommandId: request.deliveryCommandId,
        kind: request.kind,
        payloadJson: request.payloadJson,
        payloadHash: request.payloadHash,
        runId: request.runId,
        runGeneration: request.runGeneration,
        deliveryStatus: "accepted",
        recordedAt: 0,
      };
      decisions.set(key(request.taskId, request.interactionId), record);
      return record;
    },
    async getDecision(taskId, interactionId) {
      return decisions.get(key(taskId, interactionId)) ?? null;
    },
    async findDecisionByDeliveryCommandId(taskId, deliveryCommandId) {
      // 唯一约束 (task_id, delivery_command_id)：ACK 按投递 commandId 反查。
      return (
        Array.from(decisions.values()).find(
          (item) => item.taskId === taskId && item.deliveryCommandId === deliveryCommandId,
        ) ?? null
      );
    },
    async setDecisionDeliveryStatus(request) {
      const record = decisions.get(key(request.taskId, request.interactionId));
      if (!record) return null;
      // 与 InputRepo 同一状态机口径（单向推进；终态不回退）。
      if (!canAdvanceDeliveryStatus(record.deliveryStatus, request.status)) return null;
      const updated: InteractionDecisionRecord = {
        ...record,
        deliveryStatus: request.status,
        ...(request.lastError ? { lastError: request.lastError } : {}),
      };
      decisions.set(key(request.taskId, request.interactionId), updated);
      return updated;
    },
    async recordCancelIntent(request) {
      const intent: InteractionCancelIntent = {
        taskId: request.taskId,
        commandId: request.commandId,
        cancelCommandId: request.cancelCommandId,
        recordedAt: 0,
      };
      cancelIntents.set(`${request.taskId}:${request.commandId}`, intent);
      return intent;
    },
    async getCancelIntent(taskId, commandId) {
      return cancelIntents.get(`${taskId}:${commandId}`) ?? null;
    },
  };
}

/** provisioning envelope 来源 fake（12 §6）：账号态/静态选择逻辑在 host 侧，这里只回固定 JSON。 */
export function createFakeProvisioningEnvelope(): ProvisioningEnvelopeSource & {
  unavailable: boolean;
} {
  const source = {
    unavailable: false,
    async buildProvisioningEnvelopeJsonForRun(input: { runId: string }) {
      if (source.unavailable) return null;
      return {
        envelopeJson: JSON.stringify({ provider: "e2b", model: "test-model", runId: input.runId }),
        credentialGeneration: 3,
      };
    },
  };
  return source;
}

// ── 拆出的替身经本文件转出（保持测试 import 面稳定；实现分别在相邻文件）──
export {
  createFakeArtifacts,
  createFakeExecutionProjections,
  createFakeTemplateResolver,
} from "./cloudCoreSandboxFakes.js";
export {
  createFakeGitGrantBroker,
  createFakeGitGrantBrokerDeps,
  createFakeGitGrantStore,
} from "./cloudCoreGitGrantFakes.js";

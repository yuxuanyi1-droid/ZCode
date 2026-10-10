/**
 * W1 控制面 app 集成测试的端口 fake 入口（W1 §6：app 集成只替换端口 fake）。
 *
 * 本文件提供基础端口（时钟/ID/摘要/outbox）与测试装配（`buildTestPlane`）；
 * 存储、外部依赖 fake 分别在 `cloudCoreStorageFake.ts`、`cloudCoreAdapterFakes.ts`，
 * 由本文件统一转出，测试只 import 这里。
 */
import { createHash } from "node:crypto";
import type { CloudRunRecord } from "@zcode/shared";
import type {
  ExternalOperationRecord,
  LeasedOperation,
  OperationOutboxPort,
} from "../src/cloud/app/ports/operationOutboxPort.js";
import type { ClockPort } from "../src/cloud/app/ports/clockPort.js";
import type { HashPort } from "../src/cloud/app/ports/hashPort.js";
import type { IdGeneratorPort } from "../src/cloud/app/ports/idGeneratorPort.js";
import type { SandboxDriverPort } from "../src/cloud/app/ports/sandboxDriverPort.js";
import { assembleCloudControlPlane } from "../src/cloud/app/assembleCloudControlPlane.js";
import type { CloudCoreConfig } from "../src/cloud/app/config.js";
import type { BrowserWatchPort } from "../src/cloud/app/ports/browserWatchPort.js";
import { sessionFromAddress } from "../src/cloud/app/attachments/registry.js";
import {
  createFakeArtifacts,
  createFakeAttachmentPort,
  createFakeDriverRegistry,
  createFakeExecutionProjections,
  createFakeGitGrantBroker,
  createFakeGitGrantBrokerDeps,
  createFakeGitGrantStore,
  createFakeGitHub,
  createFakeInteractionDecisions,
  createFakeProvisioningEnvelope,
  createFakeRuntimeCommands,
  createFakeSandboxDriver,
  createFakeTemplateResolver,
} from "./cloudCoreAdapterFakes.js";
import { createFakeStorage, type FakeStorageOptions } from "./cloudCoreStorageFake.js";

export function newId(index: number): string {
  const hex = index.toString(16).padStart(12, "0");
  return `00000000-0000-4000-8000-${hex}`;
}

export class FakeClock implements ClockPort {
  private current = 1_700_000_000_000;
  now(): number {
    return this.current;
  }
  set(value: number): void {
    this.current = value;
  }
  advance(ms: number): void {
    this.current += ms;
  }
}

export class FakeIds implements IdGeneratorPort {
  private counter = 0;
  newId(): string {
    this.counter += 1;
    return newId(this.counter);
  }
  newSecret(): string {
    this.counter += 1;
    return `ticket-${this.counter}`;
  }
}

export class FakeHash implements HashPort {
  async sha256Hex(value: string): Promise<string> {
    return createHash("sha256").update(value).digest("hex");
  }
}

export interface FakeOutbox extends OperationOutboxPort {
  readonly records: Map<string, ExternalOperationRecord>;
  leaseTokens: Map<string, string>;
  failures: Set<string>;
  /** renewLease 成功续期的 operationId 序列（「create 60s+ 不被二次租约」断言用）。 */
  readonly renewals: string[];
}

export function createFakeOutbox(): FakeOutbox {
  const records = new Map<string, ExternalOperationRecord>();
  const leaseTokens = new Map<string, string>();
  const failures = new Set<string>();
  const renewals: string[] = [];
  let leaseCounter = 0;
  return {
    records,
    leaseTokens,
    failures,
    renewals,
    async enqueue(request) {
      const existing = [...records.values()].find(
        (item) => item.idempotencyKey === request.idempotencyKey,
      );
      if (existing) return existing;
      const record: ExternalOperationRecord = {
        operationId: request.operationId,
        kind: request.kind,
        idempotencyKey: request.idempotencyKey,
        taskId: request.taskId,
        runId: request.runId,
        runGeneration: request.runGeneration,
        state: "pending",
        attempt: 0,
        createdAt: request.now,
        updatedAt: request.now,
      };
      records.set(record.operationId, record);
      return record;
    },
    async findByKey(idempotencyKey) {
      return [...records.values()].find((item) => item.idempotencyKey === idempotencyKey) ?? null;
    },
    async get(operationId) {
      return records.get(operationId) ?? null;
    },
    async leaseNext(request) {
      // 与 SQLite 实现同一领取面（C-3/C-4 对齐）：pending，或租约已到期的 leased/ambiguous。
      // 之前只领 pending 的简化会让「续期防二次租约」无法被测试暴露。
      const claimable = (item: ExternalOperationRecord): boolean => {
        if (!request.kinds.includes(item.kind)) return false;
        const leaseUsable =
          item.state === "pending" ||
          ((item.state === "leased" || item.state === "ambiguous") &&
            item.leaseExpiresAt !== undefined &&
            item.leaseExpiresAt <= request.now);
        if (!leaseUsable) return false;
        if (
          request.operationIds !== undefined &&
          (request.operationIds.length === 0 || !request.operationIds.includes(item.operationId))
        ) {
          return false;
        }
        if (
          request.excludeOperationIds !== undefined &&
          request.excludeOperationIds.includes(item.operationId)
        ) {
          return false;
        }
        return true;
      };
      const candidate = [...records.values()]
        .filter(claimable)
        .sort((left, right) =>
          left.createdAt === right.createdAt
            ? left.operationId < right.operationId
              ? -1
              : 1
            : left.createdAt - right.createdAt,
        )[0];
      if (!candidate) return null;
      leaseCounter += 1;
      const token = `lease-${leaseCounter}`;
      candidate.state = "leased";
      candidate.attempt += 1;
      candidate.leaseExpiresAt = request.now + request.leaseMs;
      candidate.updatedAt = request.now;
      leaseTokens.set(candidate.operationId, token);
      const leased: LeasedOperation = {
        operation: { ...candidate },
        leaseToken: token,
        leaseExpiresAt: candidate.leaseExpiresAt,
      };
      return leased;
    },
    async renewLease(request) {
      // 持有人 token CAS 续租：令牌不匹配/已结算不可续（与 SQLite 实现同一语义）。
      const record = records.get(request.operationId);
      if (!record) return false;
      if (leaseTokens.get(request.operationId) !== request.leaseToken) return false;
      if (record.state !== "leased") return false;
      record.leaseExpiresAt = request.now + Math.max(1, request.leaseMs);
      record.updatedAt = request.now;
      renewals.push(request.operationId);
      return true;
    },
    async settle(request) {
      const record = records.get(request.operationId);
      if (!record) return false;
      if (leaseTokens.get(request.operationId) !== request.leaseToken) return false;
      if (request.outcome === "settled" && failures.has(request.operationId)) return false;
      record.state = request.outcome;
      record.resultRef = request.resultRef;
      record.errorCode = request.errorCode;
      record.updatedAt = request.now;
      return true;
    },
    async requeueFailed(request) {
      // 与 SQLite 实现同一 CAS 语义：仅 failed → pending；attempt/错误码保持
      // （退避与封顶按 attempt 判定，最后一次失败证据保留可查）。
      const record = records.get(request.operationId);
      if (!record) return false;
      if (record.state !== "failed") return false;
      record.state = "pending";
      record.updatedAt = request.now;
      leaseTokens.delete(request.operationId);
      return true;
    },
    async listUnsettled() {
      return [...records.values()].filter(
        (item) => item.state === "pending" || item.state === "leased" || item.state === "ambiguous",
      );
    },
  };
}

export function makeRun(
  overrides: Partial<CloudRunRecord> & { taskId: string; runId: string },
): CloudRunRecord {
  return {
    runGeneration: 1,
    executionKind: "sandbox",
    provider: "e2b",
    status: "provisioning",
    connectionEpoch: 1,
    dataAtRisk: false,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

export interface TestPlane {
  plane: ReturnType<typeof assembleCloudControlPlane>;
  clock: FakeClock;
  ids: FakeIds;
  storage: FakeStorage;
  outbox: FakeOutbox;
  github: FakeGitHub;
  driver: FakeSandboxDriver;
  attachmentPort: FakeAttachmentPort;
  runtimeCommands: ReturnType<typeof createFakeRuntimeCommands>;
  provisioningEnvelope: ReturnType<typeof createFakeProvisioningEnvelope>;
  interactionDecisions: ReturnType<typeof createFakeInteractionDecisions>;
  templates: ReturnType<typeof createFakeTemplateResolver>;
  gitGrantStore: ReturnType<typeof createFakeGitGrantStore>;
  gitGrantBrokerDeps: ReturnType<typeof createFakeGitGrantBrokerDeps>;
  /** 浏览器观看事实 fake（生产实现是 bridge 通道的多路复用器）。 */
  browserWatch: FakeBrowserWatch;
}

/** 浏览器观看连接 fake：`open/close` 模拟任务通道流的建立与关闭（关即清）。 */
export interface FakeBrowserWatch extends BrowserWatchPort {
  readonly watchers: Set<string>;
  open(runId: string): void;
  close(runId: string): void;
}

export function createFakeBrowserWatch(): FakeBrowserWatch {
  const watchers = new Set<string>();
  return {
    watchers,
    open: (runId) => {
      watchers.add(runId);
    },
    close: (runId) => {
      watchers.delete(runId);
    },
    hasWatcher: (runId) => watchers.has(runId),
  };
}

/** 组装被测的 app 服务图：只替换端口 fake（W1 §6 app 集成约定）。 */
export function buildTestPlane(
  options: {
    storage?: FakeStorageOptions;
    driver?: SandboxDriverPort | null;
    config?: Partial<CloudCoreConfig>;
  } = {},
): TestPlane {
  const clock = new FakeClock();
  const ids = new FakeIds();
  const outbox = createFakeOutbox();
  const storage = createFakeStorage(clock, outbox, options.storage ?? {});
  const github = createFakeGitHub();
  const driver = createFakeSandboxDriver();
  const attachmentPort = createFakeAttachmentPort();
  const runtimeCommands = createFakeRuntimeCommands();
  const provisioningEnvelope = createFakeProvisioningEnvelope();
  const interactionDecisions = createFakeInteractionDecisions();
  const templates = createFakeTemplateResolver();
  const gitGrant = createFakeGitGrantBroker({
    now: () => clock.now(),
    newGrantId: () => ids.newId(),
  });
  const gitGrantStore = gitGrant.store;
  const gitGrantBroker = gitGrant.broker;
  const gitGrantBrokerDeps = gitGrant.deps;
  const browserWatch = createFakeBrowserWatch();
  const plane = assembleCloudControlPlane({
    storage,
    operations: outbox,
    github,
    drivers: createFakeDriverRegistry(options.driver === undefined ? driver : options.driver),
    attachments: attachmentPort,
    browserWatch,
    runtimeCommands,
    clock,
    ids,
    hash: new FakeHash(),
    templates,
    interactionDecisions,
    executionProjections: createFakeExecutionProjections(),
    artifacts: createFakeArtifacts(),
    provisioningEnvelope,
    gitGrantStore,
    gitGrantBroker,
    ...(options.config ? { config: options.config } : {}),
  });
  return {
    plane,
    clock,
    ids,
    storage,
    outbox,
    github,
    driver,
    attachmentPort,
    runtimeCommands,
    provisioningEnvelope,
    interactionDecisions,
    templates,
    gitGrantStore,
    gitGrantBrokerDeps,
    browserWatch,
  };
}

/**
 * 注册并置位一条 ready attachment（投递前置：02 §5.3）。
 * 顺序与生产一致：welcome（注册）→ bootstrap.config 下发 → ready 置位。
 */
export async function attachReadySession(
  context: TestPlane,
  input: { taskId: string; runId: string; runGeneration: number; connectionEpoch?: number },
): Promise<void> {
  const connectionEpoch = input.connectionEpoch ?? 1;
  const run = await context.storage.runs.get(input.runId);
  context.plane.attachments.register(
    sessionFromAddress({
      address: {
        taskId: input.taskId,
        runId: input.runId,
        runGeneration: input.runGeneration,
        workspaceIdentity: `cloud-task:${input.taskId}`,
        // 地址里的 workspacePath 取持久事实（创建期由 domain/workspacePath.ts 算出）。
        workspacePath: run?.workspacePath ?? "/workspace/unknown",
        remoteSessionId: `remote-${input.runId}`,
        connectionEpoch,
      },
      at: context.clock.now(),
    }),
  );
  const bootstrap = await context.plane.provisioning.bootstrapConfig.send({
    taskId: input.taskId,
    runId: input.runId,
    runGeneration: input.runGeneration,
    connectionEpoch,
  });
  if (!bootstrap.ok) {
    throw new Error(`bootstrap config not sent: ${bootstrap.code}/${bootstrap.reason}`);
  }
  context.plane.attachments.markReady({
    runId: input.runId,
    runGeneration: input.runGeneration,
    connectionEpoch,
    runtimeSessionId: `session-${input.runId}`,
    at: context.clock.now(),
  });
}
// ── 其余 fake 的转出（测试只 import 本文件即可）──
export {
  createFakeSandboxDriver,
  createFakeDriverRegistry,
  createFakeAttachmentPort,
  createFakeGitHub,
  createFakeRuntimeCommands,
};
export type { FakeAttachmentPort, FakeGitHub, FakeSandboxDriver } from "./cloudCoreAdapterFakes.js";
export { createFakeStorage };
export type { FakeStorage, FakeStorageOptions } from "./cloudCoreStorageFake.js";
export { toReceipt } from "./cloudCoreStorageRepoFakes.js";
export type { StorageFakeState } from "./cloudCoreStorageRepoFakes.js";

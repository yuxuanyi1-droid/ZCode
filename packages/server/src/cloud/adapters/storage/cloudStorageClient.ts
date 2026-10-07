/**
 * StoragePort / OperationOutboxPort 的异步实现（W2 §4）。
 *
 * 本模块是控制面 app 层看到的唯一存储入口：所有方法都是异步的，实际的同步 SQL 发生
 * 在 worker 线程里（storageTransport）。HTTP 事件循环因此不会执行大 SQL（W2 §5）。
 * 装配方还必须调用 `assertReady()`：迁移未就绪/目录不可写/磁盘不足时 fail closed，
 * 不返回 accepted、不创建 provider 资源（03 §4、§8）。
 */
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { OperationOutboxPort } from "../../app/ports/operationOutboxPort.js";
import type { GitGrantStore } from "../../app/ports/gitGrantPort.js";
import type { GitHubEffectStore } from "../../app/ports/gitHubEffectPort.js";
import type { InteractionDecisionRepo } from "../../app/ports/inputPort.js";
import type {
  InputRepo,
  InputPayloadRead,
  ProjectRepo,
  ProjectionRepo,
  RunCredentialRepo,
  RunRepo,
  StoragePort,
  StorageReadiness,
  TaskRepo,
} from "../../app/ports/storagePort.js";
import { createStorageTransport } from "./storageTransport.js";
import {
  assertStorageHealthy,
  collectStorageHealth,
  DEFAULT_STORAGE_HEALTH_THRESHOLDS,
} from "./health.js";
import type { StorageHealthReport, StorageHealthThresholds } from "./health.js";
import { createCloudAttachmentStore } from "./attachments/attachmentStore.js";
import type { AttachmentLimits } from "./attachments/attachmentTypes.js";
import { createServiceLogger } from "@zcode/services/node";
import type { StorageMethodName, StorageMethodTable, StorageWorkerInit } from "./workerProtocol.js";
import type { StorageTransportMode } from "./storageTransport.js";

const logger = createServiceLogger("cloud-storage");

export interface CloudStorageOptions {
  /** 云持久卷上的数据目录：数据库文件与 WAL/SHM 落在这里。 */
  dataDir: string;
  /** 附件目录：受控存储的 tmp/ 与 objects/。可与 dataDir 相同。 */
  attachmentsDir: string;
  databaseFilename?: string;
  synchronous?: "FULL" | "NORMAL";
  busyTimeoutMs?: number;
  /** 默认 worker 子进程；in-process 供嵌入式装配与集成测试。 */
  transportMode?: StorageTransportMode;
  /** worker 入口覆盖（打包部署未输出独立入口时必填，见 storageTransport）。 */
  workerEntryPath?: string;
  thresholds?: Partial<StorageHealthThresholds>;
  attachmentLimits?: Partial<AttachmentLimits>;
  /** 故障注入（W10 用）：在方法派发前注入存储错误，验证 fail closed 路径。 */
  faults?: StorageWorkerInit["faults"];
  /** 容量护栏：迁移后固定页数上限（测试用于制造真实 SQLITE_FULL）。 */
  capDatabasePages?: boolean;
}

export interface CloudStorage {
  readonly storage: StoragePort;
  readonly operations: OperationOutboxPort;
  /** git grant 持久面（01 §7.2）：W4 broker 消费。 */
  readonly grants: GitGrantStore;
  /** GitHub effect outbox（09 §5.2）：W4 执行器消费。 */
  readonly effects: GitHubEffectStore;
  /** 交互决定与取消意向（02 §6.3）：W1/W5 的审批通路消费。 */
  readonly interactions: InteractionDecisionRepo;
  /** 受控附件存储（字节 IO 在调用进程异步执行）。 */
  readonly attachments: ReturnType<typeof createCloudAttachmentStore>;
  /** 部署主体持久化（03 §3）。 */
  ensurePrincipal(request: {
    principalId: string;
    displayName?: string;
    now: number;
  }): Promise<{ principalId: string; disabled: boolean; createdAt: number; updatedAt: number }>;
  readiness(): Promise<StorageReadiness>;
  health(): Promise<StorageHealthReport>;
  /** 启动门：不满足即抛 CloudStorageError（not_ready）。 */
  assertReady(): Promise<StorageHealthReport>;
  close(): Promise<void>;
}

export async function createCloudStorage(options: CloudStorageOptions): Promise<CloudStorage> {
  const databasePath = path.join(options.dataDir, options.databaseFilename ?? "cloud.db");
  await Promise.all([
    mkdir(options.dataDir, { recursive: true }),
    mkdir(options.attachmentsDir, { recursive: true }),
  ]);

  const init: StorageWorkerInit = {
    databasePath,
    synchronous: options.synchronous ?? "FULL",
    ...(options.busyTimeoutMs === undefined ? {} : { busyTimeoutMs: options.busyTimeoutMs }),
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    ...(options.capDatabasePages === undefined
      ? {}
      : { capDatabasePages: options.capDatabasePages }),
  };
  const transport = await createStorageTransport({
    init,
    ...(options.transportMode === undefined ? {} : { mode: options.transportMode }),
    ...(options.workerEntryPath === undefined ? {} : { workerEntryPath: options.workerEntryPath }),
  });
  logger.info(undefined, "存储已就绪", {
    databasePath,
    synchronous: init.synchronous,
    mode: options.transportMode ?? "worker",
  });

  const thresholds: StorageHealthThresholds = {
    ...DEFAULT_STORAGE_HEALTH_THRESHOLDS,
    ...options.thresholds,
  };

  /** 单条方法调用的类型安全包装：params 形状来自方法表，返回类型来自端口。 */
  const request = <Name extends StorageMethodName>(
    name: Name,
    params: StorageMethodTable[Name]["params"],
  ): Promise<StorageMethodTable[Name]["result"]> =>
    transport.request(name, params) as Promise<StorageMethodTable[Name]["result"]>;

  const attachments = createCloudAttachmentStore({
    dir: options.attachmentsDir,
    transport,
    ...(options.attachmentLimits === undefined ? {} : { limits: options.attachmentLimits }),
  });

  // 端口方法按原签名转成一条消息：位置参数在这里收进对象，其余层级只看到异步端口。
  const projects: ProjectRepo = {
    get: (projectId) => request("projects.get", { projectId }),
    findByRepository: (principalId, repositoryId) =>
      request("projects.findByRepository", { principalId, repositoryId }),
    createOrGet: (createRequest) => request("projects.createOrGet", createRequest),
    list: (principalId, page) => request("projects.list", { principalId, page }),
    patchMetadata: (patchRequest) => request("projects.patchMetadata", patchRequest),
  };
  const tasks: TaskRepo = {
    get: (taskId) => request("tasks.get", { taskId }),
    findByCreationKey: (ownerPrincipalId, creationKey) =>
      request("tasks.findByCreationKey", { ownerPrincipalId, creationKey }),
    createDraft: (draftRequest) => request("tasks.createDraft", draftRequest),
    listByProject: (projectId, page) => request("tasks.listByProject", { projectId, page }),
    patchMetadata: (patchRequest) => request("tasks.patchMetadata", patchRequest),
    transitionStatus: (transitionRequest) => request("tasks.transitionStatus", transitionRequest),
    freezeBaseline: (freezeRequest) => request("tasks.freezeBaseline", freezeRequest),
    recordCheckpointSha: (shaRequest) => request("tasks.recordCheckpointSha", shaRequest),
    recordArtifact: (artifact) => request("tasks.recordArtifact", { artifact }),
    setCompleteRequested: (completeRequest) =>
      request("tasks.setCompleteRequested", completeRequest),
  };
  const runs: RunRepo = {
    get: (runId) => request("runs.get", { runId }),
    activeOfTask: (taskId) => request("runs.activeOfTask", { taskId }),
    reserveRun: (reserveRequest) => request("runs.reserveRun", reserveRequest),
    listNonTerminal: () => request("runs.listNonTerminal", undefined),
    recordProviderHandle: (handleRequest) => request("runs.recordProviderHandle", handleRequest),
    transitionStatus: (transitionRequest) => request("runs.transitionStatus", transitionRequest),
    bumpConnectionEpoch: (epochRequest) => request("runs.bumpConnectionEpoch", epochRequest),
    updateLease: (leaseRequest) => request("runs.updateLease", leaseRequest),
    touchBusinessActivity: (activityRequest) =>
      request("runs.touchBusinessActivity", activityRequest),
    requestStop: (stopRequest) => request("runs.requestStop", stopRequest),
    clearStopRequest: (clearRequest) => request("runs.clearStopRequest", clearRequest),
    releaseQuota: (quotaRequest) => request("runs.releaseQuota", quotaRequest),
    setRunRuntimeSessionId: (sessionRequest) =>
      request("runs.setRunRuntimeSessionId", sessionRequest),
    setRunDataAtRisk: (riskRequest) => request("runs.setRunDataAtRisk", riskRequest),
  };
  const inputs: InputRepo = {
    get: (taskId, commandId) => request("inputs.get", { taskId, commandId }),
    list: (taskId, page) => request("inputs.list", { taskId, page }),
    markDelivery: (deliveryRequest) => request("inputs.markDelivery", deliveryRequest),
    cancelPending: (cancelRequest) => request("inputs.cancelPending", cancelRequest),
    listDeliverable: (taskId) => request("inputs.listDeliverable", { taskId }),
  };
  const projections: ProjectionRepo = {
    appendBatch: (records) => request("projections.appendBatch", { records }),
    readHistory: (historyRequest) => request("projections.readHistory", historyRequest),
    readSnapshot: (snapshotRequest) => request("projections.readSnapshot", snapshotRequest),
    writeSnapshot: (snapshotRequest) => request("projections.writeSnapshot", snapshotRequest),
    ingestCursors: (cursorRequest) => request("projections.ingestCursors", cursorRequest),
    listCheckpoints: (taskId) => request("projections.listCheckpoints", { taskId }),
    recordCheckpoint: (checkpoint) => request("projections.recordCheckpoint", { checkpoint }),
  };
  const credentials: RunCredentialRepo = {
    saveInitial: (initialRequest) => request("credentials.saveInitial", initialRequest),
    consumeForHello: (helloRequest) => request("credentials.consumeForHello", helloRequest),
    recoverByAttempt: (recoverRequest) => request("credentials.recoverByAttempt", recoverRequest),
    revokeRun: (revokeRequest) => request("credentials.revokeRun", revokeRequest),
    verifyActiveCredential: (verifyRequest) =>
      request("credentials.verifyActiveCredential", verifyRequest),
  };
  const payloads: InputPayloadRead = {
    readInputPayload: (payloadRequest) => request("payloads.readInputPayload", payloadRequest),
  };

  async function collectHealth(): Promise<StorageHealthReport> {
    const db = await request("storage.readiness", undefined);
    return collectStorageHealth({
      db,
      dataDir: options.dataDir,
      attachmentsDir: options.attachmentsDir,
      thresholds,
    });
  }

  const storage: StoragePort = {
    projects,
    tasks,
    runs,
    inputs,
    projections,
    credentials,
    payloads,
    acceptInput: (acceptRequest) => request("storage.acceptInput", acceptRequest),
    readiness: async () => (await collectHealth()).readiness,
  };

  const grants: GitGrantStore = {
    insert: (record) => request("grants.insert", { record }),
    get: (grantId) => request("grants.get", { grantId }),
    findCurrentForRun: (lookupRequest) => request("grants.findCurrentForRun", lookupRequest),
    claimRedemption: (claimRequest) => request("grants.claimRedemption", claimRequest),
    recordIssuedToken: (tokenRequest) => request("grants.recordIssuedToken", tokenRequest),
    recordFailure: (failureRequest) => request("grants.recordFailure", failureRequest),
    recordRevokeOutcome: (revokeRequest) => request("grants.recordRevokeOutcome", revokeRequest),
    listByRun: (runId) => request("grants.listByRun", { runId }),
  };

  const effects: GitHubEffectStore = {
    enqueue: (enqueueRequest) => request("effects.enqueue", enqueueRequest),
    get: (effectId) => request("effects.get", { effectId }),
    leaseNext: (leaseRequest) => request("effects.leaseNext", leaseRequest),
    settle: (settleRequest) => request("effects.settle", settleRequest),
    listUnsettled: () => request("effects.listUnsettled", undefined),
  };

  const interactions: InteractionDecisionRepo = {
    recordDecision: (decisionRequest) => request("interactions.recordDecision", decisionRequest),
    getDecision: (taskId, interactionId) =>
      request("interactions.getDecision", { taskId, interactionId }),
    findDecisionByDeliveryCommandId: (taskId, deliveryCommandId) =>
      request("interactions.findDecisionByDeliveryCommandId", { taskId, deliveryCommandId }),
    setDecisionDeliveryStatus: (statusRequest) =>
      request("interactions.setDecisionDeliveryStatus", statusRequest),
    recordCancelIntent: (cancelRequest) =>
      request("interactions.recordCancelIntent", cancelRequest),
    getCancelIntent: (taskId, commandId) =>
      request("interactions.getCancelIntent", { taskId, commandId }),
  };

  const operations: OperationOutboxPort = {
    enqueue: (enqueueRequest) => request("operations.enqueue", enqueueRequest),
    findByKey: (idempotencyKey) => request("operations.findByKey", { idempotencyKey }),
    get: (operationId) => request("operations.get", { operationId }),
    leaseNext: (leaseRequest) => request("operations.leaseNext", leaseRequest),
    settle: (settleRequest) => request("operations.settle", settleRequest),
    listUnsettled: () => request("operations.listUnsettled", undefined),
  };

  return {
    storage,
    operations,
    grants,
    effects,
    interactions,
    attachments,
    ensurePrincipal: (principalRequest) => request("principals.ensure", principalRequest),
    readiness: storage.readiness,
    health: collectHealth,
    assertReady: async () => {
      const report = await collectHealth();
      assertStorageHealthy(report, thresholds);
      return report;
    },
    close: () => transport.close(),
  };
}

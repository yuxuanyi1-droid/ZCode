/**
 * storage 方法表与 handler 契约（W2 §3/§4）：**下层类型文件**。
 *
 * 放在这里的理由（架构门禁）：`workerProtocol` 与 `repositories/*` 都依赖本文件，
 * 但本文件不依赖二者——否则会形成
 * `interactionRepo → inputRepo → workerProtocol → interactionRepo` 的循环。
 * 因此：方法表、handler 表与共享的记录类型都下沉到这里，`workerProtocol` 只做
 * 消息信封与再导出。
 *
 * 表本身是「端口方法 ↔ 实现」的编译期清单：漏实现一个端口方法类型检查就会失败，
 * 所以不存在静默缺失的 repository 能力。params 一律是可 JSON 序列化的对象，参数
 * 形状直接复用冻结端口类型，避免适配层自己发明第二套形状。
 */
import type { StorageDbReadiness } from "./health.js";
import type { StorageContext } from "./sqlite/database.js";
import type {
  AcceptInputRequest,
  AcceptInputResult,
  CursorPage,
  InputRepo,
  ProjectionRepo,
  ProjectRepo,
  ReserveRunRequest,
  RunCredentialRepo,
  RunRepo,
  RunReservation,
  TaskRepo,
} from "../../app/ports/storagePort.js";
import type { OperationOutboxPort } from "../../app/ports/operationOutboxPort.js";
import type { GitGrantRecord, GitGrantStore } from "../../app/ports/gitGrantPort.js";
import type { GitHubEffectStore, LeasedGitHubEffect } from "../../app/ports/gitHubEffectPort.js";
import type {
  CloudCheckpointRecord,
  CloudProjectionRecord,
  CloudTaskArtifactRecord,
  CloudTaskInputRecord,
  CloudTaskRecord,
} from "@zcode/shared";
import type {
  AttachmentObjectRecord,
  AttachmentSweepRequest,
  AttachmentSweepResult,
  PublishAttachmentRequest,
} from "./attachments/attachmentTypes.js";
import type {
  InteractionCancelIntent,
  InteractionDecisionRecord,
  InteractionDecisionRepo,
} from "../../app/ports/inputPort.js";

type AnyMethod = (...args: never[]) => unknown;

/** 单参数端口方法 → `{params}`；形状直接来自冻结端口，不重新声明。 */
export type MethodSignature<Method extends AnyMethod> = Method extends (
  ...args: infer Args
) => infer Result
  ? Args extends readonly [infer Only]
    ? { params: Only; result: Awaited<Result> }
    : { params: readonly unknown[]; result: Awaited<Result> }
  : never;

type PageRequest = { cursor?: string; limit: number };

export interface StorageMethodTable {
  // ── projects（03 §4 projects 表）──
  "projects.get": { params: { projectId: string }; result: CloudProjectReturn["get"] };
  "projects.findByRepository": {
    params: { principalId: string; repositoryId: number };
    result: CloudProjectReturn["get"];
  };
  "projects.createOrGet": MethodSignature<ProjectRepo["createOrGet"]>;
  "projects.list": {
    params: { principalId: string; page: PageRequest };
    result: CursorPage<NonNullable<CloudProjectReturn["get"]>>;
  };
  "projects.patchMetadata": MethodSignature<ProjectRepo["patchMetadata"]>;

  // ── tasks（08 §2/§3.1）──
  "tasks.get": { params: { taskId: string }; result: CloudTaskRecord | null };
  "tasks.findByCreationKey": {
    params: { ownerPrincipalId: string; creationKey: string };
    result: CloudTaskRecord | null;
  };
  "tasks.createDraft": MethodSignature<TaskRepo["createDraft"]>;
  "tasks.listByProject": {
    params: { projectId: string; page: PageRequest };
    result: CursorPage<CloudTaskRecord>;
  };
  "tasks.patchMetadata": MethodSignature<TaskRepo["patchMetadata"]>;
  "tasks.transitionStatus": MethodSignature<TaskRepo["transitionStatus"]>;
  "tasks.freezeBaseline": MethodSignature<TaskRepo["freezeBaseline"]>;
  "tasks.recordCheckpointSha": MethodSignature<TaskRepo["recordCheckpointSha"]>;
  "tasks.recordArtifact": { params: { artifact: CloudTaskArtifactRecord }; result: void };
  "tasks.setCompleteRequested": MethodSignature<TaskRepo["setCompleteRequested"]>;
  "tasks.listCompleteRequested": { params: undefined; result: CloudTaskRecord[] };

  // ── runs（08 §3.2/§4.2/§7）──
  "runs.get": { params: { runId: string }; result: CloudRunReturn["get"] };
  "runs.activeOfTask": { params: { taskId: string }; result: CloudRunReturn["get"] };
  "runs.reserveRun": { params: ReserveRunRequest; result: RunReservation };
  "runs.listNonTerminal": { params: undefined; result: NonNullable<CloudRunReturn["get"]>[] };
  "runs.recordProviderHandle": MethodSignature<RunRepo["recordProviderHandle"]>;
  "runs.transitionStatus": MethodSignature<RunRepo["transitionStatus"]>;
  "runs.bumpConnectionEpoch": MethodSignature<RunRepo["bumpConnectionEpoch"]>;
  "runs.updateLease": MethodSignature<RunRepo["updateLease"]>;
  "runs.touchBusinessActivity": MethodSignature<RunRepo["touchBusinessActivity"]>;
  "runs.requestStop": MethodSignature<RunRepo["requestStop"]>;
  "runs.clearStopRequest": MethodSignature<RunRepo["clearStopRequest"]>;
  "runs.releaseQuota": MethodSignature<RunRepo["releaseQuota"]>;
  "runs.setRunRuntimeSessionId": MethodSignature<RunRepo["setRunRuntimeSessionId"]>;
  "runs.setRunDataAtRisk": MethodSignature<RunRepo["setRunDataAtRisk"]>;

  // ── inputs（02 §6、03 §6.1）──
  "inputs.get": {
    params: { taskId: string; commandId: string };
    result: CloudTaskInputRecord | null;
  };
  "inputs.list": {
    params: { taskId: string; page: PageRequest };
    result: CursorPage<CloudTaskInputRecord>;
  };
  "inputs.markDelivery": MethodSignature<InputRepo["markDelivery"]>;
  "inputs.cancelPending": MethodSignature<InputRepo["cancelPending"]>;
  "inputs.settleForEndedRun": MethodSignature<InputRepo["settleForEndedRun"]>;
  "inputs.listDeliverable": { params: { taskId: string }; result: CloudTaskInputRecord[] };

  // ── projections（02 §7、03 §4）──
  "projections.appendBatch": {
    params: { records: readonly CloudProjectionRecord[] };
    result: Awaited<ReturnType<ProjectionRepo["appendBatch"]>>;
  };
  "projections.readHistory": MethodSignature<ProjectionRepo["readHistory"]>;
  "projections.readSnapshot": MethodSignature<ProjectionRepo["readSnapshot"]>;
  "projections.writeSnapshot": MethodSignature<ProjectionRepo["writeSnapshot"]>;
  "projections.ingestCursors": MethodSignature<ProjectionRepo["ingestCursors"]>;
  "projections.listCheckpoints": { params: { taskId: string }; result: CloudCheckpointRecord[] };
  "projections.recordCheckpoint": { params: { checkpoint: CloudCheckpointRecord }; result: void };

  // ── bridge 凭据（02 §5.1/§5.2；extendForRun 为 B-6 续展，2026-10-09 生命周期 v2）──
  "credentials.saveInitial": MethodSignature<RunCredentialRepo["saveInitial"]>;
  "credentials.consumeForHello": MethodSignature<RunCredentialRepo["consumeForHello"]>;
  "credentials.recoverByAttempt": MethodSignature<RunCredentialRepo["recoverByAttempt"]>;
  "credentials.revokeRun": MethodSignature<RunCredentialRepo["revokeRun"]>;
  "credentials.verifyActiveCredential": MethodSignature<
    RunCredentialRepo["verifyActiveCredential"]
  >;
  "credentials.extendForRun": MethodSignature<RunCredentialRepo["extendForRun"]>;

  // ── 正文读取与接纳事务（03 §6.1）──
  "payloads.readInputPayload": {
    params: { taskId: string; commandId: string };
    result: { prompt: string; attachmentIds?: string[] } | null;
  };
  "storage.acceptInput": { params: AcceptInputRequest; result: AcceptInputResult };
  "storage.readiness": { params: undefined; result: StorageDbReadiness };

  // ── external operation outbox（03 §5、01 §5.3）──
  "operations.enqueue": MethodSignature<OperationOutboxPort["enqueue"]>;
  "operations.findByKey": {
    params: { idempotencyKey: string };
    result: Awaited<ReturnType<OperationOutboxPort["findByKey"]>>;
  };
  "operations.get": {
    params: { operationId: string };
    result: Awaited<ReturnType<OperationOutboxPort["get"]>>;
  };
  "operations.leaseNext": MethodSignature<OperationOutboxPort["leaseNext"]>;
  "operations.renewLease": MethodSignature<OperationOutboxPort["renewLease"]>;
  "operations.settle": MethodSignature<OperationOutboxPort["settle"]>;
  "operations.listUnsettled": {
    params: undefined;
    result: Awaited<ReturnType<OperationOutboxPort["listUnsettled"]>>;
  };

  // ── git grant（01 §7.1/§7.2、03 §4 git_grants 表；W4 broker 消费）──
  "grants.insert": { params: { record: GitGrantRecord }; result: void };
  "grants.get": { params: { grantId: string }; result: GitGrantRecord | null };
  "grants.findCurrentForRun": MethodSignature<GitGrantStore["findCurrentForRun"]>;
  "grants.claimRedemption": MethodSignature<GitGrantStore["claimRedemption"]>;
  "grants.recordIssuedToken": MethodSignature<GitGrantStore["recordIssuedToken"]>;
  "grants.recordFailure": MethodSignature<GitGrantStore["recordFailure"]>;
  "grants.recordRevokeOutcome": MethodSignature<GitGrantStore["recordRevokeOutcome"]>;
  "grants.listByRun": { params: { runId: string }; result: GitGrantRecord[] };

  // ── GitHub effect outbox（09 §5.2；`external_operations` 的 GitHub 分面）──
  "effects.enqueue": MethodSignature<GitHubEffectStore["enqueue"]>;
  "effects.get": {
    params: { effectId: string };
    result: Awaited<ReturnType<GitHubEffectStore["get"]>>;
  };
  "effects.leaseNext": {
    params: Parameters<GitHubEffectStore["leaseNext"]>[0];
    result: LeasedGitHubEffect | null;
  };
  "effects.settle": MethodSignature<GitHubEffectStore["settle"]>;
  "effects.listUnsettled": {
    params: undefined;
    result: Awaited<ReturnType<GitHubEffectStore["listUnsettled"]>>;
  };

  // ── 交互决定与取消意向（02 §6.3、03 §4；W1 CR-3 裁决）──
  "interactions.recordDecision": MethodSignature<InteractionDecisionRepo["recordDecision"]>;
  "interactions.getDecision": {
    params: { taskId: string; interactionId: string };
    result: InteractionDecisionRecord | null;
  };
  /**
   * 反查：runtime ACK 按 commandId 回投，控制面据此把投递状态写回对应决定
   * （查不到是正常对账结论，返回 null，不抛错）。
   */
  "interactions.findDecisionByDeliveryCommandId": {
    params: { taskId: string; deliveryCommandId: string };
    result: InteractionDecisionRecord | null;
  };
  "interactions.setDecisionDeliveryStatus": MethodSignature<
    InteractionDecisionRepo["setDecisionDeliveryStatus"]
  >;
  "interactions.recordCancelIntent": MethodSignature<InteractionDecisionRepo["recordCancelIntent"]>;
  "interactions.getCancelIntent": {
    params: { taskId: string; commandId: string };
    result: InteractionCancelIntent | null;
  };

  // ── 部署主体（03 §3 稳定 deploymentPrincipalId 的持久化）──
  "principals.ensure": {
    params: { principalId: string; displayName?: string; now: number };
    result: { principalId: string; disabled: boolean; createdAt: number; updatedAt: number };
  };

  // ── 附件元数据（03 §4；字节由 attachments/ 在主进程异步落盘）──
  "attachments.publish": { params: PublishAttachmentRequest; result: AttachmentObjectRecord };
  "attachments.get": {
    params: { ownerPrincipalId: string; attachmentId: string };
    result: AttachmentObjectRecord | null;
  };
  "attachments.sweep": { params: AttachmentSweepRequest; result: AttachmentSweepResult };
}

/** 端口返回类型别名（避免在表里重复书写联合类型）。 */
type CloudProjectReturn = { get: Awaited<ReturnType<ProjectRepo["get"]>> };
type CloudRunReturn = { get: Awaited<ReturnType<RunRepo["get"]>> };

export type StorageMethodName = keyof StorageMethodTable;

export type StorageHandler<Name extends StorageMethodName> = (
  context: StorageContext,
  params: StorageMethodTable[Name]["params"],
) => StorageMethodTable[Name]["result"];

export type StorageHandlerTable = { [Name in StorageMethodName]: StorageHandler<Name> };

/** 故障注入规则（W2 §8、10 §6 B07）：在方法派发前生效，用于验证 fail closed 路径。 */
export interface StorageFaultRule {
  /** 命中方法名（如 "storage.acceptInput"）。 */
  method: StorageMethodName | string;
  /** 第几次调用命中（1 起）；缺省表示每次都命中。 */
  occurrence?: number;
  message?: string;
}

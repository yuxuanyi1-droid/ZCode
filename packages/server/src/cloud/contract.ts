/**
 * cloud-control-plane 公开契约：Cloud 控制面（云服务端内的编排叠加层，03 §2）的
 * 端口与状态入口。跨模块消费方只允许从这里 import；实现细节（SQLite worker、
 * provider SDK、GitHub、WS 路由、装配）都在模块内部各层。
 *
 * - 跨包 wire schema（地址/控制帧/RPC 帧/HTTP 与响应信封/领域实体/错误码）唯一
 *   事实源是 `@zcode/shared` 的 cloud 公开入口（`packages/shared/src/cloud/`），
 *   本文件不复制、不重定义。
 * - domain 层的状态迁移与代际 CAS 判定是模块内部规则；跨模块读到的是持久投影，
 *   消费方不自行裁决迁移（08 §3）。
 * - 端口只是类型：`StoragePort`/`OperationOutboxPort`/`GitHubPort` 由 adapters 实现，
 *   `SandboxDriverPort` 由 provider adapter（W3）实现，`AttachmentPort` 由 attachment
 *   传输侧实现；app 层只依赖这些接口（03 §2 分层：domain→app→adapters 单向）。
 *
 * W1 追加（本模块 owner 维护）：
 * - 应用装配入口 `assembleCloudControlPlane`（无 HTTP/SQLite；W5 注入 adapters）；
 * - 后台循环入口 `startCloudLifecycleLoops`（定时器经 `LoopSchedulerPort` 注入）；
 * - 新增窄端口：`ClockPort`/`HashPort`/`IdGeneratorPort`/`LoopSchedulerPort`/
 *   `RuntimeCommandQueryPort`/`SandboxDriverRegistryPort`（各端口 JSDoc 说明依据章节）。
 */
export type {
  CreateReconciliation,
  DeadlineResult,
  ProviderObservation,
  ProviderSandboxHandle,
  ResolvedSandboxTemplate,
  SandboxCreateInput,
  SandboxDriverCapabilities,
  SandboxDriverPort,
  SandboxResources,
  SandboxTemplateResolverPort,
  TerminationObservation,
} from "./app/ports/sandboxDriverPort.js";
export type {
  AcceptInputRequest,
  AcceptInputResult,
  ArtifactRead,
  CreateDraftTaskRequest,
  CreateProjectRequest,
  CursorPage,
  ExecutionProjectionRead,
  InputPayloadRead,
  InputRepo,
  InteractionCancelIntent,
  InteractionDecisionRecord,
  InteractionDecisionRepo,
  ProjectionAppendResult,
  ProjectionRepo,
  ProjectRepo,
  ReserveRunRequest,
  RunCredentialRepo,
  RunRepo,
  RunReservation,
  StoragePort,
  StorageReadiness,
  TaskRepo,
} from "./app/ports/storagePort.js";
// 交互决定载荷上限（W2 收口冻结）：决定必须可恢复投递，payload 与其上限随端口一起公开。
export { CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS } from "./app/ports/inputPort.js";
export type {
  ExternalOperationKind,
  ExternalOperationRecord,
  ExternalOperationState,
  LeasedOperation,
  OperationOutboxPort,
} from "./app/ports/operationOutboxPort.js";
export type { GitGrantRecord, GitGrantStatus, GitGrantStore } from "./app/ports/gitGrantPort.js";
export type {
  GitHubEffectEnqueueRequest,
  GitHubEffectKind,
  GitHubEffectRecord,
  GitHubEffectSettleOutcome,
  GitHubEffectStatus,
  GitHubEffectStore,
  LeasedGitHubEffect,
} from "./app/ports/gitHubEffectPort.js";
export type {
  BranchHead,
  EnqueueGitHubEffectRequest,
  EnqueuedGitHubEffect,
  GitHubErrorFacts,
  GitHubPort,
  MintTokenRequest,
  MintedToken,
  PublishDraftPullRequestResult,
  PullRequestProjection,
  RepositoryRef,
} from "./app/ports/gitHubPort.js";
export type {
  AttachmentBootstrapRequest,
  AttachmentCheckpointRequest,
  AttachmentCommandRequest,
  AttachmentDrainRequest,
  AttachmentIngestPort,
  AttachmentPort,
  AttachmentSendExpectation,
  AttachmentSendResult,
  ProjectionIngestResult,
} from "./app/ports/attachmentPort.js";

// ── W1 追加端口（类型）──
export type { ClockPort } from "./app/ports/clockPort.js";
export type { HashPort } from "./app/ports/hashPort.js";
export type { IdGeneratorPort } from "./app/ports/idGeneratorPort.js";
export type { LoopSchedulerPort } from "./app/ports/loopSchedulerPort.js";
export type {
  RuntimeCommandQueryPort,
  RuntimeCommandQueryResult,
} from "./app/ports/runtimeCommandQueryPort.js";
export type {
  SandboxDriverRegistryPort,
  SandboxProviderEntry,
} from "./app/ports/sandboxDriverRegistryPort.js";

// ── 入口级装配（W5 冻结面：principalId + registerRoutes + loops + close）──
//
// 这是 W5 `startCloudServer` 消费的唯一入口：把入口 context 映射成 deps、自持存储
// （透传 `storageWorkerEntryPath`、返回前完成 readiness 门槛）、建 bridge 通道、
// 注册 HTTP/WS 路由并给出两个后台循环句柄。类型刻意在入口侧声明结构兼容的形状，
// 避免 `contract.ts ⇄ adapters/entry-cloud-server.ts` 成环。
export {
  assembleCloudControlPlane,
  type CloudControlPlane,
  type CloudControlPlaneContext,
  type CloudEntryStorageSource,
  type CloudStorageReadinessSource,
} from "./adapters/entry-cloud-control-plane.js";
// 装配期结构化失败：定义在独立模块，避免入口/ git grant 装配 / 启动路径三方成环。
export { CloudControlPlaneAssemblyError } from "./adapters/controlPlaneAssemblyError.js";
export type { CloudBackgroundLoop } from "./app/lifecycleLoops.js";
export type { CloudCommandTransport, BridgeSocket } from "./adapters/ws/bridgeChannel.js";
export type { CloudUpgradeWebSocket } from "./adapters/http/registerCloudRoutes.js";
export { registerCloudRoutes } from "./adapters/http/registerCloudRoutes.js";

// ── app 服务图（内部实现；测试与 W1 用例直接消费）──
export {
  assembleCloudControlPlane as assembleCloudCoreControlPlane,
  type CloudControlPlane as CloudCoreControlPlane,
} from "./app/assembleCloudControlPlane.js";
export {
  DEFAULT_CLOUD_LOOP_INTERVALS,
  startCloudLifecycleLoops,
  type CloudLifecycleLoops,
  type CloudLoopIntervals,
  type CloudLoopTickReport,
} from "./app/lifecycleLoops.js";
export type { CloudCoreDeps } from "./app/deps.js";
export {
  CLOUD_CORE_DEFAULTS,
  DEFAULT_SANDBOX_RESOURCES,
  resolveCloudCoreConfig,
  type CloudCoreConfig,
} from "./app/config.js";
export type { CloudAppFailure, CloudAppResult, CloudAppSuccess } from "./app/result.js";
export { fail, ok } from "./app/result.js";

// ── app 用例类型（W5 路由/ W6 bridge 入站使用）──
export type { TaskService } from "./app/taskService.js";
export type { TaskDetailService } from "./app/taskDetail.js";
export type {
  CloudInputRequest,
  InputGateway,
  SubmitCloudInput,
} from "./app/inputDelivery/gateway.js";
export type {
  DispatchOutcome,
  DispatchReport,
  InputDispatcher,
} from "./app/inputDelivery/dispatcher.js";
export type { InputDeliveryControl } from "./app/inputDelivery/deliveryControl.js";
export type {
  AttachmentRegistry,
  AttachmentResolution,
  AttachmentSession,
} from "./app/attachments/registry.js";
export type { CloudCommandRouter } from "./app/attachments/router.js";
export type { HeartbeatWatchdog } from "./app/attachments/watchdog.js";
export type { RunOrchestrator } from "./app/runOrchestrator.js";
export type { RunCompensation, TerminationVerdict } from "./app/provisioning/compensation.js";
export type {
  CreateAttemptOutcome,
  CreateOperationRunner,
} from "./app/provisioning/createOperation.js";
export type { ReadinessWatchdog } from "./app/provisioning/readiness.js";
export type { CheckpointPipeline } from "./app/lifecycle/checkpoints.js";
export type { DrainLoop } from "./app/lifecycle/drain.js";
export type { KeepaliveLoop } from "./app/lifecycle/keepalive.js";
export type { StopOperations } from "./app/commands/stopOperations.js";
export type { ReopenOperations } from "./app/commands/reopenOperations.js";
export type {
  InteractionCommands,
  SubmitInteractionDecision,
} from "./app/commands/interactions.js";
export type { TaskLifecycleCommands } from "./app/commands/taskLifecycle.js";
export type { ProjectionHistoryService, ResumeDecision } from "./app/projections/history.js";
export type { ProjectionIngestService } from "./app/projections/ingest.js";
export type { StartupReconciler } from "./app/reconciler/startup.js";
export type {
  GitGrantPurpose,
  RunAuthorizationPolicy,
} from "./app/credentialAuthorization/authorization.js";
export { GIT_GRANT_TTL_MS } from "./app/credentialAuthorization/authorization.js";

// ── git grant 签发与兑换（01 §7.2；W1 新增）──
//
// 授权判定与签发时机在 app 层（`app/gitGrants.ts`），token 机制（mint / 单次兑换 CAS /
// TTL / 撤销）在 `GitGrantBrokerPort`（W4 broker）。入口的 git-grant 端点与 create/drain
// 路径都消费同一个 `CloudGitGrantService` 实例。
export {
  isRecoverableGitGrantFailure,
  type CloudGitGrantService,
  type GitGrantIssueResult,
} from "./app/gitGrants.js";
export type {
  GitGrantBrokerPort,
  GitGrantDenial,
  GitGrantDenyReason,
  GitGrantIssuance,
  GitGrantRedemption,
} from "./app/ports/gitGrantBrokerPort.js";
export {
  isSecretAllowed,
  rejectDisallowedSecrets,
  resolveRunSecretPolicy,
  type CloudDeploymentModel,
  type CloudSecretClass,
  type RunSecretPolicy,
} from "./app/credentialAuthorization/secretWhitelist.js";

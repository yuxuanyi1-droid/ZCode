/**
 * UI 侧的控制面端口（specs/cloud-agent/W8 §4「组件只经 hooks/service accessor 访问服务」）。
 *
 * UI **不导入 `@zcode/client`**：`packages/ui` 的依赖里没有该包，组件也不允许直连 SDK。
 * W9 在 `cloudApp.tsx` 用 `createCloudClient(...).controlPlane` 构造真实客户端，
 * 其方法签名与本端口结构一致，可直接注入。
 *
 * 端口只声明 UI 真正会调的方法：写操作的幂等键（`commandId` / `creationKey` /
 * `operationId`）一律由**调用方**给出，客户端不生成也不替换（03 §6.1/§6.2）。
 */
import type {
  CancelCloudInteractionDecisionRequest,
  CapabilitiesResponse,
  CloudAttachmentUploadResponse,
  CloudBranchPage,
  CloudDeletedResponse,
  CloudInteractionDecisionReceipt,
  CloudUserProfileCategory,
  CloudUserProfileEntryDeleteResponse,
  CloudUserProfileEntryReadResponse,
  CloudUserProfileEntryUploadRequest,
  CloudUserProfileEntryUploadResponse,
  CloudUserProfileSnapshot,
  CloudUserProfileSyncResponse,
  CloudHistoryPage,
  CloudHistoryQuery,
  CloudListQuery,
  CloudProjectPage,
  CloudProjectRecord,
  CloudProjectionSnapshot,
  CloudRepositoriesQuery,
  CloudRepositoryPage,
  CloudSnapshotQuery,
  CloudTaskEventsQuery,
  CloudTaskEventsResponse,
  CloudTaskPage,
  CloudTaskRecord,
  CreateCloudProjectRequest,
  CreateCloudTaskRequest,
  ForceStopCloudTaskRequest,
  InputReceipt,
  InputRecordPage,
  PatchCloudProjectRequest,
  PatchCloudTaskRequest,
  ReopenCloudTaskRequest,
  SubmitCloudInteractionDecisionRequest,
  SubmitTaskInput,
  TaskDetailResponse,
} from "@zcode/shared";

/** 单请求选项（与 SDK 的 `CloudRequestOptions` 结构一致）。 */
export interface CloudControlPlaneRequestOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
}

/**
 * 输入提交结果：`httpStatus` 是 HTTP 事实（202 = 控制面已持久接收），
 * `receipt` 是权威投递投影；**二者都不是 runtime ACK**（03 §6.2、02 §6.2 四类确认互不冒充）。
 */
export interface CloudControlPlaneInputSubmission {
  readonly httpStatus: number;
  readonly receipt: InputReceipt;
}

/**
 * 交互决定提交结果：`httpStatus` 是 HTTP 事实（202 = 持久接纳），
 * `receipt.deliveryStatus` 才是投递语义；admitted 才代表 runtime 已裁决（03 §7.2）。
 */
export interface CloudControlPlaneInteractionSubmission {
  readonly httpStatus: number;
  readonly receipt: CloudInteractionDecisionReceipt;
}

export interface CloudControlPlanePort {
  readonly origin: string;

  getCapabilities(options?: CloudControlPlaneRequestOptions): Promise<CapabilitiesResponse>;

  listRepositories(
    query?: CloudRepositoriesQuery,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudRepositoryPage>;
  listRepositoryBranches(
    repositoryId: number,
    query?: CloudListQuery,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudBranchPage>;

  listProjects(
    query?: CloudListQuery,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudProjectPage>;
  createProject(
    body: CreateCloudProjectRequest,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudProjectRecord>;
  patchProject(
    projectId: string,
    body: PatchCloudProjectRequest,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudProjectRecord>;
  deleteProject(
    projectId: string,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudDeletedResponse>;
  listProjectTasks(
    projectId: string,
    query?: CloudListQuery,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudTaskPage>;

  createTask(
    body: CreateCloudTaskRequest,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudTaskRecord>;
  getTask(taskId: string, options?: CloudControlPlaneRequestOptions): Promise<TaskDetailResponse>;
  patchTask(
    taskId: string,
    body: PatchCloudTaskRequest,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudTaskRecord>;

  submitInput(
    taskId: string,
    body: SubmitTaskInput,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudControlPlaneInputSubmission>;
  listInputs(
    taskId: string,
    query?: CloudListQuery,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<InputRecordPage>;
  getInput(
    taskId: string,
    commandId: string,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<InputReceipt>;
  cancelInput(
    taskId: string,
    commandId: string,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<InputReceipt>;

  /** 提交审批/交互决定：云模式唯一写通路（03 §7.2；不再直发 agent 写命令）。 */
  submitCloudInteractionDecision(
    taskId: string,
    interactionId: string,
    body: SubmitCloudInteractionDecisionRequest,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudControlPlaneInteractionSubmission>;
  /** 取消已提交决定：独立 cancelCommandId，不覆盖原决定记录（02 §6.3）。 */
  cancelCloudInteractionDecision(
    taskId: string,
    interactionId: string,
    body: CancelCloudInteractionDecisionRequest,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudInteractionDecisionReceipt>;
  /** 只读回执查询（响应丢失/重启恢复）：不产生第二份状态。 */
  getCloudInteractionDecision(
    taskId: string,
    interactionId: string,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudInteractionDecisionReceipt>;

  reopenTask(
    taskId: string,
    body: ReopenCloudTaskRequest,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<TaskDetailResponse>;
  stopTask(taskId: string, options?: CloudControlPlaneRequestOptions): Promise<TaskDetailResponse>;
  /**
   * force-stop（03 §6、08 §8.2；2026-10-08 巡检修订 P1）：显式丢失确认的独立端点，
   * body 必须携带 `lossAcknowledgement: true` + `expectedRevision` + `operationId`
   * （shared `forceStopCloudTaskRequestSchema`），普通 stop 失败不得自动升级到这里。
   */
  forceStopTask(
    taskId: string,
    body: ForceStopCloudTaskRequest,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<TaskDetailResponse>;
  completeTask(
    taskId: string,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<TaskDetailResponse>;
  archiveTask(
    taskId: string,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<TaskDetailResponse>;
  restoreTask(
    taskId: string,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<TaskDetailResponse>;

  getTaskHistory(
    taskId: string,
    query?: CloudHistoryQuery,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudHistoryPage>;
  getTaskEvents(
    taskId: string,
    query?: CloudTaskEventsQuery,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudTaskEventsResponse>;
  getTaskSnapshot(
    taskId: string,
    query?: CloudSnapshotQuery,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudProjectionSnapshot>;

  /** task-owned 上传；部署未支持时返回 `not_configured`（03 §6、11 §9）。 */
  uploadAttachment(
    file: Blob,
    options?: CloudControlPlaneRequestOptions & { readonly taskId?: string | undefined },
  ): Promise<CloudAttachmentUploadResponse>;

  // ── 用户资源 profile（M8；14 §9.2⑦/§9.4；W11 §12）──
  // UI 只声明真正会调的方法：快照（列表 + 版本）、单条回显（编辑）、PUT（上传/替换）、
  // DELETE（删除）、PATCH（条目开关）。`GET …/version` 不在 UI 使用面内（版本随快照与每次
  // 写的响应一起回来，多一个取数点等于多一条可漂移的路径）。

  /** 快照摘要（条目元数据 + `profileVersion` + `totalBytes` + `createdAtMs`）：无正文。 */
  listUserProfile(options?: CloudControlPlaneRequestOptions): Promise<CloudUserProfileSnapshot>;
  /**
   * 读**单个**条目元数据 + 正文（14 §9.4①）：AGENTS.md 编辑器与 MCP 表单回显的唯一通路；
   * 键不存在时抛 `not_found`。
   */
  getUserProfileEntry(
    category: CloudUserProfileCategory,
    entryId: string,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudUserProfileEntryReadResponse>;
  /**
   * 幂等整条替换：负载 + 可选 `displayName`/`enabled`（省略 `enabled` 时服务端按 true 归一，
   * 因此「保留现有开关」必须显式传当前值，14 §9.4①）。
   */
  putUserProfileEntry(
    category: CloudUserProfileCategory,
    entryId: string,
    body: CloudUserProfileEntryUploadRequest,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudUserProfileEntryUploadResponse>;
  /** 删除条目；键不存在时服务端幂等无操作（版本不变）。 */
  deleteUserProfileEntry(
    category: CloudUserProfileCategory,
    entryId: string,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudUserProfileEntryDeleteResponse>;
  /** 条目级开关（PATCH，body 只含 `{enabled}`）；开关值变化才递增版本。 */
  setUserProfileEntryEnabled(
    category: CloudUserProfileCategory,
    entryId: string,
    enabled: boolean,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudUserProfileEntryUploadResponse>;
  /**
   * 手动同步一次**最新** profile 到该 Task 当前 Run 的沙箱（14 §4.6；B 批端点
   * `POST /api/cloud/tasks/:taskId/user-profile-sync`，响应 = 本次逐条结果 +
   * 承载本次同步的真实 `trigger`）。
   *
   * 门控在服务端：未连接 → 409 `not_ready`(reason `run-not-connected`)、终态 →
   * 409 `not_ready`(reason `run-terminal`)；UI 的"未连接不显示入口"只是双保险，
   * 不是权限边界。
   */
  syncTaskUserProfile(
    taskId: string,
    options?: CloudControlPlaneRequestOptions,
  ): Promise<CloudUserProfileSyncResponse>;
}

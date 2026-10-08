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
  CapabilitiesResponse,
  CloudAttachmentUploadResponse,
  CloudBranchPage,
  CloudDeletedResponse,
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
}

/**
 * Cloud 控制面客户端（specs/cloud-agent/03 §6 HTTP API、§6.1 fingerprint、§6.2 投递与响应、04 §6 API 映射）。
 *
 * 只做「类型化传输」：把调用转成冻结端点 + 冻结 schema 的请求/响应，不缓存 Task/Run 权威事实，
 * 也不把 receipt 当 runtime ACK（03 §6.2、02 §6.2）。
 *
 * 幂等约定（03 §6.1/§6.2）：所有写操作的身份由调用方给出——`commandId`（输入、重开）、
 * `creationKey`（Project/Task 创建）、`operationId`（force-stop）。SDK 不生成也不替换这些 key，
 * 因此「同 commandId 重试」= 用同一入参再次调用同一方法；服务端按 fingerprint 返回原 receipt，
 * 不同 payload 返回 `idempotency_conflict`（409）。
 */
import { CLOUD_ATTACHMENT_UPLOAD_FORM } from "@zcode/shared";
import type {
  CancelCloudInteractionDecisionRequest,
  CapabilitiesResponse,
  CloudAttachmentUploadResponse,
  CloudBranchPage,
  CloudDeletedResponse,
  CloudExtensionResponse,
  CloudHistoryPage,
  CloudHistoryQuery,
  CloudInteractionDecisionReceipt,
  CloudListQuery,
  CloudProjectPage,
  CloudProjectionSnapshot,
  CloudProjectRecord,
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
import { CloudResyncRequiredError, cloudValidationError } from "./cloudApiError.js";
import type { CloudHttpTransport } from "./cloudHttpTransport.js";
import type { CloudInputSubmission, CloudInteractionDecisionSubmission } from "./cloudReceipts.js";
import {
  CLOUD_EVENTS_TIMEOUT_GRACE_MS,
  type CloudRequestOptions,
  type CloudUploadAttachmentOptions,
} from "./cloudRequestTypes.js";
import type { CloudUserProfileControlPlaneClient } from "./cloudUserProfileControlPlaneContract.js";

export { isRuntimeAckPending, isRuntimeAdmitted } from "./cloudReceipts.js";
export type { CloudInputSubmission, CloudInteractionDecisionSubmission } from "./cloudReceipts.js";
export { CLOUD_EVENTS_TIMEOUT_GRACE_MS } from "./cloudRequestTypes.js";
export type { CloudRequestOptions, CloudUploadAttachmentOptions } from "./cloudRequestTypes.js";
export type { CloudUserProfileControlPlaneClient } from "./cloudUserProfileControlPlaneContract.js";
import {
  CLOUD_SDK_QUERY_SCHEMAS,
  assertSupportedCloudProtocolVersion,
  parseCloudValue,
  parseCloudRequestBody,
  type CloudEndpointResponse,
  type CloudSdkEndpointId,
  type CloudSdkQuery,
  type CloudWriteEndpointId,
} from "./cloudWireSchemas.js";

// 分页响应类型直接取 shared 冻结的类型别名（W7 CR-6），SDK 不自行推导字段名。
export type {
  CloudBranchPage,
  CloudProjectPage,
  CloudRepositoryPage,
  CloudTaskPage,
} from "@zcode/shared";

export interface CloudControlPlaneClient extends CloudUserProfileControlPlaneClient {
  readonly origin: string;
  getCapabilities(options?: CloudRequestOptions): Promise<CapabilitiesResponse>;
  listRepositories(
    query?: CloudRepositoriesQuery,
    options?: CloudRequestOptions,
  ): Promise<CloudRepositoryPage>;
  listRepositoryBranches(
    repositoryId: number,
    query?: CloudListQuery,
    options?: CloudRequestOptions,
  ): Promise<CloudBranchPage>;
  listProjects(query?: CloudListQuery, options?: CloudRequestOptions): Promise<CloudProjectPage>;
  createProject(
    body: CreateCloudProjectRequest,
    options?: CloudRequestOptions,
  ): Promise<CloudProjectRecord>;
  patchProject(
    projectId: string,
    body: PatchCloudProjectRequest,
    options?: CloudRequestOptions,
  ): Promise<CloudProjectRecord>;
  deleteProject(projectId: string, options?: CloudRequestOptions): Promise<CloudDeletedResponse>;
  listProjectTasks(
    projectId: string,
    query?: CloudListQuery,
    options?: CloudRequestOptions,
  ): Promise<CloudTaskPage>;
  createTask(body: CreateCloudTaskRequest, options?: CloudRequestOptions): Promise<CloudTaskRecord>;
  getTask(taskId: string, options?: CloudRequestOptions): Promise<TaskDetailResponse>;
  patchTask(
    taskId: string,
    body: PatchCloudTaskRequest,
    options?: CloudRequestOptions,
  ): Promise<CloudTaskRecord>;
  submitInput(
    taskId: string,
    body: SubmitTaskInput,
    options?: CloudRequestOptions,
  ): Promise<CloudInputSubmission>;
  listInputs(
    taskId: string,
    query?: CloudListQuery,
    options?: CloudRequestOptions,
  ): Promise<InputRecordPage>;
  getInput(taskId: string, commandId: string, options?: CloudRequestOptions): Promise<InputReceipt>;
  cancelInput(
    taskId: string,
    commandId: string,
    options?: CloudRequestOptions,
  ): Promise<InputReceipt>;
  submitCloudInteractionDecision(
    taskId: string,
    interactionId: string,
    body: SubmitCloudInteractionDecisionRequest,
    options?: CloudRequestOptions,
  ): Promise<CloudInteractionDecisionSubmission>;
  cancelCloudInteractionDecision(
    taskId: string,
    interactionId: string,
    body: CancelCloudInteractionDecisionRequest,
    options?: CloudRequestOptions,
  ): Promise<CloudInteractionDecisionReceipt>;
  getCloudInteractionDecision(
    taskId: string,
    interactionId: string,
    options?: CloudRequestOptions,
  ): Promise<CloudInteractionDecisionReceipt>;
  reopenTask(
    taskId: string,
    body: ReopenCloudTaskRequest,
    options?: CloudRequestOptions,
  ): Promise<TaskDetailResponse>;
  stopTask(taskId: string, options?: CloudRequestOptions): Promise<TaskDetailResponse>;
  forceStopTask(
    taskId: string,
    body: ForceStopCloudTaskRequest,
    options?: CloudRequestOptions,
  ): Promise<TaskDetailResponse>;
  extendTask(taskId: string, options?: CloudRequestOptions): Promise<CloudExtensionResponse>;
  completeTask(taskId: string, options?: CloudRequestOptions): Promise<TaskDetailResponse>;
  archiveTask(taskId: string, options?: CloudRequestOptions): Promise<TaskDetailResponse>;
  reactivateTask(taskId: string, options?: CloudRequestOptions): Promise<TaskDetailResponse>;
  restoreTask(taskId: string, options?: CloudRequestOptions): Promise<TaskDetailResponse>;
  /** 历史读取：cursor 越出保留窗时抛 `CloudResyncRequiredError`，不静默从零猜测（03 §9）。 */
  getTaskHistory(
    taskId: string,
    query?: CloudHistoryQuery,
    options?: CloudRequestOptions,
  ): Promise<CloudHistoryPage>;
  /** 增量提示（有界长轮询）：`timedOut=true` 表示窗口内无新记录，不是错误。 */
  getTaskEvents(
    taskId: string,
    query?: CloudTaskEventsQuery,
    options?: CloudRequestOptions,
  ): Promise<CloudTaskEventsResponse>;
  getTaskSnapshot(
    taskId: string,
    query?: CloudSnapshotQuery,
    options?: CloudRequestOptions,
  ): Promise<CloudProjectionSnapshot>;
  /**
   * 附件上传：multipart 体由 SDK 按 shared `CLOUD_ATTACHMENT_UPLOAD_FORM` 组装
   * （单文件字段 + 可选 taskId），调用方不接触字段名。
   */
  uploadAttachment(
    file: Blob,
    options?: CloudUploadAttachmentOptions,
  ): Promise<CloudAttachmentUploadResponse>;
}

export function createCloudControlPlaneClient(
  transport: CloudHttpTransport,
): CloudControlPlaneClient {
  async function read<K extends CloudSdkEndpointId>(
    endpointId: K,
    pathParams: Readonly<Record<string, string | number>> | undefined,
    query: Readonly<Record<string, string | number | boolean | undefined>> | undefined,
    options: CloudRequestOptions | undefined,
  ): Promise<CloudEndpointResponse<K>> {
    const response = await transport.request({
      endpointId,
      ...(pathParams === undefined ? {} : { pathParams }),
      ...(query === undefined ? {} : { query }),
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return response.data;
  }

  async function write<K extends CloudWriteEndpointId>(
    endpointId: K,
    pathParams: Readonly<Record<string, string | number>> | undefined,
    body: unknown,
    options: CloudRequestOptions | undefined,
  ): Promise<CloudEndpointResponse<K>> {
    const parsed = parseCloudRequestBody(endpointId, body);
    const response = await transport.request({
      endpointId,
      ...(pathParams === undefined ? {} : { pathParams }),
      json: parsed,
      ...(options?.signal === undefined ? {} : { signal: options.signal }),
      ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    return response.data;
  }

  /** 无请求体的动作端点按冻结 `cloudEmptyBodySchema` 发送空对象，不发明第二种形状。 */
  async function act<K extends CloudWriteEndpointId>(
    endpointId: K,
    taskId: string,
    options: CloudRequestOptions | undefined,
  ): Promise<CloudEndpointResponse<K>> {
    return write(endpointId, { taskId }, {}, options);
  }

  /** 只接受冻结的 query schema；非法参数在发出请求前拒绝（返回 rejected promise，不抛同步错）。 */
  function queryFor<K extends keyof CloudSdkQuery>(
    key: K,
    query: CloudSdkQuery[K] | undefined,
  ): CloudSdkQuery[K] | undefined {
    return query === undefined
      ? undefined
      : parseCloudValue(CLOUD_SDK_QUERY_SCHEMAS[key], query, key);
  }

  return {
    origin: transport.origin,

    async getCapabilities(options) {
      const capabilities = await read("capabilities", undefined, undefined, options);
      // 协议版本不匹配时拒绝而不是猜测（00 §8、shared capabilitiesResponseSchema）。
      assertSupportedCloudProtocolVersion(capabilities.protocolVersion);
      return capabilities;
    },

    async listRepositories(query, options) {
      return read("repositories", undefined, queryFor("repositories", query), options);
    },

    async listRepositoryBranches(repositoryId, query, options) {
      return read("repositoryBranches", { repoId: repositoryId }, queryFor("list", query), options);
    },

    async listProjects(query, options) {
      return read("listProjects", undefined, queryFor("list", query), options);
    },

    async createProject(body, options) {
      return write("createProject", undefined, body, options);
    },

    async patchProject(projectId, body, options) {
      return write("patchProject", { projectId }, body, options);
    },

    async deleteProject(projectId, options) {
      return read("deleteProject", { projectId }, undefined, options);
    },

    async listProjectTasks(projectId, query, options) {
      return read("projectTasks", { projectId }, queryFor("list", query), options);
    },

    async createTask(body, options) {
      return write("createTask", undefined, body, options);
    },

    async getTask(taskId, options) {
      return read("taskDetail", { taskId }, undefined, options);
    },

    async patchTask(taskId, body, options) {
      return write("patchTask", { taskId }, body, options);
    },

    async submitInput(taskId, body, options) {
      const response = await transport.request({
        endpointId: "submitInput",
        pathParams: { taskId },
        json: parseCloudRequestBody("submitInput", body),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      return { httpStatus: response.status, receipt: response.data };
    },

    async listInputs(taskId, query, options) {
      return read("listInputs", { taskId }, queryFor("list", query), options);
    },

    async getInput(taskId, commandId, options) {
      return read("getInput", { taskId, commandId }, undefined, options);
    },

    async cancelInput(taskId, commandId, options) {
      return write("cancelInput", { taskId, commandId }, {}, options);
    },

    async submitCloudInteractionDecision(taskId, interactionId, body, options) {
      const response = await transport.request({
        endpointId: "submitInteractionDecision",
        pathParams: { taskId, interactionId },
        json: parseCloudRequestBody("submitInteractionDecision", body),
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      });
      return { httpStatus: response.status, receipt: response.data };
    },
    async cancelCloudInteractionDecision(taskId, interactionId, body, options) {
      return write("cancelInteractionDecision", { taskId, interactionId }, body, options);
    },
    async getCloudInteractionDecision(taskId, interactionId, options) {
      return read("getInteractionDecision", { taskId, interactionId }, undefined, options);
    },

    async reopenTask(taskId, body, options) {
      return write("reopenTask", { taskId }, body, options);
    },

    async stopTask(taskId, options) {
      return act("stopTask", taskId, options);
    },

    async forceStopTask(taskId, body, options) {
      return write("forceStopTask", { taskId }, body, options);
    },

    async extendTask(taskId, options) {
      return act("extendTask", taskId, options);
    },

    async completeTask(taskId, options) {
      return act("completeTask", taskId, options);
    },

    async archiveTask(taskId, options) {
      return act("archiveTask", taskId, options);
    },

    async reactivateTask(taskId, options) {
      return act("reactivateTask", taskId, options);
    },

    async restoreTask(taskId, options) {
      return act("restoreTask", taskId, options);
    },

    async getTaskHistory(taskId, query, options) {
      const parsed = queryFor("history", query);
      const page = await read("taskHistory", { taskId }, parsed, options);
      // 越出保留窗：显式上抛，调用方必须改读 snapshot（03 §9）。
      if (page.resyncRequired === true) {
        throw new CloudResyncRequiredError({
          reason: "retention-window",
          ...(parsed?.topic === undefined ? {} : { topic: parsed.topic }),
        });
      }
      return page;
    },

    async getTaskEvents(taskId, query, options) {
      const parsed = queryFor("events", query);
      // 长轮询必须让传输超时大于服务端等待窗口，否则会把正常等待误判成传输超时。
      const timeoutMs =
        options?.timeoutMs ??
        (parsed?.waitMs === undefined ? undefined : parsed.waitMs + CLOUD_EVENTS_TIMEOUT_GRACE_MS);
      return read("taskEvents", { taskId }, parsed, {
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
    },

    async getTaskSnapshot(taskId, query, options) {
      return read("taskSnapshot", { taskId }, queryFor("snapshot", query), options);
    },

    uploadAttachment(file, options) {
      const form = new FormData();
      form.append(CLOUD_ATTACHMENT_UPLOAD_FORM.fileField, file);
      if (options?.taskId !== undefined) {
        form.append(CLOUD_ATTACHMENT_UPLOAD_FORM.taskIdField, options.taskId);
      }
      return transport
        .request({
          endpointId: "uploadAttachment",
          body: form,
          ...(options?.signal === undefined ? {} : { signal: options.signal }),
          ...(options?.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
        })
        .then((response) => response.data);
    },

    async listUserProfile(options) {
      return read("userProfile", undefined, undefined, options);
    },

    async getUserProfileVersion(options) {
      return read("userProfileVersion", undefined, undefined, options);
    },

    async putUserProfileEntry(category, entryId, body, options) {
      if (body.category !== category) {
        // 路径与正文的 category 必须一致（14 §9.2⑦）：本地先拒绝，不把矛盾发到线上。
        throw cloudValidationError(
          "cloud user profile entry body category must match the path category",
          { endpointId: "putUserProfileEntry", category, bodyCategory: body.category },
        );
      }
      return write("putUserProfileEntry", { category, entryId }, body, options);
    },

    async deleteUserProfileEntry(category, entryId, options) {
      return read("deleteUserProfileEntry", { category, entryId }, undefined, options);
    },

    async getUserProfileEntry(category, entryId, options) {
      return read("readUserProfileEntry", { category, entryId }, undefined, options);
    },

    async setUserProfileEntryEnabled(category, entryId, enabled, options) {
      // body 只含 enabled：toggle 不重发正文（重发会让 sha256 依赖客户端缓存，14 §9.4①）。
      return write("patchUserProfileEntryEnabled", { category, entryId }, { enabled }, options);
    },

    async syncTaskUserProfile(taskId, options) {
      // 无请求体的 task-scoped 动作端点：按冻结 `cloudEmptyBodySchema` 发空对象。
      return act("syncTaskUserProfile", taskId, options);
    },
  };
}

/**
 * 云 hooks 公开入口（specs/cloud-agent/W8 §3/§4）。
 *
 * 组件只经这些 hooks 访问云服务：不直连 Repo/SDK、不调 `window.zcode`
 * （AGENTS「UI 与平台边界」、W8 §4）。
 */
export {
  useCloudComposerSubmit,
  type CloudComposerSubmitResult,
  type UseCloudComposerSubmitResult,
} from "./useCloudComposerSubmit.js";
export {
  useCloudCapabilities,
  type UseCloudCapabilitiesOptions,
  type UseCloudCapabilitiesResult,
} from "./useCloudCapabilities.js";
export {
  useCloudProjects,
  type UseCloudProjectsOptions,
  type UseCloudProjectsResult,
} from "./useCloudProjects.js";
export {
  useCloudTasks,
  type UseCloudTasksOptions,
  type UseCloudTasksResult,
} from "./useCloudTasks.js";
export { useCloudTask, type UseCloudTaskOptions, type UseCloudTaskResult } from "./useCloudTask.js";
export {
  useCloudTaskHistory,
  type UseCloudTaskHistoryOptions,
  type UseCloudTaskHistoryResult,
} from "./useCloudTaskHistory.js";
export {
  useCloudRepositories,
  type CloudRepositoryBlockingReason,
  type UseCloudRepositoriesOptions,
  type UseCloudRepositoriesResult,
} from "./useCloudRepositories.js";
export {
  createCloudCommandId,
  useSubmitCloudInput,
  type SubmitAppendInputArgs,
  type SubmitFirstInputArgs,
  type UseSubmitCloudInputOptions,
  type UseSubmitCloudInputResult,
} from "./useSubmitCloudInput.js";
export { useCloudAttachmentGate } from "./useCloudAttachmentGate.js";
export {
  useCancelCloudInput,
  type UseCancelCloudInputOptions,
  type UseCancelCloudInputResult,
} from "./useCancelCloudInput.js";
export {
  useReopenCloudTask,
  type ReopenCloudTaskArgs,
  type UseReopenCloudTaskOptions,
  type UseReopenCloudTaskResult,
} from "./useReopenCloudTask.js";
export {
  useCloudWorkspaceController,
  type CloudAttachmentStatus,
  type CloudWorkspaceControllerValue,
  type UseCloudWorkspaceControllerOptions,
} from "./useCloudWorkspaceController.js";
export { useCloudWorkspaceServices } from "./useCloudWorkspaceServices.js";

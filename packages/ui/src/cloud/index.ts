/**
 * 云 UI 公开入口（specs/cloud-agent/W8 §4「对外接口」）。
 *
 * W9 的 `cloudApp.tsx` 只从这里取：
 * - `CloudWorkspaceProvider` / `CloudServicesProvider`
 * - `createCloudBrowserServices`
 * - 端口类型（`CloudControlPlanePort` / `CloudAttachmentProvider`）
 * 组件侧一律经 `packages/ui/src/hooks/cloud` 的 hooks 消费，不直接引用本目录实现细节。
 */
export {
  CLOUD_EXECUTION_SERVICE_BINDINGS,
  CLOUD_HOST_CHANNEL_ENDPOINT,
  CLOUD_TASK_ATTACHMENT_ENDPOINT,
  assertCloudExecutionBindingsMatchAllowlist,
  describeCloudExecutionTargets,
  describeCloudHostTargets,
  describeCloudServiceTargets,
  isCloudExecutionServiceKey,
  type CloudExecutionScope,
  type CloudServiceScope,
  type CloudServiceTargetDescriptor,
} from "./cloudServiceScope.js";
export {
  createUnavailableServiceAccessor,
  getCloudAttachmentUnavailableServices,
  isCloudServiceUnavailableError,
  CLOUD_ATTACHMENT_UNAVAILABLE_CODE,
  CloudServiceUnavailableError,
  type UnavailableServiceAccessorOptions,
} from "./unavailableServiceAccessor.js";
export {
  createCloudBrowserServices,
  selectCloudAttachmentForTask,
  type CloudAttachmentAccessor,
  type CloudBrowserServices,
  type CloudBrowserServicesOptions,
} from "./cloudBrowserServices.js";
export {
  CloudServicesProvider,
  useCloudExecutionScope,
  useCloudServicesScope,
  type CloudServicesProviderProps,
  type CloudServicesScopeValue,
} from "./CloudServicesProvider.js";
export {
  CloudWorkspaceContextProvider,
  useCloudDraftScope,
  useCloudWorkspaceContext,
  type CloudCapabilitiesStatus,
  type CloudWorkspaceContextValue,
  type CloudWorkspaceSelection,
} from "./cloudWorkspaceContext.js";
export {
  CloudWorkspaceProvider,
  type CloudWorkspaceProviderProps,
} from "./CloudWorkspaceProvider.js";
export {
  CLOUD_TASK_ROUTE_PARAM,
  CloudBootstrapError,
  normalizeCloudControlPlaneOrigin,
  openCloudTaskRoute,
  parseCloudUiBootstrap,
  readCloudTaskIdFromSearch,
  resolveCloudTaskIdFromWorkspaceIdentity,
  withCloudTaskSearch,
  type CloudUiBootstrap,
} from "./cloudUiBootstrap.js";
export {
  CLOUD_ATTACHMENT_MESSAGE_IDS,
  describeCloudLocalPathStaging,
  resolveCloudAttachmentGate,
  type CloudAttachmentGate,
  type CloudAttachmentGateInput,
  type CloudAttachmentGateReason,
} from "./cloudAttachmentGate.js";
export {
  buildCloudTaskTabTarget,
  findCloudTaskTabIndex,
  isCloudTaskTab,
  type CloudTaskTabTarget,
} from "./cloudTaskTab.js";
export {
  buildCloudDraftScope,
  cloudDraftScopePrincipalPrefix,
  createCloudCreationKey,
  isSameCloudDraftScope,
  parseCloudDraftScopeKey,
  type CloudDraftScope,
  type CloudDraftScopeInput,
} from "./cloudDraftScope.js";
export { readCloudTaskActions, type CloudTaskActionSet } from "./cloudTaskActionsProjection.js";
export {
  CLOUD_TASK_RUN_WATCH_INTERVAL_MS,
  CLOUD_TASK_RUN_WATCH_TIMEOUT_MS,
  shouldContinueCloudTaskRunWatch,
  startCloudTaskRunWatch,
  type CloudTaskRunWatchDeps,
  type CloudTaskRunWatchDetail,
  type CloudTaskRunWatchHandle,
} from "./cloudTaskRunWatch.js";
export {
  isCloudTaskArchiveActionAvailable,
  projectCloudTaskRunPanel,
  resolveCloudReopenPlan,
  type CloudReopenPlan,
  type CloudTaskPanelDetail,
  type CloudTaskRunPanelView,
} from "./cloudTaskPanel.js";
export {
  runCloudTaskLifecycleAction,
  type CloudTaskLifecycleAction,
  type CloudTaskLifecyclePort,
} from "./cloudTaskLifecycle.js";
export { projectCloudTasksForSidebar, sortCloudTasksForSidebar } from "./cloudSidebarTaskList.js";
export {
  resolveCloudTaskRouteFailure,
  type CloudTaskRouteFailure,
  type CloudTaskRouteFailureInput,
  type CloudTaskRouteFailureReason,
} from "./cloudTaskRoute.js";
export type {
  CloudControlPlaneInputSubmission,
  CloudControlPlanePort,
  CloudControlPlaneRequestOptions,
} from "./cloudPorts.js";
export type { CloudAttachmentProvider } from "./cloudAttachmentProvider.js";
export {
  describeCloudSubmissionError,
  reconcileCloudTaskInput,
  submitCloudTaskInput,
  type CloudSubmissionOutcome,
  type CloudTaskSubmissionDeps,
} from "./cloudTaskSubmission.js";
export {
  isCloudApiErrorLike,
  isCloudApiErrorRetryable,
  isCloudResyncRequiredError,
  readCloudErrorCode,
  type CloudApiErrorLike,
} from "./cloudApiErrorLike.js";

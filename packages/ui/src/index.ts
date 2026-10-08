export { App } from "./App.js";
export { AppErrorBoundary, ScopedErrorBoundary } from "./ErrorBoundary.js";
export type { ScopedErrorBoundaryVariant } from "./ErrorBoundary.js";
export { Button, buttonVariants } from "./components/ui/button.js";
export { DesktopWindowFrame } from "./DesktopWindowFrame.js";
export {
  AssistantCodeCommentFeatureProvider,
  useAssistantCodeCommentFeatureEnabled,
} from "./AssistantCodeCommentFeatureProvider.js";
export { Root } from "./Root.js";
export { UpdateStatusWindowRoot } from "./UpdateStatusWindowRoot.js";
export { ConfirmDialogHost } from "./ConfirmDialog.js";
export { Terminal } from "./Terminal.js";
export { GitGraphPane } from "./git-graph/GitGraphPane.js";
export { layoutGitGraph } from "./git-graph/layout.js";
export type {
  GitGraphCommit,
  GitGraphLayout,
  GitGraphLayoutEdge,
  GitGraphLayoutOptions,
  GitGraphLayoutRow,
  GitGraphRef,
  GitGraphRefKind,
} from "./git-graph/layout.js";
export { SSHDialog, RemoteConnectionDialog } from "./SSHDialog.js";
export { useTheme } from "./useTheme.js";
export type { Theme } from "./useTheme.js";
export { useTestActions } from "./test-actions.js";
export type { TestActions } from "./test-actions.js";
export { StoreProvider, useZCodeStore } from "./store/StoreProvider.js";
export type { ZCodeState } from "./store/index.js";
export {
  bindRemoteWorkspacePath,
  getRemoteWorkspaceSession,
  registerBaseWorkspaceServices,
  registerRemoteWorkspaceSession,
  unbindRemoteWorkspacePath,
  unregisterRemoteWorkspaceSession,
  useRemoteWorkspaceSessionStore,
} from "./store/remoteWorkspaceSessionStore.js";
export {
  REMOTE_WORKSPACE_DISCONNECTED_ERROR_CODE,
  createRemoteWorkspaceDisconnectedError,
} from "./lib/remoteWorkspaceServiceError.js";

// Hooks —— 统一的服务和平台操作访问层
export {
  ServiceProvider,
  useServices,
  useWorkspaceServices,
  PlatformProvider,
  usePlatform,
  useSelectDirectory,
  useConnectRemote,
  useReaddir,
  useSystemInfo,
  useIntranetProbe,
  useTerminal,
  useSettings,
  useRecentProjects,
  useConfirmDialog,
  useCredentials,
  useAuthToken,
  useGitRepository,
  useGitActions,
} from "./hooks/index.js";

export { ZCodeIntlProvider, useZCodeIntl, LocaleSwitcher } from "./i18n/index.js";
export { ResourceManagerApp } from "./resource-manager/ResourceManagerApp.js";
export type {
  ResourceManagerAppProps,
  ResourceManagerTab,
} from "./resource-manager/ResourceManagerApp.js";
export type { IntlInstance } from "./i18n/index.js";
export {
  FileDisplayInline,
  createFileDisplayDom,
  getFileDisplayPath,
  resolveFileDisplayDescriptor,
  setDefaultFileDisplayBasePath,
} from "./lib/fileDisplay.js";
export type { FileDisplayDescriptor, FileDisplayOptions } from "./lib/fileDisplay.js";
export { playTaskNotificationSound } from "./lib/taskNotificationSound.js";
export {
  applyUiFontSizePx,
  loadUiFontSizePx,
  subscribeToUiFontSizeStorageChanges,
} from "./lib/uiFontSize.js";
export { reportUiLaunchToInput } from "./lib/uiPerfArmsTelemetry.js";
export {
  RendererUserActionTelemetry,
  runUserAction,
  runUserActionAsync,
  setUserActionTelemetry,
  startUserAction,
} from "./lib/userActionTelemetry.js";
export {
  CORE_USER_ACTION_FEATURES,
  SETTINGS_USER_ACTION_FEATURES,
  USER_ACTION_CATALOG,
} from "./lib/userActionTraceCatalog.js";
export { setReactErrorArmsReporter } from "./lib/reactErrorArmsTelemetry.js";
export { recordArmsCustomEventForE2E } from "./lib/armsCustomEventObservability.js";
export { generateMobileDeviceFingerprint, setStreamClientId } from "./lib/streamClientId.js";
export { GlobalDatabaseStartupLoading } from "./root/GlobalDatabaseStartupLoading.js";

export { LocalTtftObserver, setLocalTtftObserver } from "@/v4/telemetry/localTtftObserver.js";

// ── Cloud（specs/cloud-agent/W8 §4：对 W9 的公开入口）──
//
// 追加导出，不改动任何既有导出。W9 的 `cloudUi.ts` / `cloudApp.tsx` 只经这里接线：
// Provider、服务作用域合成、控制面端口类型、hooks 与投影 store。
export {
  CloudServicesProvider,
  CloudWorkspaceProvider,
  useCloudExecutionScope,
  useCloudServicesScope,
  useCloudDraftScope,
  useCloudWorkspaceContext,
  createCloudBrowserServices,
  selectCloudAttachmentForTask,
  CLOUD_ATTACHMENT_MESSAGE_IDS,
  describeCloudLocalPathStaging,
  resolveCloudAttachmentGate,
  createUnavailableServiceAccessor,
  getCloudAttachmentUnavailableServices,
  isCloudServiceUnavailableError,
  CLOUD_ATTACHMENT_UNAVAILABLE_CODE,
  CloudServiceUnavailableError,
  CLOUD_EXECUTION_SERVICE_BINDINGS,
  CLOUD_HOST_CHANNEL_ENDPOINT,
  CLOUD_TASK_ATTACHMENT_ENDPOINT,
  CLOUD_TASK_ROUTE_PARAM,
  CloudBootstrapError,
  assertCloudExecutionBindingsMatchAllowlist,
  describeCloudExecutionTargets,
  describeCloudHostTargets,
  describeCloudServiceTargets,
  describeCloudSubmissionError,
  buildCloudDraftScope,
  buildCloudTaskTabTarget,
  cloudDraftScopePrincipalPrefix,
  findCloudTaskTabIndex,
  isCloudTaskTab,
  isSameCloudDraftScope,
  parseCloudDraftScopeKey,
  createCloudCreationKey,
  isCloudExecutionServiceKey,
  isCloudApiErrorLike,
  isCloudApiErrorRetryable,
  isCloudResyncRequiredError,
  readCloudErrorCode,
  readCloudTaskActions,
  readCloudTaskIdFromSearch,
  resolveCloudTaskIdFromWorkspaceIdentity,
  resolveCloudTaskRouteFailure,
  normalizeCloudControlPlaneOrigin,
  openCloudTaskRoute,
  parseCloudUiBootstrap,
  withCloudTaskSearch,
  reconcileCloudTaskInput,
  submitCloudTaskInput,
} from "./cloud/index.js";
export type {
  CloudApiErrorLike,
  CloudAttachmentGate,
  CloudAttachmentGateInput,
  CloudAttachmentGateReason,
  CloudTaskTabTarget,
  CloudAttachmentAccessor,
  CloudAttachmentProvider,
  CloudBrowserServices,
  CloudBrowserServicesOptions,
  CloudBootstrapError as CloudBootstrapErrorType,
  CloudCapabilitiesStatus,
  CloudControlPlaneInputSubmission,
  CloudControlPlanePort,
  CloudControlPlaneRequestOptions,
  CloudDraftScope,
  CloudDraftScopeInput,
  CloudExecutionScope,
  CloudServiceScope,
  CloudServiceTargetDescriptor,
  CloudServicesProviderProps,
  CloudServicesScopeValue,
  CloudSubmissionOutcome,
  CloudTaskActionSet,
  CloudTaskSubmissionDeps,
  CloudUiBootstrap,
  CloudWorkspaceContextValue,
  CloudWorkspaceProviderProps,
  CloudWorkspaceSelection,
  UnavailableServiceAccessorOptions,
} from "./cloud/index.js";

export {
  useCancelCloudInput,
  useCloudAttachmentGate,
  useCloudCapabilities,
  useCloudComposerSubmit,
  useCloudProjects,
  useCloudRepositories,
  useCloudTask,
  useCloudTaskHistory,
  useCloudTasks,
  useCloudWorkspaceController,
  useCloudWorkspaceServices,
  useReopenCloudTask,
  useSubmitCloudInput,
  createCloudCommandId,
} from "./hooks/cloud/index.js";
export type {
  CloudAttachmentStatus,
  CloudComposerSendOutcome,
  CloudComposerSubmitResult,
  CloudRepositoryBlockingReason,
  CloudWorkspaceControllerValue,
  ReopenCloudTaskArgs,
  SubmitAppendInputArgs,
  SubmitFirstInputArgs,
  UseCancelCloudInputOptions,
  UseCancelCloudInputResult,
  UseCloudCapabilitiesOptions,
  UseCloudCapabilitiesResult,
  UseCloudComposerSubmitResult,
  UseCloudProjectsOptions,
  UseCloudProjectsResult,
  UseCloudRepositoriesOptions,
  UseCloudRepositoriesResult,
  UseCloudTaskHistoryOptions,
  UseCloudTaskHistoryResult,
  UseCloudTaskOptions,
  UseCloudTaskResult,
  UseCloudTasksOptions,
  UseCloudTasksResult,
  UseCloudWorkspaceControllerOptions,
  UseReopenCloudTaskOptions,
  UseReopenCloudTaskResult,
  UseSubmitCloudInputOptions,
  UseSubmitCloudInputResult,
} from "./hooks/cloud/index.js";

export {
  CLOUD_CONVERSATION_TOPIC,
  canApplyCloudConversationSnapshot,
  createEmptyCloudConversationFold,
  createMemoryCloudLocalStore,
  createCloudLocalStore,
  buildCloudLocalKey,
  foldCloudConversationItems,
  createMemoryCloudDraftLocalStores,
  resetCloudDraftStoresForTests,
  selectCloudTasksForProject,
  useCloudDraftStore,
  useCloudProjectsStore,
  useCloudTaskHistoryStore,
  useCloudTasksStore,
} from "./store/cloud/index.js";
export type {
  CloudConversationFold,
  CloudDraftLocalStores,
  CloudConversationWatermark,
  CloudDraftRecord,
  CloudLocalStore,
  CloudProjectsStatus,
  CloudSubmitAttempt,
  CloudSubmitPhase,
  CloudSubmitRequest,
  CloudSubmitSettlement,
  CloudTaskDetailCacheEntry,
  CloudTaskHistoryEntry,
  CloudTaskHistoryStatus,
  CloudTasksStatus,
} from "./store/cloud/index.js";

export {
  CloudRuntimeSection,
  CloudGithubSettingsSection,
  CloudSandboxSettingsSection,
  CLOUD_RUNTIME_SETTINGS_GROUP_ID,
  CLOUD_RUNTIME_SETTINGS_SECTION_ID,
  describeCloudSettingsError,
} from "./settings/CloudRuntimeSection.js";
export {
  CloudProjectTaskSection,
  describeCloudProjectLabel,
} from "./cloud/CloudProjectTaskSection.js";
export {
  projectCloudTasksForSidebar,
  sortCloudTasksForSidebar,
} from "./cloud/cloudSidebarTaskList.js";
export { CloudRepositoryPickerDialog } from "./cloud/CloudRepositoryPickerDialog.js";
export { CloudDraftStartConfigControl } from "./cloud/CloudDraftStartConfigControl.js";

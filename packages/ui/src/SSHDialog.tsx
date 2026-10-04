/* eslint-disable max-lines -- 远程连接向导的状态编排暂集中在同一组件，后续有独立拆分计划。 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  createUuid,
  type ConnectSandboxRequest,
  type RemoteTarget,
  type RemoteWorkspaceSessionEntry,
} from "@zcode/shared";
import {
  TID_SSH_CONNECT_TRIGGER,
  TID_SSH_DIALOG,
  TID_SSH_ERROR,
  TID_SSH_SUCCESS,
} from "@zcode/shared";
import { AlertTriangleIcon } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button.js";
import { Dialog, DialogContent, DialogHeader } from "@/components/ui/dialog.js";
import { useCancelPendingRemoteConnection } from "@/hooks/useCancelPendingRemoteConnection.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useRemoteConnectionForm } from "@/hooks/useRemoteConnectionForm.js";
import { useRemoteConnectionLogs } from "@/hooks/useRemoteConnectionLogs.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import {
  buildRemoteTarget,
  buildSandboxProvisionRequest,
  getRemoteWizardStepCopy,
  withDefaultRemoteResourcePackages,
  type WizardRemoteKind,
} from "@/lib/remoteConnectionWizard.js";
import {
  getRemoteConnectionCompletionDialogState,
  getRemoteConnectionDirectoryFailureState,
  isRemoteConnectionFlowActive,
  shouldResetRemoteConnectionOnOpen,
} from "@/lib/remoteConnectionDialogState.js";
import { logger } from "@/logger.js";
import { startUserAction } from "@/lib/userActionTelemetry.js";
import {
  RemoteConnectionConnectingStep,
  RemoteConnectionDirectoryStep,
  RemoteConnectionKindStep,
  RemoteConnectionSettingsStep,
} from "@/RemoteConnectionDialogContent.js";
import {
  RemoteConnectionWizardHeader,
  RemoteConnectionWizardSidebar,
  type RemoteWizardStep,
} from "@/RemoteConnectionWizardChrome.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useBaseWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import type { VariantProps } from "class-variance-authority";

interface RemoteConnectionDialogProps {
  onConnect: (options: RemoteTarget, requestId?: string) => Promise<string>;
  /**
   * 沙箱连接与 ssh/wsl/docker 不同：target 要先由 provisioner 建出来。
   * 因此这里传入的是「建沙箱的请求」，返回 provisioner 决定的 workspacePath。
   */
  onConnectSandbox?: (request: ConnectSandboxRequest) => Promise<{
    sessionId: string;
    workspacePath: string;
  }>;
  onSelectProject: (sessionId: string, path: string, localWorkspacePath?: string) => Promise<void>;
  onCancelSession: (sessionId: string) => Promise<void>;
  localWorkspacePath?: string;
  trigger?: ReactNode;
  triggerVariant?: VariantProps<typeof buttonVariants>["variant"];
  triggerSize?: VariantProps<typeof buttonVariants>["size"];
  triggerClassName?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  hideTriggerWhenClosed?: boolean;
  isWindowsDesktop?: boolean;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  onFlowActiveChange?: (active: boolean) => void;
  onFlowRequestIdChange?: (requestId: string | null) => void;
  preferredKind?: WizardRemoteKind;
  preferredWslDistro?: string;
}

export function RemoteConnectionDialog({
  onConnect,
  onConnectSandbox,
  onSelectProject,
  onCancelSession,
  localWorkspacePath,
  trigger,
  triggerVariant = "outline",
  triggerSize = "sm",
  triggerClassName,
  open: controlledOpen,
  onOpenChange,
  hideTriggerWhenClosed = false,
  isWindowsDesktop = false,
  remoteWorkspaceSessions = [],
  onFlowActiveChange,
  onFlowRequestIdChange,
  preferredKind,
  preferredWslDistro,
}: RemoteConnectionDialogProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const cancelPendingRemoteConnection = useCancelPendingRemoteConnection();
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [validationMessage, setValidationMessage] = useState("");
  const [currentStep, setCurrentStep] = useState<RemoteWizardStep>("kind");
  const [connectedSessionId, setConnectedSessionId] = useState<string | null>(null);
  const [connectingRequestId, setConnectingRequestId] = useState<string | null>(null);
  const [pendingRemoteTarget, setPendingRemoteTarget] = useState<RemoteTarget | null>(null);
  // 沙箱建好后 provisioner 返回的 checkout 目录。重试「打开工作区」时用得上：
  // 沙箱已经存在，重试必须重新 attach，而不是再建一个。
  const [pendingSandboxWorkspacePath, setPendingSandboxWorkspacePath] = useState<string | null>(
    null,
  );
  const [selectingDirectory, setSelectingDirectory] = useState(false);
  const selectingDirectoryRef = useRef(false);
  const { connectionLogs, resetConnectionLogs } = useRemoteConnectionLogs(connectingRequestId);
  const open = controlledOpen ?? uncontrolledOpen;
  const {
    kind,
    host,
    port,
    username,
    sshAuthMethod,
    assetInstallMode,
    password,
    privateKeyPath,
    privateKeyPassphrase,
    wslDistro,
    wslUser,
    dockerContainer,
    manualDockerContainer,
    sandboxProvider,
    sandboxRepoOwner,
    sandboxRepoName,
    sandboxBranch,
    sshConfigAliases,
    sshConfigAliasesLoading,
    sshConfigAliasesError,
    selectedSshConfigAlias,
    dockerAvailable,
    wslDistros,
    dockerContainers,
    availableKinds,
    setKind,
    setHost,
    setPort,
    setUsername,
    setSshAuthMethod,
    setAssetInstallMode,
    setPassword,
    setPrivateKeyPath,
    setPrivateKeyPassphrase,
    setWslDistro,
    setWslUser,
    setDockerContainer,
    setManualDockerContainer,
    setSandboxProvider,
    setSandboxRepoOwner,
    setSandboxRepoName,
    setSandboxBranch,
    refreshDockerContainers,
    applySshConfigAlias,
    clearSelectedSshConfigAlias,
    currentRuntimeOptionsLoading,
    currentRuntimeOptionsError,
  } = useRemoteConnectionForm({
    open,
    isWindowsDesktop,
    preferredKind,
    preferredWslDistro,
    // 只有真正接上 provisioner 的入口才展示云沙箱卡片，避免出现点了必然失败的选项。
    supportsSandbox: Boolean(onConnectSandbox),
  });
  const directoryBrowserServices = useRemoteWorkspaceSessionStore((state) =>
    connectedSessionId ? (state.sessionsById[connectedSessionId]?.services ?? null) : null,
  );
  const baseServices = useBaseWorkspaceServices();
  const flowSnapshot = useMemo(
    () => ({
      currentStep,
      loading,
      connectedSessionId,
    }),
    [connectedSessionId, currentStep, loading],
  );
  const flowActive = isRemoteConnectionFlowActive(flowSnapshot);

  useEffect(() => {
    onFlowActiveChange?.(flowActive);
  }, [flowActive, onFlowActiveChange]);

  const updateConnectingRequestId = useCallback(
    (requestId: string | null) => {
      setConnectingRequestId(requestId);
      onFlowRequestIdChange?.(requestId);
    },
    [onFlowRequestIdChange],
  );

  const applyOpenState = (nextOpen: boolean) => {
    onOpenChange?.(nextOpen);
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }
  };

  const resetFeedback = () => {
    setError("");
    setValidationMessage("");
  };

  const resetDirectorySelectionState = useCallback(() => {
    selectingDirectoryRef.current = false;
    setSelectingDirectory(false);
  }, []);

  const handleCancelSession = useCallback(
    async (sessionId: string) => {
      try {
        await onCancelSession(sessionId);
      } catch (sessionError) {
        logger.warn("[SSHDialog] 释放未确认的远程 session 失败:", {
          sessionId,
          error: sessionError,
        });
      }
    },
    [onCancelSession],
  );

  const closeDialog = useCallback(
    (options?: { preserveSession?: boolean }) => {
      const sessionId = connectedSessionId;
      if (!options?.preserveSession && sessionId) {
        void handleCancelSession(sessionId);
      } else if (!options?.preserveSession && loading && currentStep === "connecting") {
        // 连接过程里 sessionId 尚未返回时，关闭弹窗会只重置 UI；这里补上显式取消，确保后台下载同步停止。
        void cancelPendingRemoteConnection(connectingRequestId ?? undefined);
      }
      resetFeedback();
      setLoading(false);
      resetDirectorySelectionState();
      resetConnectionLogs();
      setCurrentStep("kind");
      setConnectedSessionId(null);
      setPendingRemoteTarget(null);
      setPendingSandboxWorkspacePath(null);
      updateConnectingRequestId(null);
      applyOpenState(false);
    },
    [
      cancelPendingRemoteConnection,
      connectedSessionId,
      connectingRequestId,
      currentStep,
      handleCancelSession,
      loading,
      resetDirectorySelectionState,
      updateConnectingRequestId,
    ],
  );

  const confirmRemoteFlowDiscard = useCallback(async () => {
    if (currentStep === "connecting" && loading) {
      return confirmDialog({
        title: intl.formatMessage({ id: "remote.connectingConfirmTitle" }),
        description: intl.formatMessage({
          id: "remote.connectingConfirmDescription",
        }),
        confirmLabel: intl.formatMessage({ id: "remote.stopConnecting" }),
        cancelLabel: intl.formatMessage({ id: "common.cancel" }),
      });
    }
    if (!connectedSessionId) {
      return true;
    }
    return confirmDialog({
      title: intl.formatMessage({ id: "remote.connectedConfirmTitle" }),
      description: intl.formatMessage({
        id: "remote.connectedConfirmDescription",
      }),
      confirmLabel: intl.formatMessage({ id: "remote.leaveConnectedSession" }),
      cancelLabel: intl.formatMessage({ id: "common.cancel" }),
    });
  }, [confirmDialog, connectedSessionId, currentStep, intl, loading]);

  const handleCloseRequest = useCallback(async () => {
    const confirmed = await confirmRemoteFlowDiscard();
    if (!confirmed) {
      return;
    }
    closeDialog();
  }, [closeDialog, confirmRemoteFlowDiscard]);

  const startRemoteConnection = async (target: RemoteTarget) => {
    const nextTarget = withDefaultRemoteResourcePackages(target);

    if (loading) {
      // React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    setPendingRemoteTarget(nextTarget);
    setLoading(true);
    const requestId = createUuid();
    updateConnectingRequestId(requestId);
    resetFeedback();
    resetConnectionLogs();
    setCurrentStep("connecting");
    const trace = startUserAction({
      featureId: "workspace.remote.lifecycle",
      action: "connect",
      trigger: "button",
      workspaceKind: "remote",
      remoteKind: nextTarget.kind,
    });
    try {
      const sessionId = await onConnect(nextTarget, requestId);
      const completionState = getRemoteConnectionCompletionDialogState("success");
      setConnectedSessionId(sessionId);
      setCurrentStep(completionState.step);
      applyOpenState(completionState.open);
      trace.complete({ resultSource: "platform_result" });
    } catch (connectError) {
      const completionState = getRemoteConnectionCompletionDialogState("error");
      const errorMessage = getErrorMessage(connectError);
      setError(errorMessage);
      setCurrentStep(completionState.step);
      applyOpenState(completionState.open);
      trace.fail({ failureStage: "remote_connect" });
    } finally {
      setLoading(false);
    }
  };

  const startSandboxConnection = async () => {
    if (loading) {
      // 与 startRemoteConnection 同样的并发保护。沙箱比 SSH 更贵：重复点击会真的
      // 让 provisioner 建出多个沙箱，而只有最后一个会被 attach，其余的只能等 TTL 回收。
      return;
    }

    const { request, errorMessage } = buildSandboxProvisionRequest(intl, {
      sandboxProvider,
      sandboxRepoOwner,
      sandboxRepoName,
      sandboxBranch,
    });
    if (!request) {
      setValidationMessage(errorMessage ?? "Connection failed");
      return;
    }
    if (!onConnectSandbox) {
      // 正常情况下选择页不会展示沙箱卡片；这里兜底，避免未来有人接了 kind 却忘了接 connector。
      setValidationMessage(intl.formatMessage({ id: "sandbox.unsupported" }));
      return;
    }

    resetFeedback();
    resetConnectionLogs();
    setLoading(true);
    const requestId = createUuid();
    updateConnectingRequestId(requestId);
    setCurrentStep("connecting");
    const trace = startUserAction({
      featureId: "workspace.remote.lifecycle",
      action: "connect",
      trigger: "button",
      workspaceKind: "remote",
      remoteKind: "sandbox",
    });
    try {
      const { sessionId, workspacePath } = await onConnectSandbox({
        provision: request,
        requestId,
        connectTrigger: "new",
      });
      trace.complete({ resultSource: "platform_result" });

      // provisioner 决定了 checkout 目录，所以沙箱流程不进入选目录步骤，
      // 直接用返回的 workspacePath 打开工作区。
      setConnectedSessionId(sessionId);
      setPendingSandboxWorkspacePath(workspacePath);
      try {
        await onSelectProject(sessionId, workspacePath);
      } catch (selectionError) {
        // 沙箱与 session 都已经就绪，只是打开工作区这一步失败。
        // 保持在 connecting 步骤显示错误：session 仍挂在 store 上，用户可以重试，
        // 关闭弹窗时也会走既有的释放逻辑，不需要（也不能）由客户端销毁沙箱。
        setError(getErrorMessage(selectionError));
        return;
      }
      resetConnectionLogs();
      setCurrentStep("kind");
      setConnectedSessionId(null);
      setPendingRemoteTarget(null);
      setPendingSandboxWorkspacePath(null);
      updateConnectingRequestId(null);
      applyOpenState(false);
    } catch (connectError) {
      const completionState = getRemoteConnectionCompletionDialogState("error");
      setError(getErrorMessage(connectError));
      setCurrentStep(completionState.step);
      applyOpenState(completionState.open);
      trace.fail({ failureStage: "remote_connect" });
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    if (loading) {
      // React 还没来得及把按钮置 disabled 时，快速重复点击会启动多个 SSH host process。
      // 这里在事件入口再做一次并发保护，避免同一个 dialog 产生多条部署流并把上传进度混在一起。
      return;
    }

    if (kind === "sandbox") {
      await startSandboxConnection();
      return;
    }

    const { target: nextTarget, errorMessage } = buildRemoteTarget(intl, {
      kind,
      host,
      port,
      username,
      sshAuthMethod,
      assetInstallMode,
      password,
      privateKeyPath,
      privateKeyPassphrase,
      selectedSshConfigAlias,
      wslDistro,
      wslUser,
      dockerContainer,
      manualDockerContainer,
    });
    if (!nextTarget) {
      // 必填项缺失属于表单校验，不应该和真实连接失败共用 destructive 错误样式。
      // 这里单独落到 settings 步骤内的 warning 提示，用户能更快理解是“缺少输入”而不是“连接出错”。
      setValidationMessage(errorMessage ?? "Connection failed");
      return;
    }

    resetFeedback();
    setPendingRemoteTarget(nextTarget);
    await startRemoteConnection(nextTarget);
  };

  const handleStartPendingRemoteConnection = useCallback(() => {
    if (pendingSandboxWorkspacePath && connectedSessionId) {
      // 「重试」发生在沙箱已建好、只是打开工作区失败的时候。
      // 这里必须重新 attach 同一个沙箱，再走一遍 handleConnect 会真的再建一个。
      void (async () => {
        resetFeedback();
        try {
          await onSelectProject(connectedSessionId, pendingSandboxWorkspacePath);
        } catch (selectionError) {
          setError(getErrorMessage(selectionError));
          return;
        }
        resetConnectionLogs();
        setCurrentStep("kind");
        setConnectedSessionId(null);
        setPendingSandboxWorkspacePath(null);
        updateConnectingRequestId(null);
        applyOpenState(false);
      })();
      return;
    }

    if (!pendingRemoteTarget) {
      void handleConnect();
      return;
    }

    void startRemoteConnection(pendingRemoteTarget);
  }, [
    connectedSessionId,
    handleConnect,
    onSelectProject,
    pendingRemoteTarget,
    pendingSandboxWorkspacePath,
    startRemoteConnection,
    updateConnectingRequestId,
  ]);

  const handleBackToConnection = useCallback(async () => {
    if (!connectedSessionId) {
      return;
    }

    resetFeedback();
    try {
      await onCancelSession(connectedSessionId);
      setConnectedSessionId(null);
      updateConnectingRequestId(null);
      resetConnectionLogs();
      setCurrentStep("settings");
    } catch (sessionError) {
      setError(getErrorMessage(sessionError));
    }
  }, [connectedSessionId, onCancelSession, updateConnectingRequestId]);

  const handleSelectDirectory = useCallback(
    async (path: string) => {
      if (!connectedSessionId || selectingDirectoryRef.current) {
        return;
      }

      // 选中远程目录后还要做 realpath、provider 同步、session 持久化和任务列表刷新。
      // 这些异步步骤之前没有独立的提交中状态，用户会看到按钮无响应；这里在入口设置状态并用 ref 防重复提交。
      selectingDirectoryRef.current = true;
      setSelectingDirectory(true);
      resetFeedback();
      try {
        await onSelectProject(connectedSessionId, path, localWorkspacePath);
        resetConnectionLogs();
        setCurrentStep("kind");
        setConnectedSessionId(null);
        setPendingRemoteTarget(null);
        updateConnectingRequestId(null);
        applyOpenState(false);
      } catch (selectionError) {
        const failureState = getRemoteConnectionDirectoryFailureState({
          connectedSessionId,
          // 事件处理器只在失败时读取一次最新 snapshot，避免为了回调判断新增重复 Zustand 订阅。
          sessionStillRegistered: Boolean(
            useRemoteWorkspaceSessionStore.getState().sessionsById[connectedSessionId],
          ),
        });
        if (!failureState.connectedSessionId) {
          setConnectedSessionId(null);
          setCurrentStep(failureState.step);
          updateConnectingRequestId(null);
        }
        setError(getErrorMessage(selectionError));
      } finally {
        resetDirectorySelectionState();
      }
    },
    [
      connectedSessionId,
      localWorkspacePath,
      onSelectProject,
      resetDirectorySelectionState,
      updateConnectingRequestId,
    ],
  );

  const handleOpenChange = (nextOpen: boolean) => {
    if (nextOpen) {
      if (shouldResetRemoteConnectionOnOpen(flowSnapshot)) {
        resetFeedback();
        resetConnectionLogs();
        setCurrentStep("kind");
        setPendingRemoteTarget(null);
      }
      applyOpenState(true);
      return;
    }

    void handleCloseRequest();
  };

  const stepCopy = getRemoteWizardStepCopy(intl, currentStep, kind);

  return (
    <>
      {!hideTriggerWhenClosed ? (
        <Button
          type="button"
          variant={triggerVariant}
          size={triggerSize}
          onClick={() => {
            if (shouldResetRemoteConnectionOnOpen(flowSnapshot)) {
              resetFeedback();
              resetConnectionLogs();
              setCurrentStep("kind");
              setPendingRemoteTarget(null);
            }
            applyOpenState(true);
          }}
          data-testid={TID_SSH_CONNECT_TRIGGER}
          className={triggerClassName}
        >
          {trigger ?? intl.formatMessage({ id: "remote.trigger" })}
        </Button>
      ) : null}
      <Dialog open={open} onOpenChange={handleOpenChange}>
        <DialogContent
          showCloseButton={false}
          className="h-[calc(100dvh-1rem)] max-h-168 w-[calc(100vw-1rem)] max-w-4xl overflow-hidden rounded-2xl p-0 md:h-[calc(100vh-6rem)]"
        >
          <div
            data-testid={TID_SSH_DIALOG}
            className="flex h-full min-h-0 flex-col overflow-hidden md:flex-row"
          >
            <RemoteConnectionWizardSidebar currentStep={currentStep} />

            <div className="flex min-w-0 flex-1 flex-col gap-3 overflow-hidden p-4 sm:gap-4 sm:p-6">
              <DialogHeader className="space-y-2">
                <RemoteConnectionWizardHeader
                  title={stepCopy.title}
                  description={stepCopy.description}
                  onMinimize={
                    flowActive
                      ? () => {
                          // 连接慢时用户只能关闭弹窗，关闭会取消 pending 连接并丢失当前步骤。
                          // 这里把“收起”明确拆成仅隐藏 dialog，不重置状态、不取消后台连接，后续入口可恢复到当前步骤。
                          applyOpenState(false);
                        }
                      : undefined
                  }
                  onClose={() => {
                    // 关闭和收起的语义不同。关闭仍走确认和取消逻辑，避免已连接但未选目录的 session 泄漏。
                    void handleCloseRequest();
                  }}
                />
              </DialogHeader>

              {error && currentStep !== "connecting" ? (
                <div
                  data-testid={TID_SSH_ERROR}
                  // 远程连接的错误提示以前直接拼接颜色 token，和全局状态反馈样式不一致。
                  // 这里统一改成 destructive 语义色对，避免 SSH/Docker 两种模式出现不同的错误视觉。
                  className="flex items-start gap-3 rounded-xl bg-destructive px-4 py-3 text-ui-base text-destructive-foreground"
                >
                  <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" />
                  {error}
                </div>
              ) : null}

              <div className="w-full min-h-0 flex-1">
                {currentStep === "kind" ? (
                  <RemoteConnectionKindStep
                    kind={kind}
                    availableKinds={availableKinds}
                    onKindChange={setKind}
                    onCancel={() => closeDialog()}
                    onNext={() => {
                      resetFeedback();
                      setCurrentStep("settings");
                    }}
                  />
                ) : null}

                {currentStep === "settings" ? (
                  <RemoteConnectionSettingsStep
                    kind={kind}
                    host={host}
                    port={port}
                    username={username}
                    sshAuthMethod={sshAuthMethod}
                    assetInstallMode={assetInstallMode}
                    password={password}
                    privateKeyPath={privateKeyPath}
                    privateKeyPassphrase={privateKeyPassphrase}
                    wslDistro={wslDistro}
                    wslUser={wslUser}
                    wslDistros={wslDistros}
                    dockerContainer={dockerContainer}
                    manualDockerContainer={manualDockerContainer}
                    dockerContainers={dockerContainers}
                    dockerAvailable={dockerAvailable}
                    sshConfigAliases={sshConfigAliases}
                    sshConfigAliasesLoading={sshConfigAliasesLoading}
                    sshConfigAliasesError={sshConfigAliasesError}
                    selectedSshConfigAlias={selectedSshConfigAlias}
                    currentRuntimeOptionsLoading={currentRuntimeOptionsLoading}
                    currentRuntimeOptionsError={currentRuntimeOptionsError}
                    sandboxProvider={sandboxProvider}
                    sandboxRepoOwner={sandboxRepoOwner}
                    sandboxRepoName={sandboxRepoName}
                    sandboxBranch={sandboxBranch}
                    remoteWorkspaceSessions={remoteWorkspaceSessions}
                    validationMessage={validationMessage}
                    loading={loading}
                    onBack={() => {
                      resetFeedback();
                      setCurrentStep("kind");
                    }}
                    onSandboxProviderChange={setSandboxProvider}
                    onSandboxRepoOwnerChange={setSandboxRepoOwner}
                    onSandboxRepoNameChange={setSandboxRepoName}
                    onSandboxBranchChange={setSandboxBranch}
                    onHostChange={setHost}
                    onPortChange={setPort}
                    onUsernameChange={setUsername}
                    onSshAuthMethodChange={setSshAuthMethod}
                    onAssetInstallModeChange={setAssetInstallMode}
                    onPasswordChange={setPassword}
                    onPrivateKeyPathChange={setPrivateKeyPath}
                    onPrivateKeyPassphraseChange={setPrivateKeyPassphrase}
                    onWslDistroChange={setWslDistro}
                    onWslUserChange={setWslUser}
                    onDockerContainerChange={setDockerContainer}
                    onManualDockerContainerChange={setManualDockerContainer}
                    onDockerContainersRefresh={refreshDockerContainers}
                    onApplySshConfigAlias={applySshConfigAlias}
                    onClearSelectedSshConfigAlias={clearSelectedSshConfigAlias}
                    onConnect={() => {
                      void handleConnect();
                    }}
                  />
                ) : null}

                {currentStep === "connecting" ? (
                  <RemoteConnectionConnectingStep
                    kind={kind}
                    logs={connectionLogs}
                    errorMessage={error}
                    loading={loading}
                    onBack={() => {
                      void (async () => {
                        const confirmed = await confirmRemoteFlowDiscard();
                        if (!confirmed) {
                          return;
                        }

                        if (loading) {
                          await cancelPendingRemoteConnection(connectingRequestId ?? undefined);
                          setLoading(false);
                        }
                        resetFeedback();
                        updateConnectingRequestId(null);
                        setCurrentStep("settings");
                      })();
                    }}
                    onRetry={() => {
                      handleStartPendingRemoteConnection();
                    }}
                  />
                ) : null}

                {currentStep === "directory" ? (
                  <div data-testid={TID_SSH_SUCCESS} className="h-full">
                    <RemoteConnectionDirectoryStep
                      services={directoryBrowserServices}
                      remoteTarget={pendingRemoteTarget}
                      localSkillSyncService={baseServices.skillSyncService}
                      remoteSkillSyncService={directoryBrowserServices?.skillSyncService ?? null}
                      localMcpSyncService={baseServices.mcpSyncService}
                      remoteMcpSyncService={directoryBrowserServices?.mcpSyncService ?? null}
                      localPluginSyncService={baseServices.pluginSyncService}
                      remotePluginSyncService={directoryBrowserServices?.pluginSyncService ?? null}
                      localZCodeAgentService={baseServices.zcodeAgentService}
                      remoteZCodeAgentService={directoryBrowserServices?.zcodeAgentService ?? null}
                      localWorkspacePath={localWorkspacePath}
                      selecting={selectingDirectory}
                      onSelect={(path) => {
                        void handleSelectDirectory(path);
                      }}
                      onBack={() => {
                        void (async () => {
                          const confirmed = await confirmRemoteFlowDiscard();
                          if (!confirmed) {
                            return;
                          }

                          await handleBackToConnection();
                        })();
                      }}
                      onCancel={() => {
                        void handleCloseRequest();
                      }}
                      onSkillsSynced={async () => undefined}
                      onMcpSynced={async () => undefined}
                      onPluginsSynced={async () => undefined}
                    />
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

export const SSHDialog = RemoteConnectionDialog;

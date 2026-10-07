/**
 * `useCloudWorkspaceController` —— 云工作区控制器（specs/cloud-agent/W8 §3、04 §3.0.1/§3.3/§5）。
 *
 * 它是「控制面选择 + 当前 Run 路由」的唯一 owner，负责：
 * 1. 维护选中 Project / Task 与**稳定草稿 scope**（principal + origin + taskId）；
 * 2. 取能力声明（fail-closed，非 cloud 模式视作错误）；
 * 3. 取当前 Task 详情投影，并按 `activeRun` 打开 / 释放 attachment；
 * 4. 刷新时先恢复未决 attempt 并按原 commandId 对账（04 §3.2.5）。
 *
 * 它不渲染任何东西、不缓存权威状态、不替组件做页面决策——`CloudWorkspaceProvider`
 * 只把它投影到 context 上。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CapabilitiesResponse, TaskDetailResponse } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import { readCloudErrorCode } from "@/cloud/cloudApiErrorLike.js";
import type { CloudAttachmentAccessor } from "@/cloud/cloudBrowserServices.js";
import type { CloudAttachmentProvider } from "@/cloud/cloudAttachmentProvider.js";
import { buildCloudDraftScope } from "@/cloud/cloudDraftScope.js";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { describeCloudSubmissionError } from "@/cloud/cloudTaskSubmission.js";
import { openCloudTaskRoute, readCloudTaskIdFromSearch } from "@/cloud/cloudUiBootstrap.js";
import type { CloudUiBootstrap } from "@/cloud/cloudUiBootstrap.js";
import type {
  CloudCapabilitiesStatus,
  CloudWorkspaceContextValue,
  CloudWorkspaceSelection,
} from "@/cloud/cloudWorkspaceContext.js";
import { useCloudDraftStore } from "@/store/cloud/cloudDraftStore.js";
import { useCloudTasksStore } from "@/store/cloud/cloudTasksStore.js";

/** attachment 生命周期：与执行域门控一一对应，没有第三个中间态。 */
export type CloudAttachmentStatus = "idle" | "connecting" | "ready" | "unavailable" | "error";

export interface CloudWorkspaceControllerValue extends CloudWorkspaceContextValue {
  readonly attachment: CloudAttachmentAccessor | null;
  readonly attachmentStatus: CloudAttachmentStatus;
}

export interface UseCloudWorkspaceControllerOptions {
  readonly bootstrap: CloudUiBootstrap;
  readonly controlPlane: CloudControlPlanePort | null;
  /** host `/ws` 的 base accessor；工作区级作用域合成需要它。 */
  readonly hostAccessor?: IServiceAccessor | null;
  readonly attachmentProvider?: CloudAttachmentProvider | null;
  /** 主路由 `?task=` 指定的初始任务；缺省从 bootstrap 推导。 */
  readonly initialProjectId?: string | null;
  /**
   * 「切到某个 task 的稳定路由」回调（04 §5 主路由 `/?task=<taskId>`）。
   *
   * 只在**用户/组件发起**的 `selectTask` 上触发，不会因为路由回灌而再次触发——
   * 路由 → 状态的同步请走 `bootstrap.taskId`，不要把回灌也接到 `selectTask`，
   * 否则会与入口的路由写入形成回环（AGENTS「广播同步的字段需要防止回环」）。
   *
   * 未提供时回落到 `openCloudTaskRoute`：路由写入始终由本控制器**一处**完成，
   * 侧栏等调用方只调 `selectTask`，不会再各自 pushState。
   */
  readonly onNavigateTask?: ((taskId: string | null) => void) | undefined;
}

/**
 * run 状态是否应打开 attachment：`ready` 当然可以；`disconnected` / `draining` 时
 * 通道本身负责重连与保存收尾，保持 attach 才能让「重开后回放」「断连不失效」成立
 * （04 §3.0.1、§3.3 状态矩阵）。终态 run 一律不 attach。
 */
function isAttachableRunStatus(status: string): boolean {
  return status === "ready" || status === "disconnected" || status === "draining";
}

export function useCloudWorkspaceController(
  options: UseCloudWorkspaceControllerOptions,
): CloudWorkspaceControllerValue {
  const { bootstrap, controlPlane, attachmentProvider, onNavigateTask } = options;

  const [projectId, setProjectId] = useState<string | null>(options.initialProjectId ?? null);
  const [taskId, setTaskId] = useState<string | null>(bootstrap.taskId ?? null);
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [capabilitiesStatus, setCapabilitiesStatus] = useState<CloudCapabilitiesStatus>("idle");
  const [capabilitiesError, setCapabilitiesError] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetailResponse | null>(null);
  const [taskDetailStatus, setTaskDetailStatus] = useState<CloudCapabilitiesStatus>("idle");
  const [taskDetailError, setTaskDetailError] = useState<string | null>(null);
  const [attachment, setAttachment] = useState<CloudAttachmentAccessor | null>(null);
  const [attachmentStatus, setAttachmentStatus] = useState<CloudAttachmentStatus>("idle");

  // 主体标识直接取控制面 capabilities 的冻结字段（03 §6、12 §5）：
  // 本地不造主体、不回落到 ui-bootstrap、也不做结构化绕过。capabilities 未到或未认证时
  // 为 null，scope 整体不可用（草稿不落盘、投影不缓存）。
  const principalId = capabilities?.principalId ?? null;

  // 主体切换时清投影与客户端记录（04 §3.4.1「登出切主体清投影」）。
  useEffect(() => {
    useCloudTasksStore.getState().setPrincipal(principalId);
    if (principalId === null) {
      useCloudDraftStore.getState().reset();
    }
  }, [principalId]);

  const draftScope = useMemo(() => {
    // 主体未声明（capabilities 未到 / 未认证）时没有 scope：不用占位主体造一个
    // 可能与其他账号撞上的稳定键（04 §3.4.1「不跨账号投递」）。
    if (!taskId || principalId === null) {
      return null;
    }
    return buildCloudDraftScope({
      principalId,
      controlPlaneOrigin: bootstrap.controlPlaneOrigin,
      taskId,
    });
  }, [bootstrap.controlPlaneOrigin, principalId, taskId]);

  // 主路由的**读取侧**（04 §5）：`/?task=<taskId>` 是云任务身份入口，浏览器前进/后退
  // 必须重读它。写入仍只有 `selectTask` → `openCloudTaskRoute` 一处，popstate 只回灌状态、
  // 不再写回路由（`pushState` 不触发 popstate，因此不会成环）。
  useEffect(() => {
    if (typeof window === "undefined" || typeof window.location?.search !== "string") {
      return;
    }
    const syncFromRoute = () => {
      const routedTaskId = readCloudTaskIdFromSearch(window.location.search);
      setTaskId((current) => (current === routedTaskId ? current : routedTaskId));
    };
    // 初次挂载：入口给的 bootstrap.taskId 与 URL 不一致时以 URL（主路由）为准。
    syncFromRoute();
    window.addEventListener("popstate", syncFromRoute);
    return () => {
      window.removeEventListener("popstate", syncFromRoute);
    };
  }, []);

  const capabilitiesRequestRef = useRef(0);
  const loadCapabilities = useCallback(async () => {
    if (!controlPlane) {
      setCapabilities(null);
      setCapabilitiesStatus("idle");
      setCapabilitiesError(null);
      return;
    }
    const requestId = capabilitiesRequestRef.current + 1;
    capabilitiesRequestRef.current = requestId;
    setCapabilitiesStatus("loading");
    setCapabilitiesError(null);
    try {
      const next = await controlPlane.getCapabilities();
      if (capabilitiesRequestRef.current !== requestId) {
        return;
      }
      if (next.mode !== "cloud") {
        // 模式不一致：fail-closed，不回落本机（04 §2）。
        setCapabilities(null);
        setCapabilitiesStatus("error");
        setCapabilitiesError("cloud capabilities reported a non-cloud mode");
        return;
      }
      setCapabilities(next);
      setCapabilitiesStatus("ready");
    } catch (error) {
      if (capabilitiesRequestRef.current !== requestId) {
        return;
      }
      setCapabilities(null);
      setCapabilitiesStatus("error");
      setCapabilitiesError(describeCloudSubmissionError(error));
    }
  }, [controlPlane]);

  useEffect(() => {
    void loadCapabilities();
  }, [loadCapabilities]);

  const detailRequestRef = useRef(0);
  const loadTask = useCallback(
    async (requestedTaskId?: string) => {
      const targetTaskId = requestedTaskId ?? taskId;
      if (!controlPlane || !targetTaskId) {
        setTaskDetail(null);
        setTaskDetailStatus("idle");
        setTaskDetailError(null);
        return;
      }
      const requestId = detailRequestRef.current + 1;
      detailRequestRef.current = requestId;
      setTaskDetailStatus("loading");
      setTaskDetailError(null);
      try {
        const next = await controlPlane.getTask(targetTaskId);
        if (detailRequestRef.current !== requestId) {
          return;
        }
        setTaskDetail(next);
        setTaskDetailStatus("ready");
        if (principalId !== null) {
          useCloudTasksStore.getState().applyTaskDetail(principalId, next, Date.now());
        }
      } catch (error) {
        if (detailRequestRef.current !== requestId) {
          return;
        }
        setTaskDetail(null);
        setTaskDetailStatus("error");
        setTaskDetailError(describeCloudSubmissionError(error));
      }
    },
    [controlPlane, principalId, taskId],
  );

  useEffect(() => {
    void loadTask();
  }, [loadTask]);

  // 恢复路径（04 §3.2.5）：选中任务后先 hydrate 本地草稿/attempt，再把未决 attempt
  // 按**原 commandId** 查询对账；查询失败保持 unknown，绝不重新组装 payload。
  useEffect(() => {
    if (!draftScope || !controlPlane || !taskId) {
      return;
    }
    const scopeKey = draftScope.key;
    useCloudDraftStore.getState().hydrate(scopeKey);
    const pending = useCloudDraftStore.getState().pendingAttempts(scopeKey);
    if (pending.length === 0) {
      return;
    }
    let cancelled = false;
    void (async () => {
      for (const attempt of pending) {
        try {
          const receipt = await controlPlane.getInput(taskId, attempt.commandId);
          if (cancelled) {
            return;
          }
          useCloudDraftStore.getState().applyReceipt(scopeKey, attempt.commandId, receipt);
        } catch {
          // 对账失败保持 unknown：调用方仍看得到未决 attempt，可以稍后重试。
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [controlPlane, draftScope, taskId]);

  // attachment 生命周期：只按当前 activeRun 状态决定，run 换代时重开。
  const activeRun = taskDetail?.activeRun ?? null;
  const activeRunId = activeRun?.runId ?? null;
  const activeRunGeneration = activeRun?.runGeneration ?? null;
  const activeRunAttachable = activeRun !== null && isAttachableRunStatus(activeRun.status);

  useEffect(() => {
    if (!attachmentProvider || !taskId || !activeRunAttachable || !activeRunId) {
      setAttachment(null);
      setAttachmentStatus(activeRunId ? "unavailable" : "idle");
      return;
    }
    let cancelled = false;
    setAttachmentStatus("connecting");
    void (async () => {
      try {
        const opened = await attachmentProvider.open(taskId);
        if (cancelled) {
          if (opened) {
            attachmentProvider.close(taskId);
          }
          return;
        }
        setAttachment(opened);
        setAttachmentStatus(opened ? "ready" : "unavailable");
        // attachment 打开说明 run 已可达，此时详情快照可能仍是选中瞬间的那份
        // （draft → start：run 在选中之后才 provisioning/ready）。runtime 会话 id
        // （activeRun.runtimeSessionId，首输入 ack 落地）是 pane 绑定的事实源，
        // 这里补一次对账读取，避免 pane 一直停在旧快照的「无会话」空态。
        if (opened) {
          void loadTask();
        }
      } catch (error) {
        if (cancelled) {
          return;
        }
        if (readCloudErrorCode(error) === "not_ready") {
          // run 尚未 ready：执行域保持不可用，不当作错误（03 §7.1）。
          setAttachment(null);
          setAttachmentStatus("unavailable");
          return;
        }
        setAttachment(null);
        setAttachmentStatus("error");
      }
    })();
    return () => {
      cancelled = true;
      // 本地释放，不停沙箱：关页后工作继续跑（04 §3.2.4）。
      attachmentProvider.close(taskId);
    };
  }, [activeRunAttachable, activeRunGeneration, activeRunId, attachmentProvider, loadTask, taskId]);

  useEffect(() => {
    if (!attachmentProvider?.onDidChange) {
      return;
    }
    // 连接状态变化（重连成功/断开）时重新评估：状态由 provider 驱动，控制器只跟随。
    // 连接换代（重连 / run 换代）意味着 activeRun 元数据可能已变——runtime 会话 id
    // 在换代后会换成新的 `sess_…`，pane 绑定必须跟 activeRun 走，这里同步刷新详情投影。
    return attachmentProvider.onDidChange(() => {
      setAttachmentStatus((current) => (current === "ready" ? "ready" : current));
      void loadTask();
    });
  }, [attachmentProvider, loadTask]);

  const selection = useMemo<CloudWorkspaceSelection>(
    () => ({
      principalId,
      controlPlaneOrigin: bootstrap.controlPlaneOrigin,
      projectId,
      taskId,
      draftScope,
    }),
    [bootstrap.controlPlaneOrigin, draftScope, principalId, projectId, taskId],
  );

  const selectProject = useCallback((nextProjectId: string | null) => {
    setProjectId(nextProjectId);
  }, []);

  const selectTask = useCallback(
    (nextTaskId: string | null) => {
      setTaskId(nextTaskId);
      // 用户发起的切换写回稳定路由；由入口据此建立 / 切换工作区（04 §5）。
      if (onNavigateTask) {
        onNavigateTask(nextTaskId);
        return;
      }
      openCloudTaskRoute(nextTaskId);
    },
    [onNavigateTask],
  );

  return useMemo(
    () => ({
      selection,
      controlPlane,
      hostAccessor: options.hostAccessor ?? null,
      attachment,
      capabilities,
      capabilitiesStatus,
      capabilitiesError,
      taskDetail,
      taskDetailStatus,
      taskDetailError,
      selectProject,
      selectTask,
      reloadCapabilities: loadCapabilities,
      reloadTask: loadTask,
      attachmentStatus,
    }),
    [
      attachment,
      attachmentStatus,
      capabilities,
      capabilitiesError,
      capabilitiesStatus,
      controlPlane,
      loadCapabilities,
      loadTask,
      options.hostAccessor,
      selectProject,
      selectTask,
      selection,
      taskDetail,
      taskDetailError,
      taskDetailStatus,
    ],
  );
}

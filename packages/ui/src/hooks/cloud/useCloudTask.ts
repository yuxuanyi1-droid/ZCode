/**
 * `useCloudTask` —— 当前 Task 详情与生命周期动作（specs/cloud-agent/04 §3.3、08 §3/§9、03 §6）。
 *
 * 详情投影包含 `{task, activeRun?, execution?, latestCheckpoint?, artifact?}`：
 * - `Task.active` ≠ attachment ready（04 §3.3）：run 缺失只说明没有活跃执行载体。
 * - stop/complete/archive/restore/reopen 都是**独立端点**，不走 PATCH status（04 §6）。
 * - reopen 是独立命令，不由 append 自动触发，也不复活旧 run（08 §9）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CloudDraftStartConfig, CloudTaskRecord, TaskDetailResponse } from "@zcode/shared";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import {
  readCloudTaskActions,
  type CloudTaskActionSet,
} from "@/cloud/cloudTaskActionsProjection.js";
import {
  runCloudTaskLifecycleAction,
  type CloudTaskLifecycleAction,
} from "@/cloud/cloudTaskLifecycle.js";
import { describeCloudSubmissionError } from "@/cloud/cloudTaskSubmission.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import type { CloudCapabilitiesStatus } from "@/cloud/cloudWorkspaceContext.js";
import { useCloudTasksStore } from "@/store/cloud/cloudTasksStore.js";

export interface UseCloudTaskResult {
  readonly status: CloudCapabilitiesStatus;
  readonly error: string | null;
  readonly detail: TaskDetailResponse | null;
  readonly task: CloudTaskRecord | null;
  /**
   * 可用动作：**直接来自控制面投影**（04 §3.3），UI 不推导、不解释、不回落。
   * 服务端没给出时为空集合 —— 「无动作可用」是唯一正确呈现（不是「按状态猜」）。
   */
  readonly actions: CloudTaskActionSet;
  refresh(): Promise<void>;
  /**
   * 按需拉取一次详情并返回最新投影（2026-10-07 终验缺陷 E：侧栏行归档点击时的
   * 准入预检用——`autoLoad=false` 的行只在动作发生时才值得发 `GET /tasks/:id`）。
   * 拉不到（未接线/网络失败）返回 null，由调用方回落服务端裁决，不本地猜。
   */
  loadDetail(): Promise<TaskDetailResponse | null>;
  /** 仅 draft 可写，带 revision CAS；冲突时保留本地编辑由调用方处理（11 §5）。 */
  saveDraftStartConfig(
    config: CloudDraftStartConfig,
    expectedRevision: number,
  ): Promise<CloudTaskRecord>;
  renameTask(title: string, expectedRevision: number): Promise<CloudTaskRecord>;
  stopTask(): Promise<void>;
  completeTask(): Promise<void>;
  archiveTask(): Promise<void>;
  restoreTask(): Promise<void>;
}

export interface UseCloudTaskOptions {
  readonly controlPlane?: CloudControlPlanePort | null;
  readonly principalId?: string | null;
  readonly taskId?: string | null;
  /**
   * 挂载时是否自动加载详情（默认 true）。侧栏任务行等**只要生命周期动作**、
   * 不展示详情的调用方传 false：避免整列行各自触发 `GET /tasks/:id`。
   * 动作本身不受影响——生命周期端点不依赖本地投影。
   */
  readonly autoLoad?: boolean;
}

export function useCloudTask(options?: UseCloudTaskOptions): UseCloudTaskResult {
  const context = useCloudWorkspaceContext();
  const controlPlane = options?.controlPlane ?? context?.controlPlane ?? null;
  const principalId = options?.principalId ?? context?.selection.principalId ?? null;
  const taskId = options?.taskId ?? context?.selection.taskId ?? null;
  const autoLoad = options?.autoLoad !== false;

  const [status, setStatus] = useState<CloudCapabilitiesStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  const detail = useCloudTasksStore((state) =>
    taskId ? (state.detailByTask[taskId]?.detail ?? null) : null,
  );

  const applyDetail = useCallback(
    (next: TaskDetailResponse) => {
      if (principalId === null) {
        return;
      }
      useCloudTasksStore.getState().applyTaskDetail(principalId, next, Date.now());
    },
    [principalId],
  );

  const load = useCallback(async (): Promise<TaskDetailResponse | null> => {
    if (!controlPlane || !taskId || principalId === null) {
      setStatus("idle");
      setError(null);
      return null;
    }
    const requestId = requestIdRef.current + 1;
    requestIdRef.current = requestId;
    setStatus("loading");
    setError(null);
    try {
      const next = await controlPlane.getTask(taskId);
      if (requestIdRef.current !== requestId) {
        return null;
      }
      applyDetail(next);
      setStatus("ready");
      return next;
    } catch (loadError) {
      if (requestIdRef.current !== requestId) {
        return null;
      }
      setStatus("error");
      setError(describeCloudSubmissionError(loadError));
      return null;
    }
  }, [applyDetail, controlPlane, principalId, taskId]);

  const refresh = useCallback(async () => {
    await load();
  }, [load]);

  useEffect(() => {
    if (autoLoad) {
      void refresh();
    }
  }, [autoLoad, refresh]);

  const runLifecycle = useCallback(
    async (action: (port: CloudControlPlanePort, id: string) => Promise<TaskDetailResponse>) => {
      if (!controlPlane || !taskId) {
        throw new Error("cloud control plane is not configured");
      }
      const next = await action(controlPlane, taskId);
      applyDetail(next);
    },
    [applyDetail, controlPlane, taskId],
  );

  const runAction = useCallback(
    (action: CloudTaskLifecycleAction) =>
      runLifecycle((port, id) => runCloudTaskLifecycleAction(port, id, action)),
    [runLifecycle],
  );

  const saveDraftStartConfig = useCallback(
    async (config: CloudDraftStartConfig, expectedRevision: number): Promise<CloudTaskRecord> => {
      if (!controlPlane || !taskId) {
        throw new Error("cloud control plane is not configured");
      }
      const record = await controlPlane.patchTask(taskId, {
        draftStartConfig: config,
        expectedRevision,
      });
      // PATCH 返回 Task 记录本身；详情投影由随后的 refresh 对齐，避免在这里拼一个半成品。
      return record;
    },
    [controlPlane, taskId],
  );

  const renameTask = useCallback(
    async (title: string, expectedRevision: number): Promise<CloudTaskRecord> => {
      if (!controlPlane || !taskId) {
        throw new Error("cloud control plane is not configured");
      }
      return controlPlane.patchTask(taskId, { title, expectedRevision });
    },
    [controlPlane, taskId],
  );

  const task = detail?.task ?? null;
  const actions = useMemo(() => readCloudTaskActions(detail), [detail]);

  const stopTask = useCallback(() => runAction("stop"), [runAction]);
  const completeTask = useCallback(() => runAction("complete"), [runAction]);
  const archiveTask = useCallback(() => runAction("archive"), [runAction]);
  const restoreTask = useCallback(() => runAction("restore"), [runAction]);

  return useMemo(
    () => ({
      status,
      error,
      detail,
      task,
      actions,
      refresh,
      loadDetail: load,
      saveDraftStartConfig,
      renameTask,
      stopTask,
      completeTask,
      archiveTask,
      restoreTask,
    }),
    [
      actions,
      archiveTask,
      completeTask,
      detail,
      error,
      load,
      renameTask,
      restoreTask,
      saveDraftStartConfig,
      status,
      stopTask,
      task,
      refresh,
    ],
  );
}

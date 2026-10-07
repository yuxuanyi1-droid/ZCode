/**
 * `useCloudTasks` —— 某个 Project 下的 Task 列表与草稿创建（specs/cloud-agent/04 §3.1/§3.3、11 §5）。
 *
 * - 展开项目只查控制面 Task，**不连沙箱**（04 §3.1）。
 * - 新建任务以 `creationKey` 创建持久 draft，不创建沙箱/session；未收到 Task 前
 *   不伪造「已创建」（04 §3.2.1）。
 * - 排序/归档视图读控制面任务事实，不复用本地 CLI 的空任务区（04 §3.0.1）。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CloudTaskRecord, CreateCloudTaskRequest } from "@zcode/shared";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { describeCloudSubmissionError } from "@/cloud/cloudTaskSubmission.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { useCloudTasksStore, type CloudTasksStatus } from "@/store/cloud/cloudTasksStore.js";

export interface UseCloudTasksResult {
  readonly status: CloudTasksStatus;
  readonly error: string | null;
  readonly tasks: readonly CloudTaskRecord[];
  readonly hasMore: boolean;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  /** 建持久 draft；`creationKey` 跨重试复用（11 §5、CT-03）。 */
  createDraftTask(request: CreateCloudTaskRequest): Promise<CloudTaskRecord>;
}

export interface UseCloudTasksOptions {
  readonly controlPlane?: CloudControlPlanePort | null;
  readonly principalId?: string | null;
  readonly projectId?: string | null;
}

export function useCloudTasks(options?: UseCloudTasksOptions): UseCloudTasksResult {
  const context = useCloudWorkspaceContext();
  const controlPlane = options?.controlPlane ?? context?.controlPlane ?? null;
  const principalId = options?.principalId ?? context?.selection.principalId ?? null;
  const projectId = options?.projectId ?? context?.selection.projectId ?? null;

  const status = useCloudTasksStore((state) =>
    projectId ? (state.statusByProject[projectId] ?? "idle") : "idle",
  );
  const error = useCloudTasksStore((state) =>
    projectId ? (state.errorByProject[projectId] ?? null) : null,
  );
  const tasks = useCloudTasksStore((state) =>
    projectId ? (state.itemsByProject[projectId] ?? EMPTY_TASKS) : EMPTY_TASKS,
  );
  const nextCursor = useCloudTasksStore((state) =>
    projectId ? state.nextCursorByProject[projectId] : undefined,
  );

  const inFlightRef = useRef(false);

  useEffect(() => {
    if (principalId === null) {
      useCloudTasksStore.getState().setPrincipal(null);
      return;
    }
    useCloudTasksStore.getState().setPrincipal(principalId);
  }, [principalId]);

  const loadPage = useCallback(
    async (mode: "replace" | "append") => {
      if (!controlPlane || principalId === null || !projectId || inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      const store = useCloudTasksStore.getState();
      if (mode === "replace") {
        store.beginLoadProject(principalId, projectId);
      }
      try {
        const cursor = mode === "append" ? store.nextCursorByProject[projectId] : undefined;
        const page = await controlPlane.listProjectTasks(
          projectId,
          cursor ? { cursor } : undefined,
        );
        useCloudTasksStore
          .getState()
          .applyProjectTasks(principalId, projectId, page, { append: mode === "append" });
      } catch (loadError) {
        useCloudTasksStore
          .getState()
          .failProject(principalId, projectId, describeCloudSubmissionError(loadError));
      } finally {
        inFlightRef.current = false;
      }
    },
    [controlPlane, principalId, projectId],
  );

  const refresh = useCallback(() => loadPage("replace"), [loadPage]);
  const loadMore = useCallback(() => loadPage("append"), [loadPage]);

  useEffect(() => {
    if (!controlPlane || !projectId || principalId === null) {
      return;
    }
    void loadPage("replace");
  }, [controlPlane, loadPage, principalId, projectId]);

  const createDraftTask = useCallback(
    async (request: CreateCloudTaskRequest): Promise<CloudTaskRecord> => {
      if (!controlPlane || principalId === null) {
        throw new Error("cloud control plane is not configured");
      }
      const record = await controlPlane.createTask(request);
      useCloudTasksStore
        .getState()
        .applyProjectTasks(principalId, record.projectId, { items: [record] }, { append: true });
      return record;
    },
    [controlPlane, principalId],
  );

  return useMemo(
    () => ({
      status,
      error,
      tasks,
      hasMore: nextCursor !== undefined,
      refresh,
      loadMore,
      createDraftTask,
    }),
    [createDraftTask, error, loadMore, nextCursor, refresh, status, tasks],
  );
}

const EMPTY_TASKS: readonly CloudTaskRecord[] = [];

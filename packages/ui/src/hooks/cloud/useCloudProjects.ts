/**
 * `useCloudProjects` —— Project 列表 / 创建 / 删除（specs/cloud-agent/04 §3.1、11 §4）。
 *
 * 规则：
 * - 列表只来自控制面；Project 不持有沙箱、不显示连接状态，展开只查 Task（04 §3.1）。
 * - 新建项目只有仓库一种类型：`createProject(repositoryId)` 只传数值 repositoryId，
 *   权限由服务端按 09 核验，客户端不传 owner/name 自证（11 §4.2）。
 * - `creationKey` 由调用方给出并**跨重试复用**：响应丢失时用原 key 恢复同一 Project，
 *   多端重复添加由控制面幂等收口（03 §6、CT-01）。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CloudProjectRecord } from "@zcode/shared";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { describeCloudSubmissionError } from "@/cloud/cloudTaskSubmission.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import {
  useCloudProjectsStore,
  type CloudProjectsStatus,
} from "@/store/cloud/cloudProjectsStore.js";

export interface UseCloudProjectsResult {
  readonly status: CloudProjectsStatus;
  readonly error: string | null;
  readonly projects: readonly CloudProjectRecord[];
  readonly hasMore: boolean;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  /** 传 `creationKey` 以支持「响应丢失后按原 key 重试」。 */
  createProject(
    repositoryId: number,
    options?: { creationKey?: string; displayName?: string },
  ): Promise<CloudProjectRecord>;
  deleteProject(projectId: string): Promise<void>;
}

export interface UseCloudProjectsOptions {
  readonly controlPlane?: CloudControlPlanePort | null;
  readonly principalId?: string | null;
}

export function useCloudProjects(options?: UseCloudProjectsOptions): UseCloudProjectsResult {
  const context = useCloudWorkspaceContext();
  const controlPlane = options?.controlPlane ?? context?.controlPlane ?? null;
  const principalId = options?.principalId ?? context?.selection.principalId ?? null;

  const status = useCloudProjectsStore((state) => state.status);
  const error = useCloudProjectsStore((state) => state.error);
  const projects = useCloudProjectsStore((state) => state.items);
  const nextCursor = useCloudProjectsStore((state) => state.nextCursor);

  const inFlightRef = useRef(false);

  useEffect(() => {
    if (principalId === null) {
      // 未认证不保留上一个主体的投影（04 §3.4.1「登出切主体清投影」）。
      useCloudProjectsStore.getState().setPrincipal(null);
      return;
    }
    useCloudProjectsStore.getState().setPrincipal(principalId);
  }, [principalId]);

  const loadPage = useCallback(
    async (mode: "replace" | "append") => {
      if (!controlPlane || principalId === null) {
        return;
      }
      const store = useCloudProjectsStore.getState();
      if (inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      if (mode === "replace") {
        store.beginLoad(principalId);
      }
      try {
        const cursor = mode === "append" ? useCloudProjectsStore.getState().nextCursor : undefined;
        const page = await controlPlane.listProjects(cursor ? { cursor } : undefined);
        useCloudProjectsStore
          .getState()
          .applyPage(principalId, page, { append: mode === "append" });
      } catch (loadError) {
        useCloudProjectsStore.getState().fail(principalId, describeCloudSubmissionError(loadError));
      } finally {
        inFlightRef.current = false;
      }
    },
    [controlPlane, principalId],
  );

  const refresh = useCallback(() => loadPage("replace"), [loadPage]);
  const loadMore = useCallback(() => loadPage("append"), [loadPage]);

  useEffect(() => {
    if (!controlPlane || principalId === null) {
      return;
    }
    void loadPage("replace");
  }, [controlPlane, principalId, loadPage]);

  const createProject = useCallback(
    async (
      repositoryId: number,
      createOptions?: { creationKey?: string; displayName?: string },
    ): Promise<CloudProjectRecord> => {
      if (!controlPlane || principalId === null) {
        throw new Error("cloud control plane is not configured");
      }
      const record = await controlPlane.createProject({
        repositoryId,
        ...(createOptions?.creationKey === undefined
          ? {}
          : { creationKey: createOptions.creationKey }),
        ...(createOptions?.displayName === undefined
          ? {}
          : { displayName: createOptions.displayName }),
      });
      useCloudProjectsStore.getState().upsert(principalId, record);
      return record;
    },
    [controlPlane, principalId],
  );

  const deleteProject = useCallback(
    async (projectId: string): Promise<void> => {
      if (!controlPlane || principalId === null) {
        throw new Error("cloud control plane is not configured");
      }
      await controlPlane.deleteProject(projectId);
      useCloudProjectsStore.getState().remove(principalId, projectId);
    },
    [controlPlane, principalId],
  );

  return useMemo(
    () => ({
      status,
      error,
      projects,
      hasMore: nextCursor !== undefined,
      refresh,
      loadMore,
      createProject,
      deleteProject,
    }),
    [createProject, deleteProject, error, loadMore, nextCursor, projects, refresh, status],
  );
}

/**
 * `useCloudTaskHistoryReplay` —— 归档/重开视图的跨 run 只读历史（specs/cloud-agent/04 §3.3、
 * 02 §7.3；2026-10-09 终验缺陷 D 的接线点）。
 *
 * 实时订阅只覆盖当前 activeRun 的会话流；本 hook 走控制面权威历史
 * （`GET /api/cloud/tasks/:id/history`，缺省族名 topic 返回跨 run 全部会话话题），
 * 分页读满（或到达条目上限）后交给 `cloudTaskHistoryReplay` 折叠成按 run 时间合并的
 * 只读行。run 不在线、沙箱已销毁亦可读（02 §7.3「客户端展示路径只依赖控制面持久副本」）。
 *
 * 与 `useCloudTaskHistory`（单话题水位恢复 + events 提示）分工：本 hook 面向呈现，
 * 无水位、无增量长轮询。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import { describeCloudSubmissionError } from "@/cloud/cloudTaskSubmission.js";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import {
  CLOUD_TASK_HISTORY_REPLAY_MAX_ITEMS,
  useCloudTaskHistoryStore,
} from "@/store/cloud/cloudTaskHistoryStore.js";
import {
  createEmptyCloudTaskHistoryReplay,
  type CloudTaskHistoryReplay,
} from "@/store/cloud/cloudTaskHistoryReplay.js";
import type { CloudCapabilitiesStatus } from "@/cloud/cloudWorkspaceContext.js";

/** 分页保护：页大小与最多页数（上限条目 = 页大小 × 页数上限，取先到者）。 */
const REPLAY_PAGE_LIMIT = 200;
const REPLAY_MAX_PAGES = Math.ceil(CLOUD_TASK_HISTORY_REPLAY_MAX_ITEMS / REPLAY_PAGE_LIMIT);

export interface UseCloudTaskHistoryReplayResult {
  readonly status: CloudCapabilitiesStatus;
  readonly error: string | null;
  readonly replay: CloudTaskHistoryReplay;
  readonly hasMore: boolean;
  /** 条目上限截断：较早的历史未进入 renderer（如实标注，不伪装成没有）。 */
  readonly truncated: boolean;
  /** 手动重读（测试打点与错误恢复入口）。 */
  reload(): void;
}

export interface UseCloudTaskHistoryReplayOptions {
  readonly controlPlane?: CloudControlPlanePort | null;
  readonly principalId?: string | null;
  readonly taskId?: string | null;
}

export function useCloudTaskHistoryReplay(
  options?: UseCloudTaskHistoryReplayOptions,
): UseCloudTaskHistoryReplayResult {
  const context = useCloudWorkspaceContext();
  const controlPlane = options?.controlPlane ?? context?.controlPlane ?? null;
  const principalId = options?.principalId ?? context?.selection.principalId ?? null;
  // 显式传 null（非云工作区）表示「不取数」，不得回落 context 的选中任务：
  // pane 可能渲染的是另一个未选中 workspace 的会话。
  const taskId =
    options !== undefined && options.taskId !== undefined
      ? options.taskId
      : (context?.selection.taskId ?? null);

  const entry = useCloudTaskHistoryStore((state) =>
    taskId !== null ? state.replayByTask[taskId] : undefined,
  );

  const inFlightRef = useRef(false);

  useEffect(() => {
    if (principalId === null) {
      useCloudTaskHistoryStore.getState().setPrincipal(null);
      return;
    }
    useCloudTaskHistoryStore.getState().setPrincipal(principalId);
  }, [principalId]);

  const loadAll = useCallback(async () => {
    if (!controlPlane || taskId === null || principalId === null || inFlightRef.current) {
      return;
    }
    inFlightRef.current = true;
    useCloudTaskHistoryStore.getState().beginReplayLoad(principalId, taskId, { reset: true });
    try {
      let cursor: string | undefined;
      for (let page = 0; page < REPLAY_MAX_PAGES; page += 1) {
        const state = useCloudTaskHistoryStore.getState();
        const truncated = state.replayByTask[taskId]?.truncated === true;
        if (truncated) {
          break;
        }
        const result = await controlPlane.getTaskHistory(taskId, {
          limit: REPLAY_PAGE_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        });
        useCloudTaskHistoryStore.getState().applyReplayPage(principalId, taskId, result);
        cursor = result.nextCursor;
        if (cursor === undefined) {
          break;
        }
      }
    } catch (loadError) {
      useCloudTaskHistoryStore
        .getState()
        .failReplay(principalId, taskId, describeCloudSubmissionError(loadError));
    } finally {
      inFlightRef.current = false;
    }
  }, [controlPlane, principalId, taskId]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const reload = useCallback(() => {
    void loadAll();
  }, [loadAll]);

  return useMemo(
    () => ({
      status: entry?.status ?? "idle",
      error: entry?.error ?? null,
      replay: entry?.replay ?? createEmptyCloudTaskHistoryReplay(),
      hasMore: entry?.nextCursor !== undefined,
      truncated: entry?.truncated ?? false,
      reload,
    }),
    [entry, reload],
  );
}

/**
 * `useCloudTaskHistory` —— 对话/投影历史读取与折叠（specs/cloud-agent/04 §3.3/§5、03 §9、02 §7.3）。
 *
 * 恢复路径固定为「持久 history 快读 + cursor 增量」，**SSE 只做提示**：
 * `GET /events` 在有界长轮询里返回增量记录或 `timedOut`，`GET /history` 才是权威快读
 * （03 §7「SSE 仅承载 metadata 投影…不能承担对话数据可靠投递」）。
 *
 * 缺口与保留窗越界一律要求重读：拿到 `resyncRequired` 时不静默从零猜（03 §9）。
 * `events` 端点在当前阶段返回 `not_implemented`（shared 端点矩阵），此时
 * `eventsAvailable=false`，UI 不得把它显示成「没有新消息」。
 */
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CloudHistoryItem } from "@zcode/shared";
import { readCloudErrorCode } from "@/cloud/cloudApiErrorLike.js";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { describeCloudSubmissionError } from "@/cloud/cloudTaskSubmission.js";
import type { CloudConversationFold } from "@/store/cloud/cloudConversationFold.js";
import { createEmptyCloudConversationFold } from "@/store/cloud/cloudConversationFold.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import type { CloudCapabilitiesStatus } from "@/cloud/cloudWorkspaceContext.js";
import { useCloudTaskHistoryStore } from "@/store/cloud/cloudTaskHistoryStore.js";

export interface UseCloudTaskHistoryResult {
  readonly status: CloudCapabilitiesStatus;
  readonly error: string | null;
  readonly fold: CloudConversationFold;
  readonly hasMore: boolean;
  /** 保留窗越界或检测到缺口：必须重读权威快照，不能继续追加。 */
  readonly requiresResync: boolean;
  /** `/events` 是否可用；`not_implemented` 时为 false（不伪装成空增量）。 */
  readonly eventsAvailable: boolean;
  refresh(): Promise<void>;
  loadMore(): Promise<void>;
  /** 增量记录入口：由持久 delta 或 events 提示调用，折叠逻辑与 history 共用。 */
  applyDelta(items: readonly CloudHistoryItem[]): void;
}

export interface UseCloudTaskHistoryOptions {
  readonly controlPlane?: CloudControlPlanePort | null;
  readonly principalId?: string | null;
  readonly taskId?: string | null;
  readonly topic?: string;
}

export function useCloudTaskHistory(
  options?: UseCloudTaskHistoryOptions,
): UseCloudTaskHistoryResult {
  const context = useCloudWorkspaceContext();
  const controlPlane = options?.controlPlane ?? context?.controlPlane ?? null;
  const principalId = options?.principalId ?? context?.selection.principalId ?? null;
  const taskId = options?.taskId ?? context?.selection.taskId ?? null;
  const topic = options?.topic;

  const entry = useCloudTaskHistoryStore((state) => (taskId ? state.byTask[taskId] : undefined));
  const inFlightRef = useRef(false);
  const eventsUnavailableRef = useRef(false);

  useEffect(() => {
    if (principalId === null) {
      useCloudTaskHistoryStore.getState().setPrincipal(null);
      return;
    }
    useCloudTaskHistoryStore.getState().setPrincipal(principalId);
  }, [principalId]);

  const loadPage = useCallback(
    async (mode: "replace" | "append") => {
      if (!controlPlane || !taskId || principalId === null || inFlightRef.current) {
        return;
      }
      inFlightRef.current = true;
      if (mode === "replace") {
        useCloudTaskHistoryStore.getState().beginLoad(principalId, taskId);
      }
      try {
        const cursor =
          mode === "append"
            ? useCloudTaskHistoryStore.getState().byTask[taskId]?.nextCursor
            : undefined;
        const page = await controlPlane.getTaskHistory(taskId, {
          ...(topic === undefined ? {} : { topic }),
          ...(cursor === undefined ? {} : { cursor }),
        });
        useCloudTaskHistoryStore
          .getState()
          .applyHistoryPage(principalId, taskId, page, { append: mode === "append" });
      } catch (loadError) {
        if (loadError instanceof Error && loadError.name === "CloudResyncRequiredError") {
          // cursor 越出保留窗：清掉折叠并要求重读，不静默从零猜测（03 §9）。
          useCloudTaskHistoryStore.getState().markResyncRequired(principalId, taskId);
        } else {
          useCloudTaskHistoryStore
            .getState()
            .fail(principalId, taskId, describeCloudSubmissionError(loadError));
        }
      } finally {
        inFlightRef.current = false;
      }
    },
    [controlPlane, principalId, taskId, topic],
  );

  const refresh = useCallback(() => loadPage("replace"), [loadPage]);
  const loadMore = useCallback(() => loadPage("append"), [loadPage]);

  useEffect(() => {
    eventsUnavailableRef.current = false;
    void loadPage("replace");
  }, [loadPage]);

  /**
   * 增量提示的有界长轮询只在 history 就绪后启用；`not_implemented` 是**阶段事实**
   * （shared 端点矩阵），记下来而不是反复重试。
   */
  useEffect(() => {
    if (!controlPlane || !taskId || principalId === null || eventsUnavailableRef.current) {
      return;
    }
    const controller = new AbortController();
    void (async () => {
      try {
        const response = await controlPlane.getTaskEvents(
          taskId,
          { ...(topic === undefined ? {} : { topic }), waitMs: 0 },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted && response.items.length > 0) {
          useCloudTaskHistoryStore
            .getState()
            .applyHistoryDelta(principalId, taskId, response.items);
        }
      } catch (eventsError) {
        if (readCloudErrorCode(eventsError) === "not_implemented") {
          eventsUnavailableRef.current = true;
          return;
        }
        // 其它失败不阻断历史读取：events 只是提示，权威恢复走 history。
      }
    })();
    return () => controller.abort();
  }, [controlPlane, principalId, taskId, topic, entry?.status]);

  const applyDelta = useCallback(
    (items: readonly CloudHistoryItem[]) => {
      if (principalId === null || !taskId) {
        return;
      }
      useCloudTaskHistoryStore.getState().applyHistoryDelta(principalId, taskId, items);
    },
    [principalId, taskId],
  );

  const fold = entry?.fold ?? createEmptyCloudConversationFold(topic);

  return useMemo(
    () => ({
      status: entry?.status ?? "idle",
      error: entry?.error ?? null,
      fold,
      hasMore: entry?.nextCursor !== undefined,
      requiresResync: entry?.requiresResync ?? false,
      eventsAvailable: !eventsUnavailableRef.current,
      refresh,
      loadMore,
      applyDelta,
    }),
    [applyDelta, entry, fold, loadMore, refresh],
  );
}

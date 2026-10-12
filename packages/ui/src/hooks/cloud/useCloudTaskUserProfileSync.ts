/**
 * `useCloudTaskUserProfileSync` —— 云任务面板的「同步用户资源」动作（specs/cloud-agent
 * 14 §4.6/§9.5、03 §6；W11 §13D）。
 *
 * 背景：连接期同步（2026-10-11 简化定调）的连接态手动触发入口——bridge ready 后控制面
 * 已自动同步一次，用户在这里可以对最新 profile 再同步任意次（只补新增/覆盖，14 §4.7）。
 *
 * 接线（与 `CloudTaskRunStatusBanner` / `useCloudTaskStop` 同款判定，不造第二份事实）：
 * - 选中任务直接读 context 的详情投影；非选中的云任务工作区用 `useCloudTask` 兜底；
 * - attachment 在线 = `selectCloudAttachmentForTask(context.attachment, taskId)`（04 §3.3）；
 * - Run 状态取详情投影 `activeRun.status`（纯投影在 `cloudTaskUserProfileSync.ts`）。
 *
 * 动作语义：调用控制面手动同步端点（`syncTaskUserProfile`），pending 期间禁止重复提交；
 * 成功返回逐条结果摘要，失败归一文案（409 `run-not-connected` → 「沙箱未连接」，14 §4.6）。
 * 端点门控在服务端：UI 隐藏入口只是双保险（UI 不是权限边界）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TaskDetailResponse } from "@zcode/shared";
import { selectCloudAttachmentForTask } from "@/cloud/cloudBrowserServices.js";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import {
  describeCloudUserProfileSyncError,
  resolveCloudUserProfileSyncEntry,
  summarizeCloudUserProfileSync,
  type CloudUserProfileSyncEntryView,
  type CloudUserProfileSyncSummary,
} from "@/cloud/cloudTaskUserProfileSync.js";
import { resolveCloudTaskIdFromWorkspaceIdentity } from "@/cloud/cloudUiBootstrap.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCloudTask } from "./useCloudTask.js";

export interface UseCloudTaskUserProfileSyncResult {
  /** 门控结果（`visible` = 面板是否渲染入口；`hiddenReason` 只作测试/排障）。 */
  readonly entry: CloudUserProfileSyncEntryView;
  /** 同步请求在飞（按钮禁用，防重复提交）。 */
  readonly pending: boolean;
  /** 最近一次手动同步的逐条结果摘要（成功后才有值）。 */
  readonly summary: CloudUserProfileSyncSummary | null;
  /** 最近一次同步失败的归一文案（重试前保留）。 */
  readonly errorText: string | null;
  sync(): Promise<void>;
}

export function useCloudTaskUserProfileSync(
  workspaceIdentity?: string | null,
): UseCloudTaskUserProfileSyncResult {
  const { intl } = useZCodeIntl();
  const taskId = resolveCloudTaskIdFromWorkspaceIdentity(workspaceIdentity);
  const context = useCloudWorkspaceContext();
  // hook 必须无条件调用（React 规则）：选中任务直接读 context 投影，不重复发 GET。
  const isSelectedTask = taskId !== null && context?.selection.taskId === taskId;
  const ownTask = useCloudTask({ taskId: isSelectedTask ? null : taskId });
  const detail: TaskDetailResponse | null = isSelectedTask
    ? (context?.taskDetail ?? null)
    : ownTask.detail;
  const controlPlane: CloudControlPlanePort | null = context?.controlPlane ?? null;

  const [pending, setPending] = useState(false);
  const [summary, setSummary] = useState<CloudUserProfileSyncSummary | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  // 任务切换清空本轮结果（同一槽位复用于另一个任务的工作区）：同步结果与失败文案都是
  // "某个 taskId 的事实"，跨任务展示等于把另一条任务的结果挂到当前任务上。
  // 在飞响应用 `settledTaskRef` 判定归属：切任务后迟到的响应不再写回（不串任务）。
  const settledTaskRef = useRef<string | null>(taskId);
  useEffect(() => {
    settledTaskRef.current = taskId;
    setPending(false);
    setSummary(null);
    setErrorText(null);
  }, [taskId]);

  const attachmentReady =
    selectCloudAttachmentForTask(context?.attachment ?? null, taskId) !== null;
  const entry = useMemo(
    () =>
      resolveCloudUserProfileSyncEntry({
        cloudTaskId: taskId,
        attachmentReady,
        activeRunStatus: detail?.activeRun?.status ?? null,
      }),
    [attachmentReady, detail?.activeRun?.status, taskId],
  );

  const sync = useCallback(async () => {
    if (taskId === null || pending) return;
    const port = controlPlane;
    if (!port) {
      // 未接线控制面端口（嵌入/测试）：与 not_configured 同一文案口径，不伪装成功。
      setErrorText(intl.formatMessage({ id: "settings.cloudUserResources.error.notConfigured" }));
      return;
    }
    const requestTaskId = taskId;
    const stillCurrent = () => settledTaskRef.current === requestTaskId;
    setPending(true);
    setErrorText(null);
    try {
      const response = await port.syncTaskUserProfile(requestTaskId);
      if (!stillCurrent()) return;
      setSummary(summarizeCloudUserProfileSync(response));
    } catch (syncError) {
      if (!stillCurrent()) return;
      setSummary(null);
      setErrorText(
        describeCloudUserProfileSyncError(syncError, (id) => intl.formatMessage({ id })),
      );
    } finally {
      if (stillCurrent()) setPending(false);
    }
  }, [controlPlane, intl, pending, taskId]);

  return { entry, pending, summary, errorText, sync };
}

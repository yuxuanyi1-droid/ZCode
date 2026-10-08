/**
 * 云任务已归档只读横幅（specs/cloud-agent/04 §3.3 状态矩阵 archived 行、
 * 2026-10-08 巡检修订）。
 *
 * 背景（实测缺陷）：archived 任务详情无任何只读标识，composer 假可写（输入后
 * Send 静默无请求）。该横幅放在工作区主区（header 之下、聊天区之上，与
 * CloudTaskRunStatusBanner 同一槽位），只按**控制面投影**呈现：
 * - 任务状态为 archived → 只读说明（04 §3.3：archived 行为只读，不接受执行命令）
 *   + 恢复入口（`POST /tasks/:id/restore` 独立端点，经 useCloudTask 分派）；
 * - 恢复可用性只认服务端 actions 投影的 `restore` 成员（03 §6，UI 不按状态猜）；
 * - 非云任务工作区 / 非 archived 返回 null，本地模式零渲染。
 *
 * composer 的禁用由 WorkspaceShellLayout 按 `useCloudTaskWorkspaceStatus` 统一投影
 * （readOnly），本横幅只负责呈现与恢复动作。
 */
import { useCallback, useState } from "react";
import { Archive, Loader2 } from "lucide-react";
import type { TaskDetailResponse } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { toast } from "@/components/ui/toast.js";
import { describeCloudTaskActionError } from "@/cloud/cloudTaskErrorText.js";
import { isCloudTaskRestoreActionAvailable } from "@/cloud/cloudTaskPanel.js";
import { resolveCloudTaskIdFromWorkspaceIdentity } from "@/cloud/cloudUiBootstrap.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { useCloudTask } from "@/hooks/cloud/useCloudTask.js";

export interface CloudTaskArchivedBannerProps {
  /** 当前工作区身份（`cloud-task:<taskId>`）；非云任务返回 null。 */
  readonly workspaceIdentity?: string | null;
  readonly className?: string;
}

export function CloudTaskArchivedBanner({
  workspaceIdentity,
  className,
}: CloudTaskArchivedBannerProps) {
  const { intl } = useZCodeIntl();
  const taskId = resolveCloudTaskIdFromWorkspaceIdentity(workspaceIdentity);
  const context = useCloudWorkspaceContext();
  // hook 必须无条件调用：选中任务直接读 context 投影，不重复发 GET（与 run 横幅同款）。
  const isSelectedTask = taskId !== null && context?.selection.taskId === taskId;
  const ownTask = useCloudTask({ taskId: isSelectedTask ? null : taskId });
  const detail: TaskDetailResponse | null = isSelectedTask
    ? (context?.taskDetail ?? null)
    : ownTask.detail;
  // 恢复动作不依赖详情加载：独立端点（04 §6），autoLoad=false 不触发 GET /tasks/:id。
  const { restoreTask } = useCloudTask({ taskId, autoLoad: false });

  const [restoring, setRestoring] = useState(false);
  const isArchived = detail?.task.status === "archived";
  const canRestore = isArchived && isCloudTaskRestoreActionAvailable(detail);

  const handleRestore = useCallback(() => {
    if (!taskId || restoring) {
      return;
    }
    setRestoring(true);
    void (async () => {
      try {
        // 成功后响应 detail 由 store 合并回投影：状态离开 archived，
        // 本横幅与只读 composer 随投影一起解除。
        await restoreTask();
      } catch (restoreError) {
        // 服务端拒绝必须可见：经错误信封归一成可读文案，不透出原始码（04 §6）。
        toast(
          intl.formatMessage(
            { id: "cloud.tasks.restoreFailed" },
            {
              reason: describeCloudTaskActionError(restoreError, (id) =>
                intl.formatMessage({ id }),
              ),
            },
          ),
        );
        return;
      } finally {
        setRestoring(false);
      }
      // 选中任务补一次详情刷新：banner 读的是 context 投影，restore 端点响应
      // 只进了 useCloudTask 的 store 合并，控制器投影需要对账（04 §3.3）。
      if (context?.selection.taskId === taskId) {
        void context.reloadTask();
      }
    })();
  }, [context, intl, restoring, restoreTask, taskId]);

  if (taskId === null || !isArchived) {
    return null;
  }

  return (
    <div
      role="status"
      data-testid="cloud-task-archived-banner"
      className={cn(
        "flex w-full shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2 text-ui-base text-foreground",
        className,
      )}
    >
      <Archive aria-hidden="true" className="size-4 shrink-0 text-foreground-subtle" />
      <span className="min-w-0 flex-1 truncate font-medium">
        {intl.formatMessage({ id: "cloud.tasks.archivedReadOnlyTitle" })}
      </span>
      <span className="hidden min-w-0 truncate text-foreground-subtle sm:inline">
        {intl.formatMessage({ id: "cloud.tasks.archivedReadOnlyDescription" })}
      </span>
      {canRestore ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          data-testid="cloud-task-restore"
          disabled={restoring}
          onClick={handleRestore}
        >
          {restoring ? <Loader2 aria-hidden="true" className="size-3.5 animate-spin" /> : null}
          {intl.formatMessage({ id: "cloud.tasks.restore" })}
        </Button>
      ) : null}
    </div>
  );
}

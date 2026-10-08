/**
 * 侧栏云任务行（specs/cloud-agent/04 §3.0.1/§3.3、03 §6；2026-10-08 巡检修订）。
 *
 * 从 `CloudProjectTaskSection.tsx` 拆出的行组件（拆分原因：分区结构 + 两种行组件
 * 同文件超过了 max-lines 预算；行组件与分区结构分别演化）：
 * - `CloudTaskRow`：活动任务行（打开任务 + 行内归档入口）；
 * - `CloudArchivedTaskRow`：已归档任务行（打开只读详情 + 行内恢复入口）。
 *
 * 共同约束：
 * - 生命周期动作走 `useCloudTask`（autoLoad=false）→ 控制面独立端点分派
 *   （04 §6：archive/restore 不走 PATCH status），不为行内动作多发 `GET /tasks/:id`；
 * - 服务端拒绝的错误信封经 `describeCloudTaskActionError` 归一成可读文案后 toast；
 * - 行内动作按钮 `stopPropagation`：行本体是打开任务，动作不能冒泡成「打开」。
 */
import { useCallback, useState } from "react";
import { Archive, ArchiveRestore, Loader2 } from "lucide-react";
import type { CloudTaskRecord } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { cn } from "@/components/lib/utils.js";
import { toast } from "@/components/ui/toast.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { useCloudTask } from "@/hooks/cloud/useCloudTask.js";
import { describeCloudTaskActionError } from "@/cloud/cloudTaskErrorText.js";
import {
  isCloudTaskArchiveActionAvailable,
  resolveCloudTaskArchiveAdmission,
} from "@/cloud/cloudTaskPanel.js";

interface CloudTaskRowProps {
  readonly task: CloudTaskRecord;
  readonly selected: boolean;
  readonly onOpen: () => void;
}

export function CloudTaskRow({ task, selected, onOpen }: CloudTaskRowProps) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const isDraft = task.status === "draft";
  // 行内只要生命周期动作（归档）：autoLoad=false 避免整列行各自触发 GET /tasks/:id；
  // 动作走与详情面板同一条 useCloudTask → port.archiveTask 路径（04 §6 独立端点）。
  const { archiveTask, detail, loadDetail } = useCloudTask({
    taskId: task.taskId,
    autoLoad: false,
  });
  // 服务端规则（03 §6）：draft/completed/failed 与「active + 终态 run」可归档；已归档
  // 不重复归档。归档入口可用性与 Header 更多菜单对齐——按 actions 投影门控：
  // 该行有缓存详情（打开过/归档过）而投影不含 archive 时预禁用并说明原因；没有缓存
  // 详情的行保持入口（不为预禁用整列发 GET），点击时先按投影预检
  // （resolveCloudTaskArchiveAdmission），活动 run 未终态时不再发出必被 409 拒绝的
  // 归档请求，而是直接给出「先停止再归档」引导（2026-10-07 终验缺陷 E）。
  const archiveVisible = task.status !== "archived";
  const archiveUnavailable =
    archiveVisible && detail !== null && !isCloudTaskArchiveActionAvailable(detail);

  const handleArchive = useCallback(() => {
    void (async () => {
      const confirmed = await confirmDialog({
        title: intl.formatMessage({ id: "cloud.tasks.archiveConfirmTitle" }),
        description: intl.formatMessage(
          { id: "cloud.tasks.archiveConfirmDescription" },
          { taskTitle: task.title.trim() || intl.formatMessage({ id: "taskList.untitled" }) },
        ),
        confirmLabel: intl.formatMessage({ id: "cloud.tasks.archive" }),
      });
      if (!confirmed) {
        return;
      }
      // 无缓存详情时先拉一次详情做准入预检：投影不含 archive（存在未终态 run 的
      // 唯一非归档情形）就直接引导「先停止」，不发必被服务端 409 拒绝的请求；
      // 详情拉不到（unknown）回落服务端裁决，错误经归一文案呈现。
      const admission = await resolveCloudTaskArchiveAdmission({
        cachedDetail: detail,
        loadDetail,
      });
      if (admission.kind === "blocked-active-run") {
        toast(intl.formatMessage({ id: "cloud.errors.not_ready.task_has_active_run" }));
        return;
      }
      try {
        // 成功后响应 detail 由 store 合并回项目列表，归档行随投影移入已归档分区。
        await archiveTask();
      } catch (archiveError) {
        // 服务端错误信封归一成可读文案（04 §6）：不再透出 validation_failed 之类的原始码。
        toast(
          intl.formatMessage(
            { id: "cloud.tasks.archiveFailed" },
            {
              reason: describeCloudTaskActionError(archiveError, (id) =>
                intl.formatMessage({ id }),
              ),
            },
          ),
        );
      }
    })();
  }, [archiveTask, confirmDialog, detail, intl, loadDetail, task.title]);

  return (
    <div className="group/task flex h-6 min-w-0 items-center rounded-md">
      <button
        type="button"
        data-testid="cloud-task-row"
        data-status={task.status}
        data-selected={selected ? "true" : undefined}
        className={cn(
          "flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-ui-base outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          selected
            ? "bg-active text-foreground"
            : "text-foreground-subtle hover:bg-hover hover:text-foreground",
        )}
        onClick={onOpen}
      >
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
        {isDraft ? (
          <span className="shrink-0 rounded bg-surface px-1 text-ui-base text-foreground-subtlest">
            {intl.formatMessage({ id: "cloud.tasks.draftBadge" })}
          </span>
        ) : null}
      </button>
      {archiveVisible ? (
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "cloud.tasks.archive" })}
          title={
            archiveUnavailable
              ? intl.formatMessage({ id: "cloud.tasks.archiveUnavailable" })
              : intl.formatMessage({ id: "cloud.tasks.archive" })
          }
          data-testid="cloud-task-archive"
          disabled={archiveUnavailable}
          className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-foreground-subtlest opacity-0 outline-none transition-opacity hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-40 group-hover/task:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={(event) => {
            // 行本体是打开任务；归档是独立动作，不能冒泡成「打开」。
            event.stopPropagation();
            handleArchive();
          }}
        >
          <Archive aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/**
 * 已归档任务行（04 §3 2026-10-08 巡检修订）：可打开（详情只读呈现），行内提供恢复。
 * 恢复走与归档对称的独立端点 `POST /tasks/:id/restore`（useCloudTask → 分派器），
 * 成功后响应 detail 由 store 合并回项目列表——行随投影离开归档分区、回到活动列表。
 */
export function CloudArchivedTaskRow({ task, selected, onOpen }: CloudTaskRowProps) {
  const { intl } = useZCodeIntl();
  const { restoreTask } = useCloudTask({ taskId: task.taskId, autoLoad: false });
  const [restoring, setRestoring] = useState(false);

  const handleRestore = useCallback(() => {
    if (restoring) {
      return;
    }
    setRestoring(true);
    void (async () => {
      try {
        await restoreTask();
      } catch (restoreError) {
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
      // 成功无需额外处理：detail 合并回 store 后，投影把该行移出归档分区。
    })();
  }, [intl, restoreTask, restoring]);

  return (
    <div className="group/archived-task flex h-6 min-w-0 items-center rounded-md">
      <button
        type="button"
        data-testid="cloud-task-archived-row"
        data-status={task.status}
        data-selected={selected ? "true" : undefined}
        className={cn(
          "flex h-6 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-ui-base outline-none focus-visible:ring-2 focus-visible:ring-ring/30",
          selected
            ? "bg-active text-foreground"
            : "text-foreground-subtlest hover:bg-hover hover:text-foreground",
        )}
        onClick={onOpen}
      >
        <Archive aria-hidden="true" className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{task.title}</span>
      </button>
      <button
        type="button"
        aria-label={intl.formatMessage({ id: "cloud.tasks.restore" })}
        title={intl.formatMessage({ id: "cloud.tasks.restore" })}
        data-testid="cloud-task-restore"
        disabled={restoring}
        className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded-md text-foreground-subtlest opacity-0 outline-none transition-opacity hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 disabled:pointer-events-none disabled:opacity-40 group-hover/archived-task:opacity-100 [@media(hover:none)]:opacity-100"
        onClick={(event) => {
          // 行本体是打开任务；恢复是独立动作，不能冒泡成「打开」。
          event.stopPropagation();
          handleRestore();
        }}
      >
        {restoring ? (
          <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
        ) : (
          <ArchiveRestore aria-hidden="true" className="size-3.5" />
        )}
      </button>
    </div>
  );
}

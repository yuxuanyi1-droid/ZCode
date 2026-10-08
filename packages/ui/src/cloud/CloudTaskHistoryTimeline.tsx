/**
 * 云任务跨 run 只读历史时间线（specs/cloud-agent/04 §3.3 状态矩阵 archived 行
 * 「只读 + 历史可查看」、2026-10-09 终验缺陷 D 的呈现点）。
 *
 * 数据来自 `useCloudTaskHistoryReplay`（控制面权威历史的跨 run 回放）。呈现规则：
 * - 该任务没有任何已投影历史（或仍在加载）→ null，不占位（归档前/新任务零渲染）；
 * - 归档 / 无在线 run：全部 run 的已投影回合按时间合并呈现（替换空时间线）；
 * - 重开后的在线 run：当前 run 的流由实时订阅呈现（`excludeTopic` 排除），这里只补
 *   旧 run 的历史，插在实时时间线上方（ConversationTimeline headerSlot 槽位）。
 *
 * 只读呈现复用 Share 与 Desktop 共用的 ConversationShareReadonlyTimeline，
 * 不复制第二套 row/turn 渲染。
 */
import { AlertTriangleIcon, HistoryIcon, Loader2 } from "lucide-react";
import type { Locale } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ConversationShareReadonlyTimeline } from "@/v4/ConversationShareReadonlyTimeline.js";
import type { UseCloudTaskHistoryReplayResult } from "@/hooks/cloud/useCloudTaskHistoryReplay.js";
import { resolveCloudTaskHistoryViewPlan } from "@/store/cloud/cloudTaskHistoryReplay.js";

export interface CloudTaskHistoryTimelineProps {
  /** pane 已持有的跨 run 历史读取结果（SessionPane 统一调用 hook，避免重复分页）。 */
  readonly history: UseCloudTaskHistoryReplayResult;
  /** 当前实时 run 的会话话题（`conversation/<sessionId>`）；该流不在此重复渲染。 */
  readonly excludeTopic?: string | null;
  readonly locale?: Locale;
  readonly className?: string;
}

export function CloudTaskHistoryTimeline({
  history,
  excludeTopic,
  locale,
  className,
}: CloudTaskHistoryTimelineProps) {
  const { intl } = useZCodeIntl();
  // 呈现判定收在纯函数（resolveCloudTaskHistoryViewPlan，node:test 覆盖）：
  // 排除当前实时流、无历史不占位、行数合计供 DOM 打点。
  const plan = resolveCloudTaskHistoryViewPlan({
    status: history.status,
    streams: history.replay.streams,
    ...(excludeTopic !== undefined ? { excludeTopic } : {}),
  });

  if (!plan.visible) {
    return null;
  }

  return (
    <section
      data-testid="cloud-task-history-timeline"
      data-history-status={history.status}
      data-stream-count={plan.streams.length}
      data-row-count={plan.rowCount}
      className={cn("flex w-full flex-col gap-2 py-2", className)}
    >
      <div className="flex items-center gap-2 px-4 text-ui-sm text-foreground-subtle">
        <HistoryIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 truncate font-medium">
          {intl.formatMessage({ id: "cloud.history.sectionTitle" })}
        </span>
        {history.status === "loading" ? (
          <span
            data-testid="cloud-task-history-loading"
            className="flex min-w-0 items-center gap-1.5"
          >
            <Loader2 aria-hidden className="size-3 animate-spin" />
            {intl.formatMessage({ id: "cloud.history.loading" })}
          </span>
        ) : null}
        {history.truncated ? (
          <span data-testid="cloud-task-history-truncated" className="min-w-0 truncate">
            {intl.formatMessage({ id: "cloud.history.truncated" })}
          </span>
        ) : null}
      </div>
      {plan.streams.map((stream) => (
        <div
          key={stream.topic}
          data-testid="cloud-task-history-stream"
          data-topic={stream.topic}
          data-row-count={stream.rows.length}
          className="flex w-full flex-col"
        >
          {stream.incomplete ? (
            <div
              data-testid="cloud-task-history-stream-incomplete"
              className="flex items-center gap-1.5 px-4 text-ui-xs text-foreground-subtle"
            >
              <AlertTriangleIcon aria-hidden className="size-3 shrink-0" />
              {intl.formatMessage({ id: "cloud.history.incompleteStream" })}
            </div>
          ) : null}
          <ConversationShareReadonlyTimeline rows={stream.rows} locale={locale} />
        </div>
      ))}
      {history.status === "error" ? (
        <div
          data-testid="cloud-task-history-error"
          className="flex items-center gap-2 px-4 text-ui-sm text-[var(--color-danger)]"
        >
          <span className="min-w-0 flex-1">
            {history.error ?? intl.formatMessage({ id: "cloud.history.loadFailed" })}
          </span>
          <Button type="button" variant="outline" size="sm" onClick={history.reload}>
            {intl.formatMessage({ id: "common.retry" })}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

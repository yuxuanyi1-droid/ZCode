import { useCallback } from "react";
import { TID_V4_RETRY_SUBSCRIBE } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { toast } from "@/components/ui/toast.js";
import { useFeedbackStore } from "@/feedback/feedbackStore.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { buildErrorFeedbackDescription } from "@/lib/errorFeedbackDraft.js";
import { classifySubscribeError } from "@/v4/subscribeErrorPresentation.js";

interface SessionSubscriptionErrorPanelProps {
  error: string;
  sessionId: string;
  workspacePath: string;
  onReconnect: () => void;
}

/**
 * 订阅失败的错误呈现（2026-10-08 巡检修订，P1）：
 * 原始错误**不得作为对话正文**渲染——之前把 `state.lastError` 直接印在会话区，云任务
 * 空串路径握手被 runtime zod 拒绝时用户看到的是 issues JSON 数组（服务端 run 实际成功，
 * 错误呈现与事实相反）。现在：
 * - 标题按分类给出：结构化校验拒绝用专门文案，其它沿用连接失败文案；
 * - 原始串收进可展开的次要细节区（反馈/排障仍可用），永不占据正文。
 */
export function SessionSubscriptionErrorPanel({
  error,
  sessionId,
  workspacePath,
  onReconnect,
}: SessionSubscriptionErrorPanelProps) {
  const { intl } = useZCodeIntl();
  const openFeedbackSubmit = useFeedbackStore((state) => state.openSubmit);
  const presentation = classifySubscribeError(error);
  const handleOpenFeedback = useCallback(async () => {
    openFeedbackSubmit({
      title: error.slice(0, 80),
      type: "bug",
      module: "Agent任务执行失败",
      severity: "P2-中",
      includeLogs: false,
      description: buildErrorFeedbackDescription({
        message: error,
        contextLines: [
          intl.formatMessage({ id: "feedback.submit.template.section.taskInfo" }),
          intl.formatMessage({ id: "feedback.submit.template.section.taskId" }, { id: sessionId }),
          intl.formatMessage(
            { id: "feedback.submit.template.section.taskWorkspace" },
            { path: workspacePath },
          ),
        ],
        formatMessage: (id: string, values?: Record<string, string>) =>
          intl.formatMessage({ id }, values),
      }),
      screenshots: [],
    });
    toast(intl.formatMessage({ id: "chat.error.feedbackOpened" }));
  }, [error, intl, openFeedbackSubmit, sessionId, workspacePath]);

  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-ui-base">
      <p
        role="alert"
        data-testid="v4-subscribe-error-title"
        className="max-w-full text-center text-foreground"
      >
        {intl.formatMessage({
          id:
            presentation.kind === "structured-validation"
              ? "cloud.run.error.validationRejected"
              : "chat.error.connectionLost",
        })}
      </p>
      {presentation.detail ? (
        <details className="max-w-full text-ui-sm text-foreground-subtle">
          <summary className="cursor-pointer break-words text-center">
            {intl.formatMessage({ id: "cloud.run.error.technicalDetail" })}
          </summary>
          <p className="mt-1 max-h-40 max-w-[36rem] overflow-auto rounded-md bg-surface-hover px-2 py-1 font-mono text-ui-xs [overflow-wrap:anywhere]">
            {presentation.detail}
          </p>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center justify-center gap-2">
        <Button type="button" variant="outline" onClick={handleOpenFeedback}>
          {intl.formatMessage({ id: "chat.error.feedback" })}
        </Button>
        <Button type="button" data-testid={TID_V4_RETRY_SUBSCRIBE} onClick={onReconnect}>
          {intl.formatMessage({ id: "workspaceSidebar.reconnect" })}
        </Button>
      </div>
    </div>
  );
}

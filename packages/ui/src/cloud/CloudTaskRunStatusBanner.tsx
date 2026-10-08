/**
 * 云任务运行状态横幅（specs/cloud-agent/04 §3.3 状态矩阵、08 §8.2 停止/§9 重开）。
 *
 * 背景（2026-10-08 实测缺陷）：run 因 E2B 拒绝等原因进入 `failed` 时 UI 没有任何
 * 失败呈现，用户只觉得「没反应」。该横幅放在工作区主区（header 之下、聊天区之上），
 * 只按**详情投影**呈现：
 * - `waiting-for-run` / `provisioning`：进行中提示（04 §3.2.4「202 后等待环境」）；
 * - `draining`（2026-10-08 巡检修订 P1）：stop 端点受理后的受控停止窗口，呈现
 *   「正在停止」而不是永远 Working；提供 force-stop 入口（丢失确认对话框，
 *   `lossAcknowledgement:true + expectedRevision + operationId`，08 §8.2）；
 * - `failed` / `stopped` / `expired`：失败/终止原因（run.lastError/endReason，shared
 *   契约为驼峰字段）+ 显式重开入口（`useReopenCloudTask`，独立命令不借 append）。
 *
 * 规则本体在 `cloudTaskPanel.ts`（纯投影，node:test 覆盖）；本组件只做绑定：
 * - 选中任务读 context 的唯一投影；非选中的云任务工作区用 `useCloudTask` 兜底，
 *   不复制第二份权威状态；
 * - 重开 resume 模式按事实自动选（有确认 checkpoint → checkpoint，否则
 *   restart-from-base）并向用户说明依据（08 §9：分支两侧必须显式声明）。
 */
import { useCallback, useMemo, useState } from "react";
import { AlertTriangle, Loader2, OctagonX, RotateCcw } from "lucide-react";
import type { TaskDetailResponse } from "@zcode/shared";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Checkbox } from "@/components/ui/checkbox.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { describeCloudSubmissionError } from "@/cloud/cloudTaskSubmission.js";
import {
  isCloudTaskForceStopActionAvailable,
  projectCloudTaskRunPanel,
  resolveCloudReopenPlan,
} from "@/cloud/cloudTaskPanel.js";
import { resolveCloudTaskIdFromWorkspaceIdentity } from "@/cloud/cloudUiBootstrap.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { createCloudCommandId } from "@/hooks/cloud/useSubmitCloudInput.js";
import { useCloudTask } from "@/hooks/cloud/useCloudTask.js";
import { useReopenCloudTask } from "@/hooks/cloud/useReopenCloudTask.js";

export interface CloudTaskRunStatusBannerProps {
  /** 当前工作区身份（`cloud-task:<taskId>`）；非云任务返回 null。 */
  readonly workspaceIdentity?: string | null;
  readonly className?: string;
}

export function CloudTaskRunStatusBanner({
  workspaceIdentity,
  className,
}: CloudTaskRunStatusBannerProps) {
  const { intl } = useZCodeIntl();
  const taskId = resolveCloudTaskIdFromWorkspaceIdentity(workspaceIdentity);
  const context = useCloudWorkspaceContext();
  // hook 必须无条件调用：选中任务直接读 context 投影，不重复发 GET（与 composer 同款）。
  const isSelectedTask = taskId !== null && context?.selection.taskId === taskId;
  const ownTask = useCloudTask({ taskId: isSelectedTask ? null : taskId });
  const detail: TaskDetailResponse | null = isSelectedTask
    ? (context?.taskDetail ?? null)
    : ownTask.detail;

  const view = useMemo(() => projectCloudTaskRunPanel(detail), [detail]);
  const reopenPlan = useMemo(() => resolveCloudReopenPlan(detail), [detail]);
  const forceStopAvailable = useMemo(() => isCloudTaskForceStopActionAvailable(detail), [detail]);

  // useReopenCloudTask 走 context 的 selection scope：只对「当前选中的任务」提供重开，
  // 非选中工作区不给出一个必失败的入口。
  const canReopen = isSelectedTask && reopenPlan.available;
  const { reopenTask } = useReopenCloudTask();
  const controlPlane = context?.controlPlane ?? null;
  const reloadTask = context?.reloadTask;

  // force-stop（08 §8.2）：独立 operationId + 显式丢失确认 + revision CAS；
  // 普通 stop 失败/超时不得自动升级（服务端契约 forceStopCloudTaskRequestSchema）。
  const [forceStopOpen, setForceStopOpen] = useState(false);
  const [forceStopAcknowledged, setForceStopAcknowledged] = useState(false);
  const [forceStopSubmitting, setForceStopSubmitting] = useState(false);
  const [forceStopError, setForceStopError] = useState<string | null>(null);

  const handleForceStopSubmit = useCallback(() => {
    if (!detail || !taskId || forceStopSubmitting) {
      return;
    }
    const controlPlaneForTask = controlPlane;
    if (!controlPlaneForTask) {
      setForceStopError("cloud control plane is not configured");
      return;
    }
    setForceStopSubmitting(true);
    setForceStopError(null);
    void (async () => {
      try {
        await controlPlaneForTask.forceStopTask(taskId, {
          lossAcknowledgement: true,
          expectedRevision: detail.task.revision,
          // operationId 与 commandId 同一 uuid 词表（cloudUuidSchema）；幂等键只在
          // 用户确认的那一刻生成，失败重试由用户再次确认后用新键（服务端 CAS 裁决）。
          operationId: createCloudCommandId(),
        });
        setForceStopOpen(false);
        setForceStopAcknowledged(false);
        if (isSelectedTask) {
          await reloadTask?.(taskId);
        }
      } catch (forceStopError_) {
        setForceStopError(describeCloudSubmissionError(forceStopError_));
      } finally {
        setForceStopSubmitting(false);
      }
    })();
  }, [controlPlane, detail, forceStopSubmitting, isSelectedTask, reloadTask, taskId]);

  const [reopenFormOpen, setReopenFormOpen] = useState(false);
  const [reopenPrompt, setReopenPrompt] = useState("");
  const [reopenError, setReopenError] = useState<string | null>(null);
  const [reopenSubmitting, setReopenSubmitting] = useState(false);

  const handleReopenSubmit = useCallback(() => {
    if (!detail || reopenSubmitting) {
      return;
    }
    const prompt = reopenPrompt.trim();
    const provider = reopenPlan.provider;
    if (!prompt || !provider) {
      return;
    }
    setReopenSubmitting(true);
    setReopenError(null);
    void (async () => {
      try {
        const outcome = await reopenTask({
          prompt,
          provider,
          resume: reopenPlan.resume,
          expectedTaskRevision: detail.task.revision,
        });
        if (outcome.kind === "persisted") {
          // 新 run 进入 provisioning：收起表单，轮询/横幅接管后续呈现。
          setReopenFormOpen(false);
          setReopenPrompt("");
          return;
        }
        // rejected/unknown 保留正文，把服务端理由呈现出来（03 §5/04 §3.4）。
        setReopenError(outcome.message);
      } catch (reopenRequestError) {
        setReopenError(describeCloudSubmissionError(reopenRequestError));
      } finally {
        setReopenSubmitting(false);
      }
    })();
  }, [detail, reopenPlan, reopenPrompt, reopenSubmitting, reopenTask]);

  if (taskId === null || view.kind === "hidden") {
    return null;
  }

  if (view.kind === "waiting-for-run" || view.kind === "provisioning") {
    return (
      <div
        role="status"
        data-testid="cloud-task-run-status"
        data-run-state={view.kind}
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-border bg-surface px-4 py-2 text-ui-base text-foreground-subtle",
          className,
        )}
      >
        <Loader2 aria-hidden="true" className="size-4 shrink-0 animate-spin" />
        <span className="min-w-0 truncate">
          {intl.formatMessage({
            id:
              view.kind === "provisioning"
                ? "cloud.run.statusProvisioning"
                : "cloud.run.statusWaitingForRun",
          })}
        </span>
      </div>
    );
  }

  if (view.kind === "draining") {
    // 受控停止窗口（2026-10-08 巡检修订 P1）：stop 已受理，run 正在保存/收尾。
    // 呈现「正在停止」而不是让 composer 永远显示 Working；force-stop 是显式
    // 丢失确认的收口入口（08 §8.2），只在服务端 actions 投影提供时出现。
    return (
      <div
        role="status"
        data-testid="cloud-task-run-status"
        data-run-state="draining"
        className={cn(
          "flex w-full shrink-0 flex-col gap-2 border-b border-border bg-surface px-4 py-2 text-ui-base text-foreground",
          className,
        )}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <Loader2
            aria-hidden="true"
            className="size-4 shrink-0 animate-spin text-foreground-subtle"
          />
          <span className="min-w-0 flex-1 font-medium">
            {intl.formatMessage({ id: "cloud.run.statusDraining" })}
          </span>
          {forceStopAvailable ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              data-testid="cloud-task-force-stop"
              disabled={forceStopSubmitting}
              onClick={() => {
                setForceStopOpen((open) => !open);
                setForceStopError(null);
              }}
            >
              <OctagonX aria-hidden="true" className="size-3.5" />
              {intl.formatMessage({ id: "cloud.run.forceStop" })}
            </Button>
          ) : null}
        </div>
        {forceStopAvailable && forceStopOpen ? (
          <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface p-3">
            <p className="text-ui-base font-medium">
              {intl.formatMessage({ id: "cloud.run.forceStopTitle" })}
            </p>
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "cloud.run.forceStopDescription" })}
            </p>
            <label className="flex items-start gap-2 text-ui-base">
              <Checkbox
                checked={forceStopAcknowledged}
                disabled={forceStopSubmitting}
                onCheckedChange={(checked) => setForceStopAcknowledged(checked === true)}
              />
              <span className="text-foreground-subtle">
                {intl.formatMessage({ id: "cloud.run.forceStopConfirm" })}
              </span>
            </label>
            {forceStopError ? (
              <p
                className="text-ui-base text-destructive"
                data-testid="cloud-task-force-stop-error"
              >
                {forceStopError}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={forceStopSubmitting}
                onClick={() => {
                  setForceStopOpen(false);
                  setForceStopError(null);
                }}
              >
                {intl.formatMessage({ id: "cloud.projects.cancel" })}
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                data-testid="cloud-task-force-stop-submit"
                disabled={forceStopSubmitting || !forceStopAcknowledged || !detail}
                onClick={handleForceStopSubmit}
              >
                {forceStopSubmitting ? (
                  <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                ) : (
                  <OctagonX aria-hidden="true" className="size-3.5" />
                )}
                {intl.formatMessage({ id: "cloud.run.forceStopSubmit" })}
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    );
  }

  // view.kind === "ended"（failed/stopped/expired）：呈现原因 + 重开入口。
  const endedTitleId =
    view.runStatus === "failed"
      ? "cloud.run.statusFailedTitle"
      : view.runStatus === "stopped"
        ? "cloud.run.statusStoppedTitle"
        : "cloud.run.statusExpiredTitle";
  const reason = view.lastError ?? view.endReason;

  return (
    <div
      role="status"
      data-testid="cloud-task-run-status"
      data-run-state={view.runStatus}
      className={cn(
        "flex w-full shrink-0 flex-col gap-2 border-b px-4 py-2 text-ui-base",
        view.runStatus === "failed"
          ? "border-destructive/30 bg-destructive/5 text-foreground"
          : "border-border bg-surface text-foreground",
        className,
      )}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <AlertTriangle
          aria-hidden="true"
          className={cn(
            "size-4 shrink-0",
            view.runStatus === "failed" ? "text-destructive" : "text-foreground-subtle",
          )}
        />
        <span
          className={cn(
            "min-w-0 flex-1 font-medium",
            view.runStatus === "failed" ? "text-destructive" : "text-foreground",
          )}
        >
          {intl.formatMessage({ id: endedTitleId })}
        </span>
        {canReopen ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="cloud-task-reopen"
            onClick={() => {
              setReopenFormOpen((open) => !open);
              setReopenError(null);
            }}
          >
            <RotateCcw aria-hidden="true" className="size-3.5" />
            {intl.formatMessage({ id: "cloud.run.reopen" })}
          </Button>
        ) : null}
      </div>
      {reason ? (
        <p
          data-testid="cloud-task-run-error"
          className="min-w-0 break-words [overflow-wrap:anywhere] text-ui-base text-foreground-subtle"
        >
          {reason}
        </p>
      ) : null}
      {canReopen && reopenFormOpen ? (
        <div className="flex min-w-0 flex-col gap-2 rounded-xl border border-border bg-surface p-3">
          <label htmlFor="cloud-task-reopen-prompt" className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "cloud.run.reopenPromptLabel" })}
          </label>
          <Textarea
            id="cloud-task-reopen-prompt"
            data-testid="cloud-task-reopen-prompt"
            value={reopenPrompt}
            rows={3}
            className="text-ui-base"
            placeholder={intl.formatMessage({ id: "cloud.run.reopenPromptPlaceholder" })}
            onChange={(event) => {
              setReopenPrompt(event.target.value);
            }}
          />
          {/* resume 按持久事实自动选择（08 §9），并说明依据；不提供与服务端事实冲突的选项。 */}
          <p className="text-ui-base text-foreground-subtle" data-testid="cloud-task-reopen-resume">
            {intl.formatMessage({
              id: reopenPlan.hasSavedCheckpoint
                ? "cloud.run.reopenResumeCheckpoint"
                : "cloud.run.reopenResumeBase",
            })}
          </p>
          {reopenPlan.provider === null ? (
            <p className="text-ui-base text-destructive">
              {intl.formatMessage({ id: "cloud.run.reopenProviderMissing" })}
            </p>
          ) : null}
          {reopenError ? (
            <p className="text-ui-base text-destructive" data-testid="cloud-task-reopen-error">
              {reopenError}
            </p>
          ) : null}
          <div className="flex items-center justify-end gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setReopenFormOpen(false);
                setReopenError(null);
              }}
            >
              {intl.formatMessage({ id: "cloud.projects.cancel" })}
            </Button>
            <Button
              type="button"
              size="sm"
              data-testid="cloud-task-reopen-submit"
              disabled={
                reopenSubmitting || reopenPrompt.trim().length === 0 || reopenPlan.provider === null
              }
              onClick={handleReopenSubmit}
            >
              {reopenSubmitting ? (
                <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
              ) : (
                <RotateCcw aria-hidden="true" className="size-3.5" />
              )}
              {intl.formatMessage({ id: "cloud.run.reopenSubmit" })}
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

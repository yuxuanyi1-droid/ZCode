/**
 * `useCloudComposerSubmit` —— 原 composer 的云发送适配（specs/cloud-agent 04 §3.2/§3.3/§3.4、
 * 03 §7.2、11 §6）。
 *
 * 把「用户按下发送」翻译成 durable input port 的一次调用，并把结果收敛成原
 * composer 已有的三种返回值，避免在 `SessionPane` 里铺开云分支：
 *
 * | 结果 | 含义 | composer 表现 |
 * | --- | --- | --- |
 * | `sent` | 控制面已持久接收（202 / reopen 200） | 与原发送成功一致，清空输入 |
 * | `blocked` | 明确失败 / 本地冻结失败 / 未 ready | 保留正文 + 错误横幅 |
 * | `unknown` | 结果不明，需按原 commandId 对账 | 保留正文 + 「结果待确认」，**不显示成功** |
 *
 * 关键区别：`sent` 也只代表 HTTP 接收，不代表 runtime 已准入。UI 不合成 CommandAck；
 * 投递结果由 receipt / `queryConversationCommandsV4` 对账后显示（03 §6.2）。
 *
 * 发送路由由 `resolveCloudComposerSendPlan`（纯函数，node:test 覆盖）决定
 * （2026-10-08 终态 run 发送行为修订，04 §3.3、03 §6、08 §5/§9）：draft → start；
 * 投影里有 run → append；无有效 run 且用户显式发送 → 自动改走 reopen（消息即新
 * 工作要求，resume 按持久事实自动选择）。只在「用户主动发送」触发；草稿恢复、
 * 对账、重试等自动路径不得触发重开。竞态兜底：详情陈旧时 append 收到 409
 * `not_ready/no-active-run` → 刷新详情 + 按 `resolveCloudReopenRetryPlan` 自动重开
 * 重试一次；其他 `not_ready` reason 不自动重开。
 *
 * 取数只有一份：当前工作区就是控制器选中的 Task 时直接读 context 的详情投影，
 * 不重复发 `GET /api/cloud/tasks/:taskId`（04 §5「只作 expected 值用于 stale 检测」）。
 */
import { useCallback, useMemo } from "react";
import type {
  CloudExecutionConfig,
  CloudRunRecord,
  CloudTaskRecord,
  TaskDetailResponse,
} from "@zcode/shared";
import type { CloudSubmissionOutcome } from "@/cloud/cloudTaskSubmission.js";
import { isCloudNoActiveRunRejection } from "@/cloud/cloudTaskSubmission.js";
import {
  buildCloudRequestedConfig,
  resolveCloudComposerSendPlan,
  resolveCloudReopenRetryPlan,
  type CloudComposerBlockedHint,
} from "@/cloud/cloudTaskPanel.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { resolveCloudTaskIdFromWorkspaceIdentity } from "@/cloud/cloudUiBootstrap.js";
import { useCloudTask } from "./useCloudTask.js";
import { useReopenCloudTask } from "./useReopenCloudTask.js";
import { useSubmitCloudInput } from "./useSubmitCloudInput.js";
import type { ComposerSubmissionConfig } from "@/v4/composer/composerSubmissionConfig.js";

export type { CloudComposerBlockedHint };
export type CloudComposerSubmitResult = "sent" | "blocked" | "unknown";

/**
 * 一次云发送的结构化结果（2026-10-08 巡检修订 P2 / 终态 run 发送行为修订）：
 * - `status === "sent"` 携带 `commandId`，pane 用它登记 optimistic pending overlay
 *   （AGENTS：pending optimistic overlay，不造第二份事实）；`reopenedRun` 表示本次
 *   发送触发了自动重开——新 run 不承接旧 run 的输入（04 §3.4），pane 须同时退场
 *   旧 run 的遗留 overlay；
 * - blocked/unknown 携带结构化 `code`（shared 目录）+ `reason`（服务端稳定标签，
 *   `details.reason`）与原始 `detail`，调用方经 `describeCloudComposerRejection`
 *   归一成用户可读文案。结果在 `send()` 返回值里就地给出，不读 hook 状态——
 *   异步回调里读 hook 状态拿到的是发送前那次 render 的旧值（实测缺陷：
 *   409 之后错误横幅永远不出现）。
 */
export type CloudComposerSendOutcome =
  | { readonly status: "sent"; readonly commandId: string; readonly reopenedRun: boolean }
  | {
      readonly status: "blocked" | "unknown";
      readonly code: string | null;
      readonly reason: string | null;
      readonly detail: string | null;
      readonly blockedHint: CloudComposerBlockedHint | null;
    };

export interface UseCloudComposerSubmitResult {
  /** 当前工作区是否是云任务；false 时调用方必须走原有本机发送路径。 */
  readonly enabled: boolean;
  /** 未决 attempt 数：>0 表示有命令等待对账，UI 应提示而不是放行重复提交。 */
  readonly pendingAttemptCount: number;
  /** 当前 activeRun 状态（无 run 为 null）：pending overlay 的终态收口依据。 */
  readonly activeRunStatus: string | null;
  /**
   * 无有效 run 且服务端 actions 给出 `reopen`（2026-10-08 终态 run 发送行为修订）：
   * 上一个 run 已终态且详情投影不再携带 run 事实——pending overlay 的权威投影
   * 永远不会出现，pane 必须在此状态退场全部遗留 overlay，任务横幅呈现重开视图。
   */
  readonly activeRunGone: boolean;
  /**
   * `submission` 是 composer 在发送点击时冻结的执行配置（createComposerSubmissionConfig）；
   * 云链路把它原样映射为控制面 input 的 `requestedConfig`，随 sendText/createSession
   * 信封下发到沙箱 runtime。null/缺省表示选择未完成，回退 runtime Session Selection。
   */
  send(
    prompt: string,
    submission?: ComposerSubmissionConfig | null,
  ): Promise<CloudComposerSendOutcome>;
}

export function useCloudComposerSubmit(
  workspaceIdentity?: string | null,
): UseCloudComposerSubmitResult {
  const context = useCloudWorkspaceContext();
  const taskId = resolveCloudTaskIdFromWorkspaceIdentity(workspaceIdentity);
  const isSelectedTask = taskId !== null && context?.selection.taskId === taskId;
  const reloadTask = context?.reloadTask;

  // hook 必须无条件调用；已经由控制器取数的任务不再重复请求。
  const ownTask = useCloudTask({ taskId: isSelectedTask ? null : taskId });
  const submit = useSubmitCloudInput();
  // 自动重开走既有 reopen 通路（useReopenCloudTask：冻结 attempt → reopen 端点 →
  // 持久化后刷新详情 + 有界 run 观察）。
  const { reopenTask } = useReopenCloudTask();

  const detail: TaskDetailResponse | null = isSelectedTask
    ? (context?.taskDetail ?? null)
    : ownTask.detail;
  const task: CloudTaskRecord | null = isSelectedTask
    ? (context?.taskDetail?.task ?? null)
    : ownTask.task;
  const activeRun: CloudRunRecord | null = isSelectedTask
    ? (context?.taskDetail?.activeRun ?? null)
    : (ownTask.detail?.activeRun ?? null);

  const enabled = taskId !== null;

  /**
   * 竞态兜底（04 §3.3 修订）：详情陈旧（仍显示活 run）而服务端 run 已终结——append
   * 收到 409 `not_ready/no-active-run`。先刷新详情让「run 已终态」事实到达 UI
   * （ended/reopenable 投影 + overlay 回滚），再按持久事实自动改走 reopen 重试一次；
   * 仅此 reason 自动重开，重试仍失败才呈现归一错误。
   */
  const retryViaReopenAfterNoActiveRun = useCallback(
    async (
      prompt: string,
      appendOutcome: CloudSubmissionOutcome,
      requestedConfig?: CloudExecutionConfig,
    ): Promise<CloudComposerSendOutcome> => {
      if (taskId !== null) {
        // 刷新详情：run 终结事实到达 UI（ended/reopenable 投影 + overlay 回滚）。
        void reloadTask?.(taskId);
      }
      const retryPlan = resolveCloudReopenRetryPlan(detail);
      if (retryPlan === null) {
        return rejectedOutcome(appendOutcome);
      }
      const outcome = await reopenTask({
        prompt,
        provider: retryPlan.provider,
        resume: retryPlan.resume,
        expectedTaskRevision: retryPlan.expectedTaskRevision,
        ...(requestedConfig !== undefined ? { requestedConfig } : {}),
      });
      if (outcome.kind === "persisted") {
        return { status: "sent", commandId: outcome.commandId, reopenedRun: true };
      }
      return rejectedOutcome(outcome);
    },
    [detail, reloadTask, reopenTask, taskId],
  );

  const send = useCallback(
    async (
      prompt: string,
      submission?: ComposerSubmissionConfig | null,
    ): Promise<CloudComposerSendOutcome> => {
      if (!enabled) {
        throw new Error("cloud composer submit used outside a cloud task workspace");
      }
      const requestedConfig = buildCloudRequestedConfig(submission);
      const plan = resolveCloudComposerSendPlan({
        task,
        ...(activeRun !== null ? { activeRun } : {}),
        ...(detail?.latestCheckpoint ? { latestCheckpoint: detail.latestCheckpoint } : {}),
        ...(detail?.actions ? { actions: detail.actions } : {}),
        isSelectedTask,
      });

      switch (plan.kind) {
        case "missing-task":
          // 还没有任务投影：不猜状态，更不能落到本机发送路径。
          return blocked(null, "no-task");
        case "missing-start-config":
          // start 必须携带与已保存 draftStartConfig 一致的选择（03 §6 start 行）：
          // 没有保存过配置就不允许首发，而不是拿默认值凑一个。
          return blocked(null, "no-start-config");
        case "start": {
          const start = task?.draftStartConfig;
          if (!start) {
            return blocked(null, "no-start-config");
          }
          const outcome = await submit.submitFirstInput({
            prompt,
            start,
            expectedTaskRevision: plan.expectedTaskRevision,
            ...(requestedConfig !== undefined ? { requestedConfig } : {}),
          });
          if (outcome.kind === "persisted") {
            return { status: "sent", commandId: outcome.commandId, reopenedRun: false };
          }
          return rejectedOutcome(outcome);
        }
        case "append": {
          const outcome = await submit.submitAppendInput({
            prompt,
            expectedRunGeneration: plan.expectedRunGeneration,
            ...(requestedConfig !== undefined ? { requestedConfig } : {}),
          });
          if (outcome.kind === "persisted") {
            return { status: "sent", commandId: outcome.commandId, reopenedRun: false };
          }
          if (isCloudNoActiveRunRejection(outcome)) {
            return retryViaReopenAfterNoActiveRun(prompt, outcome, requestedConfig);
          }
          return rejectedOutcome(outcome);
        }
        case "reopen": {
          // 无有效 run（2026-10-08 终态 run 发送行为修订）：用户显式发送的这条消息
          // 就是「继续」意图 → 自动重开，不发注定 409（not_ready/no-active-run）的
          // append（04 §3.3、08 §5 修订；服务端仍按 08 §9 独立校验重开前置条件）。
          // requestedConfig 落进新 run 的 firstCommandConfig：重开会话的首发模型/
          // 模式与 composer 当前选择一致，而不是沙箱缺省。
          const outcome = await reopenTask({
            prompt,
            provider: plan.provider,
            resume: plan.resume,
            expectedTaskRevision: plan.expectedTaskRevision,
            ...(requestedConfig !== undefined ? { requestedConfig } : {}),
          });
          if (outcome.kind === "persisted") {
            return { status: "sent", commandId: outcome.commandId, reopenedRun: true };
          }
          return rejectedOutcome(outcome);
        }
        case "reopen-unavailable":
          // 重开入口由服务端 actions 投影裁决（recovery_required 等场景不给 reopen）；
          // provider 未知时无法组装重开请求。不自动重开，由归一文案说明入口限制。
          return blocked(null, "reopen-unavailable");
        case "out-of-scope-blocked":
        default:
          return blocked(null, null);
      }
    },
    [
      activeRun,
      detail,
      enabled,
      isSelectedTask,
      reopenTask,
      retryViaReopenAfterNoActiveRun,
      submit,
      task,
    ],
  );

  const activeRunGone = useMemo(() => {
    if (activeRun !== null || !task || !detail) {
      return false;
    }
    // 终态 run 从详情投影消失（服务端只投影非终态 run）；reopen 能力是服务端对
    // 「无有效写 run」的裁决事实，等待横幅与 overlay 都必须让它收口。
    return (
      (task.status === "active" || task.status === "failed") &&
      (detail.actions ?? []).includes("reopen")
    );
  }, [activeRun, detail, task]);

  return useMemo(
    () => ({
      enabled,
      pendingAttemptCount: submit.pendingAttempts.length,
      activeRunStatus: activeRun?.status ?? null,
      activeRunGone,
      send,
    }),
    [activeRun?.status, activeRunGone, enabled, send, submit.pendingAttempts.length],
  );
}

function blocked(
  detailText: string | null,
  hint: CloudComposerBlockedHint | null,
): CloudComposerSendOutcome {
  return { status: "blocked", code: null, reason: null, detail: detailText, blockedHint: hint };
}

function rejectedOutcome(outcome: CloudSubmissionOutcome): CloudComposerSendOutcome {
  if (outcome.kind === "persisted") {
    return { status: "sent", commandId: outcome.commandId, reopenedRun: false };
  }
  if (outcome.kind === "not-frozen") {
    // 本地冻结失败（04 §3.4.1）：不发 HTTP，按明确失败呈现，保留正文。
    return {
      status: "blocked",
      code: null,
      reason: null,
      detail: outcome.message,
      blockedHint: null,
    };
  }
  return {
    status: outcome.kind === "unknown" ? "unknown" : "blocked",
    code: outcome.code,
    reason: outcome.reason,
    detail: outcome.message,
    blockedHint: null,
  };
}

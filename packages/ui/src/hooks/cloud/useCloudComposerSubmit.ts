/**
 * `useCloudComposerSubmit` —— 原 composer 的云发送适配（specs/cloud-agent 04 §3.2/§3.4、
 * 03 §7.2、11 §6）。
 *
 * 把「用户按下发送」翻译成 durable input port 的一次调用，并把结果收敛成原
 * composer 已有的三种返回值，避免在 `SessionPane` 里铺开云分支：
 *
 * | 结果 | 含义 | composer 表现 |
 * | --- | --- | --- |
 * | `sent` | 控制面已持久接收（202） | 与原发送成功一致，清空输入 |
 * | `blocked` | 明确失败 / 本地冻结失败 / 未 ready | 保留正文 + 错误横幅 |
 * | `unknown` | 结果不明，需按原 commandId 对账 | 保留正文 + 「结果待确认」，**不显示成功** |
 *
 * 关键区别：`sent` 也只代表 **HTTP 202**，不代表 runtime 已准入。UI 不合成 CommandAck；
 * 投递结果由 receipt / `queryConversationCommandsV4` 对账后显示（03 §6.2）。
 *
 * 取数只有一份：当前工作区就是控制器选中的 Task 时直接读 context 的详情投影，
 * 不重复发 `GET /api/cloud/tasks/:taskId`（04 §5「只作 expected 值用于 stale 检测」）。
 */
import { useCallback, useMemo } from "react";
import type { CloudRunRecord, CloudTaskRecord } from "@zcode/shared";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { resolveCloudTaskIdFromWorkspaceIdentity } from "@/cloud/cloudUiBootstrap.js";
import { useCloudTask } from "./useCloudTask.js";
import { useSubmitCloudInput } from "./useSubmitCloudInput.js";

export type CloudComposerSubmitResult = "sent" | "blocked" | "unknown";

export interface UseCloudComposerSubmitResult {
  /** 当前工作区是否是云任务；false 时调用方必须走原有本机发送路径。 */
  readonly enabled: boolean;
  /** 结果待确认 / 明确失败的可读说明；成功与未提交时为 null。 */
  readonly errorDetail: string | null;
  /** 未决 attempt 数：>0 表示有命令等待对账，UI 应提示而不是放行重复提交。 */
  readonly pendingAttemptCount: number;
  send(prompt: string): Promise<CloudComposerSubmitResult>;
}

export function useCloudComposerSubmit(
  workspaceIdentity?: string | null,
): UseCloudComposerSubmitResult {
  const context = useCloudWorkspaceContext();
  const taskId = resolveCloudTaskIdFromWorkspaceIdentity(workspaceIdentity);
  const isSelectedTask = taskId !== null && context?.selection.taskId === taskId;

  // hook 必须无条件调用；已经由控制器取数的任务不再重复请求。
  const ownTask = useCloudTask({ taskId: isSelectedTask ? null : taskId });
  const submit = useSubmitCloudInput();

  const task: CloudTaskRecord | null = isSelectedTask
    ? (context?.taskDetail?.task ?? null)
    : ownTask.task;
  const activeRun: CloudRunRecord | null = isSelectedTask
    ? (context?.taskDetail?.activeRun ?? null)
    : (ownTask.detail?.activeRun ?? null);

  const enabled = taskId !== null;

  const send = useCallback(
    async (prompt: string): Promise<CloudComposerSubmitResult> => {
      if (!enabled) {
        throw new Error("cloud composer submit used outside a cloud task workspace");
      }
      if (!task) {
        // 还没有任务投影：不猜状态，更不能落到本机发送路径。
        return "blocked";
      }

      if (task.status === "draft") {
        const start = task.draftStartConfig;
        if (!start) {
          // start 必须携带与已保存 draftStartConfig 一致的选择（03 §6 start 行）：
          // 没有保存过配置就不允许首发，而不是拿默认值凑一个。
          return "blocked";
        }
        const outcome = await submit.submitFirstInput({
          prompt,
          start,
          expectedTaskRevision: task.revision,
        });
        return mapOutcome(outcome.kind);
      }

      if (!activeRun) {
        // 没有活跃 run 时只能显式 reopen，不能借 append 自动起一个（08 §9）。
        return "blocked";
      }
      const outcome = await submit.submitAppendInput({
        prompt,
        expectedRunGeneration: activeRun.runGeneration,
      });
      return mapOutcome(outcome.kind);
    },
    [activeRun, enabled, submit, task],
  );

  const errorDetail = useMemo(() => {
    const outcome = submit.lastOutcome;
    if (!outcome || outcome.kind === "persisted") {
      return null;
    }
    return outcome.message;
  }, [submit.lastOutcome]);

  return useMemo(
    () => ({
      enabled,
      errorDetail,
      pendingAttemptCount: submit.pendingAttempts.length,
      send,
    }),
    [enabled, errorDetail, send, submit.pendingAttempts.length],
  );
}

function mapOutcome(
  kind: "persisted" | "not-frozen" | "unknown" | "rejected",
): CloudComposerSubmitResult {
  switch (kind) {
    case "persisted":
      return "sent";
    case "unknown":
      return "unknown";
    case "not-frozen":
    case "rejected":
    default:
      return "blocked";
  }
}

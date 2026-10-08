/**
 * `useReopenCloudTask` —— 显式重开（specs/cloud-agent/08 §9、03 §6 reopen 行、04 §3.3）。
 *
 * 三条硬规则：
 * - 重开是**独立命令**，不借普通 append 自动启动，也不隐式建 run（08 §9）。
 * - 必须显式给出恢复选择（有 checkpoint 用 checkpoint SHA；没有 checkpoint 才能
 *   `restart-from-base`），服务端按持久事实校验可用性（03 §6）。
 * - 新 run = 新 runId + 更高 runGeneration，旧终态 run 不复活（08 §3.2）。
 *
 * 重开本身也走 durable 提交通路：冻结 attempt（含 `commandId` 与完整 payload），
 * 刷新后可按原 key 对账（04 §3.2.3）。
 */
import { useCallback, useMemo, useState } from "react";
import type { InputReceipt, ReopenCloudTaskRequest, TaskDetailResponse } from "@zcode/shared";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import {
  submitCloudTaskInput,
  type CloudSubmissionOutcome,
  type CloudTaskSubmissionDeps,
} from "@/cloud/cloudTaskSubmission.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { useCloudDraftStore } from "@/store/cloud/cloudDraftStore.js";
import { useCloudTasksStore } from "@/store/cloud/cloudTasksStore.js";
import { createCloudCommandId } from "./useSubmitCloudInput.js";

export interface ReopenCloudTaskArgs {
  readonly prompt: string;
  readonly provider: string;
  /** 恢复选择：`checkpoint` 或 `restart-from-base`，两侧都必须在请求里显式声明。 */
  readonly resume: ReopenCloudTaskRequest["resume"];
  readonly expectedTaskRevision: number;
  readonly requestedConfig?: ReopenCloudTaskRequest["requestedConfig"];
  readonly commandId?: string;
}

export interface UseReopenCloudTaskResult {
  readonly lastOutcome: CloudSubmissionOutcome | null;
  reopenTask(args: ReopenCloudTaskArgs): Promise<CloudSubmissionOutcome>;
}

export interface UseReopenCloudTaskOptions {
  readonly controlPlane?: CloudControlPlanePort | null;
}

export function useReopenCloudTask(options?: UseReopenCloudTaskOptions): UseReopenCloudTaskResult {
  const context = useCloudWorkspaceContext();
  const controlPlane = options?.controlPlane ?? context?.controlPlane ?? null;
  const principalId = context?.selection.principalId ?? null;
  const scopeKey = context?.selection.draftScope?.key ?? null;
  const taskId = context?.selection.taskId ?? null;
  // 重开成功后新 run 从 provisioning 起步：请求控制器启动有界 run 观察（04 §3.2.4）。
  const beginTaskRunWatch = context?.beginTaskRunWatch ?? null;
  const [lastOutcome, setLastOutcome] = useState<CloudSubmissionOutcome | null>(null);

  const deps = useMemo<CloudTaskSubmissionDeps | null>(() => {
    if (!controlPlane || !scopeKey || !taskId) {
      return null;
    }
    return {
      controlPlane,
      scopeKey,
      taskId,
      freezeAttempt: (attempt) => useCloudDraftStore.getState().freezeAttempt(scopeKey, attempt),
      settleAttempt: (commandId, settlement) =>
        useCloudDraftStore.getState().settleAttempt(scopeKey, commandId, settlement),
      applyReceipt: (commandId: string, receipt: InputReceipt) =>
        useCloudDraftStore.getState().applyReceipt(scopeKey, commandId, receipt),
    };
  }, [controlPlane, scopeKey, taskId]);

  const reopenTask = useCallback(
    async (args: ReopenCloudTaskArgs): Promise<CloudSubmissionOutcome> => {
      if (!deps || !controlPlane || !taskId) {
        throw new Error("cloud control plane is not configured");
      }
      const commandId = args.commandId ?? createCloudCommandId();
      const body: ReopenCloudTaskRequest = {
        commandId,
        prompt: args.prompt,
        provider: args.provider,
        resume: args.resume,
        expectedTaskRevision: args.expectedTaskRevision,
        ...(args.requestedConfig === undefined ? {} : { requestedConfig: args.requestedConfig }),
      };
      const outcome = await submitCloudTaskInput({
        commandId,
        request: { kind: "reopen", body },
        bodyVersion: useCloudDraftStore.getState().drafts[deps.scopeKey]?.bodyVersion ?? 0,
        deps,
      });
      setLastOutcome(outcome);
      if (outcome.kind === "persisted") {
        // reopen 响应里的 detail 才是新 run 的权威投影；这里刷新一次，不自行拼 run。
        const detail: TaskDetailResponse = await controlPlane.getTask(taskId);
        if (principalId !== null) {
          useCloudTasksStore.getState().applyTaskDetail(principalId, detail, Date.now());
        }
        // 新 run 通常还在 provisioning：继续有界观察直到 ready/终态（04 §3.2.4）。
        beginTaskRunWatch?.();
      }
      return outcome;
    },
    [beginTaskRunWatch, controlPlane, deps, principalId, scopeKey, taskId],
  );

  return useMemo(() => ({ lastOutcome, reopenTask }), [lastOutcome, reopenTask]);
}

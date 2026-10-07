/**
 * `useCancelCloudInput` —— 撤销已提交 input（specs/cloud-agent/04 §3.4、03 §7.1、11 §8）。
 *
 * 取消走**服务端状态转移**，不能只删掉 UI 上的消息（04 §3.4 表尾段）：
 * 未投递的 outbox 输入由事务 CAS 标 cancelled；已投递但 ACK 未知先对账，必要时用
 * 独立 cancelCommandId 发取消。取消 receipt **不承诺回滚已发生的工具副作用**。
 */
import { useCallback, useMemo } from "react";
import type { InputReceipt } from "@zcode/shared";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { useCloudDraftStore } from "@/store/cloud/cloudDraftStore.js";

export interface UseCancelCloudInputResult {
  /** 幂等撤销；同 commandId 重复取消返回同一 receipt。 */
  cancelInput(commandId: string): Promise<InputReceipt>;
}

export interface UseCancelCloudInputOptions {
  readonly controlPlane?: CloudControlPlanePort | null;
}

export function useCancelCloudInput(
  options?: UseCancelCloudInputOptions,
): UseCancelCloudInputResult {
  const context = useCloudWorkspaceContext();
  const controlPlane = options?.controlPlane ?? context?.controlPlane ?? null;
  const scopeKey = context?.selection.draftScope?.key ?? null;
  const taskId = context?.selection.taskId ?? null;

  const cancelInput = useCallback(
    async (commandId: string): Promise<InputReceipt> => {
      if (!controlPlane || !taskId) {
        throw new Error("cloud control plane is not configured");
      }
      const receipt = await controlPlane.cancelInput(taskId, commandId);
      if (scopeKey) {
        // 取消是一份新的权威回执：写回投影，但不因此清掉正文（用户可能想改完再发）。
        useCloudDraftStore.getState().settleAttempt(scopeKey, commandId, {
          phase: "persisted",
          httpStatus: 200,
          receipt,
        });
      }
      return receipt;
    },
    [controlPlane, scopeKey, taskId],
  );

  return useMemo(() => ({ cancelInput }), [cancelInput]);
}

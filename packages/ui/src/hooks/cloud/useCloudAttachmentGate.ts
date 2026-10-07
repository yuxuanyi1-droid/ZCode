/**
 * `useCloudAttachmentGate` —— 把云附件门控接到组件（specs/cloud-agent/04 §3.4.1、11 §9）。
 *
 * 返回 null 表示**当前不是云模式**：调用方沿用既有行为，一个分支都不加。
 * 云模式下返回判定结果，组件据此禁用入口并显示原因（不静默失败、不伪造空附件）。
 */
import { useMemo } from "react";
import { useCloudCapabilities } from "./useCloudCapabilities.js";
import { useCloudExecutionScope } from "@/cloud/CloudServicesProvider.js";
import {
  resolveCloudAttachmentGate,
  type CloudAttachmentGate,
} from "@/cloud/cloudAttachmentGate.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";

export function useCloudAttachmentGate(): CloudAttachmentGate | null {
  const context = useCloudWorkspaceContext();
  const executionScope = useCloudExecutionScope();
  const capabilities = useCloudCapabilities();

  const taskStatus = context?.taskDetail?.task.status ?? null;
  const hasRuntimeSession = (context?.taskDetail?.activeRun?.runtimeSessionId ?? "").length > 0;

  return useMemo(() => {
    if (!context || !executionScope) {
      // 非云模式：交回既有附件路径（本地 / SSH / 已配对远控语义不变）。
      return null;
    }
    return resolveCloudAttachmentGate({
      executionScope,
      taskOwnedAttachments: capabilities.capabilities?.taskOwnedAttachments === true,
      taskStatus,
      hasRuntimeSession,
    });
  }, [
    capabilities.capabilities?.taskOwnedAttachments,
    context,
    executionScope,
    hasRuntimeSession,
    taskStatus,
  ]);
}

/**
 * `useCloudWorkspaceServices` —— 工作区级云服务作用域（specs/cloud-agent/W8 §3、04 §3.0/§4、12 §5）。
 *
 * 原 `Root` 的工作区 accessor 来自 `useWorkspaceServices`（本地 / 远程 SSH 语义）。
 * 云工作区不从那套解析里「借」服务，而是显式走本 hook：
 *
 * - workspaceIdentity **不是** `cloud-task:<taskId>` → 返回 null，调用方沿用既有解析。
 *   本地 / 已配对手机远控的预热与 delivery 语义因此完全不变（04 §2、W-13）。
 * - 是 cloud-task 且正好是控制器当前 attach 的任务 → host base + 该 Run 的 attachment。
 * - 是 cloud-task 但不是当前 attach 的任务（例如侧栏里另一个任务）→ host base +
 *   **执行域不可用**：既不回落本机执行域，也不借用别的任务的 attachment（03 §2）。
 *
 * 这里始终从 `hostAccessor` 重新合成，而不是复用 React context 里已合成的那一份：
 * `Root` 会用 `props.services` 再套一层 `ServiceProvider`，靠 context 取值会拿到
 * 被覆盖前的实例，作用域就不再由本 hook 决定。
 */
import { useMemo } from "react";
import type { IServiceAccessor } from "@zcode/services";
import {
  createCloudBrowserServices,
  selectCloudAttachmentForTask,
} from "@/cloud/cloudBrowserServices.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { resolveCloudTaskIdFromWorkspaceIdentity } from "@/cloud/cloudUiBootstrap.js";

export function useCloudWorkspaceServices(
  workspaceIdentity?: string | null,
): IServiceAccessor | null {
  const context = useCloudWorkspaceContext();
  const cloudTaskId = resolveCloudTaskIdFromWorkspaceIdentity(workspaceIdentity);
  const hostAccessor = context?.hostAccessor ?? null;
  const currentAttachment = context?.attachment ?? null;

  const attachmentForTask = selectCloudAttachmentForTask(currentAttachment, cloudTaskId);

  return useMemo(() => {
    if (cloudTaskId === null || !hostAccessor) {
      return null;
    }
    return createCloudBrowserServices({
      hostAccessor,
      attachment: attachmentForTask,
      unavailableReason: `cloud task ${cloudTaskId} has no ready run attachment`,
    }).services;
  }, [attachmentForTask, cloudTaskId, hostAccessor]);
}

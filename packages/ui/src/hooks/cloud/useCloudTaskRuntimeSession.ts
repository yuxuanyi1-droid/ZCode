/**
 * `useCloudTaskRuntimeSession` —— 云任务工作区 runtime 会话的 React 侧入口
 * （specs/cloud-agent/W8 §3、04 §3.3；规则本体见 `cloud/cloudTaskRuntimeSession.ts`）。
 *
 * pane 会话绑定（`WorkspaceShellLayout`）经本 hook 读取：云任务工作区用
 * `activeRun.runtimeSessionId`（`sess_…`），非云工作区由调用方沿用 `activeTaskId` 原语义。
 * 详情投影来自 `useCloudWorkspaceController` 的 `taskDetail`；控制器在 attachment 打开与
 * 连接换代时会对账刷新，保证 runtime 会话跟 activeRun 走（换代换新的 sess_…）。
 */
import { useMemo } from "react";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import {
  resolveCloudTaskRuntimeSession,
  type CloudTaskRuntimeSessionResolution,
} from "@/cloud/cloudTaskRuntimeSession.js";

export function useCloudTaskRuntimeSession(
  workspaceIdentity?: string | null,
): CloudTaskRuntimeSessionResolution {
  const context = useCloudWorkspaceContext();
  const taskDetail = context?.taskDetail ?? null;
  return useMemo(
    () => resolveCloudTaskRuntimeSession({ workspaceIdentity, taskDetail }),
    [taskDetail, workspaceIdentity],
  );
}

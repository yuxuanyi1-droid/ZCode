/**
 * `useCloudTaskRuntimeSession` —— 云任务工作区 runtime 会话的 React 侧入口
 * （specs/cloud-agent/W8 §3、04 §3.3；规则本体见 `cloud/cloudTaskRuntimeSession.ts`）。
 *
 * pane 会话绑定（`WorkspaceShellLayout`）经本 hook 读取：云任务工作区用
 * `activeRun.runtimeSessionId`（`sess_…`），非云工作区由调用方沿用 `activeTaskId` 原语义。
 * 详情投影来自 `useCloudWorkspaceController` 的 `taskDetail`；控制器在 attachment 打开与
 * 连接换代时会对账刷新，保证 runtime 会话跟 activeRun 走（换代换新的 sess_…）。
 *
 * 2026-10-08 巡检修订（P1）：本 hook 还负责把落定的 run checkout 路径同步进云任务
 * tab。run 的 `workspacePath` 在首发/重开后由控制面异步落定，tab 建立时持有空串路径
 * 且此前没有刷新通道；pane scope 用空串路径发起 `subscribeConversationV4` 会被 runtime
 * zod 以 `workspace.workspacePath` too_small 拒绝。同步按 `cloudTaskId` 匹配、不抢激活；
 * 绑定同时要求**pane scope 的 tab 路径已落定**，保证订阅发出的 workspace 描述永远带
 * 非空路径（spec 02 §2「身份与路径同时传递」），不存在用空串路径订阅的中间帧。
 */
import { useEffect, useMemo } from "react";
import { resolveCloudTaskIdFromWorkspaceIdentity } from "@/cloud/cloudUiBootstrap.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import {
  resolveCloudTaskRuntimeSession,
  type CloudTaskRuntimeSessionResolution,
} from "@/cloud/cloudTaskRuntimeSession.js";
import { useTabStore, useTabStoreApi } from "@/store/TabStoreProvider.js";

export function useCloudTaskRuntimeSession(
  workspaceIdentity?: string | null,
): CloudTaskRuntimeSessionResolution {
  const context = useCloudWorkspaceContext();
  const taskDetail = context?.taskDetail ?? null;
  const cloudTaskId = resolveCloudTaskIdFromWorkspaceIdentity(workspaceIdentity);
  // pane scope 的 workspacePath 事实源：云任务 tab 的 checkout 路径（run ready 前为空串）。
  const tabWorkspacePath = useTabStore((state) => {
    if (cloudTaskId === null) {
      return "";
    }
    for (const tab of state.tabs) {
      if (tab.kind === "workspace" && tab.cloudTaskId === cloudTaskId) {
        return tab.workspacePath;
      }
    }
    return "";
  });
  const resolution = useMemo(
    () => resolveCloudTaskRuntimeSession({ workspaceIdentity, taskDetail }),
    [taskDetail, workspaceIdentity],
  );

  // 详情投影里 run 路径落定后同步进云任务 tab（只同步路径与标题，不抢激活）。
  // 绑定门（resolveCloudTaskRuntimeSession + tabWorkspacePath）在下一轮渲染放行，
  // pane 在 tab 路径落定前保持「无会话」等待态，不会用空串路径发起订阅。
  const runWorkspacePath = resolution.runWorkspacePath;
  const tabStoreApi = useTabStoreApi();
  const taskTitle = taskDetail?.task.title ?? null;
  const taskId = taskDetail?.task.taskId ?? null;
  useEffect(() => {
    if (runWorkspacePath === null || taskId === null || runWorkspacePath === tabWorkspacePath) {
      return;
    }
    tabStoreApi.getState().syncCloudTaskTabWorkspacePath({
      cloudTaskId: taskId,
      workspacePath: runWorkspacePath,
      ...(taskTitle ? { label: taskTitle } : {}),
    });
  }, [runWorkspacePath, tabStoreApi, tabWorkspacePath, taskId, taskTitle]);

  return useMemo(
    () => ({
      ...resolution,
      runtimeSessionId:
        resolution.runtimeSessionId !== null && tabWorkspacePath.startsWith("/")
          ? resolution.runtimeSessionId
          : null,
    }),
    [resolution, tabWorkspacePath],
  );
}

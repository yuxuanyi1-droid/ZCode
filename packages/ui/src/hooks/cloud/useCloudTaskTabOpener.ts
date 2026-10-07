/**
 * `useCloudTaskTabOpener` —— 把云任务打开成**原工作区 tab**（specs/cloud-agent 04 §3.0/§5、
 * W8 §3「云工作区 tab 建立」）。
 *
 * 这一步是「能用」与「只改了组件」的分界：侧栏选中云任务后，必须真的在原
 * `Root` → `RootWorkspaceContent` → `App` → `WorkspaceShellLayout` 里出现该任务的工作区，
 * 会话 / 输入 / 文件服务来自当前 Run attachment。
 *
 * 三条取值规则：
 * - **匹配键是 taskId**（`tabStore.openCloudTaskTab`）：Run 换代后 checkout 路径会变，
 *   按路径匹配会开出第二个 tab（04 §5）。
 * - `workspacePath` 取 Run 的真实 checkout 路径；run ready 前为空串 —— 表示「当前没有
 *   文件系统路径」，而不是伪造一个路径，也不把 `cloud-task:<taskId>` 当路径用（04 §3.0/§3.4.1）。
 * - `workspaceIdentity = cloud-task:<taskId>` 始终固定，供服务作用域与 IO 路由使用（08 §4.1）。
 */
import { useCallback } from "react";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { buildCloudTaskTabTarget } from "@/cloud/cloudTaskTab.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { useTabStore } from "@/store/TabStoreProvider.js";
import { useZCodeSessionStore } from "@/store/zcodeSessionStore.js";

export interface CloudTaskTabOpener {
  /** 打开/激活该云任务的工作区 tab；失败抛出（调用方负责提示，不静默吞掉）。 */
  openCloudTaskTab(taskId: string): Promise<string | null>;
}

export function useCloudTaskTabOpener(): CloudTaskTabOpener {
  const context = useCloudWorkspaceContext();
  const openCloudTaskTab = useTabStore((state) => state.openCloudTaskTab);
  const controlPlane: CloudControlPlanePort | null = context?.controlPlane ?? null;
  const selectTask = context?.selectTask;

  const open = useCallback(
    async (taskId: string): Promise<string | null> => {
      if (!controlPlane) {
        throw new Error("cloud control plane is not configured");
      }
      // 控制面是 Task/Run 事实源：checkout 路径只能从 run 元数据取，不从身份推导。
      const detail = await controlPlane.getTask(taskId);
      const target = buildCloudTaskTabTarget({
        taskId,
        taskTitle: detail.task.title,
        runWorkspacePath: detail.activeRun?.workspacePath,
      });
      openCloudTaskTab(target);
      // 建出 tab 只代表「这个任务的工作区存在」；主区 pane 绑定读的是 workspace 选择态
      // （`sessionId ≡ taskId`），所以这里必须像本地任务导航（useWorkspaceTaskNavigation）
      // 那样选中任务，否则右侧一直停在 draft 空态。workspace 键用 identity
      // （`cloud-task:<taskId>`），run ready 前后的 checkout 路径变化不影响同一条选择。
      useZCodeSessionStore
        .getState()
        .setActiveTaskId(target.workspacePath, taskId, target.workspaceIdentity);
      // 控制面选择（草稿 scope / attachment 路由）+ 主路由回写由控制器统一完成。
      selectTask?.(taskId);
      return detail.activeRun?.runId ?? null;
    },
    [controlPlane, openCloudTaskTab, selectTask],
  );

  return { openCloudTaskTab: open };
}

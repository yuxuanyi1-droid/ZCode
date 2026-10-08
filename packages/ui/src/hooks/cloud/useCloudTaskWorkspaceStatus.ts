/**
 * `useCloudTaskWorkspaceStatus` —— 云任务工作区的状态读取（04 §3 2026-10-08 巡检修订）。
 *
 * 背景（实测缺陷）：archived 任务详情没有任何只读标识，composer 假可写（输入后
 * Send 静默无请求）。只读判定需要一个不含糊的状态来源：控制面投影的唯一缓存
 * （`cloudTasksStore`，详情优先、列表兜底）。非云工作区（identity 不是
 * `cloud-task:<taskId>`）返回 null，调用方沿用本地语义。
 */
import type { CloudTaskRecord } from "@zcode/shared";
import { resolveCloudTaskIdFromWorkspaceIdentity } from "@/cloud/cloudUiBootstrap.js";
import { selectCloudTaskStatusById, useCloudTasksStore } from "@/store/cloud/cloudTasksStore.js";

/** 读取当前工作区对应的云任务状态；非云工作区或状态未知返回 null。 */
export function useCloudTaskWorkspaceStatus(
  workspaceIdentity?: string | null,
): CloudTaskRecord["status"] | null {
  const taskId = resolveCloudTaskIdFromWorkspaceIdentity(workspaceIdentity);
  return useCloudTasksStore((state) => (taskId ? selectCloudTaskStatusById(state, taskId) : null));
}

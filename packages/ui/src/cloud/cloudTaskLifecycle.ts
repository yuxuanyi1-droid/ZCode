/**
 * 云任务生命周期动作到控制面端点的分派（specs/cloud-agent/04 §6、03 §6）。
 *
 * 背景（2026-10-08 实测缺陷）：归档等生命周期动作是**独立端点**
 * （`POST /api/cloud/tasks/:taskId/archive`），不走 `PATCH` status；UI 侧此前只有
 * `useCloudTask` 内联分派，无法在 node:test 里断言「打到正确端点」。
 *
 * 抽成纯分派（端口按最小形状注入）后，hook 与用例共用同一份实现：
 * - `archive` → `port.archiveTask(taskId)`，绝不触 `patchTask`；
 * - 错误原样抛回（含服务端错误信封），由调用方经 `describeCloudSubmissionError`
 *   归一后呈现，这里不吞、不改写。
 */
import type { TaskDetailResponse } from "@zcode/shared";

export type CloudTaskLifecycleAction = "stop" | "complete" | "archive" | "restore";

/** 分派所需的最小端口形状（测试桩只需实现命中的成员）。 */
export type CloudTaskLifecyclePort = {
  stopTask(taskId: string): Promise<TaskDetailResponse>;
  completeTask(taskId: string): Promise<TaskDetailResponse>;
  archiveTask(taskId: string): Promise<TaskDetailResponse>;
  restoreTask(taskId: string): Promise<TaskDetailResponse>;
};

export function runCloudTaskLifecycleAction(
  port: CloudTaskLifecyclePort,
  taskId: string,
  action: CloudTaskLifecycleAction,
): Promise<TaskDetailResponse> {
  switch (action) {
    case "stop":
      return port.stopTask(taskId);
    case "complete":
      return port.completeTask(taskId);
    case "archive":
      return port.archiveTask(taskId);
    case "restore":
      return port.restoreTask(taskId);
    default:
      return Promise.reject(new Error(`unknown cloud task lifecycle action: ${String(action)}`));
  }
}

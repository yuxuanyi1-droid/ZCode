/**
 * `useCloudTaskStop` —— 云任务工作区的停止动作（specs/cloud-agent/04 §6、03 §6 stop 行、
 * 08 §8.1 停止屏障；2026-10-08 巡检修订 P1）。
 *
 * 实测缺陷：run 运行中点击 composer 的 v4-stop 只会向 agent command 通道 dispatch
 * `stop` 命令；云任务的输入/停止走控制面独立端点（`POST /api/cloud/tasks/:taskId/stop`，
 * 03 §6），agent command 通道在云链路上不承载任务生命周期，于是零请求、零状态变化。
 * 本 hook 把停止接线到控制面生命周期端点：
 * - 成功后刷新详情投影：run 进入 draining 时 CloudTaskRunStatusBanner 呈现「正在停止」；
 * - 失败把服务端理由返回给调用方（toast），不吞错、不自动升级 force-stop（08 §8.2）。
 */
import { useCallback } from "react";
import { describeCloudSubmissionError } from "@/cloud/cloudTaskSubmission.js";
import { resolveCloudTaskIdFromWorkspaceIdentity } from "@/cloud/cloudUiBootstrap.js";
import type { CloudControlPlanePort } from "@/cloud/cloudPorts.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import { useCloudTask } from "./useCloudTask.js";

export interface UseCloudTaskStopResult {
  /** 当前工作区是否是云任务（非云调用方必须走原 v4 stop 命令路径）。 */
  readonly enabled: boolean;
  /**
   * 请求控制面停止当前任务。服务端按 run 状态裁决（无 run / 已终态自行幂等），
   * 这里不预判 canStop——那会形成与服务端两套事实。
   */
  stopTask(): Promise<{ ok: boolean; reason: string | null }>;
}

export function useCloudTaskStop(workspaceIdentity?: string | null): UseCloudTaskStopResult {
  const context = useCloudWorkspaceContext();
  const taskId = resolveCloudTaskIdFromWorkspaceIdentity(workspaceIdentity);
  const isSelectedTask = taskId !== null && context?.selection.taskId === taskId;
  // hook 无条件调用；选中任务直接复用 context 投影（taskId 传 null 不触发 GET），
  // 非选中工作区（分屏等）由 ownTask 自取详情。
  const ownTask = useCloudTask({ taskId: isSelectedTask ? null : taskId });
  const controlPlane: CloudControlPlanePort | null = context?.controlPlane ?? null;
  const reloadTask = context?.reloadTask;

  const stopTask = useCallback(async (): Promise<{ ok: boolean; reason: string | null }> => {
    if (taskId === null) {
      return { ok: false, reason: "not a cloud task workspace" };
    }
    try {
      if (isSelectedTask) {
        // 选中任务：直接经 context 的控制面端口（与 useCloudTask 同一端点分派）。
        if (!controlPlane) {
          throw new Error("cloud control plane is not configured");
        }
        await controlPlane.stopTask(taskId);
        await reloadTask?.(taskId);
      } else {
        await ownTask.stopTask();
        await ownTask.refresh();
      }
      // 停止是服务端状态转移：立刻对账详情，draining 横幅随投影出现。
      return { ok: true, reason: null };
    } catch (error) {
      return { ok: false, reason: describeCloudSubmissionError(error) };
    }
  }, [controlPlane, isSelectedTask, ownTask, reloadTask, taskId]);

  return { enabled: taskId !== null, stopTask };
}

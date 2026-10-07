/**
 * Task 详情投影（03 §6 端点分阶段语义：`{task, activeRun?, execution?, latestCheckpoint?, artifact?}`）。
 *
 * 只读组合：不查询沙箱、不裁决状态（03 §1：列表与历史不要求连上沙箱）。
 * `execution` / `artifact` 来自 frozen 的读取端口（W1 CR-4）；未接线时对应字段缺省——
 * 不猜 idle（08 §3.3「运行时失联时保留 last-known execution，不用控制面猜 idle」），
 * 也不从会话 payload 反推产物。
 */
import type { CloudCheckpointRecord, CloudRunRecord, TaskDetailResponse } from "@zcode/shared";
import { deriveTaskActions } from "../domain/taskActions.js";
import type { CloudCoreDeps } from "./deps.js";
import { cloudCoreLogger } from "./logger.js";
import { fail, ok, type CloudAppResult } from "./result.js";

export interface TaskDetailService {
  getDetail(input: {
    principalId: string;
    taskId: string;
  }): Promise<CloudAppResult<TaskDetailResponse>>;
}

export function createTaskDetailService(deps: CloudCoreDeps): TaskDetailService {
  const { storage, drivers, executionProjections, artifacts } = deps;

  /**
   * provider 续期能力：只在「有未终态 run 且有 provider handle」时查询，避免无谓的
   * capability 调用；未知一律 undefined → 不投影 `extend`（无事实不猜）。
   */
  async function providerCanExtend(run: CloudRunRecord | null): Promise<boolean | undefined> {
    if (!run || run.status === "stopped" || run.status === "expired" || run.status === "failed") {
      return undefined;
    }
    if (!run.provider || !run.providerHandle) return undefined;
    const driver = await drivers.resolve(run.provider);
    if (!driver) return undefined;
    const capabilities = await driver.describeCapabilities();
    return capabilities.canExtendDeadline;
  }

  return {
    async getDetail(input) {
      const task = await storage.tasks.get(input.taskId);
      if (!task || task.ownerPrincipalId !== input.principalId) {
        return fail("not_found", "task-not-found");
      }
      const activeRun = await storage.runs.activeOfTask(task.taskId);
      const checkpoints = await storage.projections.listCheckpoints(task.taskId);
      const latestCheckpoint = pickLatestCheckpoint(checkpoints);
      // 执行投影优先取当前 run 的（更精确），回退到 Task 级 last-known。
      const execution = executionProjections
        ? ((activeRun ? await executionProjections.readRunExecution(activeRun.runId) : null) ??
          (await executionProjections.readTaskExecution(task.taskId)))
        : undefined;
      const artifact = artifacts ? await artifacts.read(task.taskId) : null;
      // 能力投影：与各生命周期命令同一张状态表（04 §3.3）；服务端每次写操作仍独立校验。
      const unsettledInputs = await storage.inputs.listDeliverable(task.taskId);
      const canExtend = await providerCanExtend(activeRun);
      const actions = deriveTaskActions({
        task,
        activeRun,
        unsettledInputCount: unsettledInputs.length,
        artifact,
        ...(canExtend === undefined ? {} : { providerCanExtend: canExtend }),
      });
      const detail: TaskDetailResponse = {
        task,
        actions,
        ...(activeRun ? { activeRun } : {}),
        ...(execution ? { execution } : {}),
        ...(latestCheckpoint ? { latestCheckpoint } : {}),
        ...(artifact ? { artifact } : {}),
      };
      cloudCoreLogger.debug(undefined, "cloud task detail read", { taskId: task.taskId });
      return ok(detail);
    },
  };
}

/** 最近更新的 checkpoint 记录（saved 判定与风险都以其自身字段为准，不在此覆盖）。 */
export function pickLatestCheckpoint(
  checkpoints: readonly CloudCheckpointRecord[],
): CloudCheckpointRecord | undefined {
  return checkpoints.reduce<CloudCheckpointRecord | undefined>(
    (latest, item) => (latest === undefined || item.updatedAt > latest.updatedAt ? item : latest),
    undefined,
  );
}

/**
 * Task 生命周期命令：验收（complete）、归档、重新激活与恢复
 * （03 §6 complete/archive/reactivate/restore 行、08 §3.1 状态表、§9 重开、完成与历史）。
 *
 * 冻结规则：
 * - complete：先持久验收意图、阻断新输入/写入并收口执行；accepted/delivering/uncertain
 *   全部计入未决输入，已 admitted 的在途执行也须达到可信安全点；最终 completed 需保存策略/
 *   产物核验及活动 Run 终止确认，不把写 outbox 等同完成（08 §9）。
 * - archive：无活动写 run 时归档；历史仍可读（03 §6、CP-12）。
 * - reactivate：completed 且 PR 未 merged 时显式转 active，不自动建 run；merged 时新建
 *   follow-up Task（08 §3.1）。
 * - restore：从 archived 恢复 archivedFromStatus；仍需显式 reopen 才有新 run（03 §6）。
 */
import type { TaskDetailResponse } from "@zcode/shared";
import { canReactivateTask, restoreTargetStatus } from "../../domain/taskRunState.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, type CloudAppResult } from "../result.js";
import type { TaskDetailService } from "../taskDetail.js";
import type { DrainLoop } from "../lifecycle/drain.js";

export interface TaskLifecycleCommands {
  completeTask(input: {
    principalId: string;
    taskId: string;
  }): Promise<CloudAppResult<TaskDetailResponse>>;
  archiveTask(input: {
    principalId: string;
    taskId: string;
  }): Promise<CloudAppResult<TaskDetailResponse>>;
  reactivateTask(input: {
    principalId: string;
    taskId: string;
  }): Promise<CloudAppResult<TaskDetailResponse>>;
  restoreTask(input: {
    principalId: string;
    taskId: string;
  }): Promise<CloudAppResult<TaskDetailResponse>>;
}

/** 未决输入：持久接收但未收口的输入都算（08 §9：不能只检查 accepted 集合）。 */
const UNSETTLED_INPUT_STATUSES = new Set(["accepted", "delivering", "uncertain"]);

export function createTaskLifecycleCommands(
  deps: CloudCoreDeps,
  taskDetail: TaskDetailService,
  drain: DrainLoop,
): TaskLifecycleCommands {
  const { storage, clock } = deps;

  async function detail(input: { principalId: string; taskId: string }) {
    return taskDetail.getDetail(input);
  }

  return {
    async completeTask(input) {
      const current = await detail(input);
      if (!current.ok) return current;
      const task = current.value.task;
      if (task.status === "completed") return current;
      if (task.status !== "active") {
        return fail("validation_failed", "task-not-completable", { status: task.status });
      }
      // 08 §9：用户 complete 先持久验收意图（revision CAS），之后才谈收口与最终 completed。
      const requested = await storage.tasks.setCompleteRequested({
        taskId: task.taskId,
        expectedRevision: task.revision,
        requested: true,
        now: clock.now(),
      });
      if (!requested) return fail("stale", "task-revision-mismatch");
      const run = current.value.activeRun;
      if (run && run.status !== "stopped" && run.status !== "expired" && run.status !== "failed") {
        // 验收使用同一 drain 依赖通路（08 §9）：先收口执行，条件满足前不宣告 completed。
        await drain.beginDrain({ taskId: task.taskId, runId: run.runId, reason: "user-stop" });
        return fail("not_ready", "completion-drain-in-progress", { runId: run.runId });
      }
      const inputs = await storage.inputs.listDeliverable(task.taskId);
      const unsettled = inputs.filter((item) => UNSETTLED_INPUT_STATUSES.has(item.deliveryStatus));
      if (unsettled.length > 0) {
        return fail("not_ready", "unsettled-inputs", { count: unsettled.length });
      }
      if (current.value.latestCheckpoint?.state === "failed") {
        // 保存风险必须可见；不在写 outbox 未收口时宣称完成（08 §9），但风险本身不阻断验收。
        cloudCoreLogger.warn(undefined, "cloud task completing with failed checkpoint", {
          taskId: task.taskId,
        });
      }
      const latest = await storage.tasks.get(task.taskId);
      const updated = await storage.tasks.transitionStatus({
        taskId: task.taskId,
        from: ["active"],
        to: "completed",
        revision: latest?.revision ?? task.revision,
        completeRequested: true,
        now: clock.now(),
      });
      if (!updated) return fail("stale", "task-revision-mismatch");
      return await detail(input);
    },

    async archiveTask(input) {
      const current = await detail(input);
      if (!current.ok) return current;
      const task = current.value.task;
      if (task.status === "archived") return current;
      const run = current.value.activeRun;
      if (run && run.status !== "stopped" && run.status !== "expired" && run.status !== "failed") {
        // 归档前置：无活动写 run（03 §6、CP-12）。
        return fail("validation_failed", "task-has-active-run", { runId: run.runId });
      }
      const updated = await storage.tasks.transitionStatus({
        taskId: task.taskId,
        from: ["draft", "active", "completed", "failed"],
        to: "archived",
        revision: task.revision,
        archivedFromStatus: task.status,
        now: clock.now(),
      });
      if (!updated) return fail("stale", "task-revision-mismatch");
      return await detail(input);
    },

    async reactivateTask(input) {
      const current = await detail(input);
      if (!current.ok) return current;
      const task = current.value.task;
      const artifact = deps.artifacts ? await deps.artifacts.read(task.taskId) : null;
      if (task.prRef && !artifact) {
        // 有 PR 记录但读不到产物投影：无法判定 merged，明确拒绝而不猜（08 §3.1）。
        return fail("not_implemented", "pr-status-projection-missing", { prRef: task.prRef });
      }
      const prStatus = artifact?.prStatus ?? null;
      if (prStatus === "merged") {
        // 08 §3.1：已 merged 不 reactivate，新建 follow-up Task。
        return fail("validation_failed", "pr-merged-requires-follow-up-task");
      }
      // 只把「PR 已存在」的四种状态交给判定；none/creating/publication-failed 视为未发布。
      const publishedPrStatus =
        prStatus === "draft" || prStatus === "open" || prStatus === "closed" ? prStatus : undefined;
      if (
        !canReactivateTask({
          task,
          activeRun: current.value.activeRun ?? null,
          prStatus: publishedPrStatus,
        })
      ) {
        return fail("validation_failed", "task-not-reactivatable", { status: task.status });
      }
      const updated = await storage.tasks.transitionStatus({
        taskId: task.taskId,
        from: ["completed"],
        to: "active",
        revision: task.revision,
        now: clock.now(),
      });
      if (!updated) return fail("stale", "task-revision-mismatch");
      return await detail(input);
    },

    async restoreTask(input) {
      const current = await detail(input);
      if (!current.ok) return current;
      const task = current.value.task;
      const target = restoreTargetStatus(task);
      if (!target) return fail("validation_failed", "task-not-restorable", { status: task.status });
      const updated = await storage.tasks.transitionStatus({
        taskId: task.taskId,
        from: ["archived"],
        to: target,
        revision: task.revision,
        now: clock.now(),
      });
      if (!updated) return fail("stale", "task-revision-mismatch");
      return await detail(input);
    },
  };
}

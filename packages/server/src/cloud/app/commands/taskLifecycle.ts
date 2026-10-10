/**
 * Task 生命周期命令：验收（complete）、归档、重新激活与恢复
 * （03 §6 complete/archive/reactivate/restore 行、08 §3.1 状态表、§9 重开、完成与历史）。
 *
 * 冻结规则：
 * - complete：先持久验收意图、阻断新输入/写入并收口执行；accepted/delivering 计入未决
 *   输入（08 §9 不能只检查 accepted），run 终态后已按 08 §8.1 收口的输入（accepted→
 *   cancelled、delivering/uncertain→uncertain 保留为「结果不明」事实）不再阻塞——
 *   已 admitted 的在途执行也须达到可信安全点；最终 completed 需保存策略/产物核验及
 *   活动 Run 终止确认，不把写 outbox 等同完成（08 §9）。
 * - archive：无活动写 run 时归档；例外（08 §3.2/§8.2 修订 2026-10-10，用户决议）：
 *   Run=paused 时归档是用户结束任务的显式意图——自动推进暂停中停止（复用
 *   pausedStop 的 advancePausedStop 同一实现，terminate 后 dataAtRisk 如实标注）
 *   再完成归档；ready/provisioning/draining/disconnected 仍 409 引导先停止（03 §6、CP-12）。
 * - reactivate：completed 且 PR 未 merged 时显式转 active，不自动建 run；merged 时新建
 *   follow-up Task（08 §3.1）。
 * - restore：从 archived 恢复 archivedFromStatus；仍需显式 reopen 才有新 run（03 §6）。
 *
 * revision 约定（P0 修复，2026-10-07 review）：本文件调 `storage.tasks.transitionStatus` 时传的是
 * **新的 revision（当前值 + 1）**，不是 CAS 期望值——端口契约见 app/ports/taskPort.ts:41-46，
 * 真实 repo 落库为 `WHERE ... AND revision < ?`（repositories/taskRepo.ts:195）。
 */
import type { TaskDetailResponse } from "@zcode/shared";
import { canReactivateTask, restoreTargetStatus } from "../../domain/taskRunState.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, type CloudAppResult } from "../result.js";
import type { TaskDetailService } from "../taskDetail.js";
import type { DrainLoop } from "../lifecycle/drain.js";
import type { PauseResumeControl } from "../lifecycle/pauseResume.js";

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
  /**
   * 验收意图后台扫尾（08 §9、审计 N-P3）：对 `complete_requested=1`、无活动 run 且
   * 输入已收口的 Task 自动 completeTask（completeTask 自身幂等：已是 completed 直接返回）。
   * 返回本轮实际收口为 completed 的 Task 数。由 lifecycle 循环每拍调用。
   */
  settleCompleteRequests(): Promise<number>;
}

/**
 * 未决输入（08 §9「不能只检查 accepted 集合」+ D4-3 终态收口裁决）：
 * - `accepted/delivering` 计入未决：accepted 可能还没投递，delivering 的结论未知，
 *   有活动 run（或收口尚未发生）时都不能宣告 completed；
 * - `uncertain` **不**计入：run 终态后其 runtime 已不可达，对账永不收敛；按 08 §8.1
 *   「unknown 保留对账」的诚实事实语义，它保留为「结果不明」的历史事实，由 receipt
 *   查询呈现（runId 指向已终态 run + endReason），不再阻塞 complete——否则复现审计
 *   发现的「complete 永久 not_ready」死锁。accepted 在终态收口时已落 cancelled，
 *   delivering 已收口为 uncertain，因此到达本检查的 accepted/delivering 只可能是
 *   终态转换与收口之间崩溃的残留（complete 内会先幂等再收口一次）。
 */
const UNSETTLED_INPUT_STATUSES = new Set(["accepted", "delivering"]);

export function createTaskLifecycleCommands(
  deps: CloudCoreDeps,
  taskDetail: TaskDetailService,
  drain: DrainLoop,
  /** 暂停中停止推进（pausedStop.ts 共享实现）：归档驱动的停止复用同一实现，不写两份。 */
  pauseResume: Pick<PauseResumeControl, "advancePausedStop">,
): TaskLifecycleCommands {
  const { storage, clock } = deps;

  async function detail(input: { principalId: string; taskId: string }) {
    return taskDetail.getDetail(input);
  }

  /** complete 唯一实现：HTTP 命令与后台验收 sweep（N-P3）共用，不复制收口逻辑。 */
  async function completeTaskInternal(input: {
    principalId: string;
    taskId: string;
  }): Promise<CloudAppResult<TaskDetailResponse>> {
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
    if (run && run.status === "paused") {
      // 行为表（03 §6 修订 2026-10-09）：paused 的 complete = 拒绝——须先 resume（发消息
      // 自驱恢复）或完成 stop 终态收口，才能进入验收。**不走 beginDrain**：暂停态无
      // 运行时写入、无 checkpoint 前置可执行，对 paused 启动保存通路只会留下永不结算的
      // checkpoint 意图。not_ready 归一 409，输入与配额状态不变。
      return fail("not_ready", "run-paused-resume-or-stop-required", { runId: run.runId });
    }
    if (run && run.status !== "stopped" && run.status !== "expired" && run.status !== "failed") {
      // 验收使用同一 drain 依赖通路（08 §9）：先收口执行，条件满足前不宣告 completed。
      await drain.beginDrain({ taskId: task.taskId, runId: run.runId, reason: "user-stop" });
      return fail("not_ready", "completion-drain-in-progress", { runId: run.runId });
    }
    // 终态收口兜底（幂等）：终态转换与输入收口之间崩溃会留下 accepted/delivering
    // 残留，这里对最近一次 run 再收口一次（08 §8.1、审计 D4-3），保证 complete 可用。
    // activeRun 在 run 终态后为空（真实存储按非终态过滤），回退到 task.activeRunId。
    const lastRun = run ?? (task.activeRunId ? await storage.runs.get(task.activeRunId) : null);
    if (lastRun) {
      await storage.inputs.settleForEndedRun({
        taskId: task.taskId,
        runId: lastRun.runId,
        now: clock.now(),
      });
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
      // 修复依据（2026-10-07 review，P0）：端口 `transitionStatus.revision` 是**新的 revision**
      // 而非 CAS 期望值（app/ports/taskPort.ts:41-46），真实 repo 落库为
      // `UPDATE ... SET revision = ? WHERE ... AND revision < ?`（repositories/taskRepo.ts:195）。
      // 旧代码传 latest.revision（当前值），`revision < ?` 恒不成立 → changes:0 恒 stale，
      // 且此处 complete_requested 已置位，无法再用原 revision 收口（08 §9 死锁）。
      // 传 latest + 1：revision 单调允许跳号；并发安全由 `revision < ?` 的 CAS 自己保证。
      revision: (latest?.revision ?? task.revision) + 1,
      completeRequested: true,
      now: clock.now(),
    });
    if (!updated) return fail("stale", "task-revision-mismatch");
    return await detail(input);
  }

  return {
    async completeTask(input) {
      return completeTaskInternal(input);
    },

    async archiveTask(input) {
      const current = await detail(input);
      if (!current.ok) return current;
      const task = current.value.task;
      if (task.status === "archived") return current;
      const run = current.value.activeRun;
      if (run && run.status === "paused") {
        // 归档 on paused run（08 §3.2/§8.2 修订 2026-10-10，用户决议）：归档是用户结束
        // 任务的显式意图，自动推进暂停中停止后完成归档——与 stopTask 的 paused 分支同一
        // 序列：beginDrain 写持久屏障（复用 stopOperationId）并推进 paused→draining
        // （不走保存通路，暂停态无 checkpoint 前置），再复用 pauseResume.advancePausedStop
        // 直接 terminate + stopped 收口（dataAtRisk 按停止 op 结算事实如实标注）。
        const started = await drain.beginDrain({
          taskId: task.taskId,
          runId: run.runId,
          reason: "user-stop",
        });
        if (!started.ok) return started;
        const fresh = await storage.runs.get(run.runId);
        if (fresh && (fresh.status === "paused" || fresh.status === "draining")) {
          const advanced = await pauseResume.advancePausedStop(fresh, clock.now());
          if (!advanced) {
            // terminate 未当场确认：run 留在 draining（占槽），由 stop/compensation sweep
            // 按证据收口；归档未完成，按既有语义 409 让 UI 重试（重试时 run 已终态或
            // draining 仍 409，直至停止收口后归档成功）。
            return fail("not_ready", "task-has-active-run", { runId: run.runId });
          }
        }
        // 停止已收口（run 终态，fresh 已终态或推进返回 true）：继续下方既有归档路径。
        // 不复检过期 run 快照——transitionStatus 的 `revision < ?` CAS 自行兜底并发。
      } else if (
        run &&
        run.status !== "stopped" &&
        run.status !== "expired" &&
        run.status !== "failed"
      ) {
        // 归档前置：无活动写 run（03 §6、CP-12）。ready/provisioning/draining/
        // disconnected 仍归一 not_ready（409）引导先停止（03 §6 修订 2026-10-10：
        // 仅 paused 由上方分支自动推进停止后放行）。
        return fail("not_ready", "task-has-active-run", { runId: run.runId });
      }
      const updated = await storage.tasks.transitionStatus({
        taskId: task.taskId,
        from: ["draft", "active", "completed", "failed"],
        to: "archived",
        // 同 complete：`revision` 必须传新值（当前 + 1），传当前值会被 `revision < ?` 判为 stale
        // （app/ports/taskPort.ts:41-46、repositories/taskRepo.ts:195；03 §6 archive 行）。
        revision: task.revision + 1,
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
        // 同 archive：`revision` 是新的 revision（当前 + 1），不是 CAS 期望值
        // （app/ports/taskPort.ts:41-46；08 §3.1 completed → active）。
        revision: task.revision + 1,
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
        // 同 archive：`revision` 是新的 revision（当前 + 1），不是 CAS 期望值
        // （app/ports/taskPort.ts:41-46；03 §6 restore 行）。
        revision: task.revision + 1,
        now: clock.now(),
      });
      if (!updated) return fail("stale", "task-revision-mismatch");
      return await detail(input);
    },

    async settleCompleteRequests() {
      const requested = await storage.tasks.listCompleteRequested();
      let completed = 0;
      for (const task of requested) {
        // 前置：无活动 run（run 终态/不存在）且无未决输入。条件不满足时静默跳过，
        // 等下一拍——这里不是错误路径（drain/收口可能仍在进行）。
        const run = await storage.runs.activeOfTask(task.taskId);
        if (run) continue;
        const inputs = await storage.inputs.listDeliverable(task.taskId);
        if (inputs.some((item) => UNSETTLED_INPUT_STATUSES.has(item.deliveryStatus))) continue;
        // completeTaskInternal 幂等且自带全部核验（revision CAS、failed checkpoint
        // 可见性、owner 归一），复用唯一实现。
        const result = await completeTaskInternal({
          principalId: task.ownerPrincipalId,
          taskId: task.taskId,
        });
        if (result.ok && result.value.task.status === "completed") completed += 1;
      }
      return completed;
    },
  };
}

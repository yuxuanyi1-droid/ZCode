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
 * - archive：任何非 archived 状态都可归档（08 §3.2/§8.2 修订 2026-10-18，用户决议）：
 *   归档不再要求「无活动写 run」。存在未终态 run 时，先持久停止意图并经 provider
 *   terminate 停止沙箱（**不发起 checkpoint、不等待保存**），随后立即把 Task 置为
 *   archived；终止未确认不阻塞归档（run 留 draining，由既有 stop/compensation sweep
 *   收口）。ready/disconnected/draining 按「未保存即终止」标 dataAtRisk，paused 维持
 *   既有暂停中停止语义，provisioning 不强行标风险（03 §6、CP-12）。
 * - reactivate：completed 且 PR 未 merged 时显式转 active，不自动建 run；merged 时新建
 *   follow-up Task（08 §3.1）。
 * - restore：从 archived 恢复 archivedFromStatus；仍需显式 reopen 才有新 run（03 §6）。
 *
 * revision 约定（P0 修复，2026-10-07 review）：本文件调 `storage.tasks.transitionStatus` 时传的是
 * **新的 revision（当前值 + 1）**，不是 CAS 期望值——端口契约见 app/ports/taskPort.ts:41-46，
 * 真实 repo 落库为 `WHERE ... AND revision < ?`（repositories/taskRepo.ts:195）。
 */
import type { CloudRunRecord, CloudRunStatus, TaskDetailResponse } from "@zcode/shared";
import {
  canReactivateTask,
  isTerminalRunStatus,
  restoreTargetStatus,
} from "../../domain/taskRunState.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, type CloudAppResult } from "../result.js";
import type { TaskDetailService } from "../taskDetail.js";
import type { DrainLoop } from "../lifecycle/drain.js";
import type { PauseResumeControl } from "../lifecycle/pauseResume.js";
import type { RunCompensation } from "../provisioning/compensation.js";

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
  /** 终止执行器（provider SDK 核验）：归档驱动停止直接 terminate，不等待 checkpoint。 */
  compensation: RunCompensation,
): TaskLifecycleCommands {
  const { storage, clock } = deps;

  async function detail(input: { principalId: string; taskId: string }) {
    return taskDetail.getDetail(input);
  }

  /**
   * 归档驱动的暂停中停止：复用 stopTask/pauseResume 的同一序列（beginDrain 写屏障并推进
   * `paused → draining` → advancePausedStop 直接 terminate → `stopped` 收口，dataAtRisk
   * 按停止 op 结算事实如实标注）。失败/未确认只记 warn——归档不因终止未确认而失败，
   * run 留在 draining 由既有 stop/compensation sweep 收口（03 §6 修订 2026-10-18）。
   */
  async function stopPausedRunForArchive(taskId: string, run: CloudRunRecord): Promise<void> {
    const started = await drain.beginDrain({
      taskId,
      runId: run.runId,
      reason: "user-stop",
    });
    if (!started.ok) {
      cloudCoreLogger.warn(undefined, "cloud archive paused stop barrier failed", {
        taskId,
        runId: run.runId,
        reason: started.reason,
      });
      return;
    }
    const fresh = await storage.runs.get(run.runId);
    if (!fresh || (fresh.status !== "paused" && fresh.status !== "draining")) return;
    const advanced = await pauseResume.advancePausedStop(fresh, clock.now());
    if (!advanced) {
      // terminate 未当场确认：run 留在 draining（占槽），由 stop/compensation sweep 按证据
      // 收口；归档不等待、不阻断（用户要求：终止即归档，保存风险如实标注）。
      cloudCoreLogger.warn(undefined, "cloud archive paused stop unconfirmed", {
        taskId,
        runId: run.runId,
      });
    }
  }

  /**
   * 归档前停止未终态 run（03 §6 / 08 §3.2 修订 2026-10-18）：持久 stopRequested（复用既有
   * `run.stopOperationId`，没有才新建）→ ready/disconnected CAS 到 draining → 直接
   * `compensation.terminateRun(reason="archive")`。**不调用 beginDrain 的保存通路、不等待
   * checkpoint**：归档是用户结束任务的显式意图，宁可终止未保存内容也不让归档被保存链阻塞。
   *
   * 失败语义：terminate 结果未确认只记 warn，不抛错、不阻断归档——停止屏障与 terminate
   * operation 已持久，run 保持 draining，由既有 stop/compensation sweep 继续重试清理。
   * 风险标注：verdict === terminated 且终止前状态属于 ready/disconnected/draining 时按
   * 「未保存即终止」写 dataAtRisk=true（08 §8.2）；paused 维持既有语义（暂停态无运行时
   * 写入，风险由停止 op 结算事实判定），provisioning 不强行标风险。
   */
  async function stopRunForArchive(taskId: string, run: CloudRunRecord): Promise<void> {
    if (isTerminalRunStatus(run.status)) return;
    if (run.status === "paused") {
      await stopPausedRunForArchive(taskId, run);
      return;
    }
    // 幂等：已有停止意图时保留原指针（requestStop 本身也保持原 operationId），不新建
    // 第二个屏障，避免与 stop sweep 的保存/终止依赖链分叉。
    const operationId =
      run.stopRequested && run.stopOperationId ? run.stopOperationId : deps.ids.newId();
    await storage.runs.requestStop({ taskId, operationId, now: clock.now() });

    // 终止前状态决定 dataAtRisk 口径（ready/disconnected/draining 属「未保存即终止」）。
    let statusBeforeTerminate: CloudRunStatus = run.status;
    if (run.status === "ready" || run.status === "disconnected") {
      const draining = await storage.runs.transitionStatus({
        runId: run.runId,
        runGeneration: run.runGeneration,
        from: ["ready", "disconnected"],
        to: "draining",
        endReason: "archive",
        now: clock.now(),
      });
      if (!draining) {
        // CAS 失败（与 resume/stop 推进并发）：按重读后的最新状态分支，不按过期快照裁决。
        const fresh = await storage.runs.get(run.runId);
        if (!fresh || fresh.runGeneration !== run.runGeneration) return;
        if (isTerminalRunStatus(fresh.status)) return;
        if (fresh.status === "paused") {
          await stopPausedRunForArchive(taskId, fresh);
          return;
        }
        statusBeforeTerminate = fresh.status;
      }
    }

    const terminated = await compensation.terminateRun({
      runId: run.runId,
      runGeneration: run.runGeneration,
      reason: "archive",
    });
    const verdict = terminated.ok ? terminated.value.verdict : "unknown";
    if (verdict !== "terminated") {
      // 终止未确认：run 留在 draining（或 provisioning），停止屏障与 terminate operation
      // 已持久，由既有 stop/compensation sweep 继续按证据收口。归档不等待保存、不失败。
      cloudCoreLogger.warn(undefined, "cloud archive run termination unconfirmed", {
        taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
        verdict,
        ...(terminated.ok ? {} : { reason: terminated.reason }),
      });
      return;
    }
    if (
      statusBeforeTerminate === "ready" ||
      statusBeforeTerminate === "disconnected" ||
      statusBeforeTerminate === "draining"
    ) {
      // 未保存即终止：如实标注风险（08 §8.2「不得宣称工作全部保住」）。terminate 可能在
      // 收口时已把 run 写终态，本端口不限制状态，以持久事实为准补齐 dataAtRisk。
      await storage.runs.setRunDataAtRisk({
        runId: run.runId,
        runGeneration: run.runGeneration,
        dataAtRisk: true,
        now: clock.now(),
      });
    }
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
    // 行为表（03 §6 修订 2026-10-09）：paused 的 complete = 拒绝——须先 resume（发消息
    // 自驱恢复）或完成 stop 终态收口，才能进入验收。**不走 beginDrain**：暂停态无
    // 运行时写入、无 checkpoint 前置可执行，对 paused 启动保存通路只会留下永不结算的
    // checkpoint 意图。not_ready 归一 409，输入与配额状态不变。
    //
    // 修复依据（15 §R3）：该判定必须先于 setCompleteRequested。旧实现先持久验收意图再
    // 拒绝，留下 complete_requested=1——用户随后 stop/resume 使 run 终态后，后台
    // settleCompleteRequests 会把任务自动推成 completed，与「被拒绝」的响应自相矛盾。
    const run = current.value.activeRun;
    if (run && run.status === "paused") {
      return fail("not_ready", "run-paused-resume-or-stop-required", { runId: run.runId });
    }
    // 08 §9：用户 complete 先持久验收意图（revision CAS），之后才谈收口与最终 completed。
    const requested = await storage.tasks.setCompleteRequested({
      taskId: task.taskId,
      expectedRevision: task.revision,
      requested: true,
      now: clock.now(),
    });
    if (!requested) return fail("stale", "task-revision-mismatch");
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
      // 幂等：已归档直接返回既有详情（不重复停止/归档）。
      if (task.status === "archived") return current;
      // 归档对任何非 archived 状态受理（03 §6 / 08 §3.2 修订 2026-10-18 用户决议）：存在
      // 未终态 run 时先停止运行环境——持久 stopRequested + provider terminate，不发起
      // checkpoint、不等待保存；终止未确认也不阻塞归档（run 留 draining 由 sweep 收口）。
      // 旧「无活动写 run 才归档 / 有活动 run 返回 409 task-has-active-run」的限制已删除。
      const run = current.value.activeRun;
      if (run) await stopRunForArchive(task.taskId, run);
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

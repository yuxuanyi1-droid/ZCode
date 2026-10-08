/**
 * Task / Run 状态迁移规则（specs/cloud-agent/08 §3.1 Task 生命周期、§3.2 Run 状态机、
 * §8.1 停止屏障、§9 归档与重开）。
 *
 * 纯规则层：无 IO、无时钟（调用方传入已确定的 `now`/事实），不做任何裁决之外的事；
 * 唯一事实源是 08 §3 的两张状态图，本文件只把它们表达成可判定的迁移表与谓词，
 * 不新增状态、不放宽迁移。
 *
 * 三类状态必须分开（08 §3.3）：
 * - Task 生命周期（本文件）；Run 执行载体/连接状态（本文件）；
 * - Execution / 保存 / PR 投影由 runtime 与外部事实驱动，不在本文件裁决。
 */
import type {
  CloudRunRecord,
  CloudRunStatus,
  CloudTaskRecord,
  CloudTaskStatus,
} from "@zcode/shared";

/** Run 终态：终态 run 不可复活，重开必须新 runId + 更高 runGeneration（08 §3.2 尾段）。 */
export const TERMINAL_RUN_STATUSES = [
  "stopped",
  "expired",
  "failed",
] as const satisfies readonly CloudRunStatus[];

/**
 * 未终态 run 仍占用资源槽（08 §6：provisioning/ready/paused/disconnected/draining 都算）。
 * `paused` 为 2026-10-09 生命周期 v2 增补：暂停保留期占槽（quota_released_at 保持 NULL），
 * 并发上限 3 时「3 个 paused 占槽 → 第 4 个任务 409」为预期行为。
 */
export const NON_TERMINAL_RUN_STATUSES = [
  "provisioning",
  "ready",
  "paused",
  "disconnected",
  "draining",
] as const satisfies readonly CloudRunStatus[];

/**
 * Run 状态迁移表（08 §3.2 状态图逐条对齐，含 2026-10-09 修订的四条 paused 边）。
 *
 * 注意几处容易写错的地方：
 * - `provisioning` 没有到 `draining` 的边：08 §8.1 明确「provisioning 保持供给事实，
 *   停止意图优先」，创建途中的停止靠 stopRequested 阻断启动/ready/投递，不改 run 状态。
 * - `disconnected` 不会自动变 `expired`/`failed`：网络断连只改变 connectivity
 *   （02 §2 不变量 4），终态必须有 provider 终止确认、受控停止结果或执行节点退出事实。
 * - `paused` 的四条边（08 §3.2 修订）：ready → paused（仅分级能力 provider，provider
 *   确认暂停后才写）；paused → ready（控制面自驱 resume，同 run 同 generation）；
 *   paused → draining（暂停中停止意图：屏障后直接 terminate）；paused → expired
 *   （暂停预算耗尽 → provider 保留期尽 → keepalive liveness 确认后收口）。
 *   **没有 paused → stopped**：暂停态收口 stopped 必须先过 draining（停止推进通路
 *   负责 paused→draining 的 CAS），能力位 none 的 provider 根本不进入 paused。
 */
export const RUN_STATUS_TRANSITIONS: Readonly<Record<CloudRunStatus, readonly CloudRunStatus[]>> = {
  provisioning: ["ready", "failed", "stopped", "expired"],
  ready: ["paused", "disconnected", "draining", "expired", "failed"],
  paused: ["ready", "draining", "expired"],
  disconnected: ["ready", "draining", "expired", "failed"],
  draining: ["ready", "disconnected", "stopped", "expired", "failed"],
  stopped: [],
  expired: [],
  failed: [],
};

export function canTransitionRun(from: CloudRunStatus, to: CloudRunStatus): boolean {
  return RUN_STATUS_TRANSITIONS[from].includes(to);
}

export function isTerminalRunStatus(status: CloudRunStatus): boolean {
  return (TERMINAL_RUN_STATUSES as readonly CloudRunStatus[]).includes(status);
}

/** 占配额槽的 run：未终态，或终止结果未知仍保留槽的资源（01 §4.3、08 §6）。 */
export function occupiesQuotaSlot(status: CloudRunStatus): boolean {
  return (NON_TERMINAL_RUN_STATUSES as readonly CloudRunStatus[]).includes(status);
}

/**
 * Task 生命周期迁移表（08 §3.1 各状态「允许操作」列推导）。
 * 迁移都由显式命令或接纳事务触发，不存在隐式自动迁移。
 */
export const TASK_STATUS_TRANSITIONS: Readonly<
  Record<CloudTaskStatus, readonly CloudTaskStatus[]>
> = {
  // 首输入持久接收后才 active（08 §3.1）；归档保留历史。
  draft: ["active", "archived"],
  // 验收、确定失败、归档；reactivate 是 completed 的显式回退。
  active: ["completed", "failed", "archived"],
  // 查看/归档；PR 未 merged 时显式 reactivate（03 §6 reactivate 行）。
  completed: ["active", "archived"],
  // 查看原因、重试/新输入（reopen 成功后回到 active）、归档。
  failed: ["active", "archived"],
  // 只读历史；restore 由 archivedFromStatus 决定落点，不走普通迁移表。
  archived: [],
};

export function canTransitionTask(from: CloudTaskStatus, to: CloudTaskStatus): boolean {
  return TASK_STATUS_TRANSITIONS[from].includes(to);
}

/** 归档前置（03 §6 archive 行）：无活动写 run。 */
export function canArchiveTask(task: CloudTaskRecord, activeRun: CloudRunRecord | null): boolean {
  return task.status !== "archived" && !hasActiveWriteRun(activeRun);
}

/** 活动写 run = 未终态 run；每 Task 至多一个（08 §4.2）。 */
export function hasActiveWriteRun(run: CloudRunRecord | null): boolean {
  return run !== null && !isTerminalRunStatus(run.status);
}

/**
 * reactivate 前置（03 §6）：completed 且 PR 未 merged，不自动建 run。
 * `prStatus === "merged"` 时必须新建 follow-up Task，不能把已完成任务拉回 active（08 §3.1）。
 */
export function canReactivateTask(input: {
  task: CloudTaskRecord;
  activeRun: CloudRunRecord | null;
  prStatus?: "draft" | "open" | "merged" | "closed" | null;
}): boolean {
  if (input.task.status !== "completed") return false;
  if (hasActiveWriteRun(input.activeRun)) return false;
  return input.prStatus !== "merged";
}

/** restore 前置：archived 且有原前置状态（03 §6 restore 行）。 */
export function restoreTargetStatus(task: CloudTaskRecord): CloudTaskStatus | null {
  if (task.status !== "archived") return null;
  const restored = task.archivedFromStatus;
  if (!restored || restored === "archived") return null;
  return restored;
}

/**
 * force-stop 的 endReason 标记（03 §6「显式 loss acknowledgement」）：
 * 用持久事实让终止通路知道本次停止已由用户确认可能丢失工作，从而如实标记 dataAtRisk
 * （08 §8.2「不得宣称工作全部保住」）。普通 stop 不得使用该标记。
 */
export const FORCE_STOP_END_REASON = "force-stop" as const;

/**
 * 停止屏障（08 §8.1）：stop 受理后不再新启动 Agent、不投递、不发布 ready；
 * 在途不可撤销外部操作的结果只用于对账/补偿。
 */
export function stopIntentBlocksProgress(run: CloudRunRecord): boolean {
  return run.stopRequested === true;
}

/**
 * pause 准入（08 §3.2 修订 2026-10-09）：仅 `pauseResume ≠ none` 的分级能力 provider、
 * ready 且无停止意图的 run 可进入 paused。能力位 none 的 provider 永不进入 paused
 * （fail-closed，A-7 门禁在 driver describeCapabilities 层已把未实测能力收敛为 none）。
 */
export function mayPauseRun(input: {
  run: CloudRunRecord;
  pauseResume: "memory" | "disk" | "none";
}): boolean {
  return (
    input.run.status === "ready" &&
    !stopIntentBlocksProgress(input.run) &&
    input.pauseResume !== "none"
  );
}

/**
 * resume 预算判定（03 §6 修订 2026-10-09）：暂停预算（run 的硬期限，08 §7 修订：
 * hardDeadline 在 memory 级 pause 语义下转为「暂停预算」）耗尽后拒绝自驱 resume，
 * 归一错误 `budget_exhausted`；输入保持 accepted（202 已持久接收，不被追溯拒绝），
 * 直至 provider 保留期尽、keepalive liveness 确认实例不存在 → expired 并释放占槽。
 */
export function resumeBudgetExhausted(input: { run: CloudRunRecord; now: number }): boolean {
  return input.run.hardDeadlineAt !== undefined && input.now >= input.run.hardDeadlineAt;
}

/**
 * 创建途中取消（08 §8.1/11 §8）：provisioning run 保留供给事实，停止意图只阻断推进，
 * 迟到 handle 进入清理，不能发布 ready 或启动 Agent。
 */
export function provisioningCancelKeepsSupplyFact(run: CloudRunRecord): boolean {
  return run.status === "provisioning" && run.stopRequested === true;
}

/**
 * run 终态失败只在「runtime 不可恢复且实例处置完成」时使用（08 §3.2）。
 * 结果未知（provider 不可查询、operation 未结算）一律不得归 failed，只能保留
 * disconnected/reconciling（03 §5「网络超时不等于失败」）。
 */
export function mayTransitionToFailed(input: {
  run: CloudRunRecord;
  runtimeUnrecoverable: boolean;
  instanceDispositioned: boolean;
}): boolean {
  if (isTerminalRunStatus(input.run.status)) return false;
  if (input.run.status === "provisioning") {
    // provisioning→failed 要求「创建失败已核验并清理」。
    return input.instanceDispositioned;
  }
  return input.runtimeUnrecoverable && input.instanceDispositioned;
}

/**
 * Task 在 run 进入终态后的落点（08 §3.1 failed 行：「已确定失败且无活跃写 run」）。
 * 返回 null 表示保持当前状态（仍有可继续工作的 run，或已归档/已验收）。
 */
export function taskStatusAfterRunEnd(input: {
  task: CloudTaskRecord;
  runStatus: CloudRunStatus;
  remainingActiveRun: CloudRunRecord | null;
}): CloudTaskStatus | null {
  if (input.remainingActiveRun && !isTerminalRunStatus(input.remainingActiveRun.status))
    return null;
  if (input.task.status === "archived" || input.task.status === "completed") return null;
  if (input.task.status === "draft") return null;
  if (input.runStatus === "failed") return "failed";
  // stopped/expired 不改变 Task 委托状态：provider 到期不能直接写成「任务完成」（08 §3.1 尾段）。
  return null;
}

/**
 * 项目删除的活动任务判定（03 §6 deleteProject 行「默认有活动任务时 409」、08 §9 不级联丢历史）：
 * 只要还有未归档任务（含其历史），默认拒绝物理删除。
 */
export function blocksProjectDeletion(
  task: CloudTaskRecord,
  activeRun: CloudRunRecord | null,
): boolean {
  if (task.status === "archived" && !hasActiveWriteRun(activeRun)) return false;
  return true;
}

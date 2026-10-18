/**
 * checkpoint 保存的失败退避与在途占用策略（specs/cloud-agent/08 §7 修订 2026-10-09，
 * 终验缺陷 B）。从 savePolicy 拆出的单一职责：周期保存的「何时允许下一次保存」判定。
 *
 * 纯策略层：所有判定取注入的 `now` 与已持久事实，不读系统时钟、不发起副作用。
 */
/**
 * 周期保存失败退避阶梯（08 §7 修订 2026-10-09，终验缺陷 B）：连续失败按
 * 30s→2min→5min 放大重试间隔，封顶 5 分钟；且不低于部署的周期档（配置更长时按配置）。
 * 修复依据：终验中「无 checkpoint 记录 → 周期保存 sweep 每拍（30s）重建新 op」无限循环。
 */
export const CHECKPOINT_RETRY_LADDER_MS: readonly [number, number, number] = [
  30_000, 120_000, 300_000,
];

/** 连续失败 N 次后的重试间隔：阶梯第 min(N,3) 档与周期档取大（N≤0 = 正常周期档）。 */
export function checkpointRetryIntervalMs(input: {
  consecutiveFailures: number;
  periodicCheckpointMs: number;
}): number {
  const base = Math.max(1, input.periodicCheckpointMs);
  if (input.consecutiveFailures <= 0) return base;
  const step = Math.min(input.consecutiveFailures - 1, CHECKPOINT_RETRY_LADDER_MS.length - 1);
  // noUncheckedIndexedAccess：索引访问回退到封顶档（300s），不改变阶梯语义。
  const stepped = CHECKPOINT_RETRY_LADDER_MS[step] ?? CHECKPOINT_RETRY_LADDER_MS[2] ?? base;
  return Math.max(base, stepped);
}

/**
 * checkpoint「在途」占用窗口（08 §7 修订 2026-10-09）：`saving/pending` 记录只在窗口内
 * 算占用保存通道；超窗无更新是僵尸事实（op 已被 attempt 封顶结算），不再阻塞周期保存与
 * 空闲 pause——数据风险由 run.dataAtRisk 如实承载。窗口与「3 次 × 30s 租约」的 op 结算
 * 上界同数量级并留裕量。
 */
export const CHECKPOINT_IN_FLIGHT_WINDOW_MS = 120_000;

/** checkpoint 记录的状态事实切片（shared CheckpointState 的本地镜像，保持本文件零依赖）。 */
export type CheckpointStateFactState = "none" | "pending" | "saving" | "saved" | "failed";

export interface CheckpointStateFact {
  readonly state: CheckpointStateFactState;
  readonly updatedAt: number;
}

/** 保存通道占用判定：窗口内有 saving/pending 记录才算在途（08 §7「无 checkpoint」条件）。 */
export function hasCheckpointInFlight(input: {
  records: readonly CheckpointStateFact[];
  now: number;
  windowMs?: number;
}): boolean {
  const windowMs = input.windowMs ?? CHECKPOINT_IN_FLIGHT_WINDOW_MS;
  return input.records.some(
    (record) =>
      (record.state === "saving" || record.state === "pending") &&
      input.now - record.updatedAt <= windowMs,
  );
}

/** 连续失败计数：按 updatedAt 降序数「开头连续 failed」的记录数（08 §7 退避的事实源）。 */
export function consecutiveCheckpointFailures(records: readonly CheckpointStateFact[]): number {
  const ordered = [...records].sort((left, right) => right.updatedAt - left.updatedAt);
  let count = 0;
  for (const record of ordered) {
    if (record.state !== "failed") break;
    count += 1;
  }
  return count;
}

/** checkpoint.result 归属校验所需的 operation 事实切片（domain 不依赖 app 端口）。 */
export interface CheckpointOperationFact {
  readonly kind: string;
  readonly taskId?: string;
  readonly runId?: string;
  readonly runGeneration?: number;
}

export type CheckpointResultAdmission =
  | { kind: "ok" }
  /** 同一 operationId 已 saved：saved 是终态，迟到结果只忽略、不改记录与派生事实。 */
  | { kind: "already-saved" }
  | { kind: "operation-not-found" }
  | { kind: "operation-mismatch" }
  /** saved 声明不在 Task 的任务分支上：不得伪造保存成功（08 §8.1、R2）。 */
  | { kind: "branch-rejected" };

/**
 * checkpoint.result 准入（2026-10-17 R2，15 §3）：
 * - operationId 必须对应本 task/run/generation 上真实存在的 checkpoint 操作；
 * - 已 saved 的记录为终态，迟到 failed/unknown 不覆盖（也不改 dataAtRisk/lastCheckpointSha）；
 * - saved 仅在 branch 等于非空 taskBranch 时允许，否则按 failed 语义 fail-closed。
 */
export function evaluateCheckpointResultAdmission(input: {
  operation: CheckpointOperationFact | null;
  existingState?: string;
  taskId: string;
  runId: string;
  runGeneration: number;
  status: "saved" | "failed" | "unknown";
  branch?: string;
  taskBranch?: string;
}): CheckpointResultAdmission {
  const operation = input.operation;
  if (!operation) return { kind: "operation-not-found" };
  if (
    operation.kind !== "checkpoint" ||
    operation.taskId !== input.taskId ||
    operation.runId !== input.runId ||
    operation.runGeneration !== input.runGeneration
  ) {
    return { kind: "operation-mismatch" };
  }
  if (input.existingState === "saved") return { kind: "already-saved" };
  if (
    input.status === "saved" &&
    (input.taskBranch === undefined ||
      input.taskBranch.length === 0 ||
      input.branch !== input.taskBranch)
  ) {
    return { kind: "branch-rejected" };
  }
  return { kind: "ok" };
}

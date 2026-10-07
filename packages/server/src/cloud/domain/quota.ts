/**
 * 并发配额规则（specs/cloud-agent/08 §6「创建事务与配额」、01 §4.3 期限与配额）。
 *
 * 规则来源逐条：
 * - 建议初始全局并发上限 3，可配置（08 §6；01 §4.3 候选值，M0 冻结前是规划默认值）。
 * - 占额包括 provisioning/ready/disconnected/draining（08 §6），以及终止结果未知
 *   仍保留槽的资源（01 §4.3「终止结果未知的资源都占槽」）。
 * - 并发检查和预留必须事务化，不能先 count 后 create（08 §6）；本文件只提供
 *   「哪些算占用 / 是否允许预留 / 何时可释放」的纯判定，事务由 storage.acceptInput 承担。
 * - 最终释放以终止/失败核验为依据，不能靠页面取消或删 Task 释放（01 §4.3、03 §5）。
 */
import type { CloudRunRecord } from "@zcode/shared";
import { occupiesQuotaSlot } from "./taskRunState.js";

/** 08 §6 / 01 §4.3 的规划默认值；部署可通过配置覆盖。 */
export const DEFAULT_MAX_CONCURRENT_RUNS = 3;

export type QuotaDecision =
  | { allowed: true; occupiedSlots: number; maxConcurrentRuns: number }
  | {
      allowed: false;
      code: "quota_exceeded";
      occupiedSlots: number;
      maxConcurrentRuns: number;
    };

/**
 * 计算占用的并发槽：未终态 run + 终止结果未知的 run（后者在状态上可能已终态，
 * 但「资源清理未确认仍占额」，故由调用方显式列出 pendingTerminationRunIds）。
 */
export function countOccupiedSlots(input: {
  runs: readonly CloudRunRecord[];
  /** 终止结果未知（operation=ambiguous 或 provider 未核验）的 runId。 */
  pendingTerminationRunIds?: readonly string[];
}): number {
  const occupied = new Set<string>();
  const pending = new Set(input.pendingTerminationRunIds ?? []);
  for (const run of input.runs) {
    if (occupiesQuotaSlot(run.status) || pending.has(run.runId)) occupied.add(run.runId);
  }
  return occupied.size;
}

/**
 * 预留判定：调用方传入事务中读到的当前占用数；`maxConcurrentRuns` 必须与事务
 * 内读到的配置一致，不能先查后用陈旧值（08 §6）。
 */
export function evaluateQuotaReservation(input: {
  occupiedSlots: number;
  maxConcurrentRuns: number;
}): QuotaDecision {
  const max = Math.max(1, Math.trunc(input.maxConcurrentRuns));
  if (input.occupiedSlots >= max) {
    return {
      allowed: false,
      code: "quota_exceeded",
      occupiedSlots: input.occupiedSlots,
      maxConcurrentRuns: max,
    };
  }
  return { allowed: true, occupiedSlots: input.occupiedSlots, maxConcurrentRuns: max };
}

/**
 * 配额释放依据（01 §4.3、08 §6）：只有 provider 确认资源释放才释放计费槽。
 * `unknown`/`notTerminated` 都保留槽并对账。
 */
export function mayReleaseQuota(termination: "terminated" | "notTerminated" | "unknown"): boolean {
  return termination === "terminated";
}

/**
 * 资源槽保留事实（03 §6.2 尾段）：资源清理未确认时 Run/配额仍保留，
 * 不因 input 终态释放。
 */
export function quotaRetainedWhileCleanupUnknown(input: {
  inputResolved: boolean;
  terminationConfirmed: boolean;
}): boolean {
  return !input.terminationConfirmed;
}

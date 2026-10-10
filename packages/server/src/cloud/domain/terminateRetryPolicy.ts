/**
 * terminate 操作的失败重试策略（specs/cloud-agent/08 §8.1 修订 2026-10-09，
 * 生命周期 v2 审计第一批）。纯策略层：所有判定取注入的 `now` 与已持久事实，
 * 不读系统时钟、不发起副作用。
 *
 * 背景（审计 P1）：outbox 租约只领 pending/到期 leased/ambiguous（03 §5），
 * `failed` 行永不重领，而 `enqueue` 幂等返回既有行不改状态——provider 明确拒绝
 * 终止（notTerminated，如 403/402）后 op 停在 failed，非终态 run 永久卡
 * draining/paused。修复：按 attempt 退避把 failed terminate op 重排队为 pending，
 * 由既有补偿循环重试；attempt 封顶后保持 failed 并升级告警，终局兜底是
 * keepalive liveness（provider 实例消失会收口）。
 */

/** 重试上限（含首次）：达到后不再重排队（08 §8.1 修订：升级告警，不无限打 provider）。 */
export const TERMINATE_RETRY_MAX_ATTEMPTS = 10;

/**
 * 退避阶梯（对齐周期保存退避风格，08 §7 修订终验缺陷 B）：第 1 次失败后 30s、
 * 第 2 次后 2min、之后 5min 封顶。terminate 是对 provider 的破坏性最小操作
 * （幂等 destroy），阶梯只用于降频，不承担「保存窗口」语义。
 */
const TERMINATE_RETRY_LADDER_MS: readonly [number, number, number] = [30_000, 120_000, 300_000];

/** 第 N 次（attempt=N）失败后的重试间隔：阶梯第 min(N,3) 档（N<=0 视为立即可试）。 */
export function terminateRetryIntervalMs(attempt: number): number {
  if (attempt <= 0) return 0;
  const step = Math.min(attempt - 1, TERMINATE_RETRY_LADDER_MS.length - 1);
  // noUncheckedIndexedAccess：索引访问回退到封顶档（300s），不改变阶梯语义。
  return TERMINATE_RETRY_LADDER_MS[step] ?? TERMINATE_RETRY_LADDER_MS[2] ?? 300_000;
}

/**
 * failed terminate op 是否应重排队重试：
 * - `attempt < maxAttempts`：封顶后保持 failed + 告警（08 §8.1 修订）；
 * - `now - failedAt >= interval(attempt)`：按阶梯退避，锚点是 op 的 failed 结算时刻。
 */
export function terminateRetryDue(input: {
  attempt: number;
  failedAt: number;
  now: number;
  maxAttempts?: number;
}): boolean {
  if (input.attempt >= (input.maxAttempts ?? TERMINATE_RETRY_MAX_ATTEMPTS)) return false;
  return input.now - input.failedAt >= terminateRetryIntervalMs(input.attempt);
}

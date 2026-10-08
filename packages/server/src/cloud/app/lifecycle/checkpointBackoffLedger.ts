/**
 * 周期保存「结果帧缺失」失败的进程内台账（08 §7 退避修订 2026-10-09，终验缺陷 B）。
 *
 * 为什么需要：结果长期不到的 checkpoint op 被 attempt 封顶结算 failed 时，控制面**没有**
 * checkpoint 记录可数（结果帧从未回来），持久化的「连续失败」事实无从谈起——用 worker
 * 本地台账兜住。lifecycle 循环单飞且同进程，无并发写（与 keepalive 的 liveness 节流表同
 * 一所有权口径）；保存成功即清零。终验 2026-10-09：结果缺失 + 无记录 → 周期保存 sweep
 * 每 30s 重建新 op，30 分钟 90 个 failed op 空转。
 */
const RESULTLESS_FAILURE_TTL_MS = 30 * 60_000;

export interface CheckpointFailureLedger {
  /** 结果缺失（attempt 封顶/ambiguous）记一次失败；TTL 外的旧条目重新计数。 */
  recordFailure(runId: string, now: number): void;
  /** 保存成功即清零（08 §7 退避：成功恢复 normal 周期档）。 */
  clear(runId: string): void;
  /** 当前连击数（TTL 内）；0 = 无事实。 */
  streak(runId: string, now: number): number;
  /** 连击的最后一次失败时刻（无记录时的退避锚）；无事实返回 undefined。 */
  anchorAt(runId: string, now: number): number | undefined;
  /** 只留 TTL 内且仍非终态的 run，避免长跑进程无限增长。 */
  retain(liveRunIds: ReadonlySet<string>, now: number): void;
}

export function createCheckpointFailureLedger(): CheckpointFailureLedger {
  const entries = new Map<string, { count: number; lastAt: number }>();

  const fresh = (runId: string, now: number): { count: number; lastAt: number } | undefined => {
    const entry = entries.get(runId);
    return entry !== undefined && now - entry.lastAt <= RESULTLESS_FAILURE_TTL_MS
      ? entry
      : undefined;
  };

  return {
    recordFailure(runId, now) {
      const current = fresh(runId, now);
      entries.set(runId, {
        count: current !== undefined ? current.count + 1 : 1,
        lastAt: now,
      });
    },
    clear(runId) {
      entries.delete(runId);
    },
    streak(runId, now) {
      return fresh(runId, now)?.count ?? 0;
    },
    anchorAt(runId, now) {
      return fresh(runId, now)?.lastAt;
    },
    retain(liveRunIds, now) {
      for (const [runId, entry] of entries) {
        if (!liveRunIds.has(runId) || now - entry.lastAt > RESULTLESS_FAILURE_TTL_MS) {
          entries.delete(runId);
        }
      }
    },
  };
}

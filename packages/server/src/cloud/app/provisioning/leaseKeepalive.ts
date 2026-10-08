/**
 * create 租约保活（C-3「租约续期覆盖 create 全程」；specs/cloud-agent/03 §5 operation 租约）。
 *
 * 问题：provider create 可能远超默认租期（60s+，慢 provider/冷启动）。租约到期后
 * `leaseNext` 会把同一 operation 领给第二个 worker，两个 create 并发（迟到分配的根源）。
 *
 * 修法：持有方在执行期间用 `renewLease`（持有人 token CAS）周期续租——
 * - 续期间隔取租期的 1/3（纯决策 `leaseKeepaliveIntervalMs`，夹在 [250ms, 15s]），
 *   提前续、不在最后一刻赌 IO 延迟；
 * - 续租返回 false（令牌被接管/已结算）立即停止：本 worker 的后续结算会被 CAS 拒绝，
 *   由对账路径收口，不与持有者竞争；
 * - `stop()` 幂等，等待在飞一次续租收尾；进程崩溃时定时器随之消亡，租约到期自然可重领。
 *
 * 定时器经 `delay` 注入（缺省真实 `setTimeout`，测试注入受控等待）；决策与效果分离
 * （D5），纯函数不打桩可测。
 */
import type { ClockPort } from "../ports/clockPort.js";
import type { OperationOutboxPort } from "../ports/operationOutboxPort.js";

/** 续期间隔下限：过短的租期也不至于把续租打成忙循环。 */
const MIN_INTERVAL_MS = 250;
/** 续期间隔上限：默认 60s 租期下 20s→夹到 15s，留足一次续租失败后的重试窗口。 */
const MAX_INTERVAL_MS = 15_000;

/** 纯决策：给定租期，续期间隔 = 租期/3 夹在 [250ms, 15s]。 */
export function leaseKeepaliveIntervalMs(leaseMs: number): number {
  const third = Math.floor(Math.max(1, leaseMs) / 3);
  return Math.min(Math.max(third, MIN_INTERVAL_MS), MAX_INTERVAL_MS);
}

export interface OperationLeaseKeepalive {
  /** 停止续租并等待在飞一次续租收尾（幂等）。 */
  stop(): Promise<void>;
  /** 已成功续租次数（测试观测）。 */
  renewals(): number;
  /** 续租被拒（令牌丢失/已结算）：持有方应尽快收尾，不做新的副作用。 */
  lost(): boolean;
}

export interface OperationLeaseKeepaliveOptions {
  operations: Pick<OperationOutboxPort, "renewLease">;
  clock: ClockPort;
  operationId: string;
  /** 结算用的同一租约令牌：renewLease 只延长时间，不换令牌。 */
  leaseToken: string;
  leaseMs: number;
  /** 等待实现（测试注入受控时钟；缺省真实 setTimeout）。 */
  delay?: (ms: number) => Promise<void>;
  /** 续租丢失时的告警钩子（缺省静默；调用方接 logger）。 */
  onLost?: () => void;
}

export function startOperationLeaseKeepalive(
  options: OperationLeaseKeepaliveOptions,
): OperationLeaseKeepalive {
  const intervalMs = leaseKeepaliveIntervalMs(options.leaseMs);
  const delay =
    options.delay ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let stopped = false;
  let lost = false;
  let renewalCount = 0;
  let inFlight: Promise<void> = Promise.resolve();

  const loop = (async () => {
    while (!stopped) {
      await delay(intervalMs);
      if (stopped) return;
      inFlight = (async () => {
        try {
          const renewed = await options.operations.renewLease({
            operationId: options.operationId,
            leaseToken: options.leaseToken,
            leaseMs: options.leaseMs,
            now: options.clock.now(),
          });
          if (renewed) {
            renewalCount += 1;
            return;
          }
          // 令牌被接管（第二个 worker 已领）或 op 已结算：立刻退出，不再竞争。
          lost = true;
          stopped = true;
          options.onLost?.();
        } catch {
          // 续租 IO 失败不等于接管：下一拍再试（租约到期前仍有余量）。
        }
      })();
      await inFlight;
    }
  })();
  void loop;

  return {
    async stop() {
      stopped = true;
      await inFlight;
    },
    renewals: () => renewalCount,
    lost: () => lost,
  };
}

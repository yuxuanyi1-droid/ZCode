/**
 * 生命周期循环的定时器实现（`LoopSchedulerPort` 的生产侧；W1 §4）。
 *
 * 由云入口注入：app 的循环体是纯编排，定时器是 adapter 关注点（`app/ports/loopSchedulerPort.ts`）。
 * 契约：同一循环两拍不重叠（上一拍未结束即跳过）、单拍抛错不终止后续调度、`stop()` 后不再触发。
 */
import type { LoopSchedulerPort } from "../app/ports/loopSchedulerPort.js";
import type { CloudAdapterLogger } from "./sandbox/adapterError.js";

// ── 生命周期循环的定时器实现（LoopSchedulerPort 的生产侧）──

export interface IntervalLoopScheduler extends LoopSchedulerPort {
  /** 关闭全部定时器并等待在飞 tick 收尾。 */
  stopAll(): Promise<void>;
}

export function createIntervalLoopScheduler(options: {
  jitterRatio?: number;
  logger: CloudAdapterLogger;
}): IntervalLoopScheduler {
  const jitterRatio = options.jitterRatio ?? 0.1;
  const intervalTimers = new Set<ReturnType<typeof setInterval>>();
  const delayTimers = new Set<ReturnType<typeof setTimeout>>();
  const inFlight = new Set<Promise<void>>();

  const track = (task: () => Promise<void>) => {
    const promise = task()
      .catch((error: unknown) => {
        // 单拍失败不得终止后续调度（loopSchedulerPort 约定）。
        options.logger.warn(undefined, "[cloud-entry] loop tick failed", error);
      })
      .finally(() => {
        inFlight.delete(promise);
      });
    inFlight.add(promise);
  };

  return {
    schedule(intervalMs, task) {
      if (!(intervalMs > 0)) {
        throw new Error(`loop interval must be positive: ${intervalMs}`);
      }
      const jitter = Math.round(intervalMs * jitterRatio * (Math.random() * 2 - 1));
      let running = false;
      const timer = setInterval(
        () => {
          if (running) {
            // 上一拍未结束则跳过本拍，不叠加并发 tick。
            return;
          }
          running = true;
          const promise = task()
            .catch((error: unknown) => {
              options.logger.warn(undefined, "[cloud-entry] loop tick failed", error);
            })
            .finally(() => {
              running = false;
              inFlight.delete(promise);
            });
          inFlight.add(promise);
        },
        Math.max(1, intervalMs + jitter),
      );
      intervalTimers.add(timer);
      return () => {
        clearInterval(timer);
        intervalTimers.delete(timer);
      };
    },
    delay(delayMs, task) {
      const timer = setTimeout(
        () => {
          delayTimers.delete(timer);
          track(task);
        },
        Math.max(0, delayMs),
      );
      delayTimers.add(timer);
      return () => {
        clearTimeout(timer);
        delayTimers.delete(timer);
      };
    },
    async stopAll() {
      for (const timer of intervalTimers) {
        clearInterval(timer);
      }
      for (const timer of delayTimers) {
        clearTimeout(timer);
      }
      intervalTimers.clear();
      delayTimers.clear();
      await Promise.allSettled(inFlight);
    },
  };
}

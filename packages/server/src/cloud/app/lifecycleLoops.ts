/**
 * 后台生命周期循环（W1 §4；03 §8 启动顺序、§9 背压观测、01 §5.3 启动对账、08 §7/§8 保活与 drain）。
 *
 * 分工：
 * - 循环体是**纯编排**（探测/恢复/对账/投递），定时器由 `LoopSchedulerPort` 注入（W5 用真实
 *   `setInterval`，测试用手动调度器）：app 不持有定时器，入口也**不得自建定时器**；
 * - 入口按 W5 冻结面需要两个句柄：`delivery`（durable outbox 投递，先停）与
 *   `lifecycle`（保活/对账/reconciler，后停）；
 * - 同一循环不重叠：上一拍未结束即跳过本拍；tick 抛错只记录，不终止后续调度（02 §8）。
 */
import type { CloudControlPlane } from "./assembleCloudControlPlane.js";
import type { LoopSchedulerPort } from "./ports/loopSchedulerPort.js";
import { cloudCoreLogger } from "./logger.js";

export interface CloudLoopIntervals {
  /** 投递与对账（202 后后台启动，03 §1：无客户端也继续投递）。 */
  deliveryIntervalMs: number;
  /** 心跳检查：阈值 90s，30s 检查足够（02 §8 心跳周期 30s）。 */
  heartbeatIntervalMs: number;
  /** provider 创建/readiness 轮询。 */
  provisioningIntervalMs: number;
  /** 租期、闲置、周期保存、checkpoint 结算。 */
  lifecycleIntervalMs: number;
}

export const DEFAULT_CLOUD_LOOP_INTERVALS: CloudLoopIntervals = {
  deliveryIntervalMs: 1_000,
  heartbeatIntervalMs: 30_000,
  provisioningIntervalMs: 5_000,
  lifecycleIntervalMs: 30_000,
};

export interface CloudLoopTickReport {
  deliveredTasks: number;
  created: number;
  stopsAdvanced: number;
  reconciliation: Record<string, number>;
}

/** W5 冻结的后台循环句柄形状（`name` + 幂等 start + 等待在飞一拍的 stop）。 */
export interface CloudBackgroundLoop {
  readonly name: string;
  /** 注册周期任务；幂等。 */
  start(): void;
  /** 取消并等待在飞一拍收尾；重复调用无副作用。 */
  stop(): Promise<void>;
  /** 手动执行一拍（测试与预热；不改变调度状态）。 */
  runOnce(): Promise<CloudLoopTickReport>;
}

const CREATE_LEASES_PER_TICK = 2;

/** 单拍内共享的编排顺序（两条循环都按它推进，避免「先投递后 ready」一类乱序）。 */
function createTickRunner(plane: CloudControlPlane, workerId: string) {
  const inFlight = new Set<string>();

  async function guarded(scope: string, task: () => Promise<unknown>): Promise<void> {
    if (inFlight.has(scope)) return;
    inFlight.add(scope);
    try {
      await task();
    } catch (error) {
      // 循环抛错不得终止后续调度（02 §8：只记录，不静默停摆）。
      cloudCoreLogger.error(undefined, "cloud lifecycle loop tick failed", {
        scope,
        error: error instanceof Error ? error.message : "unknown",
      });
    } finally {
      inFlight.delete(scope);
    }
  }

  return {
    guarded,
    /** 投递 + 输入对账（delivery 循环）。 */
    async deliveryTick(): Promise<CloudLoopTickReport> {
      const report = emptyReport();
      const dispatches = await plane.delivery.dispatchOnce();
      report.deliveredTasks = dispatches.filter((item) =>
        item.outcomes.some((outcome) => outcome.result === "sent"),
      ).length;
      const reconciliations = await plane.inputControl.reconcileOnce();
      report.reconciliation = summarizeReconciliation(reconciliations);
      return report;
    },
    /** 生命周期：终止结算 → create → readiness → checkpoint 结算 → stop 推进 → 保活/drain → 心跳。 */
    async lifecycleTick(): Promise<CloudLoopTickReport> {
      const report = emptyReport();
      await plane.provisioning.compensation.runCompensationOnce({ workerId });
      for (let index = 0; index < CREATE_LEASES_PER_TICK; index += 1) {
        const attempt = await plane.provisioning.create.runCreateOnce({ workerId });
        if (!attempt) break;
        if (attempt.outcome === "created") report.created += 1;
      }
      await plane.provisioning.readiness.sweep();
      await plane.lifecycle.checkpoints.sweepCheckpointOperations({ workerId });
      const stopReport = await plane.commands.stop.sweep();
      report.stopsAdvanced = stopReport.advanced;
      await plane.lifecycle.keepalive.sweep();
      await plane.lifecycle.drain.sweep();
      await plane.lifecycle.checkpoints.sweepPeriodicCheckpoints();
      await plane.watchdog.sweep();
      return report;
    },
  };
}

export function createDeliveryLoop(
  plane: CloudControlPlane,
  options: { scheduler: LoopSchedulerPort; workerId?: string; intervalMs?: number },
): CloudBackgroundLoop {
  const runner = createTickRunner(plane, options.workerId ?? "cloud-delivery");
  const intervalMs = options.intervalMs ?? DEFAULT_CLOUD_LOOP_INTERVALS.deliveryIntervalMs;
  let cancel: (() => void) | undefined;
  let inFlightTick: Promise<unknown> = Promise.resolve();
  return {
    name: "delivery",
    start() {
      if (cancel) return;
      cancel = options.scheduler.schedule(intervalMs, async () => {
        inFlightTick = runner.guarded("delivery", async () => {
          await runner.deliveryTick();
        });
        await inFlightTick;
      });
    },
    async stop() {
      cancel?.();
      cancel = undefined;
      await inFlightTick;
    },
    runOnce: () => runner.deliveryTick(),
  };
}

export function createLifecycleLoop(
  plane: CloudControlPlane,
  options: {
    scheduler: LoopSchedulerPort;
    workerId?: string;
    intervals?: Partial<CloudLoopIntervals>;
  },
): CloudBackgroundLoop {
  const workerId = options.workerId ?? "cloud-lifecycle";
  const runner = createTickRunner(plane, workerId);
  const intervals = { ...DEFAULT_CLOUD_LOOP_INTERVALS, ...options.intervals };
  const cancels: (() => void)[] = [];
  let inFlightTick: Promise<unknown> = Promise.resolve();
  return {
    name: "lifecycle",
    start() {
      if (cancels.length > 0) return;
      cancels.push(
        options.scheduler.schedule(intervals.heartbeatIntervalMs, () =>
          runner.guarded("heartbeat", () => plane.watchdog.sweep().then(() => undefined)),
        ),
      );
      cancels.push(
        options.scheduler.schedule(intervals.provisioningIntervalMs, () =>
          runner.guarded("provisioning", async () => {
            await plane.provisioning.compensation.runCompensationOnce({ workerId });
            await plane.provisioning.create.runCreateOnce({ workerId });
            await plane.provisioning.readiness.sweep();
          }),
        ),
      );
      cancels.push(
        options.scheduler.schedule(intervals.lifecycleIntervalMs, async () => {
          inFlightTick = runner.guarded("lifecycle", async () => {
            await runner.lifecycleTick();
          });
          await inFlightTick;
        }),
      );
    },
    async stop() {
      for (const cancel of cancels.splice(0)) cancel();
      await inFlightTick;
    },
    runOnce: () => runner.lifecycleTick(),
  };
}

/** 组合句柄：保留给既有测试与「一拍跑完所有编排」的预热路径。 */
export interface CloudLifecycleLoops {
  runOnce(): Promise<CloudLoopTickReport>;
  runStartupReconciliation(): Promise<void>;
  stop(): void;
}

export function startCloudLifecycleLoops(
  plane: CloudControlPlane,
  options: {
    scheduler: LoopSchedulerPort;
    intervals?: Partial<CloudLoopIntervals>;
    workerId?: string;
  },
): CloudLifecycleLoops {
  const runner = createTickRunner(plane, options.workerId ?? "cloud-lifecycle");
  const delivery = createDeliveryLoop(plane, {
    scheduler: options.scheduler,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    ...(options.intervals?.deliveryIntervalMs !== undefined
      ? { intervalMs: options.intervals.deliveryIntervalMs }
      : {}),
  });
  const lifecycle = createLifecycleLoop(plane, {
    scheduler: options.scheduler,
    ...(options.workerId ? { workerId: options.workerId } : {}),
    ...(options.intervals ? { intervals: options.intervals } : {}),
  });
  delivery.start();
  lifecycle.start();
  return {
    async runOnce() {
      const deliveryReport = await runner.deliveryTick();
      const lifecycleReport = await runner.lifecycleTick();
      return {
        deliveredTasks: deliveryReport.deliveredTasks,
        created: lifecycleReport.created,
        stopsAdvanced: lifecycleReport.stopsAdvanced,
        reconciliation: deliveryReport.reconciliation,
      };
    },
    async runStartupReconciliation() {
      await runner.guarded("startup-reconciliation", async () => {
        await plane.reconciler.reconcileOnStartup();
      });
    },
    stop() {
      void delivery.stop();
      void lifecycle.stop();
    },
  };
}

function emptyReport(): CloudLoopTickReport {
  return { deliveredTasks: 0, created: 0, stopsAdvanced: 0, reconciliation: {} };
}

function summarizeReconciliation(
  reports: readonly {
    examined: number;
    resolved: number;
    resent: number;
    stillUncertain: number;
  }[],
): Record<string, number> {
  return {
    examined: reports.reduce((sum, item) => sum + item.examined, 0),
    resolved: reports.reduce((sum, item) => sum + item.resolved, 0),
    resent: reports.reduce((sum, item) => sum + item.resent, 0),
    uncertain: reports.reduce((sum, item) => sum + item.stillUncertain, 0),
  };
}

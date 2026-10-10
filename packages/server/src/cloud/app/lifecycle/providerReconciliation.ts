/**
 * provider 事实核对与 paused 终局兜底（08 §7 断连保留槽位、01 §4.1/§4.3、01 §4.1 修订
 * 2026-10-09 审计第二批；从 keepalive.ts 拆出，行数预算）。
 *
 * 两个职责，判定都只认 **provider 的确定事实**：
 * 1. **存活核对（liveness）**：断连/停摆/暂停 run 周期性核对实例事实——notFound/stopped
 *    才按唯一收口入口 settleTerminal 终止并释放槽位；running/paused/unknown 一律不动
 *    （结果未知不等于资源已释放，01 §4.3、03 §5）。paused run 的 stopped 观测按
 *    disk-pause 保留态调停（消费侧，见 reconcileLiveness 注释）。
 * 2. **暂停预算耗尽的时间兜底**：paused + 预算耗尽超宽限（PAUSED_BUDGET_TERMINATION_GRACE_MS）
 *    → 经既有终止入口主动终止，provider 确认后收口 expired（provider 保留期无界时 run
 *    否则永久占槽）。
 */
import type { CloudRunRecord } from "@zcode/shared";
import { resumeBudgetExhausted } from "../../domain/taskRunState.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import type { RunCompensation } from "../provisioning/compensation.js";
import type { ProviderObservation } from "../ports/sandboxDriverPort.js";
import type { RunOrchestrator } from "../runOrchestrator.js";

/** provider 明确报告实例不存在/已终止时的收口标签（03 §9 可读原因）。 */
export const PROVIDER_INSTANCE_LOST_END_REASON = "provider-instance-lost";

/**
 * 断连后的 provider 事实核对周期（08 §7 断连保留槽位、01 §4.3 只有确认释放才释放计费槽）。
 *
 * 为什么需要：断连本身**要**保留槽位（bridge 可能重连），但断连之后若没人核对 provider 事实，
 * 一个已被删除/已停止的沙箱会让槽位一直占到硬期限。真实链路：两个 run 停在 disconnected、
 * `quota_released_at` 为 NULL、sandbox 已被 provider 删除（204），期间所有新接纳都 409
 * `quota_exceeded`，直到硬期限才自愈。
 *
 * 频率：不新建定时器，跟着 sweep 既有节奏（lifecycle 30s 一拍）；但同一 run 两次核对之间
 * 至少间隔本值，避免每轮都对每个 run 打 provider。
 */
export const PROVIDER_LIVENESS_RECHECK_MS = 60_000;

/**
 * paused 预算耗尽后的主动终止宽限（03 修订 2026-10-09 审计第二批）。
 *
 * 为什么需要：预算耗尽只拒 resume（pauseResume 的 budget_exhausted），终局只等 provider
 * 保留期尽（notFound）；provider 保留期无界（未核实上限）时，run 永久 paused 占槽——
 * 并发上限 3 时 3 个即满配额，所有新接纳 409。
 *
 * 取值 24h 的依据：①跨一个完整工作日周期，夜间/周末暂停的 run 不会被「当夜销毁」，
 * 预算耗尽闭环（停旧 run + checkpoint 重开）与用户手动重开都有充足窗口；②占槽与保留
 * 计费仍然有界，不会无限累积；③长于所有既有退避/重试节奏（resume 退避 30s、liveness
 * 60s、drain 预算 5min），宽限内的收口拍不会被在途重试干扰。部署要收紧时可按部署键
 * 覆盖（与其它 SAVE_POLICY_DEFAULTS 同思路；先以常量落地，等真实保留期实测再冻结）。
 */
export const PAUSED_BUDGET_TERMINATION_GRACE_MS = 24 * 60 * 60 * 1000;

/** 预算宽限兜底收口的 endReason（03 §9 可读原因）。 */
export const PAUSED_BUDGET_END_REASON = "pause-budget-exhausted";

/** liveness 结论：lost = 已按确定事实收口；其余结论调用方一律不动该 run。 */
export type LivenessResult =
  | "alive"
  | "lost"
  | "unknown"
  | "throttled"
  | "no-fact"
  | "stop-pending";

export interface ProviderFactControl {
  /** 断连/停摆/暂停 run 的存活核对（节流内重复调用返回 throttled，不打 provider）。 */
  reconcileLiveness(run: CloudRunRecord, now: number): Promise<LivenessResult>;
  /** 预算宽限尽的 paused run 主动终止；false = 未确认（保持 paused，下一拍重试）。 */
  terminatePauseBudgetExpired(run: CloudRunRecord): Promise<boolean>;
  /** paused 预算宽限是否已尽（无硬期限事实的 run 恒 false，等 provider 确定事实收口）。 */
  isPauseBudgetGraceExpired(run: CloudRunRecord, now: number): boolean;
  /** 节流表只留仍非终态的 run，避免长跑进程里无限增长。 */
  pruneLiveRuns(runIds: ReadonlySet<string>): void;
}

export function createProviderFactControl(
  deps: CloudCoreDeps,
  orchestrator: RunOrchestrator,
  /** 既有终止入口（持久 terminate op + 幂等键执行）：预算宽限兜底收口复用，不另写终止。 */
  compensation: RunCompensation,
): ProviderFactControl {
  const { storage, operations, drivers } = deps;
  /** 上一次 provider 事实核对时间（进程内节流；重启后立即核对一次，无害）。 */
  const lastLivenessCheckAt = new Map<string, number>();

  /**
   * 断连/停摆 run 的 provider 事实核对（08 §7、01 §4.3、01 §4.1 修订 2026-10-09）。
   *
   * 只对 **provider 的确定事实** 下结论：
   * - `notFound` / `stopped`（实例不存在或已终止）→ 按既有唯一收口入口
   *   `RunOrchestrator.settleTerminal` 终止并释放槽位（`termination: "terminated"` 由
   *   provider 结论作为证据；本文件不另写终止/释放逻辑）；
   * - `running` → 什么都不做（断连保留槽位，等 bridge 重连）；
   * - `paused` → 什么都不做（01 §4.1 修订：暂停保留期的实例被 provider 保留，存在性
   *   核对走 paused 态——**不得**按 stopped/notFound 收口；run 保持 paused、不续期，
   *   收口只发生在暂停预算/保留期尽后的确定事实上）；
   * - `stopped` × run=paused → 视为存活（01 §4.1 修订审计第二批的消费侧调停：Daytona
   *   disk 级暂停的 provider 落点就是 stop 系停态，控制面 paused 事实优先；notFound
   *   才是真终局）；
   * - 不可达/超时/`unknown` → **什么都不做**，只记 warn，下一轮再查。绝不「查不到就释放」：
   *   结果未知不等于资源已释放（01 §4.3、03 §5），提前释放会让另一个 run 与旧沙箱并跑。
   */
  async function reconcileLiveness(run: CloudRunRecord, now: number): Promise<LivenessResult> {
    if (!run.provider || !run.providerHandle) return "no-fact";
    const last = lastLivenessCheckAt.get(run.runId);
    if (last !== undefined && now - last < PROVIDER_LIVENESS_RECHECK_MS) return "throttled";
    lastLivenessCheckAt.set(run.runId, now);

    const driver = await drivers.resolve(run.provider);
    if (!driver) {
      cloudCoreLogger.warn(undefined, "cloud provider liveness check unavailable", {
        runId: run.runId,
        provider: run.provider,
      });
      return "unknown";
    }
    let observation: ProviderObservation;
    try {
      observation = await driver.inspect({
        provider: run.provider,
        sandboxId: run.providerHandle,
      });
    } catch (error) {
      // 不可达/超时：结果未知，保留槽位并等下一轮；不猜、不提前释放。
      cloudCoreLogger.warn(undefined, "cloud provider liveness check failed", {
        runId: run.runId,
        provider: run.provider,
        message: error instanceof Error ? error.message : String(error),
      });
      return "unknown";
    }
    if (observation.status === "running") return "alive";
    if (observation.status === "paused") {
      // 暂停保留期（01 §4.1 修订）：实例仍被 provider 保留，绝不按 stopped 收口。
      cloudCoreLogger.debug(undefined, "cloud provider liveness paused", {
        runId: run.runId,
        provider: run.provider,
      });
      return "alive";
    }
    if (observation.status === "stopped" && run.status === "paused") {
      // 消费侧调停（01 §4.1 修订审计第二批）：Daytona disk 级暂停的 provider 落点就是
      // stop 系停态（stop 只停不删、文件系统保留，pause 当场一次性改写为 paused 观测，
      // 之后每次 inspect 都返回 stopped）；run.status=paused 是控制面持久事实，stopped
      // 观测按 disk-pause 保留态处理——视为存活，不收口。notFound 才是真终局。若实例
      // 确被外部移除，暂停预算宽限兜底（PAUSED_BUDGET_TERMINATION_GRACE_MS）保证有界收口。
      cloudCoreLogger.debug(undefined, "cloud provider liveness stopped while run paused", {
        runId: run.runId,
        provider: run.provider,
      });
      return "alive";
    }
    if (observation.status === "unknown") {
      cloudCoreLogger.warn(undefined, "cloud provider liveness unknown", {
        runId: run.runId,
        provider: run.provider,
      });
      return "unknown";
    }

    // 已请求停止的 run 收口为 stopped；未请求停止却资源消失按 expired 收口（08 §3.2 状态图，
    // 与补偿路径 `settleTerminated` 同口径）。保存风险如实暴露（08 §8.2）：与 stop sweep 同一
    // 判据——stop operation 已 settled 才算保存已确认。
    // 第 2 批遗留 2：stopRequested 但尚未 draining（paused/disconnected/ready）的 run 在这里
    // **跳过收口**（实例消失的事实不在此定终态）——迁移表没有 paused→stopped 边，若按 expired
    // 收口会与 stop 屏障打架（「用户已停止」的 run 以过期终态落账）。终态由 stop 推进通路
    // （pauseResume.advancePausedStop / drain→stop sweep）收口 stopped。
    if (run.stopRequested === true && run.status !== "draining") {
      return "stop-pending";
    }
    const to = run.status === "draining" ? "stopped" : "expired";
    let dataAtRisk = true;
    if (to === "stopped" && run.stopOperationId) {
      const stopOperation = await operations.get(run.stopOperationId);
      dataAtRisk = stopOperation?.state !== "settled";
    }
    const settled = await orchestrator.settleTerminal({
      runId: run.runId,
      runGeneration: run.runGeneration,
      to,
      endReason: PROVIDER_INSTANCE_LOST_END_REASON,
      termination: "terminated",
      dataAtRisk,
      lastError: `provider reported instance ${observation.status}`,
    });
    if (!settled.ok) {
      // CAS 失败（run 已换代/已终态）：不重试，下一轮重新核对（幂等）。
      cloudCoreLogger.warn(undefined, "cloud lost instance could not be settled", {
        runId: run.runId,
        code: settled.code,
        reason: settled.reason,
      });
      return "unknown";
    }
    lastLivenessCheckAt.delete(run.runId);
    cloudCoreLogger.info(undefined, "cloud run closed: provider instance lost", {
      taskId: run.taskId,
      runId: run.runId,
      to,
      instanceStatus: observation.status,
    });
    return "lost";
  }

  /**
   * 预算宽限尽的 paused run 主动终止（03 修订审计第二批）。经既有终止入口
   * `compensation.terminateRun`（持久 terminate op + 幂等键执行；provider DELETE 确认
   * 才是证据），verdict=terminated 后按唯一收口入口落 `expired` 并释放占槽；未确认
   * 保持 paused，下一拍按幂等 op 键重试（「结果未知不收口」，01 §4.3）。
   * compensation 的 settleTerminated 对 paused 不写终态（无该分支），终态由本函数
   * 经 settleTerminal 落地（paused→expired 是迁移表合法边）。
   */
  async function terminatePauseBudgetExpired(run: CloudRunRecord): Promise<boolean> {
    const driver = run.provider ? await drivers.resolve(run.provider) : null;
    if (!driver || !run.providerHandle) return false;
    cloudCoreLogger.warn(undefined, "cloud paused budget grace exhausted; terminating sandbox", {
      taskId: run.taskId,
      runId: run.runId,
      hardDeadlineAt: run.hardDeadlineAt,
      graceMs: PAUSED_BUDGET_TERMINATION_GRACE_MS,
    });
    const terminated = await compensation.terminateRun({
      runId: run.runId,
      runGeneration: run.runGeneration,
      reason: PAUSED_BUDGET_END_REASON,
    });
    if (!terminated.ok || terminated.value.verdict !== "terminated") {
      cloudCoreLogger.warn(
        undefined,
        "cloud paused budget termination unverified; staying paused",
        {
          taskId: run.taskId,
          runId: run.runId,
          verdict: terminated.ok ? terminated.value.verdict : terminated.code,
        },
      );
      return false;
    }
    const settled = await orchestrator.settleTerminal({
      runId: run.runId,
      runGeneration: run.runGeneration,
      to: "expired",
      endReason: PAUSED_BUDGET_END_REASON,
      termination: "terminated",
      // 暂停态没有已确认的保存事实可引用（无 stop op、checkpoint 未经远端 SHA 核验）：
      // 如实暴露风险，不宣称工作全部保住（08 §8.2）。
      dataAtRisk: true,
      lastError: "pause budget exhausted; control-plane terminated sandbox after grace window",
    });
    if (!settled.ok) {
      // CAS 失败（已换代/已终态）：不重试，下一拍以新状态裁决。
      cloudCoreLogger.warn(undefined, "cloud paused budget closure could not be settled", {
        runId: run.runId,
        code: settled.code,
        reason: settled.reason,
      });
      return false;
    }
    const current = await storage.runs.get(run.runId);
    if (!current || current.status !== "expired") return false;
    cloudCoreLogger.info(undefined, "cloud run closed: pause budget exhausted after grace", {
      taskId: run.taskId,
      runId: run.runId,
    });
    return true;
  }

  return {
    reconcileLiveness,
    terminatePauseBudgetExpired,
    isPauseBudgetGraceExpired(run, now) {
      return (
        run.hardDeadlineAt !== undefined &&
        resumeBudgetExhausted({ run, now }) &&
        now - run.hardDeadlineAt >= PAUSED_BUDGET_TERMINATION_GRACE_MS
      );
    },
    pruneLiveRuns(runIds) {
      for (const runId of lastLivenessCheckAt.keys()) {
        if (!runIds.has(runId)) lastLivenessCheckAt.delete(runId);
      }
    },
  };
}

/**
 * 保活与续期（08 §7 租期与业务活动、01 §4.3 期限与配额、03 §6 extend 端点行）。
 *
 * 规则：
 * - 续期只在存在业务需要时发生：业务 running/写操作/pending 交互保护；heartbeat、attach、
 *   轮询、SSE、日志、协议 ACK 都不算业务活动（08 §7、02 §5.3）。
 * - 续期结果未知保持旧的已确认 expiresAt 并重查；只能估计时持久 deadlineEstimate +
 *   deadlineConfidence，以保守截止 drain（08 §7、01 §4.3）。
 * - 不支持 extend 返回能力错误，不伪造续期（01 §4.3）。
 * - 迟到结果必须 CAS 当前 run，不能更新新的 run（08 §7）：updateLease 带 runGeneration。
 * - 活动节流合并为一次续期，不逐 stream chunk 调 API（01 §4.3）：本 sweep 每轮每 run 最多一次。
 */
import type { CloudExtensionResponse, CloudRunRecord } from "@zcode/shared";
import { resolveEffectiveDeadline, shouldRenewLease } from "../../domain/savePolicy.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import type { ProviderObservation } from "../ports/sandboxDriverPort.js";
import type { RunOrchestrator } from "../runOrchestrator.js";
import { fail, ok, type CloudAppResult } from "../result.js";

/**
 * 「仍在执行」的判定窗口：对齐 08 §7 周期保存候选 5 分钟——该窗口内有过业务活动
 * （runtime/tool 执行会经投影 ingest 调 touchBusinessActivity）即视为 running。
 * 说明：执行状态投影的读取端口在 W0 未冻结（见报告 CR-4），因此此处不猜 idle，
 * 只用持久业务活动时间做保守判定。
 */
export const BUSINESS_ACTIVITY_FRESH_MS = 5 * 60 * 1000;

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

export interface LeaseSweepReport {
  examined: number;
  renewed: number;
  estimated: number;
  unsupported: number;
  skipped: number;
  /** provider 明确报告实例已不存在/已终止、并已按收口入口终止的 run 数。 */
  instancesLost: number;
}

export interface KeepaliveLoop {
  sweep(now?: number): Promise<LeaseSweepReport>;
  /** `POST /tasks/:taskId/extend`：返回 provider 确认期限或明确标记的保守估计。 */
  extendTask(input: {
    principalId: string;
    taskId: string;
  }): Promise<CloudAppResult<CloudExtensionResponse>>;
}

export function createKeepaliveLoop(
  deps: CloudCoreDeps,
  orchestrator: RunOrchestrator,
): KeepaliveLoop {
  const { storage, operations, drivers, clock, config } = deps;
  /** 上一次 provider 事实核对时间（进程内节流；重启后立即核对一次，无害）。 */
  const lastLivenessCheckAt = new Map<string, number>();

  function executionFreshness(run: CloudRunRecord, now: number): "running" | "idle" {
    const last = run.lastBusinessActivityAt;
    if (last === undefined) return "idle";
    return now - last <= BUSINESS_ACTIVITY_FRESH_MS ? "running" : "idle";
  }

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
   * - 不可达/超时/`unknown` → **什么都不做**，只记 warn，下一轮再查。绝不「查不到就释放」：
   *   结果未知不等于资源已释放（01 §4.3、03 §5），提前释放会让另一个 run 与旧沙箱并跑。
   */
  async function reconcileProviderLiveness(
    run: CloudRunRecord,
    now: number,
  ): Promise<"alive" | "lost" | "unknown" | "throttled" | "no-fact" | "stop-pending"> {
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

  async function renewRun(run: CloudRunRecord, now: number): Promise<LeaseSweepReport> {
    const report: LeaseSweepReport = {
      examined: 1,
      renewed: 0,
      estimated: 0,
      unsupported: 0,
      skipped: 0,
      instancesLost: 0,
    };
    if (run.status === "stopped" || run.status === "expired" || run.status === "failed") {
      report.skipped += 1;
      return report;
    }
    const pendingInputs = await storage.inputs.listDeliverable(run.taskId);
    const pendingInputCount = pendingInputs.filter(
      (input) => input.deliveryStatus === "accepted" || input.deliveryStatus === "delivering",
    ).length;
    const deadline = resolveEffectiveDeadline({
      expiresAt: run.expiresAt,
      deadlineEstimate: run.deadlineEstimate,
      hardDeadlineAt: run.hardDeadlineAt,
    });
    const desired = shouldRenewLease({
      now,
      execution: executionFreshness(run, now),
      pendingInputCount,
      // pending 交互的持久记录端口未冻结（见报告 CR-3）：不猜交互数量，只用输入与写操作。
      pendingInteractionCount: 0,
      writeInFlight: run.status === "draining",
      hardDeadlineAt: run.hardDeadlineAt,
      autoRenewEnabled: config.autoRenewEnabled,
    });
    if (!desired) {
      report.skipped += 1;
      return report;
    }
    // 只在剩余租期进入 lead 窗口时请求，保证续期失败后仍留有 drain 预算。
    const lead = Math.max(config.drainBudgetMs, BUSINESS_ACTIVITY_FRESH_MS);
    if (deadline && now < deadline.at - lead) {
      report.skipped += 1;
      return report;
    }
    const driver = run.provider ? await drivers.resolve(run.provider) : null;
    if (!driver || !run.providerHandle) {
      report.skipped += 1;
      return report;
    }
    const requestedDeadline = Math.min(
      now + config.hardRunDurationMs,
      run.hardDeadlineAt ?? Number.POSITIVE_INFINITY,
    );
    // D4-9：extendDeadline 是 provider IO，可能抛错（网络/SDK）；只包了 inspect 的旧版
    // 会把它穿透到整轮 sweep。这里单独收口：续期失败保持旧的已确认期限（08 §7），
    // 下一轮重试；不伪造续期成功。
    let result: Awaited<ReturnType<typeof driver.extendDeadline>>;
    try {
      result = await driver.extendDeadline(
        { provider: run.provider ?? "", sandboxId: run.providerHandle },
        requestedDeadline,
      );
    } catch (error) {
      cloudCoreLogger.warn(undefined, "cloud lease renewal failed", {
        runId: run.runId,
        message: error instanceof Error ? error.message : String(error),
      });
      report.skipped += 1;
      return report;
    }
    if (result.status === "unsupported") {
      // 能力错误不伪造成功；保留上一次已确认期限（08 §7）。
      report.unsupported += 1;
      return report;
    }
    const updated = await storage.runs.updateLease({
      runId: run.runId,
      runGeneration: run.runGeneration,
      ...(result.status === "confirmed" ? { expiresAt: result.expiresAt } : {}),
      ...(result.status === "estimated"
        ? {
            deadlineEstimate: result.deadlineEstimate,
            deadlineConfidence: result.deadlineConfidence,
          }
        : {}),
      now,
    });
    if (!updated) {
      // 迟到结果：run 已被更高代际接管，丢弃（08 §7）。
      cloudCoreLogger.debug(undefined, "cloud lease renewal dropped as stale", {
        runId: run.runId,
      });
      report.skipped += 1;
      return report;
    }
    if (result.status === "confirmed") report.renewed += 1;
    else report.estimated += 1;
    return report;
  }

  return {
    async sweep(now = clock.now()) {
      const runs = await storage.runs.listNonTerminal();
      const total: LeaseSweepReport = {
        examined: 0,
        renewed: 0,
        estimated: 0,
        unsupported: 0,
        skipped: 0,
        instancesLost: 0,
      };
      for (const run of runs) {
        // D4-9（审计 #5）：单 run 的核对/续期异常只属于该 run，不得穿透整轮 sweep
        //（否则一个毒 run 会挡住其余 run 的续期与 provider 事实核对）。记 warn 后继续。
        try {
          // 断连（以及 drain 之后长期无进展的）run：先核对 provider 事实再决定是否续期——
          // 资源已被 provider 删除时续期毫无意义，且槽位会被白占到硬期限。
          // paused（2026-10-09 生命周期 v2）：暂停保留期纳入周期 liveness——provider
          // 保留期尽（notFound/stopped）→ expired 收口并释放占槽（03 §6 修订：终局
          // 「预算耗尽 → 保留期尽 → expired」）；paused 观察本身保持 run 原状、不收口。
          if (
            run.status === "disconnected" ||
            run.status === "paused" ||
            isDrainStalled(run, now, config.drainBudgetMs)
          ) {
            const liveness = await reconcileProviderLiveness(run, now);
            if (liveness === "lost") {
              total.instancesLost += 1;
              continue;
            }
          }
          // paused 不续期（03 §6 修订）：暂停期间墙钟照走，租期与凭据只在自驱 resume
          // 成功时同步续展（B-6）；周期续期对 paused 没有意义。
          if (run.status !== "ready" && run.status !== "disconnected" && run.status !== "draining")
            continue;
          const report = await renewRun(run, now);
          total.examined += report.examined;
          total.renewed += report.renewed;
          total.estimated += report.estimated;
          total.unsupported += report.unsupported;
          total.skipped += report.skipped;
        } catch (error) {
          cloudCoreLogger.warn(undefined, "cloud keepalive sweep run failed", {
            runId: run.runId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // 节流表只留仍未终态的 run，避免长跑进程里无限增长。
      const stillLive = new Set(runs.map((run) => run.runId));
      for (const runId of lastLivenessCheckAt.keys()) {
        if (!stillLive.has(runId)) lastLivenessCheckAt.delete(runId);
      }
      return total;
    },

    async extendTask(input) {
      const task = await storage.tasks.get(input.taskId);
      if (!task || task.ownerPrincipalId !== input.principalId)
        return fail("not_found", "task-not-found");
      const run = await storage.runs.activeOfTask(input.taskId);
      if (!run) return fail("not_ready", "no-active-run");
      const driver = run.provider ? await drivers.resolve(run.provider) : null;
      if (!driver) return fail("validation_failed", "provider-not-configured");
      const capabilities = await driver.describeCapabilities();
      if (!capabilities.canExtendDeadline || !run.providerHandle) {
        // 不支持 extend 返回能力错误，不伪造续期（01 §4.3）。
        return fail("resource_unsupported", "provider-cannot-extend-deadline");
      }
      const now = clock.now();
      const result = await driver.extendDeadline(
        { provider: run.provider ?? "", sandboxId: run.providerHandle },
        now + config.hardRunDurationMs,
      );
      if (result.status === "unsupported") {
        return fail("resource_unsupported", "provider-cannot-extend-deadline");
      }
      const updated = await storage.runs.updateLease({
        runId: run.runId,
        runGeneration: run.runGeneration,
        ...(result.status === "confirmed" ? { expiresAt: result.expiresAt } : {}),
        ...(result.status === "estimated"
          ? {
              deadlineEstimate: result.deadlineEstimate,
              deadlineConfidence: result.deadlineConfidence,
            }
          : {}),
        now,
      });
      if (!updated) return fail("stale", "run-generation-mismatch");
      const response: CloudExtensionResponse =
        result.status === "confirmed"
          ? { extended: true, expiresAt: result.expiresAt }
          : {
              extended: true,
              deadlineEstimate: result.deadlineEstimate,
              deadlineConfidence: result.deadlineConfidence,
            };
      return ok(response);
    },
  };
}

/**
 * `draining` 长期无进展的判定（仅用于**节流核对**，永远不决定收口——决定收口的只有 provider 事实）。
 *
 * 判据用 `updatedAt`：进入 draining 与租期更新都会刷新它；超过 drain 预算仍停在 draining，
 * 说明这一轮保存/终止已经停摆，值得问一次 provider「实例还在不在」。实例仍在时不做任何事，
 * 该 run 的收口仍由 stop sweep 的保存/终止通路负责。
 */
function isDrainStalled(run: CloudRunRecord, now: number, drainBudgetMs: number): boolean {
  return run.status === "draining" && now - run.updatedAt >= drainBudgetMs;
}

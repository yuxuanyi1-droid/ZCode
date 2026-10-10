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
 *
 * 审计第二批增补（03 修订 2026-10-09）：本 sweep 还承担两个有界兜底——
 * **停止链路崩溃窗口自愈**（draining + stopRequested + 无 stop op 且停摆 → 认领并复用
 * advancePausedStop 收口 stopped）与**暂停预算耗尽的时间兜底**（paused 超宽限 → 主动
 * 终止，provider 确认后收口 expired；实现与 liveness 判定在 providerReconciliation.ts）。
 */
import type { CloudExtensionResponse, CloudRunRecord } from "@zcode/shared";
import { resolveEffectiveDeadline, shouldRenewLease } from "../../domain/savePolicy.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import type { RunCompensation } from "../provisioning/compensation.js";
import type { PausedStopAdvance } from "./pausedStop.js";
import type { RunOrchestrator } from "../runOrchestrator.js";
import { fail, ok, type CloudAppResult } from "../result.js";
import { createProviderFactControl } from "./providerReconciliation.js";

// provider 事实核对与 paused 终局兜底的常量/实现：本体在 providerReconciliation.ts，
// 这里按既有导入面转出（liveness/暂停预算用例仍从 keepalive 导入）。
export {
  PAUSED_BUDGET_END_REASON,
  PAUSED_BUDGET_TERMINATION_GRACE_MS,
  PROVIDER_INSTANCE_LOST_END_REASON,
  PROVIDER_LIVENESS_RECHECK_MS,
} from "./providerReconciliation.js";

/**
 * 「仍在执行」的判定窗口：对齐 08 §7 周期保存候选 5 分钟——该窗口内有过业务活动
 * （runtime/tool 执行会经投影 ingest 调 touchBusinessActivity）即视为 running。
 * 说明：执行状态投影的读取端口在 W0 未冻结（见报告 CR-4），因此此处不猜 idle，
 * 只用持久业务活动时间做保守判定。
 */
export const BUSINESS_ACTIVITY_FRESH_MS = 5 * 60 * 1000;

export interface LeaseSweepReport {
  examined: number;
  renewed: number;
  estimated: number;
  unsupported: number;
  skipped: number;
  /** provider 明确报告实例已不存在/已终止、并已按收口入口终止的 run 数。 */
  instancesLost: number;
  /** 停止链路崩溃窗口自愈：keepalive 认领「draining + stopRequested + 无 op」并推进到 stopped 的 run 数。 */
  stopFallbackAdvanced: number;
  /** 暂停预算超宽限被主动终止并收口 expired 的 run 数。 */
  pausedBudgetClosed: number;
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
  /** 既有终止入口：预算宽限兜底收口经 providerReconciliation 复用，不另写终止。 */
  compensation: RunCompensation,
  /** 暂停中停止推进（pausedStop.ts 共享实现）：崩溃窗口自愈认领时复用同一推进核心。 */
  advancePausedStop: PausedStopAdvance,
): KeepaliveLoop {
  const { storage, operations, drivers, clock, config } = deps;
  const providerFacts = createProviderFactControl(deps, orchestrator, compensation);

  function executionFreshness(run: CloudRunRecord, now: number): "running" | "idle" {
    const last = run.lastBusinessActivityAt;
    if (last === undefined) return "idle";
    return now - last <= BUSINESS_ACTIVITY_FRESH_MS ? "running" : "idle";
  }

  /**
   * stop 指针是否无对应 operation 行（03 修订审计第二批兜底推进的认领条件之一）：
   * 指针缺失，或 operations.get 查不到（屏障写入后、入队前崩溃）。指向存在 op 的 run
   * 一律不认领——pending/failed 的保存重试归 stop sweep（不得绕过保存前置，08 §8.1）。
   */
  async function isStopOperationMissing(run: CloudRunRecord): Promise<boolean> {
    return !run.stopOperationId || (await operations.get(run.stopOperationId)) === null;
  }

  async function renewRun(run: CloudRunRecord, now: number): Promise<LeaseSweepReport> {
    const report: LeaseSweepReport = {
      examined: 1,
      renewed: 0,
      estimated: 0,
      unsupported: 0,
      skipped: 0,
      instancesLost: 0,
      stopFallbackAdvanced: 0,
      pausedBudgetClosed: 0,
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
        stopFallbackAdvanced: 0,
        pausedBudgetClosed: 0,
      };
      for (const run of runs) {
        // D4-9（审计 #5）：单 run 的核对/续期异常只属于该 run，不得穿透整轮 sweep
        //（否则一个毒 run 会挡住其余 run 的续期与 provider 事实核对）。记 warn 后继续。
        try {
          // 兜底推进（03 修订审计第二批：停止链路崩溃窗口自愈）。窗口：beginDrain 写好
          // 屏障并推进 paused→draining 后、advancePausedStop 前崩溃 → draining run 的
          // stop 指针无 operation 行（paused 分支不入队 checkpoint op）——stop sweep 对
          // 无 op 行只跳过、pauseResume sweep 只认 paused，run 卡 draining 到 provider
          // 保留期尽。这里认领并复用 advancePausedStop 直接 terminate 收口 stopped。
          // 守卫逐条说明：
          // - 停摆（超过 drain 预算无进展）才认领：正常推进在一拍内完成，不与在途的
          //   stopTask/预算闭环串联抢跑；
          // - 只认「op 行不存在」：pending/leased/failed 的 op 归 stop sweep（保存重试
          //   与预算内重试是它的职责，不得在此绕过保存前置，08 §8.1）；
          // - 就绪态停止「屏障已写、checkpoint op 未入队」的微窗口同样命中本兜底：
          //   屏障即用户停止意图，收口后 dataAtRisk 如实为 true（provider 保留期与
          //   dataAtRisk 是该微窗口的既定 backstop）。
          if (
            run.status === "draining" &&
            run.stopRequested === true &&
            isDrainStalled(run, now, config.drainBudgetMs) &&
            (await isStopOperationMissing(run))
          ) {
            cloudCoreLogger.warn(
              undefined,
              "cloud stop fallback advancing draining run without stop operation",
              {
                taskId: run.taskId,
                runId: run.runId,
              },
            );
            if (await advancePausedStop(run, now)) total.stopFallbackAdvanced += 1;
            continue;
          }
          // 暂停预算耗尽的时间兜底（03 修订审计第二批）：paused + 预算耗尽超宽限 →
          // 主动终止收口 expired（provider 保留期无界时 run 永久占槽）。带停止意图的
          // paused run 不进本兜底——终态语义归停止推进通路（stopped，不落 expired）。
          if (
            run.status === "paused" &&
            run.stopRequested !== true &&
            providerFacts.isPauseBudgetGraceExpired(run, now) &&
            (await providerFacts.terminatePauseBudgetExpired(run))
          ) {
            total.pausedBudgetClosed += 1;
            continue;
            // 终止未确认：落回 liveness/下一拍重试（幂等 terminate op 键）。
          }
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
            const liveness = await providerFacts.reconcileLiveness(run, now);
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
      providerFacts.pruneLiveRuns(new Set(runs.map((run) => run.runId)));
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

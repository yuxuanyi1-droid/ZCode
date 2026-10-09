/**
 * paused 状态机的控制面通路（08 §3.2 修订 2026-10-09、03 §6 修订、01 §4.1 修订、
 * 定稿附录 A-7/B-4/B-6、决策 D3 第 3 批）。本文件是四个职责的**控制面 owner**，
 * 重实现按单一职责拆分（同一实现多处复用，不写两份）：
 *
 * 1. **自驱 resume**（03 §6 修订，`resumeRunWithDeliverableInput`）：paused + deliverable
 *    输入 → 能力门禁（A-7：none 时不可达）→ 预算核对（耗尽拒绝 `budget_exhausted`）→
 *    单飞 `driver.resume(handle, requestedDeadline)` → 续展 run 租期 + bridge 凭据有效期
 *    （B-6：墙钟照走，不续展则长暂停后 hello 永远被拒）→ `paused → ready` CAS。失败停留
 *    paused 退避重试；notFound 交 keepalive liveness 收口 expired。预算耗尽 + 用户显式
 *    输入按意图闭环「停旧 run → checkpoint 重开」（规则本体 `budgetExhaustedClosure.ts`）。
 * 2. **暂停中停止推进**（行为表）：屏障已写好（复用 `stopOperationId`）后的推进实现拆在
 *    `pausedStop.ts`——sweep（tick 兜底）与 stopTask（受理即时）共用。
 * 3. **空闲 pause 拍**（D3/08 §7 修订，第 3 批）：裁决在纯模块 `idlePolicy.ts`、编排拆在
 *    `idlePause.ts`；4. **pause 转换助手**（B-4 顺序冻结，`pauseRun`）：checkpoint(如需) →
 *    `driver.pause` → provider paused 确认 → detach registry → `ready → paused` CAS；
 *    确认前绝不写 paused。
 *
 * 纪律：能力门禁只读 driver 能力声明（实测解禁前一律 none），不持第二份开关。
 */
import type { CloudRunRecord } from "@zcode/shared";
import { mayPauseRun, resumeBudgetExhausted } from "../../domain/taskRunState.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import type { InputGateway } from "../inputDelivery/gateway.js";
import type { ProviderObservation } from "../ports/sandboxDriverPort.js";
import type { RunCompensation } from "../provisioning/compensation.js";
import type { RunOrchestrator } from "../runOrchestrator.js";
import { fail, ok, type CloudAppResult } from "../result.js";
import type { AttachmentRegistry } from "../attachments/registry.js";
import { createBudgetExhaustedClosure } from "./budgetExhaustedClosure.js";
import type { DrainLoop } from "./drain.js";
import { createIdlePauseSweep, type IdlePauseSweepReport } from "./idlePause.js";
import { createPausedStopAdvance } from "./pausedStop.js";

/** resume 失败后的重试退避：不熔断，只降频。 */
export const RESUME_RETRY_BACKOFF_MS = 30_000;

export interface ResumeSweepReport {
  /** 本拍检查过的 paused run 数。 */
  examined: number;
  /** 成功恢复（paused→ready CAS 落地）的 run 数。 */
  resumed: number;
  /** 暂停中停止推进完成（paused→draining→stopped）的 run 数。 */
  stopAdvanced: number;
  /** 因暂停预算耗尽被拒绝的 resume 尝试数（输入保持 accepted）。 */
  budgetExhausted: number;
  /** 预算耗尽 + 用户显式输入 → 「停旧 run + 重开」闭环完成的 run 数（串联失败不计）。 */
  budgetExhaustedReopened: number;
  /** 能力门禁关闭（pauseResume=none）而跳过的 run 数（fail-closed 路径不可达）。 */
  gatedSkipped: number;
}

export type { IdlePauseSweepReport };

export interface PauseResumeControl {
  /** lifecycle 循环单拍：暂停中停止推进 + 自驱 resume。 */
  sweep(now?: number): Promise<ResumeSweepReport>;
  /**
   * 空闲 pause 拍（D3/08 §7 修订）：对满足 idlePolicy 裁决的 ready run 调用 `pauseRun`。
   * 在 lifecycleTick 中位于 drain.sweep 之前——同拍 pause 成功的 run 已离开 ready，
   * 不会被 idle drain 重复处理（单轨 F-3 第一道互斥；第二道是 drain.sweep 的守卫）。
   */
  idleSweep(now?: number): Promise<IdlePauseSweepReport>;
  /**
   * pause 转换助手（B-4 顺序冻结；空闲拍与后续预算 pause 的共用入口）：checkpoint(如需)
   * → driver.pause → provider paused 确认 → detach registry → ready→paused CAS。
   * 确认前不得写 run=paused；回查为 paused 时按幂等重入处理。
   */
  pauseRun(input: {
    taskId: string;
    runId: string;
    reason: string;
    /** 可选前置 checkpoint（boot 失败路径绝不成为恢复点）。 */
    checkpoint?: () => Promise<void>;
  }): Promise<CloudAppResult<CloudRunRecord>>;
  /**
   * 暂停中停止推进（行为表共享实现，实现在 `pausedStop.ts`）：`paused → draining` CAS →
   * 直接 terminate → `stopped` 收口（dataAtRisk 按 stop op 结算事实）。传入记录已是
   * `draining` 时跳过 CAS 直接 terminate。返回 false = 状态被并发改变或终止未确认，
   * 由调用方按自身节奏重试（sweep 下拍；stopTask 的 run 留给 stop sweep 按证据收口）。
   */
  advancePausedStop(run: CloudRunRecord, now: number): Promise<boolean>;
}

export function createPauseResumeControl(
  deps: CloudCoreDeps,
  orchestrator: RunOrchestrator,
  compensation: RunCompensation,
  registry: AttachmentRegistry,
  /** durable input gateway：预算耗尽闭环的 reopen 走同一唯一写入路径（02 §6.1）。 */
  inputs: InputGateway,
  /** drain 入口：闭环停止复用「屏障 + paused→draining」同一实现（08 §8.1）。 */
  drain: Pick<DrainLoop, "beginDrain">,
): PauseResumeControl {
  const { storage, drivers, clock, ids, config } = deps;
  const inFlight = new Set<string>();
  const nextResumeAttemptAt = new Map<string, number>();

  const handleOf = (run: CloudRunRecord): { provider: string; sandboxId: string } | null =>
    run.provider && run.providerHandle
      ? { provider: run.provider, sandboxId: run.providerHandle }
      : null;

  /** 自驱 resume（03 §6 修订）：paused + deliverable 输入 → resume → 续租/凭据 → ready。 */
  async function resumeRunWithDeliverableInput(
    run: CloudRunRecord,
    now: number,
    report: ResumeSweepReport,
  ): Promise<void> {
    const handle = handleOf(run);
    const driver = run.provider ? await drivers.resolve(run.provider) : null;
    if (!driver || !handle) {
      report.gatedSkipped += 1;
      return;
    }
    // A-7 能力门禁：pauseResume=none（未实测）时路径不可达——不 resume、不报错
    // （预期形态：none 的 provider 根本不该出现 paused run，见到即记 warn 供排查）。
    const capabilities = await driver.describeCapabilities();
    if (capabilities.pauseResume === "none") {
      report.gatedSkipped += 1;
      cloudCoreLogger.warn(undefined, "cloud paused run skipped: pauseResume capability is none", {
        runId: run.runId,
        provider: run.provider,
      });
      return;
    }
    if (inFlight.has(run.runId)) return;
    // 暂停预算（08 §7 修订：hardDeadline 在 memory 级 pause 语义下转为暂停预算）耗尽：
    // 拒绝 resume（budget_exhausted），输入保持 accepted；终局由 keepalive liveness 在
    // provider 保留期尽后收口 expired。
    if (resumeBudgetExhausted({ run, now })) {
      report.budgetExhausted += 1;
      cloudCoreLogger.warn(undefined, "cloud resume rejected: pause budget exhausted", {
        taskId: run.taskId,
        runId: run.runId,
        hardDeadlineAt: run.hardDeadlineAt,
        errorCode: "budget_exhausted",
      });
      // 08 §7 修订（2026-10-09 第二批）：预算耗尽 + 用户显式发消息 = 继续工作意图，
      // 停旧 run → 以该消息 checkpoint 重开（规则本体 budgetExhaustedClosure.ts）；
      // 无用户输入的 run 维持现状（保留期尽后 liveness 收口 expired）。
      if (await closeBudgetExhaustedRunWithUserInput(run)) {
        report.budgetExhaustedReopened += 1;
      }
      return;
    }
    const backoffAt = nextResumeAttemptAt.get(run.runId);
    if (backoffAt !== undefined && now < backoffAt) return;
    inFlight.add(run.runId);
    try {
      // 请求寿命与 keepalive 续期同一收敛口径（部署预算与硬期限取小，不放大 provider 上限）。
      const requestedDeadline = Math.min(
        now + config.hardRunDurationMs,
        run.hardDeadlineAt ?? Number.POSITIVE_INFINITY,
      );
      let observation: ProviderObservation;
      try {
        observation = await driver.resume(handle, requestedDeadline);
      } catch (error) {
        // 能力错误/网络错误都停留 paused 退避重试；不换代、不改写原 run（01 §4.1 修订）。
        cloudCoreLogger.warn(undefined, "cloud resume failed; staying paused", {
          taskId: run.taskId,
          runId: run.runId,
          message: error instanceof Error ? error.message : String(error),
        });
        nextResumeAttemptAt.set(run.runId, now + RESUME_RETRY_BACKOFF_MS);
        return;
      }
      if (observation.status !== "running") {
        // paused/unknown：恢复未完成，退避重试；notFound：provider 保留期已尽，交
        // keepalive liveness 收口 expired（不在本通路写终态，保持唯一收口入口）。
        cloudCoreLogger.warn(undefined, "cloud resume did not confirm running", {
          taskId: run.taskId,
          runId: run.runId,
          status: observation.status,
        });
        nextResumeAttemptAt.set(run.runId, now + RESUME_RETRY_BACKOFF_MS);
        return;
      }
      // B-6：resume 成功 → 续展 run 租期（updateLease 同语义）+ bridge 凭据有效期
      // （只外推不内缩）。凭据续到硬期限：墙钟照走，长暂停后 hello 不再被过期拒绝。
      const leaseApplied = await storage.runs.updateLease({
        runId: run.runId,
        runGeneration: run.runGeneration,
        expiresAt: requestedDeadline,
        now,
      });
      if (!leaseApplied) {
        // 迟到结果：run 已换代，丢弃（08 §7）；不写 ready。
        cloudCoreLogger.debug(undefined, "cloud resume lease update dropped as stale", {
          runId: run.runId,
        });
        return;
      }
      await storage.credentials.extendForRun({
        runId: run.runId,
        expiresAt: run.hardDeadlineAt ?? requestedDeadline,
      });
      const updated = await storage.runs.transitionStatus({
        runId: run.runId,
        runGeneration: run.runGeneration,
        from: ["paused"],
        to: "ready",
        now,
      });
      if (!updated) {
        // CAS 失败：暂停期间状态已被改变（如停止推进已转 draining）——沙箱恢复成功但
        // 停止屏障优先生效，stop 推进通路会按 draining 收口；不回写 paused。
        cloudCoreLogger.warn(undefined, "cloud resume ready cas failed", {
          taskId: run.taskId,
          runId: run.runId,
        });
        return;
      }
      nextResumeAttemptAt.delete(run.runId);
      report.resumed += 1;
      // resume 是为继续 pending 工作而做的推进，即业务活动（08 §7 事实源收窄补充）；
      // 不推进的话 idle 拍会在回合产出首批投影前把 run 再次暂停（实测二次暂停中断回合）。
      await storage.runs.touchBusinessActivity({ runId: run.runId, at: now });
      cloudCoreLogger.info(undefined, "cloud run resumed to ready", {
        taskId: run.taskId,
        runId: run.runId,
        expiresAt: requestedDeadline,
      });
    } finally {
      inFlight.delete(run.runId);
    }
  }

  /**
   * pause 转换助手（B-4 顺序冻结；空闲拍与后续预算 pause 的共用入口）。独立闭包函数：
   * idlePause 编排与控制面对象都引用同一实现（不写两份）。
   */
  async function pauseRun(input: {
    taskId: string;
    runId: string;
    reason: string;
    /** 可选前置 checkpoint（boot 失败路径绝不成为恢复点）。 */
    checkpoint?: () => Promise<void>;
  }): Promise<CloudAppResult<CloudRunRecord>> {
    const run = await storage.runs.get(input.runId);
    if (!run || run.taskId !== input.taskId) return fail("not_found", "run-not-found");
    if (run.runGeneration === undefined) return fail("stale", "stale-generation");
    const handle = handleOf(run);
    const driver = run.provider ? await drivers.resolve(run.provider) : null;
    if (!driver || !handle) return fail("validation_failed", "provider-not-configured");
    const capabilities = await driver.describeCapabilities();
    if (!mayPauseRun({ run, pauseResume: capabilities.pauseResume })) {
      // 能力位 none / 非 ready / 已受理停止：不允许 pause（08 §3.2 修订准入）。
      return fail("resource_unsupported", "run-not-pausable", {
        status: run.status,
        pauseResume: capabilities.pauseResume,
      });
    }
    // B-4 第 1 步（可选）：checkpoint（boot 失败路径绝不成为恢复点——checkpoint 抛错
    // 则本函数失败，绝不带损暂停）。
    await input.checkpoint?.();
    // B-4 第 2 步：provider paused 确认。确认前不得写 run=paused。
    let observation: ProviderObservation;
    try {
      observation = await driver.pause(handle);
    } catch (error) {
      // 幂等重入：沙箱已是 paused 时 provider 会明确拒绝；回查确认后按已暂停继续。
      try {
        const recheck = await driver.inspect(handle);
        if (recheck.status === "paused") {
          observation = recheck;
        } else {
          cloudCoreLogger.warn(undefined, "cloud pause failed before confirmation", {
            taskId: input.taskId,
            runId: input.runId,
            message: error instanceof Error ? error.message : String(error),
          });
          return fail("provider_unreachable", "pause-not-confirmed");
        }
      } catch {
        return fail("provider_unreachable", "pause-not-confirmed");
      }
    }
    if (observation.status === "paused") {
      // 已确认，继续 B-4 第 3 步。
    } else if (observation.status === "unknown") {
      // 观察未知：回查一次；仍未确认则 fail-closed（不写 run=paused）。
      try {
        const recheck = await driver.inspect(handle);
        if (recheck.status === "paused") {
          observation = recheck;
        } else {
          return fail("provider_unreachable", "pause-not-confirmed");
        }
      } catch {
        return fail("provider_unreachable", "pause-not-confirmed");
      }
    } else {
      // running（provider 拒绝暂停）/ notFound（实例已不存在）：如实失败，不虚构暂停。
      cloudCoreLogger.warn(undefined, "cloud pause not confirmed by provider", {
        taskId: input.taskId,
        runId: input.runId,
        status: observation.status,
      });
      return fail("provider_unreachable", "pause-not-confirmed", { status: observation.status });
    }
    // B-4 第 3 步：detach registry（暂停期间 heartbeat/投递/看门狗都不应再见到该连接；
    // watchdog 对 paused 的显式跳过在 markDisconnected，双保险）。
    registry.detach({
      runId: run.runId,
      at: clock.now(),
      reason: input.reason,
      expectedRunGeneration: run.runGeneration,
    });
    // B-4 第 4 步：ready→paused CAS。
    const updated = await storage.runs.transitionStatus({
      runId: run.runId,
      runGeneration: run.runGeneration,
      from: ["ready"],
      to: "paused",
      endReason: input.reason,
      now: clock.now(),
    });
    if (!updated) {
      // CAS 失败（run 已换代/进入 draining）：沙箱已被暂停但 run 状态未落——如实报错，
      // 不回滚 provider 侧（幂等重入会经 inspect(paused) 分支重新走到这里）。
      cloudCoreLogger.error(undefined, "cloud pause cas failed after provider confirmation", {
        taskId: input.taskId,
        runId: input.runId,
      });
      return fail("stale", "run-transition-cas-failed");
    }
    cloudCoreLogger.info(undefined, "cloud run paused", {
      taskId: input.taskId,
      runId: input.runId,
      reason: input.reason,
      sandboxId: handle.sandboxId,
    });
    return ok(updated);
  }

  const advancePausedStop = createPausedStopAdvance(deps, orchestrator, compensation);
  // 预算耗尽 + 用户显式输入的意图闭环（08 §7 修订第二批）：规则本体在 budgetExhaustedClosure.ts。
  const closeBudgetExhaustedRunWithUserInput = createBudgetExhaustedClosure({
    storage,
    ids,
    clock,
    inputs,
    drain,
    advancePausedStop,
  });
  const idleSweep = createIdlePauseSweep(deps, pauseRun);

  return {
    async sweep(now = clock.now()) {
      const report: ResumeSweepReport = {
        examined: 0,
        resumed: 0,
        stopAdvanced: 0,
        budgetExhausted: 0,
        budgetExhaustedReopened: 0,
        gatedSkipped: 0,
      };
      const runs = await storage.runs.listNonTerminal();
      for (const run of runs) {
        if (run.status !== "paused") continue;
        report.examined += 1;
        try {
          if (run.stopRequested) {
            // 停止意图优先于 resume：先推进停止，不再自驱恢复。
            if (await advancePausedStop(run, now)) report.stopAdvanced += 1;
            continue;
          }
          const deliverable = await storage.inputs.listDeliverable(run.taskId);
          const hasAcceptedInput = deliverable.some((input) => input.deliveryStatus === "accepted");
          if (!hasAcceptedInput) continue;
          await resumeRunWithDeliverableInput(run, now, report);
        } catch (error) {
          // 单 run 异常只属于该 run（D4-9 sweep 隔离），不得穿透整轮 sweep。
          cloudCoreLogger.warn(undefined, "cloud pause resume sweep run failed", {
            runId: run.runId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // 退避表只留仍 paused 的 run，避免长跑进程无限增长。
      const stillPaused = new Set(
        runs.filter((run) => run.status === "paused").map((r) => r.runId),
      );
      for (const runId of nextResumeAttemptAt.keys()) {
        if (!stillPaused.has(runId)) nextResumeAttemptAt.delete(runId);
      }
      return report;
    },

    idleSweep,

    pauseRun,

    advancePausedStop,
  };
}

/**
 * idle / 硬期限 drain 与停止屏障（08 §3.2 ready→draining、§7 到达期限前停止接收新工作、
 * §8.1 停止屏障与操作依赖、01 §8 checkpoint 通路）。
 *
 * 停止通路的依赖顺序（08 §8.1）：
 *   stop intent（持久）→ quiesce → checkpoint 及远端 SHA 确认 → terminate → 配额释放。
 * 本文件负责 **intent 与 drain 入口**：先写持久屏障与 checkpoint/terminate 操作意图，
 * 再通知 attachment；保存结果由 `lifecycle/checkpoints.ts` 落地，终止由 commands 的 stop
 * 编排执行。worker 不能先领 terminate 绕过保存前置。
 *
 * quiesce 边界（08 §8.1 第三批，必须如实标注）：v1 quiesce = 控制面投递屏障 + 沙箱侧
 * 工作区收口提交，**没有可等待的 in-flight 命令面**；不得用 sleep 冒充同步。
 * 见 domain/savePolicy.ts 的 `QUIESCE_BOUNDARY`。
 */
import type { BridgeDrainFrame, CloudRunRecord } from "@zcode/shared";
import { checkpointOperationKey } from "../../domain/idempotency.js";
import { hasCheckpointInFlight } from "../../domain/checkpointPolicy.js";
import { occupiesWorkspaceByInput } from "../../domain/deliveryStatus.js";
import {
  isIdleArchiveEligible,
  resolveEffectiveDeadline,
  shouldBeginDrain,
} from "../../domain/savePolicy.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { type CloudGitGrantService } from "../gitGrants.js";
import { fail, ok, type CloudAppResult } from "../result.js";

export interface DrainSweepReport {
  began: number;
  skipped: number;
}

export interface DrainLoop {
  sweep(now?: number): Promise<DrainSweepReport>;
  /** drain 入口：与用户 stop 共用同一屏障与操作意图（08 §8.1）。 */
  beginDrain(input: {
    taskId: string;
    runId: string;
    reason: BridgeDrainFrame["reason"];
    operationId?: string;
  }): Promise<CloudAppResult<CloudRunRecord>>;
}

export function createDrainLoop(deps: CloudCoreDeps, gitGrants: CloudGitGrantService): DrainLoop {
  const { storage, operations, attachments, clock, ids, config, drivers } = deps;

  async function beginDrain(input: {
    taskId: string;
    runId: string;
    reason: BridgeDrainFrame["reason"];
    operationId?: string;
  }): Promise<CloudAppResult<CloudRunRecord>> {
    const run = await storage.runs.get(input.runId);
    if (!run || run.taskId !== input.taskId) return fail("not_found", "run-not-found");
    if (run.status === "stopped" || run.status === "expired" || run.status === "failed") {
      return ok(run);
    }
    // C-1（定稿附录 6）：停止屏障已存在时**复用 run.stopOperationId**——不新建 operation、
    // 不改写屏障指针。一条规则闭两洞（D4-4）：
    // - 重试 beginDrain 不再产生第二个 checkpoint 意图（旧实现每次新建 op，旧 op 变僵尸
    //   且把 checkpoint FIFO 顶到饿死）；
    // - run.stopOperationId 永远指向唯一（=最新）op，stop 编排读它的状态就是最新状态，
    //   重试成功不再假 dataAtRisk。
    // 同 id + 同幂等键重复 enqueue 幂等返回既有行，也顺带补齐「屏障写入后、入队前崩溃」
    // 的缺损（同一 op，不是第二个 op）。
    const barrierActive = run.stopRequested === true && run.stopOperationId !== undefined;
    const operationId = barrierActive
      ? (run.stopOperationId as string)
      : (input.operationId ?? ids.newId());
    // 1) 持久停止屏障：先于任何投递/启动（08 §8.1）；已有屏障时 requestStop 保持原指针。
    await storage.runs.requestStop({ taskId: run.taskId, operationId, now: clock.now() });
    // 暂停中停止（08 §3.2 修订 paused→draining 边、03 §6 修订行为表，第 2 批遗留 1）：
    // 屏障照常 + 状态直接推进 draining；**不走保存通道**——暂停态无运行时写入、无
    // checkpoint 前置可执行（与 taskLifecycle 的 complete 同一教义：对 paused 启动保存
    // 通路只会留下永不结算的 checkpoint 意图），也不通知 attachment（pause 已 detach
    // registry）。终止由调用方（stopTask 经 pauseResume.advancePausedStop 即时推进）或
    // stop sweep/compensation 按证据收口。
    if (run.status === "paused") {
      const pausedDraining = await storage.runs.transitionStatus({
        runId: run.runId,
        runGeneration: run.runGeneration,
        from: ["paused"],
        to: "draining",
        endReason: input.reason,
        now: clock.now(),
      });
      if (!pausedDraining) return fail("stale", "run-transition-cas-failed");
      cloudCoreLogger.debug(undefined, "cloud paused run stop barrier advanced to draining", {
        taskId: run.taskId,
        runId: run.runId,
        reason: input.reason,
      });
      return ok(pausedDraining);
    }
    // 2a) 重试必须重新武装失败/未知的停止保存操作（修复依据 2026-10-18 停止无响应实测）。
    // `enqueue` 幂等返回既有行、不重置 state；而 `sweepCheckpointOperations` 只领
    // pending/leased/到期 ambiguous，终态 failed 的停止 op 永远不会再被领取，`attempt`
    // 冻结在失败当次。stop sweep 于是每拍都认为「还有重试预算」→ 永远重新 beginDrain，
    // run 卡在 draining 直到硬期限。这里把 failed 显式重排队，让 attempt 随租约推进并
    // 在 3 次预算用尽后按 08 §8.1 收口终止。
    if (barrierActive) {
      const existing = await operations.get(operationId);
      if (existing?.state === "failed") {
        await operations.requeueFailed({ operationId, now: clock.now() });
      }
    }
    // 2b) 操作意图先落库（03 §5：外部操作不是数据库事务）。
    await operations.enqueue({
      operationId,
      kind: "checkpoint",
      idempotencyKey: checkpointOperationKey(run.runId, operationId),
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      now: clock.now(),
    });
    // 3) 状态迁移：ready/disconnected → draining；provisioning 保持供给事实（08 §8.1）。
    let updated: CloudRunRecord | null = run;
    if (run.status === "ready" || run.status === "disconnected") {
      updated = await storage.runs.transitionStatus({
        runId: run.runId,
        runGeneration: run.runGeneration,
        from: ["ready", "disconnected"],
        to: "draining",
        endReason: input.reason,
        now: clock.now(),
      });
      if (!updated) return fail("stale", "run-transition-cas-failed");
    }
    // 4) 通知 attachment 进入 quiesce（投递屏障 + 沙箱侧收口提交；无等待面）。
    // 修复依据（2026-10-18 停止无响应实测）：只有本次真正进入 draining 时才发 drain。
    // 停止 sweep 的保存重试会对**已 draining** 的 run 再次 beginDrain；重复发 drain 会让
    // 旧执行节点（drain 后关闭连接）每次重试都把刚重连的 bridge 关掉，保存结果永远回不来。
    cloudCoreLogger.debug(undefined, "cloud run drain requested", {
      taskId: run.taskId,
      runId: run.runId,
      reason: input.reason,
    });
    if (run.status !== "draining") {
      await attachments.requestDrain({
        taskId: run.taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
        operationId,
        reason: input.reason,
      });
    }
    // push/fetch grant 必须在 checkpoint 通路**之前**签发（TTL 60s；01 §7.2、09 §3 矩阵）。
    // 签发点收口到 `issueSaveGrants`（与周期保存 sweep 同一实现，01 §7.2 签发时机修订
    // 2026-10-09）；失败分流在服务内记录（可自愈/不可自愈），不在此补兜底——保存通路会
    // 如实用 checkpoint.result=failed + dataAtRisk 记录（08 §8.1/§8.2），配额与 run 终态
    // 由 stop 编排按证据收口。
    await gitGrants.issueSaveGrants({ runId: run.runId });
    await attachments.requestCheckpoint({
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      operationId,
      // purpose 映射：用户停止 → stop；闲置/硬期限 → drain（02 §4 checkpoint.request 帧）。
      purpose: input.reason === "user-stop" ? "stop" : "drain",
    });
    return ok(updated);
  }

  return {
    beginDrain,

    async sweep(now = clock.now()) {
      const report: DrainSweepReport = { began: 0, skipped: 0 };
      const runs = await storage.runs.listNonTerminal();
      for (const run of runs) {
        if (run.status !== "ready" && run.status !== "disconnected") continue;
        if (run.stopRequested) {
          // 已有停止意图但状态未推进（例如上一轮迁移失败）：重试 drain 入口。
          const retried = await beginDrain({
            taskId: run.taskId,
            runId: run.runId,
            reason: "reclaim",
          });
          if (retried.ok) report.began += 1;
          else report.skipped += 1;
          continue;
        }
        const deadline = resolveEffectiveDeadline({
          expiresAt: run.expiresAt,
          deadlineEstimate: run.deadlineEstimate,
          hardDeadlineAt: run.hardDeadlineAt,
        });
        if (shouldBeginDrain({ now, deadline, drainBudgetMs: config.drainBudgetMs })) {
          const started = await beginDrain({
            taskId: run.taskId,
            runId: run.runId,
            reason: "hard-deadline",
          });
          if (started.ok) report.began += 1;
          else report.skipped += 1;
          continue;
        }
        // idle 归档阈值（08 §7）：execution idle、无 pending input/interaction、无 checkpoint。
        // 单轨互斥（F-3、08 §7 修订 2026-10-09）：memory 级 provider 的 idle 归空闲 pause 拍
        // （lifecycleTick 中 idleSweep 先于本 sweep），这里关闭 idle drain——同一 run 不得
        // 既被 pause 又被 idle drain。disk/none provider 维持 idle drain 不变（08 §7 修订：
        // 「其余 provider 维持 idle drain」；disk 级在 pause 失败时仍是合法的闲置收口路径）。
        const driver = run.provider ? await drivers.resolve(run.provider) : null;
        const capabilities = driver ? await driver.describeCapabilities() : null;
        if (capabilities?.pauseResume === "memory") {
          report.skipped += 1;
          continue;
        }
        const pendingInputs = await storage.inputs.listDeliverable(run.taskId);
        // pending 输入事实含 uncertain（08 §7 修订 2026-10-09 审计第一批，domain 唯一谓词）：
        // 与空闲 pause/resume 触发同口径（08 §7「保守口径，多处同改」）。
        const pendingInputCount = pendingInputs.filter((input) =>
          occupiesWorkspaceByInput(input.deliveryStatus),
        ).length;
        // 修复依据（08 §7「审批等待不是业务空闲」，2026-10-17）：等待审批的 run 没有
        // pending 输入，旧实现恒传 0 会把它 idle drain；与空闲 pause 共用同一读取口径
        // （按 run 的最新持久投影，单一数据源）。
        const pendingInteractionCount = await storage.projections.readLatestPendingInteractionCount(
          run.runId,
        );
        const checkpoints = await storage.projections.listCheckpoints(run.taskId);
        const idle = isIdleArchiveEligible({
          now,
          lastBusinessActivityAt: run.lastBusinessActivityAt,
          // 执行状态读取端口未冻结（CR-4）：只用持久业务活动时间与 pending 输入做保守判定。
          execution: run.lastBusinessActivityAt === undefined ? "unknown" : "idle",
          pendingInputCount,
          pendingInteractionCount,
          // 在途判定收口到 domain/checkpointPolicy（15 §R3、08 §7 修订 2026-10-09）：
          // 只有窗口内（2 分钟）的 saving/pending 才算占用保存通道。旧实现只认
          // `state === "saving"`：pending 记录不阻塞 idle drain，且超窗僵尸事实会让 run
          // 永久无法归档。超窗后按「僵尸事实」继续 idle drain，数据风险由 dataAtRisk 承载。
          checkpointInFlight: hasCheckpointInFlight({ records: checkpoints, now }),
          idleArchiveThresholdMs: config.idleArchiveThresholdMs,
        });
        if (idle) {
          const started = await beginDrain({
            taskId: run.taskId,
            runId: run.runId,
            reason: "idle",
          });
          if (started.ok) report.began += 1;
          else report.skipped += 1;
        } else {
          report.skipped += 1;
        }
      }
      return report;
    },
  };
}

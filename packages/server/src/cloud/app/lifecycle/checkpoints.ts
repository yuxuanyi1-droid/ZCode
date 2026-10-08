/**
 * checkpoint / stop 对账与周期保存（08 §8.1 统一 checkpoint/stop 通路、§8.2 保存与终止事实、
 * 03 §5 operation 结算、01 §8 checkpoint）。
 *
 * 事实来源：
 * - 沙箱侧保存结果以 `checkpoint.result` 帧回到控制面（02 §4）；本文件把它落成
 *   `checkpoints` 记录（`saved` 必须有 confirmedRemoteSha，08 §8.2），并更新
 *   Task 的 lastCheckpointSha。
 * - checkpoint operation 的结算由**带租约的 worker**完成（`sweepCheckpointOperations`）：
 *   它读取已持久的结果记录再 CAS 结算，避免用没有租约令牌的迟到结果覆盖新 worker
 *   （OperationOutboxPort 的租约语义）。
 * - 保存失败不伪装 saved：state=failed + dataAtRisk（08 §8.2）。
 */
import type { CheckpointResultFrame, CloudCheckpointRecord } from "@zcode/shared";
import { checkpointOperationKey } from "../../domain/idempotency.js";
import {
  checkpointPendingExhausted,
  evaluateCheckpointOutcome,
  shouldRequestPeriodicCheckpoint,
} from "../../domain/savePolicy.js";
import {
  checkpointRetryIntervalMs,
  consecutiveCheckpointFailures,
  hasCheckpointInFlight,
} from "../../domain/checkpointPolicy.js";
import { isTerminalRunStatus } from "../../domain/taskRunState.js";
import type { CloudCoreDeps } from "../deps.js";
import { type CloudGitGrantService } from "../gitGrants.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, ok, type CloudAppResult } from "../result.js";
import type { ExternalOperationRecord } from "../ports/operationOutboxPort.js";
import { createCheckpointFailureLedger } from "./checkpointBackoffLedger.js";

export interface CheckpointSweepReport {
  requested: number;
  settled: number;
  ambiguous: number;
  failed: number;
}

export interface CheckpointPipeline {
  /** 处理 bridge 的 checkpoint.result：只落事实，不在没有租约的情况下结算 operation。 */
  handleCheckpointResult(input: {
    taskId: string;
    runId: string;
    runGeneration: number;
    frame: CheckpointResultFrame;
  }): Promise<CloudAppResult<CloudCheckpointRecord>>;
  /** 周期保存（08 §7：5 分钟候选，优先轮次安全点，dirty 且能获得写屏障才执行）。 */
  sweepPeriodicCheckpoints(now?: number): Promise<CheckpointSweepReport>;
  /** 结算已到期的 checkpoint operation（租约 + 已持久结果）。 */
  sweepCheckpointOperations(input?: {
    workerId?: string;
    leaseMs?: number;
    maxLeases?: number;
  }): Promise<CheckpointSweepReport>;
}

export function createCheckpointPipeline(
  deps: CloudCoreDeps,
  gitGrants: CloudGitGrantService,
): CheckpointPipeline {
  const { storage, operations, attachments, clock, ids, config } = deps;

  // 结果帧缺失失败的进程内台账（08 §7 退避修订；拆至 checkpointBackoffLedger 单一职责）。
  const resultlessFailures = createCheckpointFailureLedger();

  /** 组合连续失败事实：持久 failed 记录连击与结果缺失连击取大（08 §7 退避）。 */
  async function consecutiveSaveFailures(taskId: string, runId: string, now: number) {
    const checkpoints = await storage.projections.listCheckpoints(taskId);
    const recordStreak = consecutiveCheckpointFailures(checkpoints);
    const localStreak = resultlessFailures.streak(runId, now);
    return {
      checkpoints,
      consecutiveFailures: Math.max(recordStreak, localStreak),
      // 结果缺失连击的时间锚（无记录时退避间隔的起算点）。
      failureAnchorAt: recordStreak === 0 ? resultlessFailures.anchorAt(runId, now) : undefined,
    };
  }

  /**
   * 停止屏障关联的 checkpoint op ids（C-4 分相领取的"停止相"候选）：stopRequested run 的
   * stopOperationId 就是 beginDrain 入队的 checkpoint op id（C-1 复用屏障，同 id 同键）。
   */
  async function listStopAssociatedOperationIds(): Promise<string[]> {
    const runs = await storage.runs.listNonTerminal();
    return runs
      .filter((run) => run.stopRequested === true && run.stopOperationId !== undefined)
      .map((run) => run.stopOperationId as string);
  }

  async function settleCheckpoint(
    operation: ExternalOperationRecord,
    leaseToken: string,
  ): Promise<"settled" | "ambiguous" | "failed" | "pending"> {
    // 标识缺损的 op 永远无法对账：直接结算 failed，否则租约到期重领成死循环（C-4 同族）。
    if (!operation.taskId || !operation.runId) {
      await operations.settle({
        operationId: operation.operationId,
        leaseToken,
        outcome: "failed",
        errorCode: "validation_failed",
        now: clock.now(),
      });
      return "failed";
    }
    const run = await storage.runs.get(operation.runId);
    if (!run || isTerminalRunStatus(run.status)) {
      // C-4：run 已终态（或已不存在），保存结果永远不会回来——僵尸 pending 结算为
      // failed（reason=run-terminal），不再无限重租。dataAtRisk 不在这里宣称：
      // 保存风险由 stop 链路按最新记录如实标注（08 §8.2）；迟到的保存事实仍留在
      // checkpoints 记录里，终端拒绝/SHA 单调守卫是后续批次（D4-6）的事。
      await operations.settle({
        operationId: operation.operationId,
        leaseToken,
        outcome: "failed",
        errorCode: "stale",
        now: clock.now(),
      });
      cloudCoreLogger.warn(undefined, "cloud checkpoint op settled for terminal run", {
        taskId: operation.taskId,
        runId: operation.runId,
        operationId: operation.operationId,
        attempt: operation.attempt,
        runStatus: run?.status ?? "missing",
      });
      return "failed";
    }
    const checkpoints = await storage.projections.listCheckpoints(operation.taskId);
    const record = checkpoints.find((item) => item.operationId === operation.operationId);
    if (!record) {
      if (checkpointPendingExhausted({ attempt: operation.attempt })) {
        // C-4：结果长期未到，attempt 封顶后结算 failed + 告警，防无限重租饿死 FIFO。
        await operations.settle({
          operationId: operation.operationId,
          leaseToken,
          outcome: "failed",
          errorCode: "checkpoint_failed",
          now: clock.now(),
        });
        // 结果缺失也计入连续失败（08 §7 退避修订）：否则周期保存 sweep 因「无记录」
        // 每拍重建新 op（终验 2026-10-09 死循环的第二半）。
        resultlessFailures.recordFailure(operation.runId, clock.now());
        cloudCoreLogger.warn(undefined, "cloud checkpoint op exhausted pending attempts", {
          taskId: operation.taskId,
          runId: operation.runId,
          operationId: operation.operationId,
          attempt: operation.attempt,
        });
        return "failed";
      }
      // 结果未到：保留 pending（不猜 saved，也不当 failed）。
      return "pending";
    }
    if (record.state === "saved" && record.confirmedRemoteSha) {
      resultlessFailures.clear(operation.runId);
      await operations.settle({
        operationId: operation.operationId,
        leaseToken,
        outcome: "settled",
        resultRef: record.confirmedRemoteSha,
        now: clock.now(),
      });
      return "settled";
    }
    if (record.state === "failed") {
      await operations.settle({
        operationId: operation.operationId,
        leaseToken,
        outcome: "failed",
        errorCode: "checkpoint_failed",
        now: clock.now(),
      });
      return "failed";
    }
    await operations.settle({
      operationId: operation.operationId,
      leaseToken,
      outcome: "ambiguous",
      errorCode: "checkpoint_failed",
      now: clock.now(),
    });
    return "ambiguous";
  }

  return {
    async handleCheckpointResult(input) {
      const run = await storage.runs.get(input.runId);
      if (!run || run.taskId !== input.taskId) return fail("not_found", "run-not-found");
      if (run.runGeneration !== input.runGeneration) {
        // 旧代际的 checkpoint 结果不得修改新 run（08 §4.2）。
        return fail("stale", "stale-generation");
      }
      const task = await storage.tasks.get(input.taskId);
      if (!task) return fail("not_found", "task-not-found");

      const outcome = evaluateCheckpointOutcome({
        status: input.frame.status,
        branch: input.frame.branch,
        remoteSha: input.frame.remoteSha,
        hadNewCommits: input.frame.hadNewCommits,
        errorCode: input.frame.errorCode,
        errorMessage: input.frame.error,
        frozenBaseSha: task.baseSha,
      });
      const now = clock.now();
      const record: CloudCheckpointRecord = {
        operationId: input.frame.operationId,
        taskId: input.taskId,
        runId: input.runId,
        runGeneration: input.runGeneration,
        state: outcome.state,
        // v1 收口范围 = tracked + non-ignored untracked，逐文件清单未上报（08 §8.1 第三批如实记录）。
        includedFiles: [],
        ...(input.frame.remoteSha && outcome.confirmedRemoteSha
          ? { confirmedRemoteSha: outcome.confirmedRemoteSha }
          : {}),
        ...(outcome.riskSummary ? { riskSummary: outcome.riskSummary } : {}),
        createdAt: now,
        updatedAt: now,
      };
      await storage.projections.recordCheckpoint(record);
      // CR-6 冻结写口（08 §8.2「不得宣称工作全部保住」），且**双向如实**：最新一次保存
      // 带确认 SHA 即解除既有风险标注（D4-4：stop 保存重试成功不得被更早的失败永久
      // 标成 dataAtRisk）；失败/未知则如实标注。run.dataAtRisk 的语义 =「最新保存事实
      // 是否有丢失风险」，由本通路（唯一写口之一）随结果推进。
      await storage.runs.setRunDataAtRisk({
        runId: input.runId,
        runGeneration: input.runGeneration,
        dataAtRisk: outcome.dataAtRisk,
        now,
      });
      if (outcome.state === "saved" && outcome.confirmedRemoteSha) {
        // 保存成功：清零结果缺失连击（08 §7 退避：成功即恢复正常周期档）。
        resultlessFailures.clear(input.runId);
        // 最近确认 checkpoint 的 remote SHA 落在 Task 上（08 §2、§9 重开 resumeSha 来源）。
        await storage.tasks.recordCheckpointSha({
          taskId: input.taskId,
          remoteSha: outcome.confirmedRemoteSha,
          now,
        });
        cloudCoreLogger.info(undefined, "cloud checkpoint saved", {
          taskId: input.taskId,
          runId: input.runId,
          operationId: input.frame.operationId,
          noNewCommits: outcome.noNewCommits === true,
        });
      } else {
        cloudCoreLogger.warn(undefined, "cloud checkpoint not saved", {
          taskId: input.taskId,
          runId: input.runId,
          operationId: input.frame.operationId,
          state: outcome.state,
          dataAtRisk: outcome.dataAtRisk,
        });
      }
      return ok(record);
    },

    async sweepPeriodicCheckpoints(now = clock.now()) {
      const report: CheckpointSweepReport = { requested: 0, settled: 0, ambiguous: 0, failed: 0 };
      const runs = await storage.runs.listNonTerminal();
      // 不无限重建 op（08 §7 修订 2026-10-09）：该 run 已有未落定的 checkpoint op
      // （pending/leased，结果帧可能仍在路上）时不再新建——终验中「无记录 → 每拍新建 op」
      // 的死循环由此 + 失败退避双闸关闭。ambiguous/failed/settled 是 op 终态，不在其列。
      const unsettledCheckpointRunIds = new Set(
        (await operations.listUnsettled())
          .filter(
            (operation) =>
              operation.kind === "checkpoint" &&
              (operation.state === "pending" || operation.state === "leased"),
          )
          .map((operation) => operation.runId),
      );
      for (const run of runs) {
        if (run.status !== "ready" || run.stopRequested) continue;
        if (unsettledCheckpointRunIds.has(run.runId)) continue;
        try {
          const { checkpoints, consecutiveFailures, failureAnchorAt } =
            await consecutiveSaveFailures(run.taskId, run.runId, now);
          const lastCheckpointAt = checkpoints.reduce(
            (latest, item) => Math.max(latest, item.updatedAt),
            0,
          );
          // 「保存中」以已持久 checkpoint 记录判定（08 §7 修订：占用有界窗口——超窗无更新
          // 的 saving/pending 是僵尸事实，不永久阻塞保存；风险由 run.dataAtRisk 承载）。
          const checkpointInFlight = hasCheckpointInFlight({ records: checkpoints, now });
          // 失败退避（08 §7 修订 2026-10-09）：连续失败按 30s→2min→5min 阶梯放大重试间隔
          //（且不低于周期档），不无限重建 op。无记录（结果帧缺失）时以失败锚为起算点——
          // `shouldRequestPeriodicCheckpoint` 对「从无记录」默认立即放行，必须被退避覆盖，
          // 否则每拍重建新 op（终验死循环根源）。
          const intervalMs = checkpointRetryIntervalMs({
            consecutiveFailures,
            periodicCheckpointMs: config.periodicCheckpointMs,
          });
          const shouldRequest = shouldRequestPeriodicCheckpoint({
            now,
            lastCheckpointAt: lastCheckpointAt || failureAnchorAt || undefined,
            // 执行状态读取端口未冻结（CR-4）：以业务活动新鲜度保守判定（不猜 idle 就不发保存）。
            execution: run.lastBusinessActivityAt === undefined ? "unknown" : "running",
            checkpointInFlight,
            periodicCheckpointMs: intervalMs,
          });
          if (!shouldRequest) continue;
          const operationId = ids.newId();
          await operations.enqueue({
            operationId,
            kind: "checkpoint",
            idempotencyKey: checkpointOperationKey(run.runId, operationId),
            taskId: run.taskId,
            runId: run.runId,
            runGeneration: run.runGeneration,
            now,
          });
          // 保存通路在 checkpoint 之前成组签发 push+fetch grant（01 §7.2 签发时机修订
          // 2026-10-09）。修复依据（终验）：周期保存从不签发 → 沙箱 push 兑换必然
          // 403 no-issued-grant → 保存事实永远出不来。签发失败只记录，保存照发——
          // 兑换侧会如实用 checkpoint.result=failed + dataAtRisk 收口（08 §8.1/§8.2）。
          await gitGrants.issueSaveGrants({ runId: run.runId });
          await attachments.requestCheckpoint({
            taskId: run.taskId,
            runId: run.runId,
            runGeneration: run.runGeneration,
            operationId,
            // 周期保存是控制面主动保存：purpose 取 manual（stop/drain 之外的动作）。
            purpose: "manual",
          });
          report.requested += 1;
        } catch (error) {
          // D4-9 sweep 隔离：单 run 异常只属于该 run，不得穿透整轮周期保存 sweep。
          cloudCoreLogger.warn(undefined, "cloud periodic checkpoint sweep run failed", {
            taskId: run.taskId,
            runId: run.runId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      // 退避台账只留仍未终态且近期活跃的 run，避免长跑进程无限增长。
      resultlessFailures.retain(new Set(runs.map((run) => run.runId)), now);
      return report;
    },

    async sweepCheckpointOperations(input = {}) {
      const report: CheckpointSweepReport = { requested: 0, settled: 0, ambiguous: 0, failed: 0 };
      const workerId = input.workerId ?? "cloud-checkpoint";
      const leaseMs = input.leaseMs ?? 30_000;
      const maxLeases = input.maxLeases ?? 4;
      // C-4 分相领取（定稿附录 6，防 FIFO 饿死，不加优先级列）：
      // 第 1 相只领停止屏障关联的 op（run.stopOperationId）——它们卡着 run 终态收口，
      // 优先结算；第 2 相排除这些 op，领其余（周期保存等）。查询参数化，不加新列。
      // `maxLeases` 是本轮总预算：第 1 相优先消耗，剩余给第 2 相。
      const stopOperationIds = await listStopAssociatedOperationIds();
      let leasedCount = 0;
      const runPhase = async (filter: {
        operationIds?: readonly string[];
        excludeOperationIds?: readonly string[];
      }): Promise<void> => {
        while (leasedCount < maxLeases) {
          const leased = await operations.leaseNext({
            kinds: ["checkpoint"],
            workerId,
            leaseMs,
            now: clock.now(),
            ...filter,
          });
          if (!leased) break;
          leasedCount += 1;
          const outcome = await settleCheckpoint(leased.operation, leased.leaseToken);
          if (outcome === "settled") report.settled += 1;
          else if (outcome === "failed") report.failed += 1;
          else if (outcome === "ambiguous") report.ambiguous += 1;
        }
      };
      if (stopOperationIds.length > 0) {
        await runPhase({ operationIds: stopOperationIds });
      }
      await runPhase(stopOperationIds.length > 0 ? { excludeOperationIds: stopOperationIds } : {});
      return report;
    },
  };
}

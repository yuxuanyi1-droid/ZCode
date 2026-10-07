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
  evaluateCheckpointOutcome,
  shouldRequestPeriodicCheckpoint,
} from "../../domain/savePolicy.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, ok, type CloudAppResult } from "../result.js";
import type { ExternalOperationRecord } from "../ports/operationOutboxPort.js";

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

export function createCheckpointPipeline(deps: CloudCoreDeps): CheckpointPipeline {
  const { storage, operations, attachments, clock, ids, config } = deps;

  async function settleCheckpoint(
    operation: ExternalOperationRecord,
    leaseToken: string,
  ): Promise<"settled" | "ambiguous" | "failed" | "pending"> {
    if (!operation.taskId || !operation.runId) return "failed";
    const checkpoints = await storage.projections.listCheckpoints(operation.taskId);
    const record = checkpoints.find((item) => item.operationId === operation.operationId);
    if (!record) {
      // 结果未到：保留 pending（不猜 saved，也不当 failed）。
      return "pending";
    }
    if (record.state === "saved" && record.confirmedRemoteSha) {
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
      if (outcome.dataAtRisk) {
        // CR-6 冻结写口：保存风险在不改状态的前提下可见（08 §8.2「不得宣称工作全部保住」）。
        await storage.runs.setRunDataAtRisk({
          runId: input.runId,
          runGeneration: input.runGeneration,
          dataAtRisk: true,
          now,
        });
      }
      if (outcome.state === "saved" && outcome.confirmedRemoteSha) {
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
      for (const run of runs) {
        if (run.status !== "ready" || run.stopRequested) continue;
        const checkpoints = await storage.projections.listCheckpoints(run.taskId);
        const lastCheckpointAt = checkpoints.reduce(
          (latest, item) => Math.max(latest, item.updatedAt),
          0,
        );
        // 「保存中」以已持久 checkpoint 记录判定：outbox 端口只能按键查询，不能按 run 枚举。
        const checkpointInFlight = checkpoints.some(
          (item) => item.state === "pending" || item.state === "saving",
        );
        const shouldRequest = shouldRequestPeriodicCheckpoint({
          now,
          lastCheckpointAt: lastCheckpointAt || undefined,
          // 执行状态读取端口未冻结（CR-4）：以业务活动新鲜度保守判定（不猜 idle 就不发保存）。
          execution: run.lastBusinessActivityAt === undefined ? "unknown" : "running",
          checkpointInFlight,
          periodicCheckpointMs: config.periodicCheckpointMs,
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
        await attachments.requestCheckpoint({
          taskId: run.taskId,
          runId: run.runId,
          runGeneration: run.runGeneration,
          operationId,
          // 周期保存是控制面主动保存：purpose 取 manual（stop/drain 之外的动作）。
          purpose: "manual",
        });
        report.requested += 1;
      }
      return report;
    },

    async sweepCheckpointOperations(input = {}) {
      const report: CheckpointSweepReport = { requested: 0, settled: 0, ambiguous: 0, failed: 0 };
      const workerId = input.workerId ?? "cloud-checkpoint";
      const leaseMs = input.leaseMs ?? 30_000;
      const maxLeases = input.maxLeases ?? 4;
      for (let index = 0; index < maxLeases; index += 1) {
        const leased = await operations.leaseNext({
          kinds: ["checkpoint"],
          workerId,
          leaseMs,
          now: clock.now(),
        });
        if (!leased) break;
        const outcome = await settleCheckpoint(leased.operation, leased.leaseToken);
        if (outcome === "settled") report.settled += 1;
        else if (outcome === "failed") report.failed += 1;
        else if (outcome === "ambiguous") report.ambiguous += 1;
      }
      return report;
    },
  };
}

/**
 * 补偿清理与终止核验（01 §5.1「provider 已建而初始化失败持久补偿 terminate；结果未知
 * 对账不盲重建」、§4.3「provider 确认资源释放后才释放计费槽」、03 §5 operation 租约、
 * 08 §8.1 停止通路依赖）。
 *
 * 设计：
 * - 终止是**持久操作意图**（operation + 幂等键绑定 run+generation），先入队再执行；
 *   唯一 worker 用租约串行调用 provider，结算必须带租约令牌，迟到结果不覆盖新 worker
 *   （OperationOutboxPort 的 CAS 语义）。
 * - handle 未知时不能谎报已释放：用 create operationKey 对账找回资源；`unknown` 保留
 *   操作与配额槽（08 §6、01 §4.3）。
 * - 只有 provider 确认终止才把 run 写终态并释放配额。
 */
import type { CloudRunRecord } from "@zcode/shared";
import {
  cleanupOperationKey,
  createOperationKey,
  terminateOperationKey,
} from "../../domain/idempotency.js";
import { mayReleaseQuota } from "../../domain/quota.js";
import { FORCE_STOP_END_REASON } from "../../domain/taskRunState.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, ok, type CloudAppResult } from "../result.js";
import type { LeasedOperation } from "../ports/operationOutboxPort.js";
import type { RunOrchestrator } from "../runOrchestrator.js";

export type TerminationVerdict = "terminated" | "notTerminated" | "unknown";

/**
 * 迟到分配清账的 provider 重试预算（C-3 两阶段清账，定稿附录 6）：create 结果 ambiguous
 * 时终止意图已持久（terminate/cleanup op 先入队，见 requestTermination），provider IO
 * 按 cleanup op 的租约重试；超过该预算仍无法核验的，保持 ambiguous + 告警，不再对
 * provider 反复打 destroy（对账窗口交给启动恢复与运营入口）。
 */
export const CLEANUP_RETRY_BUDGET_MS = 30_000 as const;

/** 纯判定：清理重试预算是否耗尽（至少经历过一次 provider IO，attempt > 1）。 */
export function cleanupRetryBudgetExhausted(input: {
  attempt: number;
  createdAt: number;
  now: number;
  budgetMs?: number;
}): boolean {
  return (
    input.attempt > 1 && input.now - input.createdAt >= (input.budgetMs ?? CLEANUP_RETRY_BUDGET_MS)
  );
}

export interface CompensationReport {
  leased: number;
  settled: number;
  ambiguous: number;
  failed: number;
}

export interface RunCompensation {
  /** 入队终止意图（幂等）：同 run+generation 重复调用复用同一 operation。 */
  requestTermination(input: {
    runId: string;
    runGeneration: number;
    reason: string;
  }): Promise<CloudAppResult<{ operationId: string }>>;
  /** 执行一轮 terminate/cleanup 操作（生命周期循环与 stop/readiness 共用）。 */
  runCompensationOnce(input?: {
    workerId?: string;
    leaseMs?: number;
    maxLeases?: number;
  }): Promise<CompensationReport>;
  /** 请求终止并尽力执行，返回**已核验**的结论（unknown 时调用方必须保留配额槽）。 */
  terminateRun(input: {
    runId: string;
    runGeneration: number;
    reason: string;
    /** 收口 run 时的可读原因（如 bootstrap 失败详情），落到 run.lastError。 */
    lastError?: string;
  }): Promise<CloudAppResult<{ verdict: TerminationVerdict }>>;
}

export function createRunCompensation(
  deps: CloudCoreDeps,
  orchestrator: RunOrchestrator,
): RunCompensation {
  const { storage, operations, drivers, clock } = deps;

  /**
   * 本次 `terminateRun` 内的补偿文本：`runCompensationOnce` 在 `terminateRun` 里同步执行，
   * 因此用局部变量把可读原因带到 `settleTerminated`（不新增端口字段）。
   */
  let pendingLastError: string | undefined;
  /** 同一次调用内的补偿原因（终止通路的 endReason 取它，缺省用内部核验标签）。 */
  let pendingReason: string | undefined;

  async function requestTermination(input: {
    runId: string;
    runGeneration: number;
    reason: string;
  }) {
    const run = await storage.runs.get(input.runId);
    if (!run) return fail("not_found", "run-not-found");
    if (run.runGeneration !== input.runGeneration) return fail("stale", "stale-generation");
    const operation = await operations.enqueue({
      operationId: `${run.runId}:terminate:${run.runGeneration}`,
      kind: "terminate",
      idempotencyKey: terminateOperationKey(run.runId, run.runGeneration),
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      now: clock.now(),
    });
    // 资源清理未核验时同时登记 cleanup 意图，供对账与运营入口（01 §5.3）。
    await operations.enqueue({
      operationId: `${run.runId}:cleanup:${run.runGeneration}`,
      kind: "cleanup",
      idempotencyKey: cleanupOperationKey(run.runId, run.runGeneration),
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      now: clock.now(),
    });
    return ok({ operationId: operation.operationId });
  }

  async function executeTermination(
    leased: LeasedOperation,
    run: CloudRunRecord,
  ): Promise<"settled" | "ambiguous" | "failed"> {
    const driver = run.provider ? await drivers.resolve(run.provider) : null;
    if (!driver) {
      await operations.settle({
        operationId: leased.operation.operationId,
        leaseToken: leased.leaseToken,
        outcome: "failed",
        errorCode: "validation_failed",
        now: clock.now(),
      });
      return "failed";
    }
    let handle = run.providerHandle
      ? { provider: run.provider ?? "", sandboxId: run.providerHandle }
      : null;
    if (!handle) {
      // handle 未知：按 create operationKey 对账找回，找不到时保留槽等对账（不谎报已释放）。
      // C-3 两阶段清账：清理意图已在此前持久（terminate/cleanup op），provider IO 按预算
      // 重试；预算耗尽（重试 30s+ 仍无结论）保持 ambiguous + 告警，不再反复打 provider。
      const createOperation = await operations.findByKey(createOperationKey(run.runId));
      if (
        cleanupRetryBudgetExhausted({
          attempt: leased.operation.attempt,
          createdAt: leased.operation.createdAt,
          now: clock.now(),
        })
      ) {
        await operations.settle({
          operationId: leased.operation.operationId,
          leaseToken: leased.leaseToken,
          outcome: "ambiguous",
          errorCode: "provider_termination_unknown",
          now: clock.now(),
        });
        cloudCoreLogger.error(
          undefined,
          "cloud cleanup retry budget exhausted; staying ambiguous",
          {
            taskId: run.taskId,
            runId: run.runId,
            operationId: leased.operation.operationId,
            attempt: leased.operation.attempt,
            createOperationRecorded: createOperation !== null,
          },
        );
        return "ambiguous";
      }
      // C-3（定稿附录 6）：对账锚点取 create op 的持久 createdAt（跨重启可用）；
      // op 缺失时不传锚点，findCreateResult 保守回 unknown（不猜「未创建」）。
      const createAnchor = createOperation
        ? { operationAttemptedAtMs: createOperation.createdAt }
        : undefined;
      const reconciliation = await driver.findCreateResult(
        createOperationKey(run.runId),
        createAnchor,
      );
      if (reconciliation.status === "unknown") {
        await operations.settle({
          operationId: leased.operation.operationId,
          leaseToken: leased.leaseToken,
          outcome: "ambiguous",
          errorCode: "provider_termination_unknown",
          now: clock.now(),
        });
        return "ambiguous";
      }
      if (reconciliation.status === "notFound") {
        // provider 明确没有该 operationKey 的资源：无需终止，按已核验收口。
        await settleTerminated(leased, run, "no-resource");
        return "settled";
      }
      handle = reconciliation.handle;
    }
    const observation = await driver.terminate(handle);
    if (observation.status === "terminated") {
      await settleTerminated(leased, run, "provider-confirmed");
      return "settled";
    }
    if (observation.status === "notTerminated") {
      await operations.settle({
        operationId: leased.operation.operationId,
        leaseToken: leased.leaseToken,
        outcome: "failed",
        errorCode: observation.errorCode ?? "provider_unreachable",
        now: clock.now(),
      });
      return "failed";
    }
    await operations.settle({
      operationId: leased.operation.operationId,
      leaseToken: leased.leaseToken,
      outcome: "ambiguous",
      errorCode: observation.errorCode ?? "provider_termination_unknown",
      now: clock.now(),
    });
    return "ambiguous";
  }

  async function settleTerminated(leased: LeasedOperation, run: CloudRunRecord, reason: string) {
    await operations.settle({
      operationId: leased.operation.operationId,
      leaseToken: leased.leaseToken,
      outcome: "settled",
      now: clock.now(),
    });
    if (run.stopRequested === true || run.status === "draining" || run.status === "provisioning") {
      // 停止/补偿路径：确认终止后按证据收口终态并释放配额（01 §4.3）。
      await orchestrator.settleTerminal({
        runId: run.runId,
        runGeneration: run.runGeneration,
        to: "stopped",
        // 同一次 terminateRun 调用内用调用方的原因（bootstrap-failed/user-stop/…）；
        // 循环驱动的路径回落到内部核验标签。
        endReason: pendingReason ?? reason,
        termination: "terminated",
        ...(pendingLastError ? { lastError: pendingLastError } : {}),
        // 用户显式 force-stop 已确认可能丢失工作：终态必须如实暴露风险（03 §6、08 §8.2）。
        ...(run.endReason === FORCE_STOP_END_REASON ? { dataAtRisk: true } : {}),
      });
      return;
    }
    if (run.status === "ready" || run.status === "disconnected") {
      // 未请求停止却资源消失：按 expired 收口，Task 仍可继续或 failed（08 §3.2）。
      await orchestrator.settleTerminal({
        runId: run.runId,
        runGeneration: run.runGeneration,
        to: "expired",
        endReason: reason,
        termination: "terminated",
        dataAtRisk: true,
      });
    }
  }

  async function runCompensationOnce(
    input: { workerId?: string; leaseMs?: number; maxLeases?: number } = {},
  ): Promise<CompensationReport> {
    const report: CompensationReport = { leased: 0, settled: 0, ambiguous: 0, failed: 0 };
    const workerId = input.workerId ?? "cloud-compensation";
    const leaseMs = input.leaseMs ?? 60_000;
    const maxLeases = input.maxLeases ?? 4;
    for (let index = 0; index < maxLeases; index += 1) {
      const leased = await operations.leaseNext({
        kinds: ["terminate", "cleanup"],
        workerId,
        leaseMs,
        now: clock.now(),
      });
      if (!leased) break;
      report.leased += 1;
      const run = leased.operation.runId ? await storage.runs.get(leased.operation.runId) : null;
      if (!run || run.runGeneration !== leased.operation.runGeneration) {
        // 旧代际的迟到操作：结算为 failed，绝不作用于新 run（08 §4.2）。
        await operations.settle({
          operationId: leased.operation.operationId,
          leaseToken: leased.leaseToken,
          outcome: "failed",
          errorCode: "stale",
          now: clock.now(),
        });
        report.failed += 1;
        continue;
      }
      const outcome = await executeTermination(leased, run);
      if (outcome === "settled") report.settled += 1;
      else if (outcome === "ambiguous") report.ambiguous += 1;
      else report.failed += 1;
    }
    return report;
  }

  return {
    requestTermination,
    runCompensationOnce,

    async terminateRun(input) {
      const requested = await requestTermination(input);
      if (!requested.ok) return requested;
      pendingLastError = input.lastError;
      pendingReason = input.reason;
      try {
        await runCompensationOnce({ workerId: `compensate:${input.runId}` });
      } finally {
        pendingLastError = undefined;
        pendingReason = undefined;
      }
      const operation = await operations.findByKey(
        terminateOperationKey(input.runId, input.runGeneration),
      );
      if (!operation) return fail("not_found", "operation-not-found");
      switch (operation.state) {
        case "settled":
          return ok({ verdict: "terminated" as const });
        case "failed":
          return ok({ verdict: "notTerminated" as const });
        default:
          cloudCoreLogger.warn(undefined, "cloud run termination unverified", {
            runId: input.runId,
            state: operation.state,
          });
          return ok({ verdict: "unknown" as const });
      }
    },
  };
}

/** 终止核验后配额释放的判定（01 §4.3）：只有 terminated 才释放。 */
export function releasedAfterTermination(verdict: TerminationVerdict): boolean {
  return mayReleaseQuota(verdict);
}

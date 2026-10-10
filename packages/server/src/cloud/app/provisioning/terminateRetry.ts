/**
 * failed terminate op 的退避重排队（specs/cloud-agent/08 §8.1 修订 2026-10-09，
 * 生命周期 v2 审计第一批 P1）。从 compensation 拆出的单一职责编排：
 * outbox 租约只领 pending/到期 leased/ambiguous（03 §5），failed 行永不重领，而
 * `enqueue` 幂等返回既有行不改状态——provider 明确拒绝终止（notTerminated，如
 * 403/402）后 op 停在 failed，非终态 run 永久卡 draining/paused。本模块在终止入口
 * （`compensation.terminateRun`）里把到期的 failed op 显式重排队为 pending，由既有
 * 补偿循环重试；attempt 封顶后保持 failed 并升级结构化告警，终局兜底是 keepalive
 * liveness（provider 实例消失会收口）。
 *
 * 幂等边界：幂等键（`terminateOperationKey`）/attempt/屏障指针不变——paused 停止推进
 * 与预算耗尽闭环复用同一键，兼容；旧代际 op 不复活（run 已换代即返回，08 §4.2）。
 */
import type { CloudRunRecord } from "@zcode/shared";
import { terminateOperationKey } from "../../domain/idempotency.js";
import { isTerminalRunStatus } from "../../domain/taskRunState.js";
import {
  TERMINATE_RETRY_MAX_ATTEMPTS,
  terminateRetryDue,
} from "../../domain/terminateRetryPolicy.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";

/** 失败重排队编排：非终态 run 的 failed terminate op 按策略重排队/升级告警。 */
export type TerminateRetry = (run: CloudRunRecord) => Promise<void>;

export function createTerminateRetry(
  deps: Pick<CloudCoreDeps, "operations" | "clock">,
): TerminateRetry {
  const { operations, clock } = deps;
  /**
   * attempt 封顶告警的进程内去重：同一 op 的升级告警只记一次，不随 sweep 每 30s
   * 重复刷屏；进程重启后重记一次（可接受，封顶是持久事实）。
   */
  const escalatedCapReached = new Set<string>();

  return async function requeueFailedTermination(run: CloudRunRecord): Promise<void> {
    if (isTerminalRunStatus(run.status)) return;
    const operation = await operations.findByKey(
      terminateOperationKey(run.runId, run.runGeneration),
    );
    if (!operation || operation.state !== "failed") return;
    if (operation.attempt >= TERMINATE_RETRY_MAX_ATTEMPTS) {
      if (!escalatedCapReached.has(operation.operationId)) {
        escalatedCapReached.add(operation.operationId);
        cloudCoreLogger.error(
          undefined,
          "cloud terminate retry budget exhausted; op stays failed",
          {
            taskId: run.taskId,
            runId: run.runId,
            operationId: operation.operationId,
            attempt: operation.attempt,
            errorCode: operation.errorCode,
          },
        );
      }
      return;
    }
    if (
      !terminateRetryDue({
        attempt: operation.attempt,
        failedAt: operation.updatedAt,
        now: clock.now(),
      })
    ) {
      return;
    }
    const requeued = await operations.requeueFailed({
      operationId: operation.operationId,
      now: clock.now(),
    });
    if (requeued) {
      cloudCoreLogger.info(undefined, "cloud failed terminate op requeued for retry", {
        taskId: run.taskId,
        runId: run.runId,
        operationId: operation.operationId,
        attempt: operation.attempt,
      });
    }
  };
}

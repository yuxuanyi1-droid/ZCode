/**
 * readiness 看门狗（08 §8.2 实施决议「provisioning 超 soft timeout（默认 120s）→ 查
 * provider 事实（liveness）；running 且无 bridge → 持久 terminate 意图并按 provider 确认
 * 收口；unknown 保留对账，不建替代沙箱」、01 §5.2 readiness 与错误）。
 *
 * 注意：timeout 只表示「未就绪」，不证明资源不存在（01 §5.2）；因此未知结论保留 run 与配额。
 */
import { createOperationKey } from "../../domain/idempotency.js";
import type { CloudCoreDeps } from "../deps.js";
import type { ProviderSandboxHandle } from "../ports/sandboxDriverPort.js";
import { cloudCoreLogger } from "../logger.js";
import type { RunCompensation } from "./compensation.js";
import type { RunOrchestrator } from "../runOrchestrator.js";

export interface ReadinessSweepReport {
  inspected: number;
  terminated: number;
  settled: number;
  unknown: number;
}

export interface ReadinessWatchdog {
  sweep(now?: number): Promise<ReadinessSweepReport>;
}

export function createReadinessWatchdog(
  deps: CloudCoreDeps,
  orchestrator: RunOrchestrator,
  compensation: RunCompensation,
): ReadinessWatchdog {
  const { storage, operations, drivers, clock, config } = deps;

  return {
    async sweep(now = clock.now()) {
      const report: ReadinessSweepReport = { inspected: 0, terminated: 0, settled: 0, unknown: 0 };
      const runs = await storage.runs.listNonTerminal();
      for (const run of runs) {
        if (run.status !== "provisioning") continue;
        if (now - run.createdAt < config.readinessSoftTimeoutMs) continue;
        // D4-9（审计 #5）：单 run 的探测/收口异常只属于该 run——裸调用曾让排序最前的
        // 毒 run 拖垮其后全部 run 的对账。记 warn 后继续处理下一个（模式对齐 keepalive
        // 的 inspect 处理）。
        try {
          report.inspected += 1;
          const driver = run.provider ? await drivers.resolve(run.provider) : null;
          if (!driver) {
            report.unknown += 1;
            continue;
          }
          let handle: ProviderSandboxHandle | null = run.providerHandle
            ? { provider: run.provider ?? "", sandboxId: run.providerHandle }
            : null;
          if (!handle) {
            // handle 未落地（create 结果未知）：按 operationKey 对账，不建替代沙箱。
            // C-3（定稿附录 6）：对账锚点取 create op 的持久 createdAt（跨重启可用）；
            // op 缺失时不传锚点，findCreateResult 保守回 unknown（不猜「未创建」）。
            const createOperation = await operations.findByKey(createOperationKey(run.runId));
            // op 缺失时不传锚点：findCreateResult 保守回 unknown（不猜「未创建」）。
            const anchor = createOperation
              ? { operationAttemptedAtMs: createOperation.createdAt }
              : undefined;
            const reconciliation = await driver.findCreateResult(
              createOperationKey(run.runId),
              anchor,
            );
            if (reconciliation.status === "unknown") {
              report.unknown += 1;
              continue;
            }
            if (reconciliation.status === "notFound") {
              // provider 明确没有该资源：创建失败已核验并清理（08 §3.2 provisioning→failed）。
              await orchestrator.failProvisioning({
                runId: run.runId,
                runGeneration: run.runGeneration,
                reason: "readiness-create-not-found",
                instanceDispositioned: true,
                termination: "terminated",
              });
              report.settled += 1;
              continue;
            }
            handle = reconciliation.handle;
            await storage.runs.recordProviderHandle({
              runId: run.runId,
              runGeneration: run.runGeneration,
              provider: handle.provider,
              providerHandle: handle.sandboxId,
              providerDeadline: handle.providerDeadline,
              deadlineEstimate: handle.deadlineEstimate,
              now,
            });
          }
          const observation = await driver.inspect(handle);
          if (observation.status === "unknown") {
            // 不可查询：保留 disconnected/reconciling 信息，禁止新的写 run（03 §8）。
            report.unknown += 1;
            continue;
          }
          if (observation.status === "stopped" || observation.status === "notFound") {
            // provider 确认资源不存在/已停：可恢复为「准备未完成即终止」，保留正文与 recipe。
            await orchestrator.failProvisioning({
              runId: run.runId,
              runGeneration: run.runGeneration,
              reason: "readiness-instance-gone",
              instanceDispositioned: true,
              termination: "terminated",
            });
            report.settled += 1;
            continue;
          }
          // running 且无 bridge：持久 terminate 意图并按 provider 确认收口（不建替代沙箱）。
          cloudCoreLogger.warn(undefined, "cloud provisioning timed out with live instance", {
            runId: run.runId,
          });
          await compensation.requestTermination({
            runId: run.runId,
            runGeneration: run.runGeneration,
            reason: "readiness-timeout",
          });
          const outcome = await compensation.runCompensationOnce({
            workerId: `readiness:${run.runId}`,
          });
          report.terminated += outcome.settled;
          if (outcome.ambiguous > 0) report.unknown += 1;
        } catch (error) {
          cloudCoreLogger.warn(undefined, "cloud readiness sweep run failed", {
            runId: run.runId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
      return report;
    },
  };
}

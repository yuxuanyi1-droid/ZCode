/**
 * 启动恢复扫描与 provider 存活核验（03 §8 重启与故障恢复、01 §5.3 启动对账、02 §8 故障表）。
 *
 * 恢复器的判定分支是冻结的：
 * - provider 确认存活 → 等待/验证 bridge 恢复；**不创建重复沙箱**；
 * - provider 确认终止 → 写终态、释放配额，记录保存结果/风险；
 * - provider 不可查询 → 保留 disconnected/reconciling 信息，禁止新的写 run；
 * - durable input 有 receipt 无 ACK → 同 run 查询 runtime commandId，确认为 unknown 才重投同 ID
 *   （由 inputDelivery 的对账承担；本文件把重启时仍在途的 delivering 收口为 uncertain）。
 */
import { createOperationKey } from "../../domain/idempotency.js";
import type { CloudCoreDeps } from "../deps.js";
import type { ProviderSandboxHandle } from "../ports/sandboxDriverPort.js";
import { cloudCoreLogger } from "../logger.js";
import type { RunOrchestrator } from "../runOrchestrator.js";

export interface ReconcileSummary {
  examined: number;
  alive: number;
  settled: number;
  unknown: number;
  inputsUncertain: number;
  unsettledOperations: number;
}

export interface StartupReconciler {
  reconcileOnStartup(now?: number): Promise<ReconcileSummary>;
}

export function createStartupReconciler(
  deps: CloudCoreDeps,
  orchestrator: RunOrchestrator,
): StartupReconciler {
  const { storage, operations, drivers, clock } = deps;

  return {
    async reconcileOnStartup(now = clock.now()) {
      const summary: ReconcileSummary = {
        examined: 0,
        alive: 0,
        settled: 0,
        unknown: 0,
        inputsUncertain: 0,
        unsettledOperations: 0,
      };
      const runs = await storage.runs.listNonTerminal();
      for (const run of runs) {
        summary.examined += 1;
        // 重启后连接注册表为空：仍在途的投递结论不可知，先收口为 uncertain 再对账（02 §6.3）。
        const inputs = await storage.inputs.listDeliverable(run.taskId);
        for (const input of inputs) {
          if (input.deliveryStatus !== "delivering") continue;
          const marked = await storage.inputs.markDelivery({
            taskId: run.taskId,
            commandId: input.commandId,
            to: "uncertain",
            lastError: "control-plane-restart",
            now,
          });
          if (marked) summary.inputsUncertain += 1;
        }

        const driver = run.provider ? await drivers.resolve(run.provider) : null;
        if (!driver) {
          summary.unknown += 1;
          continue;
        }
        let handle: ProviderSandboxHandle | null = run.providerHandle
          ? { provider: run.provider ?? "", sandboxId: run.providerHandle }
          : null;
        if (!handle) {
          const reconciliation = await driver.findCreateResult(createOperationKey(run.runId));
          if (reconciliation.status === "unknown") {
            // 内存表清空不是 Run 消失；不建替代沙箱（01 §5.3）。
            summary.unknown += 1;
            await orchestrator.markDisconnected({
              runId: run.runId,
              runGeneration: run.runGeneration,
              reason: "provider-unqueryable",
            });
            continue;
          }
          if (reconciliation.status === "notFound") {
            await orchestrator.failProvisioning({
              runId: run.runId,
              runGeneration: run.runGeneration,
              reason: "restart-create-not-found",
              instanceDispositioned: true,
              termination: "terminated",
            });
            summary.settled += 1;
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
          summary.unknown += 1;
          await orchestrator.markDisconnected({
            runId: run.runId,
            runGeneration: run.runGeneration,
            reason: "provider-unqueryable",
          });
          continue;
        }
        if (observation.status === "stopped" || observation.status === "notFound") {
          // provider 确认终止：写终态、释放配额，并记录保存风险不可知（01 §5.3）。
          const settled = await orchestrator.settleTerminal({
            runId: run.runId,
            runGeneration: run.runGeneration,
            to: run.status === "provisioning" ? "stopped" : "expired",
            endReason: "restart-provider-terminated",
            termination: "terminated",
            dataAtRisk: run.status !== "provisioning",
          });
          if (settled.ok) summary.settled += 1;
          continue;
        }
        // provider 存活：等待合法 bridge 恢复，不创建重复沙箱。
        summary.alive += 1;
        cloudCoreLogger.info(undefined, "cloud run alive after restart", {
          taskId: run.taskId,
          runId: run.runId,
        });
      }

      const unsettled = await operations.listUnsettled();
      summary.unsettledOperations = unsettled.length;
      for (const operation of unsettled) {
        if (operation.state === "pending" || operation.state === "leased") continue;
        // ambiguous 操作保留对账入口，不降级为 failed（03 §5）。
        cloudCoreLogger.warn(undefined, "cloud external operation awaits reconciliation", {
          operationId: operation.operationId,
          kind: operation.kind,
          state: operation.state,
        });
      }
      cloudCoreLogger.info(undefined, "cloud startup reconciliation complete", { ...summary });
      return summary;
    },
  };
}

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
  /** stop-pending 守卫跳过收口的 run 数（终态交停止推进通路收口 stopped，03 修订审计第二批）。 */
  stopPending: number;
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
        stopPending: 0,
      };
      const runs = await storage.runs.listNonTerminal();
      for (const run of runs) {
        // D4-9（审计 #5）：单 run 的恢复核验异常不得拖垮其后全部 run 的启动对账
        // （此前按排序第一个毒 run 会让其余 run 停在未对账状态）。记 warn 后继续。
        try {
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
            // C-3（定稿附录 6）：对账必须带持久锚点——create op 的 createdAt 是跨重启
            // 可用的 create 尝试时间；没有它，「查不到」无法安全判 notFound（01 §4.1）。
            // op 缺失时不传锚点：findCreateResult 保守回 unknown（不猜「未创建」）。
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
          if (observation.status === "paused") {
            // 暂停保留期（01 §4.1 修订 2026-10-09）：实例被 provider 保留，run 保持
            // paused——不按 stopped/notFound 收口、不标 disconnected；恢复由控制面
            // 自驱 resume（有 deliverable 输入时）或暂停预算终局负责。
            summary.alive += 1;
            cloudCoreLogger.info(undefined, "cloud run paused after restart", {
              taskId: run.taskId,
              runId: run.runId,
            });
            continue;
          }
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
            // stop-pending 守卫（03 修订审计第二批，与 keepalive liveness keepalive.ts
            // 同一口径）：已受理停止但未在停止推进中的 run（paused/ready/disconnected）
            // 不以 expired 落账——「用户显式停止的 run 以过期终态落账」与停止屏障打架，
            // 且迁移表没有 paused→stopped 边。终态由停止推进通路收口 stopped：
            // paused → pauseResume sweep（advancePausedStop）；ready/disconnected →
            // drain sweep 重试 beginDrain；draining 无 op → keepalive 兜底认领。
            // provisioning 例外：notFound → stopped 本就遵循停止意图（行为不变）。
            if (
              run.stopRequested === true &&
              run.status !== "draining" &&
              run.status !== "provisioning"
            ) {
              summary.stopPending += 1;
              cloudCoreLogger.info(
                undefined,
                "cloud startup defers terminal settlement to stop path",
                {
                  taskId: run.taskId,
                  runId: run.runId,
                  runStatus: run.status,
                  instanceStatus: observation.status,
                },
              );
              continue;
            }
            // 消费侧调停（01 §4.1 修订审计第二批）：run=paused（控制面持久事实）时
            // driver 的 stopped 观测按 disk-pause 保留态处理（Daytona stop 只停不删，
            // pause 后每次 inspect 都返回 stopped）——保持 paused 不收口；notFound 才是
            // 真终局。若实例确被外部移除，暂停预算宽限兜底（keepalive）保证有界收口。
            if (observation.status === "stopped" && run.status === "paused") {
              summary.alive += 1;
              cloudCoreLogger.info(
                undefined,
                "cloud run paused after restart (stop-state retained)",
                {
                  taskId: run.taskId,
                  runId: run.runId,
                },
              );
              continue;
            }
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
        } catch (error) {
          cloudCoreLogger.warn(undefined, "cloud startup reconciliation run failed", {
            runId: run.runId,
            message: error instanceof Error ? error.message : String(error),
          });
        }
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

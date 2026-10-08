/**
 * Run 生命周期编排（W1 §3「预约→create→ready→drain 的生命周期编排（经端口）」；
 * 08 §3.2 Run 状态机、§4.2 代际、§6 配额、§8.1 停止屏障、02 §5.3 ready 门控）。
 *
 * 边界：
 * - Run 状态迁移一律经 `RunRepo.transitionStatus` 的 CAS（generation 精确匹配），
 *   旧代际/旧 epoch 的结果不得覆盖新 run（08 §4.2）。
 * - 本文件不创建 provider 资源（那是 provisioning/ 的 create 操作）也不做保存内容
 *   （那是 lifecycle/ 的 checkpoint 通路）；它只裁决状态与配额。
 * - 预约本身是接纳事务的一部分（`StoragePort.acceptInput` 事务内 count+reserve，08 §6），
 *   本文件不「先 count 后 create」。
 */
import type { CloudRunRecord, CloudRunStatus } from "@zcode/shared";
import {
  canTransitionRun,
  isTerminalRunStatus,
  provisioningCancelKeepsSupplyFact,
} from "../domain/taskRunState.js";
import { mayReleaseQuota } from "../domain/quota.js";
import { fenceFrame } from "../domain/fencing.js";
import type { AttachmentRegistry } from "./attachments/registry.js";
import type { CloudCoreDeps } from "./deps.js";
import { cloudCoreLogger } from "./logger.js";
import { fail, ok, type CloudAppResult } from "./result.js";

export interface RunOrchestrator {
  /** bridge.ready 落地：只有有效的 run/generation/epoch 才能从 provisioning 转 ready。 */
  markReady(input: {
    taskId: string;
    runId: string;
    runGeneration: number;
    connectionEpoch: number;
    runtimeIncarnation?: string;
    runtimeSessionId?: string;
  }): Promise<CloudAppResult<CloudRunRecord>>;
  /** 心跳/网络丢失：ready → disconnected，绝不自动 expired/failed（02 §2 不变量 4）。 */
  markDisconnected(input: {
    runId: string;
    runGeneration: number;
    connectionEpoch?: number;
    reason: string;
  }): Promise<CloudAppResult<CloudRunRecord>>;
  /** 终态落地：必须带证据（provider 确认终止 / 停止结果），未知结果不写终态。 */
  settleTerminal(input: {
    runId: string;
    runGeneration: number;
    to: "stopped" | "expired" | "failed";
    endReason: string;
    termination: "terminated" | "notTerminated" | "unknown";
    dataAtRisk?: boolean;
    /** 可读、有界、脱敏的失败原因（落到 run.lastError，供 UI/运维诊断，03 §9）。 */
    lastError?: string;
  }): Promise<CloudAppResult<CloudRunRecord>>;
  /** 因准备失败（确定未投递）收口 run：创建失败已核验并清理时用。 */
  failProvisioning(input: {
    runId: string;
    runGeneration: number;
    reason: string;
    instanceDispositioned: boolean;
    termination: "terminated" | "notTerminated" | "unknown";
    /** 可读、有界、脱敏的失败原因（落到 run.lastError，供 UI/运维诊断，03 §9）。 */
    lastError?: string;
  }): Promise<CloudAppResult<CloudRunRecord>>;
}

export function createRunOrchestrator(
  deps: CloudCoreDeps,
  registry: AttachmentRegistry,
): RunOrchestrator {
  const { storage, clock } = deps;

  async function currentRun(runId: string) {
    return storage.runs.get(runId);
  }

  /**
   * 终态输入收口（08 §8.1「生命周期对确定未执行输入收口」、审计 D4-3）：run 落终态后，
   * 残留的 deliverable 输入（accepted/delivering/uncertain）若不收口，dispatcher 因
   * activeOfTask 返回空而永不处理它们，complete 的 unsettled 检查会永久 not_ready。
   * 本函数是**所有**终态路径（stop 补偿、keepalive expired、readiness/startup、
   * create 失败）唯一的收口点：settleTerminal/failProvisioning 是仅有的两个终态 CAS 入口。
   * 收口失败不回滚已落地的终态（终态是 provider 证据事实），记 error 留待幂等重试
   * （complete 前的再收口与 sweep 兜底）。
   */
  async function settleInputsOfEndedRun(taskId: string, runId: string): Promise<void> {
    try {
      const outcome = await storage.inputs.settleForEndedRun({
        taskId,
        runId,
        now: clock.now(),
      });
      if (outcome.cancelled > 0 || outcome.unknown > 0) {
        cloudCoreLogger.info(undefined, "cloud ended run inputs settled", {
          taskId,
          runId,
          ...outcome,
        });
      }
    } catch (error) {
      cloudCoreLogger.error(undefined, "cloud ended run input settlement failed", {
        taskId,
        runId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    async markReady(input) {
      const run = await currentRun(input.runId);
      if (!run || run.taskId !== input.taskId) return fail("not_found", "run-not-found");
      const fence = fenceFrame({
        frameGeneration: input.runGeneration,
        currentGeneration: run.runGeneration,
        frameEpoch: input.connectionEpoch,
        currentEpoch: run.connectionEpoch,
      });
      if (!fence.accepted) {
        // 旧 ready 不得复活终态 run 或覆盖 activeRunId（08 §10 故障矩阵）。
        return fail("stale", fence.reason);
      }
      if (run.stopRequested) {
        // 08 §8.1：stop 受理后不再发布 ready；迟到 ready 只用于对账/补偿。
        return fail("recovery_required", "stop-requested");
      }
      if (
        !registry.bootstrapConfigSent({
          runId: run.runId,
          runGeneration: run.runGeneration,
          connectionEpoch: input.connectionEpoch,
        })
      ) {
        // 02 §5.3：运行配置/凭据/策略快照安装是 ready 的必要条件；未下发不得发布 ready。
        // 补救路径是「标记 + 下次连接重装」，不在此处补发或放宽。
        return fail("recovery_required", "bootstrap-config-not-sent");
      }
      if (run.status === "ready") {
        // 幂等发布（2026-10-09 生命周期 v2）：控制面自驱 resume 已把 paused CAS 为 ready，
        // 沙箱随后回连并重发 bridge.ready——此时状态已是 ready，重复 CAS 是自反边。
        // 不得回 bridge.fault（那会让恢复中的沙箱误判失败），registry.ready 照常置位，
        // 投递门控只看 attachment ready（02 §5.3）。
        cloudCoreLogger.debug(undefined, "cloud run ready already published", {
          taskId: run.taskId,
          runId: run.runId,
          runGeneration: run.runGeneration,
          connectionEpoch: input.connectionEpoch,
        });
        return ok(run);
      }
      if (!canTransitionRun(run.status, "ready")) {
        return fail("stale", "invalid-run-transition", { from: run.status });
      }
      const updated = await storage.runs.transitionStatus({
        runId: run.runId,
        runGeneration: run.runGeneration,
        from: ["provisioning", "disconnected", "draining"],
        to: "ready",
        now: clock.now(),
      });
      if (!updated) return fail("stale", "run-transition-cas-failed");
      cloudCoreLogger.info(undefined, "cloud run ready", {
        taskId: run.taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
        connectionEpoch: input.connectionEpoch,
      });
      return ok(updated);
    },

    async markDisconnected(input) {
      const run = await currentRun(input.runId);
      if (!run) return fail("not_found", "run-not-found");
      const fence = fenceFrame({
        frameGeneration: input.runGeneration,
        currentGeneration: run.runGeneration,
        frameEpoch: input.connectionEpoch,
        currentEpoch: run.connectionEpoch,
      });
      if (!fence.accepted) return fail("stale", fence.reason);
      if (
        isTerminalRunStatus(run.status) ||
        run.status === "draining" ||
        // paused 显式跳过（08 §3.2 修订：watchdog 对 paused 不推进；暂停保留期由
        // keepalive liveness 按 provider 事实核对，断连语义不适用于已 detach 的暂停 run）。
        run.status === "paused"
      ) {
        // draining 失联保持 draining（08 §3.2：draining → disconnected 由既有停止意图决定，
        // 但控制面不得借断线改写终态或解除屏障）。
        return ok(run);
      }
      if (!canTransitionRun(run.status, "disconnected")) return ok(run);
      const updated = await storage.runs.transitionStatus({
        runId: run.runId,
        runGeneration: run.runGeneration,
        from: ["ready"],
        to: "disconnected",
        endReason: input.reason,
        now: clock.now(),
      });
      if (updated) {
        cloudCoreLogger.warn(undefined, "cloud run disconnected", {
          taskId: run.taskId,
          runId: run.runId,
          reason: input.reason,
        });
      }
      return updated ? ok(updated) : fail("stale", "run-transition-cas-failed");
    },

    async settleTerminal(input) {
      const run = await currentRun(input.runId);
      if (!run) return fail("not_found", "run-not-found");
      if (run.runGeneration !== input.runGeneration) return fail("stale", "stale-generation");
      if (isTerminalRunStatus(run.status)) return ok(run);
      if (!canTransitionRun(run.status, input.to)) {
        return fail("stale", "invalid-run-transition", { from: run.status, to: input.to });
      }
      if (input.to === "failed" && input.termination === "unknown") {
        // provider 结果未知不得归 failed（03 §5、08 §10）：保留 disconnected/reconciling。
        return fail("provider_termination_unknown", "termination-unverified");
      }
      const updated = await storage.runs.transitionStatus({
        runId: run.runId,
        runGeneration: run.runGeneration,
        // paused 含在内（2026-10-09 生命周期 v2）：暂停预算耗尽 → provider 保留期尽 →
        // keepalive liveness 确认实例不存在 → expired（paused→expired 边）。paused→stopped
        // 不在迁移表里：canTransitionRun 会先拒绝（停止推进通路必须先 paused→draining）。
        from: ["provisioning", "ready", "paused", "disconnected", "draining"],
        to: input.to,
        endReason: input.endReason,
        ...(input.dataAtRisk !== undefined ? { dataAtRisk: input.dataAtRisk } : {}),
        ...(input.lastError ? { lastError: input.lastError } : {}),
        now: clock.now(),
      });
      if (!updated) return fail("stale", "run-transition-cas-failed");
      if (mayReleaseQuota(input.termination)) {
        await storage.runs.releaseQuota({
          runId: run.runId,
          reason: input.endReason,
          now: clock.now(),
        });
      } else {
        // 资源清理未确认仍占槽（01 §4.3、03 §6.2 尾段）。
        cloudCoreLogger.warn(undefined, "cloud run terminal without confirmed termination", {
          taskId: run.taskId,
          runId: run.runId,
          termination: input.termination,
        });
      }
      // 终态扫尾：残留 deliverable 输入确定性收口（08 §8.1、审计 D4-3）。
      await settleInputsOfEndedRun(run.taskId, run.runId);
      return ok(updated);
    },

    async failProvisioning(input) {
      const run = await currentRun(input.runId);
      if (!run) return fail("not_found", "run-not-found");
      if (run.runGeneration !== input.runGeneration) return fail("stale", "stale-generation");
      if (run.status !== "provisioning") return fail("stale", "run-not-provisioning");
      // 08 §8.1：创建未发出时取消意图并确认无资源；已在途时保留核验，迟到 handle 进入清理。
      if (!input.instanceDispositioned) {
        const stillSupplyFact = provisioningCancelKeepsSupplyFact(run);
        return fail(
          "provider_create_unknown",
          stillSupplyFact ? "cleanup-unverified" : "create-unknown",
        );
      }
      const target: CloudRunStatus = run.stopRequested ? "stopped" : "failed";
      const updated = await storage.runs.transitionStatus({
        runId: run.runId,
        runGeneration: run.runGeneration,
        from: ["provisioning"],
        to: target,
        endReason: input.reason,
        ...(input.lastError ? { lastError: input.lastError } : {}),
        now: clock.now(),
      });
      if (!updated) return fail("stale", "run-transition-cas-failed");
      if (mayReleaseQuota(input.termination)) {
        await storage.runs.releaseQuota({
          runId: run.runId,
          reason: input.reason,
          now: clock.now(),
        });
      }
      // 终态扫尾：创建失败/停止的 provisioning run 同样收口残留输入（08 §8.1 首命令
      // 取消/拒绝清理、审计 D4-3）。
      await settleInputsOfEndedRun(run.taskId, run.runId);
      return ok(updated);
    },
  };
}

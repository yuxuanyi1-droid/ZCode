/**
 * create 成功后的 handle 持久化与 supervisor 启动（specs/cloud-agent 01 §5.1 第 3 条、§8、
 * 08 §8.1 停止屏障）。从 `createOperation.ts` 拆出以保持单文件职责与行数预算。
 *
 * 顺序（01 §5.1 第 3 条）：create 成功**立即持久 handle/deadline** → 校验停止意图 →
 * 启动 supervisor → 结算 create 操作。启动放在结算之前：失败时本 operation 记
 * `failed(bootstrap_failed)`，不留"settled 却没人管的沙箱"（01 §9 补偿终止）。
 * 正常 create 路径与 `findCreateResult` 对账恢复路径**共用**本函数。
 */
import { type CloudErrorCode, type CloudRunRecord } from "@zcode/shared";
import { createOperationKey } from "../../domain/idempotency.js";
import type { CloudCoreConfig } from "../config.js";
import type { ClockPort } from "../ports/clockPort.js";
import type { LeasedOperation } from "../ports/operationOutboxPort.js";
import type { ProviderSandboxHandle, SandboxDriverPort } from "../ports/sandboxDriverPort.js";
import type { StoragePort } from "../ports/storagePort.js";
import { cloudCoreLogger } from "../logger.js";
import type { RunCompensation } from "./compensation.js";
import { isRecoverableGitGrantFailure, type CloudGitGrantService } from "../gitGrants.js";
import { SandboxBootstrapError, bootstrapSandboxWithCompensation } from "./bootstrapSandbox.js";

/** create 尝试结论（01 §9 三分支 + 迟到 handle 跳过）。 */
export type CreateAttemptOutcome =
  | { operationId: string; outcome: "created"; runId: string }
  | { operationId: string; outcome: "skipped"; reason: string }
  | { operationId: string; outcome: "failed"; reason: string }
  | { operationId: string; outcome: "unknown"; reason: string };

export async function persistRunHandle(input: {
  driver: SandboxDriverPort;
  leased: LeasedOperation;
  run: CloudRunRecord;
  handle: ProviderSandboxHandle;
  deadlineSource: "provider" | "estimated";
  workspacePath: string;
  bootstrapTicket: string;
  storage: StoragePort;
  clock: ClockPort;
  config: CloudCoreConfig;
  compensation: RunCompensation;
  /** git grant 签发（01 §7.2）：clone grant 必须在 supervisor 启动前签发。 */
  gitGrants: CloudGitGrantService;
  /** 带租约的 operation 结算（由 create worker 提供）。 */
  settle: (
    outcome: "settled" | "ambiguous" | "failed",
    errorCode?: CloudErrorCode,
  ) => Promise<void>;
}): Promise<CreateAttemptOutcome> {
  const {
    driver,
    leased,
    run,
    handle,
    deadlineSource,
    workspacePath,
    bootstrapTicket,
    storage,
    clock,
    config,
    compensation,
    gitGrants,
    settle,
  } = input;
  // create 成功立即持久 handle/deadline（必须匹配 runGeneration；01 §5.1 第 3 条）。
  const persisted = await storage.runs.recordProviderHandle({
    runId: run.runId,
    runGeneration: run.runGeneration,
    provider: handle.provider,
    providerHandle: handle.sandboxId,
    // 与创建期下发值同一份计算（08 §4.1：workspacePath 来自 run 的已验证描述）。
    workspacePath,
    providerDeadline: handle.providerDeadline,
    deadlineEstimate: handle.deadlineEstimate,
    now: clock.now(),
  });
  if (!persisted) {
    // 写 handle 前 run 已被新代际接管/已终态：迟到 handle 只能进入清理（08 §8.1）。
    await compensation.requestTermination({
      runId: run.runId,
      runGeneration: run.runGeneration,
      reason: "late-handle",
    });
    await settle("settled");
    return {
      operationId: leased.operation.operationId,
      outcome: "skipped",
      reason: "late-handle",
    };
  }
  if (deadlineSource === "estimated") {
    cloudCoreLogger.info(undefined, "cloud sandbox created with estimated deadline", {
      runId: run.runId,
    });
  }
  const latest = await storage.runs.get(run.runId);
  if (latest?.stopRequested) {
    // 创建与停止并发：不启动 supervisor（08 §8.1「迟到 handle 只能进入清理，不能启动 Agent」）。
    await compensation.requestTermination({
      runId: run.runId,
      runGeneration: run.runGeneration,
      reason: "stop-after-create",
    });
    await settle("settled");
    return {
      operationId: leased.operation.operationId,
      outcome: "skipped",
      reason: "stop-after-create",
    };
  }

  // 01 §5.1 第 3 条 + §7.2：持久 handle/deadline 之后依次执行 bootstrap 步骤
  // （**clone grant 签发 → 拉起 supervisor**），正常路径与对账恢复路径共用。
  // 放在 settle 之前：失败时本 operation 记 `failed(<归一码>)`，不留"settled 却没人管"。
  const started = await bootstrapSandboxWithCompensation({
    run,
    compensation,
    settleFailed: async (code) => {
      await settle("failed", code);
    },
    bootstrap: async () => {
      // clone grant 必须在 supervisor 启动**之前**：TTL 60s，而 supervisor 启动 → hello →
      // welcome → bootstrap.config → 兑换实测约 2s，窗口足够；接纳期不能签（create 可能几十秒）。
      const cloneGrant = await gitGrants.issueForRun({ runId: run.runId, purpose: "clone" });
      if (!cloneGrant.ok) {
        if (isRecoverableGitGrantFailure(cloneGrant.code)) {
          // 可自愈（外部临时不可用）：记录并继续，由兑换侧失败 + 对账兜住，不阻塞 bootstrap。
          cloudCoreLogger.warn(undefined, "cloud clone grant issuance deferred", {
            runId: run.runId,
            code: cloneGrant.code,
            reason: cloneGrant.reason,
          });
        } else {
          // 不可自愈（终态/停止/仓库未绑定/权限被撤/未配置）：不要启动注定 clone 失败的沙箱。
          throw new SandboxBootstrapError(
            cloneGrant.code,
            "git-grant-issuance-failed",
            `clone grant issuance failed: ${cloneGrant.reason}`,
          );
        }
      }
      await driver.startSupervisor(handle, {
        operationKey: createOperationKey(run.runId),
        runId: run.runId,
        runGeneration: run.runGeneration,
        publicControlPlaneUrl: config.publicControlPlaneUrl,
        bootstrapTicket,
        taskId: run.taskId,
        workspacePath,
      });
    },
  });
  if (!started.ok) {
    return {
      operationId: leased.operation.operationId,
      outcome: "failed",
      reason: started.code === "bootstrap_failed" ? "bootstrap-failed" : "bootstrap-step-failed",
    };
  }

  await settle("settled");
  return { operationId: leased.operation.operationId, outcome: "created", runId: run.runId };
}

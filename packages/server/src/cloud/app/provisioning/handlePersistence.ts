/**
 * create 尝试的 handle 持久化适配（specs/cloud-agent 15 §3 R1、01 §5.1 第 3 条、§8、
 * 08 §8.1 停止屏障）。
 *
 * 具体行为（workspacePath 持久化 → recordProviderHandle → 停止/迟到 handle 清理 →
 * clone grant → startSupervisor → 结算操作）由 `recoverHandle.ts` 的单实现承担；
 * 本文件只把统一结论映射成 create worker 的 `CreateAttemptOutcome`（01 §9 三分支）。
 */
import type { CloudErrorCode, CloudRunRecord } from "@zcode/shared";
import type { LeasedOperation } from "../ports/operationOutboxPort.js";
import type { ProviderSandboxHandle, SandboxDriverPort } from "../ports/sandboxDriverPort.js";
import type { EstablishRunHandleResult, RunHandleEstablisher } from "./recoverHandle.js";

/** create 尝试结论（01 §9 三分支 + 迟到 handle 跳过）。 */
export type CreateAttemptOutcome =
  | { operationId: string; outcome: "created"; runId: string }
  | { operationId: string; outcome: "skipped"; reason: string }
  | { operationId: string; outcome: "failed"; reason: string }
  | { operationId: string; outcome: "unknown"; reason: string };

/** 统一 helper 的结论 → create 尝试结论（operation 结算已在 helper 内完成）。 */
function toCreateAttemptOutcome(
  operationId: string,
  result: EstablishRunHandleResult,
): CreateAttemptOutcome {
  switch (result.status) {
    case "established":
      return { operationId, outcome: "created", runId: result.run.runId };
    case "skipped":
      return {
        operationId,
        outcome: "skipped",
        // 与既有可读原因保持一致（测试与日志口径不变）。
        reason: result.reason === "stop-requested" ? "stop-after-create" : "late-handle",
      };
    case "failed":
      return {
        operationId,
        outcome: "failed",
        reason: result.reason,
      };
  }
}

/** create worker 的持久化入口：带租约调用统一 helper 并映射结论。 */
export async function persistRunHandle(input: {
  establish: RunHandleEstablisher;
  driver: SandboxDriverPort;
  leased: LeasedOperation;
  run: CloudRunRecord;
  handle: ProviderSandboxHandle;
  deadlineSource: "provider" | "estimated";
  /** create 前算好的同一份路径（唯一计算点）；恢复路径可省略。 */
  workspacePath?: string;
  /** 本尝试已铸造的票据；恢复路径省略时由 helper 重新铸造。 */
  bootstrapTicket?: string;
  /** 带租约的 operation 结算（由 create worker 提供）。 */
  settle: (
    outcome: "settled" | "ambiguous" | "failed",
    errorCode?: CloudErrorCode,
  ) => Promise<void>;
}): Promise<CreateAttemptOutcome> {
  const result = await input.establish.establish({
    driver: input.driver,
    run: input.run,
    handle: input.handle,
    deadlineSource: input.deadlineSource,
    ...(input.workspacePath ? { workspacePath: input.workspacePath } : {}),
    ...(input.bootstrapTicket ? { bootstrapTicket: input.bootstrapTicket } : {}),
    leasedOperation: input.leased,
    settleOperation: input.settle,
  });
  return toCreateAttemptOutcome(input.leased.operation.operationId, result);
}

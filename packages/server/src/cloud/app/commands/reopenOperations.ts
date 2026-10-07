/**
 * reopen 前置核验与凭据处置（08 §9 重开、完成与历史、§4.2 代际和租约、02 §2 不变量 5、
 * 03 §6 reopen 行、01 §7.2 git grant）。
 *
 * 重开前必须核验（08 §9 首段）：
 * - 无有效写 run；
 * - 旧 instance 终止/凭据已处置（结果不明时拒绝自动重开，返回 recovery-required）；
 * - 授权仍有效、配额可预留（配额由接纳事务在同一事务内 count+reserve，见 gateway）；
 * - 有 checkpoint 时必须确认任务分支存在（由 gateway 的预检查询远端事实）。
 *
 * 新 Run 固定 resumeSha=最后确认 checkpoint SHA，并查询 taskBranch HEAD 是否一致；
 * 没有 checkpoint 的任务只能显式选择从冻结 baseSha 重新开始（08 §9）。
 */
import type { CloudRunRecord, CloudTaskRecord } from "@zcode/shared";
import { isTerminalRunStatus } from "../../domain/taskRunState.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, ok, type CloudAppResult } from "../result.js";

export interface ReopenEligibility {
  /** 最近一次 run（可能为 null：从未创建过）。 */
  lastRun: CloudRunRecord | null;
  resumeChoices: ("checkpoint" | "restart-from-base")[];
}

export interface ReopenOperations {
  /** 核验重开前置：不满足时返回 recovery-required（禁止自动重开，02 §2 不变量 5）。 */
  verifyReopenEligibility(task: CloudTaskRecord): Promise<CloudAppResult<ReopenEligibility>>;
  /** 处置上一代写凭据（尽力 revoke；结果持久且可重试，01 §7.2）。 */
  revokeSupersededRunCredentials(input: { runId: string }): Promise<number>;
}

/**
 * 独立导出：接纳事务之前的 reopen 前置核验（gateway 的 reopen 预检直接调用，
 * 避免复制「旧写 run 必须已终态」这条规则）。
 */
export async function verifyReopenEligibility(
  deps: CloudCoreDeps,
  task: CloudTaskRecord,
): Promise<CloudAppResult<ReopenEligibility>> {
  const activeRun = await deps.storage.runs.activeOfTask(task.taskId);
  if (activeRun && !isTerminalRunStatus(activeRun.status)) {
    // 断网/失联不授权第二个 run：拒绝双写并显示核验状态（08 §4.2、CP-10）。
    return fail("recovery_required", "active-write-run-present", { runId: activeRun.runId });
  }
  if (!task.baseSha || !task.taskBranch) {
    // 首次准备失败且已证明从未发布任务分支的情况由 start 路径处理；此处要求冻结基线。
    return fail("invalid_ref", "task-baseline-not-frozen");
  }
  const resumeChoices: ("checkpoint" | "restart-from-base")[] = ["restart-from-base"];
  if (task.lastCheckpointSha) resumeChoices.unshift("checkpoint");
  return ok({ lastRun: activeRun, resumeChoices });
}

export function createReopenOperations(deps: CloudCoreDeps): ReopenOperations {
  const { storage } = deps;

  return {
    verifyReopenEligibility: (task) => verifyReopenEligibility(deps, task),

    async revokeSupersededRunCredentials(input) {
      // 旧 run 的 bridge 凭据按 run 撤销；结果持久且可重试（02 §5.1 撤销、01 §7.2）。
      // revokeRun 由 W2 用真实时钟；端口不接受调用方时间（冻结口径）。
      const revoked = await storage.credentials.revokeRun({
        runId: input.runId,
        reason: "superseded-by-reopen",
      });
      if (revoked > 0) {
        cloudCoreLogger.info(undefined, "cloud run credentials revoked before reopen", {
          runId: input.runId,
          revoked,
        });
      }
      return revoked;
    },
  };
}

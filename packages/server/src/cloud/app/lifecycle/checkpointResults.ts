/**
 * checkpoint.result 落库（08 §8.1 统一 checkpoint/stop 通路、§8.2 保存与终止事实；
 * R2 归属与单调性，spec 15 §3）。
 *
 * 事实来源：沙箱侧保存结果以 `checkpoint.result` 帧回到控制面（02 §4）；本文件把它落成
 * `checkpoints` 记录（`saved` 必须有 confirmedRemoteSha，08 §8.2），并更新 Task 的
 * lastCheckpointSha 与 run.dataAtRisk。operation 的结算仍由带租约的 worker 完成
 * （`sweepCheckpointOperations`），本文件只落事实、不结算。
 *
 * 信任边界（R2）：
 * - operationId 必须对应本 task/run/generation 上真实存在的 checkpoint 操作；
 * - saved 是记录终态：迟到 failed/unknown 不覆盖，也不改 dataAtRisk/lastCheckpointSha；
 * - saved 仅在 branch 等于非空 taskBranch 时允许，否则按 failed 语义 fail-closed。
 */
import type { CheckpointResultFrame, CloudCheckpointRecord } from "@zcode/shared";
import { evaluateCheckpointResultAdmission } from "../../domain/checkpointPolicy.js";
import { evaluateCheckpointOutcome } from "../../domain/savePolicy.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, ok, type CloudAppResult } from "../result.js";

export interface CheckpointResultInput {
  taskId: string;
  runId: string;
  runGeneration: number;
  frame: CheckpointResultFrame;
}

export function createCheckpointResultHandler(
  deps: CloudCoreDeps,
  onSaved: (runId: string) => void,
): (input: CheckpointResultInput) => Promise<CloudAppResult<CloudCheckpointRecord>> {
  const { storage, operations, clock } = deps;

  return async function handleCheckpointResult(input) {
    const run = await storage.runs.get(input.runId);
    if (!run || run.taskId !== input.taskId) return fail("not_found", "run-not-found");
    if (run.runGeneration !== input.runGeneration) {
      // 旧代际的 checkpoint 结果不得修改新 run（08 §4.2）。
      return fail("stale", "stale-generation");
    }
    const task = await storage.tasks.get(input.taskId);
    if (!task) return fail("not_found", "task-not-found");

    // 修复依据（2026-10-17 R2，spec 15 §3、08 §8.1/§8.2）：旧实现只按 run 归属校验，
    // 任意 operationId（伪造/不存在/别 run 的 op）都能写入 checkpoints 并改写
    // dataAtRisk。结果必须对应本 task/run/generation 上真实存在的 checkpoint 操作；
    // saved 是终态且只能落在任务分支上。任一不符都拒绝/忽略，不改
    // run.dataAtRisk 与 task.lastCheckpointSha（判定见 domain/checkpointPolicy）。
    const existing = (await storage.projections.listCheckpoints(input.taskId)).find(
      (item) => item.operationId === input.frame.operationId,
    );
    const admission = evaluateCheckpointResultAdmission({
      operation: await operations.get(input.frame.operationId),
      ...(existing ? { existingState: existing.state } : {}),
      taskId: input.taskId,
      runId: input.runId,
      runGeneration: input.runGeneration,
      status: input.frame.status,
      ...(input.frame.branch !== undefined ? { branch: input.frame.branch } : {}),
      ...(task.taskBranch !== undefined ? { taskBranch: task.taskBranch } : {}),
    });
    if (admission.kind === "operation-not-found" || admission.kind === "operation-mismatch") {
      cloudCoreLogger.warn(undefined, "cloud checkpoint result rejected: operation ownership", {
        taskId: input.taskId,
        runId: input.runId,
        operationId: input.frame.operationId,
        reason: admission.kind,
      });
      return admission.kind === "operation-not-found"
        ? fail("not_found", "checkpoint-operation-not-found")
        : fail("validation_failed", "checkpoint-operation-mismatch");
    }
    if (admission.kind === "already-saved") {
      cloudCoreLogger.warn(undefined, "cloud checkpoint late result ignored: already saved", {
        taskId: input.taskId,
        runId: input.runId,
        operationId: input.frame.operationId,
        incomingStatus: input.frame.status,
      });
      // existing 由 already-saved 判定保证存在；缺失时仍 fail-closed，不伪造记录。
      return existing ? ok(existing) : fail("not_found", "checkpoint-record-not-found");
    }
    const branchRejected = admission.kind === "branch-rejected";
    if (branchRejected) {
      cloudCoreLogger.warn(undefined, "cloud checkpoint saved rejected: branch mismatch", {
        taskId: input.taskId,
        runId: input.runId,
        operationId: input.frame.operationId,
        reportedBranch: input.frame.branch,
        taskBranch: task.taskBranch,
      });
    }

    const outcome = evaluateCheckpointOutcome({
      status: branchRejected ? "failed" : input.frame.status,
      branch: input.frame.branch,
      remoteSha: input.frame.remoteSha,
      hadNewCommits: input.frame.hadNewCommits,
      errorCode: branchRejected ? "checkpoint_failed" : input.frame.errorCode,
      errorMessage: branchRejected
        ? "checkpoint reported saved on a branch that is not the task branch"
        : input.frame.error,
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
    // CR-6 冻结写口（08 §8.2「不得宣称工作全部保住」），且**双向如实**：最新一次保存
    // 带确认 SHA 即解除既有风险标注（D4-4：stop 保存重试成功不得被更早的失败永久
    // 标成 dataAtRisk）；失败/未知则如实标注。run.dataAtRisk 的语义 =「最新保存事实
    // 是否有丢失风险」，由本通路（唯一写口之一）随结果推进。
    await storage.runs.setRunDataAtRisk({
      runId: input.runId,
      runGeneration: input.runGeneration,
      dataAtRisk: outcome.dataAtRisk,
      now,
    });
    if (outcome.state === "saved" && outcome.confirmedRemoteSha) {
      // 保存成功：清零结果缺失连击（08 §7 退避：成功即恢复正常周期档）。
      onSaved(input.runId);
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
  };
}

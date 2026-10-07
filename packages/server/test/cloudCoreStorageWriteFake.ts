/**
 * 存储端口 fake 的接纳事务（03 §6.1/§6.2、08 §6、CT-09/CT-10）。
 *
 * 在一个同步「事务」内完成：去重 → revision/generation/stop/配额检查 → Run 预留
 * （事务内递增 nextRunGeneration）→ Input 序号 → create 操作入队。
 * 失败注入 `options.failAcceptInput` 模拟 DB 不可用（CP-02）。
 */
import type { CloudTaskInputRecord } from "@zcode/shared";
import type {
  AcceptInputRequest,
  AcceptInputResult,
  RunRepo,
  StoragePort,
  TaskRepo,
} from "../src/cloud/app/ports/storagePort.js";
import type { FakeOutbox } from "./cloudCoreFakes.js";
import { toReceipt, type StorageFakeState } from "./cloudCoreStorageRepoFakes.js";

export interface WritePathOptions {
  failAcceptInput?: boolean;
  writable?: boolean;
}

export function createWritePathFake(context: {
  state: StorageFakeState;
  runs: RunRepo;
  tasks: TaskRepo;
  outbox: FakeOutbox;
  options: WritePathOptions;
  createOperations: string[];
}): Pick<StoragePort, "acceptInput" | "readiness"> {
  const { state, runs, tasks, outbox, options, createOperations } = context;
  const { tasksById, runsById, inputsByKey, acceptanceSeq, payloadText, taskRevisionBumps } = state;
  return {
    async acceptInput(request: AcceptInputRequest): Promise<AcceptInputResult> {
      if (options.failAcceptInput) throw new Error("storage unavailable");
      const task = tasksById.get(request.taskId);
      if (!task) throw new Error("task missing");
      const existing = inputsByKey.get(`${request.taskId}:${request.commandId}`);
      if (existing) {
        if (existing.payloadHash === request.payloadHash) {
          return { status: "duplicate", receipt: toReceipt(existing, runsById) };
        }
        return { status: "conflict", code: "idempotency_conflict", reason: "payload-mismatch" };
      }
      if (request.intent === "append") {
        const run = [...runsById.values()]
          .filter((item) => item.taskId === request.taskId)
          .sort((left, right) => right.runGeneration - left.runGeneration)[0];
        if (
          !run ||
          run.status === "stopped" ||
          run.status === "expired" ||
          run.status === "failed"
        ) {
          return { status: "conflict", code: "not_ready", reason: "no-active-run" };
        }
        if (
          request.expectedRunGeneration !== undefined &&
          run.runGeneration !== request.expectedRunGeneration
        ) {
          return { status: "conflict", code: "stale", reason: "generation-stale" };
        }
        if (run.stopRequested)
          return { status: "conflict", code: "not_ready", reason: "stop-requested" };
        if (run.status !== "ready")
          return { status: "conflict", code: "not_ready", reason: "not-ready" };
      } else {
        if (
          request.expectedTaskRevision !== undefined &&
          task.revision !== request.expectedTaskRevision
        ) {
          return { status: "conflict", code: "stale", reason: "revision-mismatch" };
        }
        const active = [...runsById.values()].find(
          (item) =>
            item.taskId === request.taskId &&
            item.status !== "stopped" &&
            item.status !== "expired" &&
            item.status !== "failed",
        );
        if (active) return { status: "conflict", code: "stale", reason: "start-on-active" };
        const occupied = [...runsById.values()].filter(
          (item) =>
            item.status === "provisioning" ||
            item.status === "ready" ||
            item.status === "disconnected" ||
            item.status === "draining",
        ).length;
        if (occupied >= request.quota.maxConcurrentRuns) {
          return { status: "conflict", code: "quota_exceeded", reason: "quota-exceeded" };
        }
      }
      const seq = (acceptanceSeq.get(request.taskId) ?? 0) + 1;
      acceptanceSeq.set(request.taskId, seq);
      let runId = request.runId;
      let runGeneration: number | undefined;
      if (request.intent !== "append" && request.runId && request.runRecipe) {
        const reservation = await runs.reserveRun({
          taskId: request.taskId,
          runId: request.runId,
          executionRecipe: request.runRecipe,
          firstInputCommandId: request.commandId,
          quota: request.quota,
          now: request.now,
        });
        runId = reservation.run.runId;
        runGeneration = reservation.runGeneration;
        if (request.taskBranch) {
          const draft = tasksById.get(request.taskId);
          await tasks.freezeBaseline({
            taskId: request.taskId,
            baseBranch: draft?.draftStartConfig?.baseBranch ?? "main",
            baseSha: request.runRecipe.baseSha ?? "a".repeat(40),
            taskBranch: request.taskBranch,
            now: request.now,
          });
        }
        createOperations.push(request.createOperationId);
        await outbox.enqueue({
          operationId: request.createOperationId,
          kind: "create",
          idempotencyKey: `create:${request.runId}`,
          taskId: request.taskId,
          runId: request.runId,
          runGeneration: reservation.runGeneration,
          now: request.now,
        });
      } else {
        const run = [...runsById.values()]
          .filter((item) => item.taskId === request.taskId)
          .sort((left, right) => right.runGeneration - left.runGeneration)[0];
        runId = run?.runId;
        runGeneration = run?.runGeneration;
      }
      const record: CloudTaskInputRecord = {
        taskId: request.taskId,
        commandId: request.commandId,
        intent: request.intent,
        payloadHash: request.payloadHash,
        acceptanceSeq: seq,
        attachmentRefs: request.attachmentIds,
        requestedConfig: request.requestedConfig,
        resolvedExecutionConfig: request.resolvedExecutionConfig,
        acceptedAt: request.now,
        targetRunId: runId,
        deliveryStatus: "accepted",
      };
      inputsByKey.set(`${request.taskId}:${request.commandId}`, record);
      payloadText.set(`${request.taskId}:${request.commandId}`, request.prompt);
      const latest = tasksById.get(request.taskId);
      if (latest) {
        taskRevisionBumps.value += 1;
        tasksById.set(latest.taskId, {
          ...latest,
          revision: latest.revision + 1,
          updatedAt: request.now,
        });
      }
      return {
        status: "accepted",
        receipt: toReceipt(record, runsById),
        runId,
        runGeneration,
      };
    },
    async readiness() {
      return {
        lastAppliedMigrationId:
          options.writable === false ? null : "0005_task_input_interaction_decisions",
        schemaVersion: 5,
        writable: options.writable !== false,
        attachmentsWritable: true,
      };
    },
  };
}

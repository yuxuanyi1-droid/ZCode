/**
 * 存储端口 fake 的 repository 部分（输入 / 投影 / 凭据 / 持久正文读取）与分页、receipt 助手。
 * 与 cloudCoreStorageFake.ts 共享 `StorageFakeState`；语义对齐端口 JSDoc：
 * 去重键、水位单调、只存凭据 hash、正文不进 receipt 投影。
 */
import type {
  CloudCheckpointRecord,
  CloudProjectRecord,
  CloudProjectionRecord,
  CloudRunRecord,
  CloudStreamCursor,
  CloudTaskInputRecord,
  CloudTaskRecord,
  InputReceipt,
} from "@zcode/shared";
import type {
  CursorPage,
  InputPayloadRead,
  InputRepo,
  ProjectionRepo,
  RunCredentialRepo,
} from "../src/cloud/app/ports/storagePort.js";

import { canAdvanceDeliveryStatus } from "../src/cloud/domain/deliveryStatus.js";
import {
  advanceContiguousWatermark,
  projectionCoveredInterval,
} from "../src/cloud/domain/projectionSequence.js";

export interface StorageFakeState {
  projectsById: Map<string, CloudProjectRecord>;
  tasksById: Map<string, CloudTaskRecord>;
  runsById: Map<string, CloudRunRecord>;
  inputsByKey: Map<string, CloudTaskInputRecord>;
  acceptanceSeq: Map<string, number>;
  checkpoints: CloudCheckpointRecord[];
  projectionRecords: CloudProjectionRecord[];
  revokedRuns: string[];
  quotaReleases: string[];
  payloadText: Map<string, string>;
  credentials: Map<string, { credentialHash: string; rotationId: string; expiresAt?: number }>;
  cursors: Map<string, CloudStreamCursor>;
  snapshots: Map<string, { logEpoch: string; coveredSourceSeq: number; snapshot: unknown }>;
  taskRevisionBumps: { value: number };
}

export function createStorageFakeState(): StorageFakeState {
  return {
    projectsById: new Map(),
    tasksById: new Map(),
    runsById: new Map(),
    inputsByKey: new Map(),
    acceptanceSeq: new Map(),
    checkpoints: [],
    projectionRecords: [],
    revokedRuns: [],
    quotaReleases: [],
    payloadText: new Map(),
    credentials: new Map(),
    cursors: new Map(),
    snapshots: new Map(),
    taskRevisionBumps: { value: 0 },
  };
}

export function createInputsRepo(state: StorageFakeState): InputRepo {
  const { inputsByKey } = state;
  return {
    async get(taskId, commandId) {
      return inputsByKey.get(`${taskId}:${commandId}`) ?? null;
    },
    async list(taskId, page) {
      return paginate(
        [...inputsByKey.values()]
          .filter((item) => item.taskId === taskId)
          .sort((left, right) => left.acceptanceSeq - right.acceptanceSeq),
        page,
      );
    },
    async markDelivery(request) {
      const current = inputsByKey.get(`${request.taskId}:${request.commandId}`);
      if (!current) return null;
      // 端口语义：只允许状态机内的前进（规则与 app 侧同一份 domain 实现）。
      if (!canAdvanceDeliveryStatus(current.deliveryStatus, request.to)) return null;
      const updated: CloudTaskInputRecord = {
        ...current,
        deliveryStatus: request.to,
        runtimeAck: request.runtimeAck ?? current.runtimeAck,
        targetRunId: request.runId ?? current.targetRunId,
        runtimeSessionId: request.runtimeSessionId ?? current.runtimeSessionId,
        lastError: request.lastError ?? current.lastError,
      };
      inputsByKey.set(`${request.taskId}:${request.commandId}`, updated);
      return updated;
    },
    async cancelPending(request) {
      const current = inputsByKey.get(`${request.taskId}:${request.commandId}`);
      if (!current) return null;
      if (current.deliveryStatus !== "accepted") return null;
      const updated: CloudTaskInputRecord = { ...current, deliveryStatus: "cancelled" };
      inputsByKey.set(`${request.taskId}:${request.commandId}`, updated);
      return updated;
    },
    /**
     * 终态扫尾（D4-3）：与真实 repo 同一裁决——accepted→cancelled（确定未执行），
     * delivering→uncertain（结果不明，不伪称 cancelled），uncertain 保持；
     * 只作用于绑定本 run 或未绑定的输入。
     */
    async settleForEndedRun(request) {
      let cancelled = 0;
      let unknown = 0;
      for (const [key, input] of inputsByKey) {
        if (input.taskId !== request.taskId) continue;
        if (input.targetRunId !== undefined && input.targetRunId !== request.runId) continue;
        if (input.deliveryStatus === "accepted") {
          inputsByKey.set(key, {
            ...input,
            deliveryStatus: "cancelled",
            lastError: "run-ended",
          });
          cancelled += 1;
        } else if (input.deliveryStatus === "delivering") {
          inputsByKey.set(key, {
            ...input,
            deliveryStatus: "uncertain",
            lastError: "run-ended",
          });
          unknown += 1;
        }
      }
      return { cancelled, unknown };
    },
    async listDeliverable(taskId) {
      return [...inputsByKey.values()]
        .filter(
          (item) =>
            item.taskId === taskId &&
            item.deliveryStatus !== "admitted" &&
            item.deliveryStatus !== "rejected" &&
            item.deliveryStatus !== "cancelled",
        )
        .sort((left, right) => left.acceptanceSeq - right.acceptanceSeq);
    },
  };
}

export function createProjectionsRepo(state: StorageFakeState): ProjectionRepo {
  const { projectionRecords, cursors, snapshots, checkpoints } = state;
  return {
    async appendBatch(records) {
      const conflicts: { topic: string; logEpoch: string; sourceSeq: number }[] = [];
      let appended = 0;
      const appendedRunIds = new Set<string>();
      for (const record of records) {
        const key = [
          record.runId,
          record.runtimeIncarnation,
          record.topic,
          record.logEpoch,
          record.sourceSeq,
        ].join("|");
        const existing = projectionRecords.find(
          (item) =>
            [item.runId, item.runtimeIncarnation, item.topic, item.logEpoch, item.sourceSeq].join(
              "|",
            ) === key,
        );
        if (existing) {
          if (existing.contentHash !== record.contentHash) {
            conflicts.push({
              topic: record.topic,
              logEpoch: record.logEpoch,
              sourceSeq: record.sourceSeq,
            });
          }
          continue;
        }
        projectionRecords.push(record);
        appended += 1;
        appendedRunIds.add(record.runId);
        // 与真实 SQLite 仓库同一水位口径（domain/projectionSequence.ts 的区间链）：
        // 导出记录的 sourceSeq 取交付帧 toSeq，snapshot 领头流的第一条记录 sourceSeq=N，
        // 「逐条 +1」的旧算法会把水位错成 -1（2026-10-07 复核缺陷 2 的 4001 根因）。
        const cursorKey = `${record.runId}|${record.topic}|${record.logEpoch}`;
        const stored = cursors.get(cursorKey)?.sourceSeq ?? -1;
        const intervals = projectionRecords
          .filter(
            (item) =>
              item.runId === record.runId &&
              item.topic === record.topic &&
              item.logEpoch === record.logEpoch,
          )
          .map((item) => projectionCoveredInterval(item.payload, item.sourceSeq))
          .sort((left, right) => left.from - right.from);
        const next = Math.max(advanceContiguousWatermark(intervals, stored), stored);
        if (next > stored) {
          cursors.set(cursorKey, {
            topic: record.topic,
            logEpoch: record.logEpoch,
            sourceSeq: next,
          });
        }
      }
      return {
        cursors: [...cursors.entries()]
          .filter(([key]) => key.startsWith(`${records[0]?.runId ?? ""}|`))
          .map(([, value]) => value),
        conflicts,
        appended,
        appendedRunIds: [...appendedRunIds],
      };
    },
    async readHistory(request) {
      const items = projectionRecords
        .filter((item) => item.taskId === request.taskId)
        .filter((item) => (request.topic ? item.topic === request.topic : true));
      return { items, nextCursor: undefined, resyncRequired: false };
    },
    async readSnapshot(request) {
      return snapshots.get(`${request.taskId}|${request.topic}`) ?? null;
    },
    async writeSnapshot(request) {
      snapshots.set(`${request.taskId}|${request.topic}`, {
        logEpoch: request.logEpoch,
        coveredSourceSeq: request.coveredSourceSeq,
        snapshot: request.snapshot,
      });
    },
    async ingestCursors(runId) {
      return [...cursors.entries()]
        .filter(([key]) => key.startsWith(`${runId}|`))
        .map(([, value]) => value);
    },
    async listCheckpoints(taskId) {
      return checkpoints.filter((item) => item.taskId === taskId);
    },
    async recordCheckpoint(checkpoint) {
      // 与真实 repo 同一语义（projections.recordCheckpoint 按 operation_id UPSERT）：
      // 同一 operationId 的重试结果覆盖旧记录（C-1/D4-4 重试成功读最新状态的前提）。
      const index = checkpoints.findIndex((item) => item.operationId === checkpoint.operationId);
      if (index >= 0) checkpoints[index] = checkpoint;
      else checkpoints.push(checkpoint);
    },
  };
}

export function createCredentialsRepo(state: StorageFakeState): RunCredentialRepo {
  const { credentials, revokedRuns } = state;
  return {
    async saveInitial(request) {
      credentials.set(request.runId, { credentialHash: request.credentialHash, rotationId: "r1" });
    },
    async consumeForHello(request) {
      const record = credentials.get(request.runId);
      if (!record || record.credentialHash !== request.proofHash) return null;
      credentials.set(request.runId, { credentialHash: request.candidateHash, rotationId: "r1" });
      return { rotationId: "r1" };
    },
    async recoverByAttempt(request) {
      const record = credentials.get(request.runId);
      if (!record) return null;
      return { rotationId: "r1", committed: record.credentialHash === request.candidateHash };
    },
    async revokeRun(request) {
      revokedRuns.push(request.runId);
      return credentials.delete(request.runId) ? 1 : 0;
    },
    async extendForRun(request) {
      // 与真实 repo 同一语义：只外推不内缩（B-6 续展口径）；无凭据/已撤销返回 false。
      const record = credentials.get(request.runId);
      if (!record) return false;
      const current = record.expiresAt ?? 0;
      record.expiresAt = Math.max(current, request.expiresAt);
      return true;
    },
  };
}

export function toReceipt(
  record: CloudTaskInputRecord,
  runs: Map<string, CloudRunRecord>,
): InputReceipt {
  const receipt: InputReceipt = {
    taskId: record.taskId,
    commandId: record.commandId,
    deliveryStatus: record.deliveryStatus,
  };
  if (record.targetRunId) {
    receipt.runId = record.targetRunId;
    const run = runs.get(record.targetRunId);
    if (run) receipt.runGeneration = run.runGeneration;
  }
  return receipt;
}

export function paginate<T>(items: T[], page: { cursor?: string; limit: number }): CursorPage<T> {
  const start = page.cursor ? Number(page.cursor) : 0;
  const slice = items.slice(start, start + page.limit);
  const next = start + slice.length < items.length ? String(start + slice.length) : undefined;
  return next ? { items: slice, nextCursor: next } : { items: slice };
}

export function createPayloadReadRepo(state: StorageFakeState): InputPayloadRead {
  const { payloadText } = state;
  return {
    async readInputPayload(request) {
      const prompt = payloadText.get(`${request.taskId}:${request.commandId}`);
      if (prompt === undefined) return null;
      return { prompt };
    },
  };
}

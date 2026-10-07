/**
 * 历史、快照与恢复（02 §7.3 快照、历史与恢复、§7.4 continuous/replayable、03 §9 留存、
 * 03 §6 history/snapshot 端点行）。
 *
 * 冻结语义：
 * - 客户端展示路径只依赖控制面持久副本：任何端打开会话都从控制面读快照 + 增量恢复，
 *   不要求 Run 在线、不从沙箱拉历史，沙箱已销毁亦然（02 §7.3）。
 * - 客户端持有一致状态才携 `{logEpoch,seq}`；epoch 匹配且保留窗覆盖则 resume，否则回
 *   持久 snapshot；越出保留窗返回 resync-required，**不静默从零猜**（02 §7.3、03 §9）。
 * - 快照必须声明所覆盖的事件范围（03 §4 projection_snapshots 约束）。
 */
import type {
  CloudHistoryItem,
  CloudHistoryPage,
  CloudProjectionSnapshot,
  CloudProjectionRecord,
  CloudStreamCursor,
} from "@zcode/shared";
import type { CloudCoreDeps } from "../deps.js";
import { fail, ok, type CloudAppResult } from "../result.js";

/** v1 canonical 流是 conversation（02 §7.4 实施决议）；缺省 topic 即该族名。 */
export const CANONICAL_TOPIC = "conversation";

/** 建议默认 history/input 保留 30 天（03 §9，待产品冻结）。 */
export const PROJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export type ResumeDecision =
  | { kind: "resume"; logEpoch: string; fromSeq: number }
  | { kind: "snapshot"; reason: "epoch-mismatch" | "no-cursor" }
  | { kind: "resync"; reason: "retention-exceeded" };

export interface ProjectionHistoryService {
  readHistory(input: {
    principalId: string;
    taskId: string;
    topic?: string;
    cursor?: string;
    limit?: number;
  }): Promise<CloudAppResult<CloudHistoryPage>>;
  readSnapshot(input: {
    principalId: string;
    taskId: string;
    topic?: string;
    logEpoch?: string;
  }): Promise<CloudAppResult<CloudProjectionSnapshot>>;
}

const DEFAULT_HISTORY_LIMIT = 100;

export function createProjectionHistoryService(deps: CloudCoreDeps): ProjectionHistoryService {
  const { storage, clock } = deps;

  async function ownedTask(principalId: string, taskId: string) {
    const task = await storage.tasks.get(taskId);
    if (!task || task.ownerPrincipalId !== principalId) return null;
    return task;
  }

  return {
    async readHistory(input) {
      const task = await ownedTask(input.principalId, input.taskId);
      if (!task) return fail("not_found", "task-not-found");
      const page = await storage.projections.readHistory({
        taskId: task.taskId,
        topic: input.topic ?? CANONICAL_TOPIC,
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_HISTORY_LIMIT,
      });
      const response: CloudHistoryPage = {
        items: page.items.map((record) => toHistoryItem(record, clock.now())),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        // 游标越出保留窗时客户端必须 resync（03 §9）；只声明事实，不静默从零猜。
        ...(page.resyncRequired ? { resyncRequired: true } : {}),
      };
      return ok(response);
    },

    async readSnapshot(input) {
      const task = await ownedTask(input.principalId, input.taskId);
      if (!task) return fail("not_found", "task-not-found");
      const snapshot = await storage.projections.readSnapshot({
        taskId: task.taskId,
        topic: input.topic ?? CANONICAL_TOPIC,
        logEpoch: input.logEpoch,
      });
      if (!snapshot) return fail("not_found", "snapshot-not-available");
      // 快照必须声明覆盖到的 sourceSeq：后续 delta 必须从 seq+1 连续（02 §7.3）。
      const response: CloudProjectionSnapshot = {
        taskId: task.taskId,
        topic: input.topic ?? CANONICAL_TOPIC,
        logEpoch: snapshot.logEpoch,
        coveredSourceSeq: snapshot.coveredSourceSeq,
        // snapshot payload 在 shared 侧是 z.json()（有界 JSON）：此处只做类型收窄。
        snapshot: snapshot.snapshot as CloudProjectionSnapshot["snapshot"],
        createdAt: clock.now(),
      };
      return ok(response);
    },
  };
}

/**
 * 投影记录 → 历史行：payload 由服务端解码，seq 是执行节点 export cursor（02 §7.1）。
 * `CloudProjectionRecord.payload` 在 zod 侧是有界 JSON（shared 已校验），此处只做类型收窄。
 */
export function toHistoryItem(record: CloudProjectionRecord, ts: number): CloudHistoryItem {
  return {
    topic: record.topic,
    logEpoch: record.logEpoch,
    seq: record.sourceSeq,
    kind: record.kind,
    payload: record.payload as CloudHistoryItem["payload"],
    ts,
  };
}

/**
 * 恢复判定（02 §7.3）：epoch 匹配且水位覆盖则 resume；否则回快照；
 * 越出保留窗返回 resync（需要 snapshot + 明确告知客户端丢弃旧状态）。
 */
export function decideResume(input: {
  requestedLogEpoch?: string;
  requestedSeq?: number;
  cursors: readonly CloudStreamCursor[];
  snapshotAvailable: boolean;
  elapsedSinceCursorMs?: number;
  retentionMs?: number;
}): ResumeDecision {
  const retention = input.retentionMs ?? PROJECTION_RETENTION_MS;
  if (input.elapsedSinceCursorMs !== undefined && input.elapsedSinceCursorMs > retention) {
    return { kind: "resync", reason: "retention-exceeded" };
  }
  if (input.requestedLogEpoch === undefined || input.requestedSeq === undefined) {
    return input.snapshotAvailable
      ? { kind: "snapshot", reason: "no-cursor" }
      : { kind: "resync", reason: "retention-exceeded" };
  }
  const cursor = input.cursors.find((item) => item.logEpoch === input.requestedLogEpoch);
  if (!cursor) return { kind: "snapshot", reason: "epoch-mismatch" };
  if (cursor.sourceSeq < input.requestedSeq) return { kind: "snapshot", reason: "epoch-mismatch" };
  return { kind: "resume", logEpoch: cursor.logEpoch, fromSeq: input.requestedSeq };
}

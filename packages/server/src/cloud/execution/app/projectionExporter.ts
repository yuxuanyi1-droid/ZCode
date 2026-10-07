/**
 * canonical 投影 exporter（specs/cloud-agent/02 §7 全节，W6 §3「projectionExporter」）。
 *
 * 位置：接在**执行节点权威投影提交后的语义边界**——订阅既有 V4 conversation topic
 * （02 §7.4 实施决议：`subscribeConversationV4` 只读已提交投影，不改 runtime 内部），
 * 把交付帧按 `(topic, logEpoch, seq)` 写 WAL，再转 `projection.batch`；控制面提交后回
 * `projection.ack` 清 WAL。
 *
 * 关键规则：
 * - 一条记录 = 一个 V4 交付帧（含 `fromSeq`/`toSeq` 完整区间），**不把 coalesced 区间
 *   压成假逐事件 seq**（02 §7.1）；`sourceSeq` 取该帧 `toSeq`（持久 export cursor）；
 * - 去重键 `(runId, runtimeIncarnation, topic, logEpoch, sourceSeq)`；同键同 hash 幂等，
 *   同键不同 hash 是一致性 fault；
 * - 缺口不跳跃确认：返回 expectedSourceSeq 并触发一次有界重订（先 snapshot 再 delta）；
 * - WAL 写成功才推进 exported cursor；ACK 丢失只重投，不重建引用。
 */
import { createHash } from "node:crypto";
import {
  CLOUD_PROJECTION_SCHEMA_VERSION,
  CLOUD_PROJECTION_BATCH_MAX_RECORDS,
  type CloudErrorCode,
  type CloudProjectionKind,
  type CloudProjectionRecord,
  type CloudStreamCursor,
} from "@zcode/shared";
import {
  createProjectionWalState,
  DEFAULT_WAL_CAPACITY,
  type ProjectionWalCapacity,
  type ProjectionWalState,
} from "../domain/projectionWal.js";
import type { ExecutionLogger, ProjectionPort, ProjectionWalPort } from "./ports.js";

/** V4 topic 交付帧（只声明导出需要的字段；形状由 V4 契约持有，不在此复刻 schema）。 */
export interface TopicDeliveryFrame {
  topic: string;
  subscriptionId: string;
  fromSeq: number;
  toSeq: number;
  sentAt: unknown;
  payload: { kind: "snapshot" | "deltas"; [key: string]: unknown };
}

/** 常驻本地 client 的 V4 订阅面（adapter 实现；exporter 不认识 RPC 细节）。 */
export interface ConversationTopicSource {
  subscribe(params: {
    topic: string;
    base?: { logEpoch: string; seq: number };
    clientMode: "web-remote-replayable";
  }): Promise<{ subscriptionId: string; mode: "snapshot" | "resume"; logEpoch: string }>;
  unsubscribe(subscriptionId: string): Promise<void>;
  onFrame(listener: (frame: TopicDeliveryFrame) => void): { dispose(): void };
}

export interface ProjectionExporterOptions {
  taskId: string;
  runId: string;
  runGeneration: number;
  runtimeIncarnation: string;
  /** sessions-index 订阅（用于发现 conversation 话题）；不导出该 topic 自身。 */
  sessionIndexTopic: string;
  /** 会话 id 提取（从 sessions-index 帧里取；注入以便测试与其他 topic 形态复用）。 */
  extractSessionIds(frame: TopicDeliveryFrame): string[];
  source: ConversationTopicSource;
  walStore: ProjectionWalPort;
  logger: ExecutionLogger;
  capacity?: ProjectionWalCapacity;
  /** 一致性 fault / 容量 fault 的对外上报（会话转 `bridge.fault`）。 */
  reportFault?(fault: { code: CloudErrorCode; message: string; retryable: boolean }): void;
}

export interface ProjectionExporter extends ProjectionPort {
  start(): Promise<void>;
  /** 追加需要导出的话题（幂等）；由 session-index 发现或显式指定。 */
  ensureTopic(topic: string): Promise<void>;
}

export function conversationTopic(sessionId: string): string {
  return `conversation/${sessionId}`;
}

export function parseConversationTopic(topic: string): string | null {
  const prefix = "conversation/";
  if (!topic.startsWith(prefix)) return null;
  const sessionId = topic.slice(prefix.length);
  return sessionId.length > 0 ? sessionId : null;
}

export function createProjectionExporter(options: ProjectionExporterOptions): ProjectionExporter {
  const walState: ProjectionWalState = createProjectionWalState(
    options.capacity ?? DEFAULT_WAL_CAPACITY,
  );
  const subscriptions = new Map<string, string>();
  const logEpochByTopic = new Map<string, string>();
  let started = false;
  let walHealthy = true;
  let frameListener: { dispose(): void } | null = null;

  function contentHashFor(frame: TopicDeliveryFrame): string {
    return createHash("sha256").update(JSON.stringify(frame)).digest("hex");
  }

  /** 交付帧 → 持久记录：payload 保留完整区间，不制造假逐事件 seq（02 §7.1）。 */
  function recordFor(frame: TopicDeliveryFrame, logEpoch: string): CloudProjectionRecord {
    const kind: CloudProjectionKind = frame.payload.kind === "snapshot" ? "snapshot" : "delta";
    return {
      schemaVersion: CLOUD_PROJECTION_SCHEMA_VERSION,
      taskId: options.taskId,
      runId: options.runId,
      runGeneration: options.runGeneration,
      runtimeIncarnation: options.runtimeIncarnation,
      topic: frame.topic,
      logEpoch,
      sourceSeq: frame.toSeq,
      kind,
      payload: {
        topic: frame.topic,
        fromSeq: frame.fromSeq,
        toSeq: frame.toSeq,
        // 原样透传 V4 帧的时间戳与负载：不解析、不改写（record 只做封装与区间记账）。
        sentAt: frame.sentAt as never,
        payload: frame.payload as never,
      },
      contentHash: contentHashFor(frame),
    };
  }

  async function persist(): Promise<void> {
    try {
      await options.walStore.save(walState.exportEntries(), walState.exportCursors());
      walHealthy = true;
    } catch (error) {
      // WAL 不可写：停新投递并如实标记（不承诺无损继续，02 §8）。
      walHealthy = false;
      options.logger.error(undefined, "projection WAL write failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      options.reportFault?.({
        code: "data_at_risk",
        message: "projection WAL is not writable",
        retryable: true,
      });
    }
  }

  async function handleFrame(frame: TopicDeliveryFrame): Promise<void> {
    if (frame.topic === options.sessionIndexTopic) {
      // 只做话题发现：会话列表不是 canonical 导出面（02 §7.4 的导出钩子是 conversation topic）。
      for (const sessionId of options.extractSessionIds(frame)) {
        await ensureTopic(conversationTopic(sessionId));
      }
      return;
    }
    const logEpoch = logEpochByTopic.get(frame.topic);
    if (!logEpoch) return;
    const outcome = walState.accept(recordFor(frame, logEpoch), frame.fromSeq);
    switch (outcome.kind) {
      case "accepted":
        await persist();
        return;
      case "duplicate":
        // ACK 丢失后的重投：幂等，不重复落盘。
        return;
      case "conflict":
        options.logger.warn(undefined, "projection conflict: same key different hash", {
          topic: frame.topic,
          logEpoch,
          sourceSeq: frame.toSeq,
        });
        options.reportFault?.({
          code: "protocol_incompatible",
          message: "projection record conflicts with persisted content",
          retryable: false,
        });
        return;
      case "capacity":
        options.reportFault?.({
          code: "quota_exceeded",
          message: "projection WAL capacity exceeded",
          retryable: false,
        });
        return;
      case "gap": {
        // 缺口不跳跃：重订一次（无 base → 运行端先发 snapshot 屏障），不跳 cursor。
        options.logger.warn(undefined, "projection gap detected; resubscribing for snapshot", {
          topic: frame.topic,
          expectedNextSeq: outcome.expectedNextSeq,
        });
        await resyncTopic(frame.topic);
        return;
      }
      default:
        return;
    }
  }

  async function resyncTopic(topic: string): Promise<void> {
    subscriptions.delete(topic);
    logEpochByTopic.delete(topic);
    await ensureTopic(topic);
  }

  async function ensureTopic(topic: string): Promise<void> {
    if (subscriptions.has(topic)) return;
    // 续传 base 必须用「已导出水位」；logEpoch 优先取内存记录，重启后从持久 WAL 水位恢复
    // （否则重连会把已导出区间重新算成缺口，02 §7.3）。
    const restored = logEpochByTopic.has(topic) ? null : walState.acceptedCursor(topic);
    const logEpoch = logEpochByTopic.get(topic) ?? restored?.logEpoch;
    const accepted = logEpoch === undefined ? null : walState.acceptedSeq(topic, logEpoch);
    const params: {
      topic: string;
      clientMode: "web-remote-replayable";
      base?: { logEpoch: string; seq: number };
    } = {
      topic,
      clientMode: "web-remote-replayable",
    };
    if (logEpoch !== undefined && accepted !== null) {
      params.base = { logEpoch, seq: accepted };
    }
    const ack = await options.source.subscribe(params);
    subscriptions.set(topic, ack.subscriptionId);
    logEpochByTopic.set(topic, ack.logEpoch);
    options.logger.info(undefined, "projection topic subscribed", {
      topic,
      mode: ack.mode,
      logEpoch: ack.logEpoch,
    });
  }

  return {
    async start() {
      if (started) return;
      const loaded = await options.walStore.load();
      walState.restore(loaded.entries, loaded.cursors);
      walHealthy = loaded.healthy;
      frameListener = options.source.onFrame((frame) => {
        void handleFrame(frame).catch((error: unknown) => {
          options.logger.error(undefined, "projection frame handling failed", {
            topic: frame.topic,
            error: error instanceof Error ? error.message : String(error),
          });
        });
      });
      started = true;
      await ensureTopic(options.sessionIndexTopic);
    },

    ensureTopic,

    async onAck(ack) {
      // 只按匹配源流的 sourceSeq 清 WAL；ingestCursor 是不透明表示，不作本地下标（02 §7.1）。
      const result = walState.ack({
        topic: ack.topic,
        logEpoch: ack.logEpoch,
        sourceSeq: ack.lastContiguousSourceSeq,
      });
      if (result.cleared > 0) {
        await persist();
      }
    },

    async drain(limit) {
      if (!walHealthy) return { capacityExceeded: true };
      const capacity = walState.capacity();
      if (capacity.exceeded) return { capacityExceeded: true };
      const bounded = Math.min(limit, CLOUD_PROJECTION_BATCH_MAX_RECORDS);
      return { records: walState.pending(bounded).map((entry) => entry.record) };
    },

    highWatermarks(): CloudStreamCursor[] {
      return walState.highWatermarks();
    },

    ready() {
      return { exporterReady: started && frameListener !== null, walReady: walHealthy };
    },

    async stop() {
      frameListener?.dispose();
      frameListener = null;
      for (const subscriptionId of subscriptions.values()) {
        await options.source.unsubscribe(subscriptionId).catch(() => undefined);
      }
      subscriptions.clear();
      logEpochByTopic.clear();
      started = false;
    },
  };
}

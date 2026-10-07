/**
 * CloudAttachmentRegistry（03 §2 模块结构、02 §2 不变量 3、§5.1 epoch 接管）。
 *
 * 控制面的 attachment 连接注册表是**内存对象、可重建、不是元数据事实源**
 * （cloud/CONTRACT.md「状态所有者」表）：持久事实在 runs/task_inputs，进程重启后
 * 由 bridge 重新 hello 接管。
 *
 * 围栏规则：
 * - 每次投递都必须按当前 ready attachment 与 runGeneration/connectionEpoch 校验，
 *   旧代际帧拒绝（02 §2 不变量 3）；
 * - 同 socket 重复 hello 不递增 epoch；新 socket 接管由数据库 CAS 递增（02 §5.1），
 *   本注册表只记录「哪条连接当前有效」；
 * - heartbeat 只证明连接可见，不证明业务活跃，也不写 lastBusinessActivityAt（08 §7）。
 */
import type { CloudAttachmentAddress } from "@zcode/shared";

export interface AttachmentSession {
  taskId: string;
  runId: string;
  runGeneration: number;
  connectionEpoch: number;
  address: CloudAttachmentAddress;
  /** ready 门控后才允许首命令（02 §5.3）。 */
  ready: boolean;
  runtimeIncarnation?: string;
  runtimeSessionId?: string;
  connectedAt: number;
  lastHeartbeatAt?: number;
  lastActivitySummary?: string;
  /** 已下发 bootstrap 配置的 epoch（= connectionEpoch 时才算已发）。 */
  bootstrapConfigSentForEpoch?: number;
  bootstrapConfigSentAt?: number;
}

export type AttachmentResolution =
  | { status: "ok"; session: AttachmentSession }
  | { status: "no-attachment" }
  | { status: "stale" }
  | { status: "not-ready" };

export interface AttachmentRegistry {
  /** 新 socket 接管：同一 run 只保留一条有效 session。 */
  register(session: AttachmentSession): AttachmentSession;
  /**
   * `bootstrap.config` 已在该 epoch 发出（02 §5.3：run 配置/envelope 安装是 ready 前置）。
   * 这是可重建的连接态事实，不是元数据事实源。
   */
  markBootstrapConfigSent(input: {
    runId: string;
    runGeneration: number;
    connectionEpoch: number;
    at: number;
  }): boolean;
  /** 该 run/epoch 是否已下发过 bootstrap 配置（ready 门控用）。 */
  bootstrapConfigSent(input: {
    runId: string;
    runGeneration: number;
    connectionEpoch: number;
  }): boolean;
  markReady(input: {
    runId: string;
    runGeneration: number;
    connectionEpoch: number;
    runtimeIncarnation?: string;
    runtimeSessionId?: string;
    at: number;
  }): boolean;
  heartbeat(input: {
    runId: string;
    runGeneration: number;
    connectionEpoch: number;
    at: number;
    activitySummary?: string;
  }): boolean;
  detach(input: { runId: string; at: number; reason: string }): AttachmentSession | null;
  /** 投递前解析：generation 精确匹配、epoch 不落后、ready 为真。 */
  resolve(input: {
    runId: string;
    runGeneration: number;
    connectionEpoch?: number;
    requireReady?: boolean;
  }): AttachmentResolution;
  current(runId: string): AttachmentSession | null;
  list(): AttachmentSession[];
  /** 心跳缺失候选（看门狗用，不在此判定 run 终态）。 */
  listHeartbeatExpired(now: number, timeoutMs: number): AttachmentSession[];
}

export function createAttachmentRegistry(): AttachmentRegistry {
  const sessions = new Map<string, AttachmentSession>();

  return {
    markBootstrapConfigSent(input) {
      const session = sessions.get(input.runId);
      if (!session) return false;
      if (session.runGeneration !== input.runGeneration) return false;
      if (session.connectionEpoch !== input.connectionEpoch) return false;
      session.bootstrapConfigSentForEpoch = input.connectionEpoch;
      session.bootstrapConfigSentAt = input.at;
      return true;
    },

    bootstrapConfigSent(input) {
      const session = sessions.get(input.runId);
      if (!session) return false;
      if (session.runGeneration !== input.runGeneration) return false;
      if (session.connectionEpoch !== input.connectionEpoch) return false;
      return session.bootstrapConfigSentForEpoch === input.connectionEpoch;
    },

    register(session) {
      const existing = sessions.get(session.runId);
      // 旧 epoch 不得继续投递或发布在线状态（02 §2 不变量 3）：只在 epoch 不落后时接管。
      if (existing && session.connectionEpoch < existing.connectionEpoch) return existing;
      sessions.set(session.runId, session);
      return session;
    },

    markReady(input) {
      const session = sessions.get(input.runId);
      if (!session) return false;
      if (session.runGeneration !== input.runGeneration) return false;
      if (session.connectionEpoch !== input.connectionEpoch) return false;
      session.ready = true;
      if (input.runtimeIncarnation) session.runtimeIncarnation = input.runtimeIncarnation;
      if (input.runtimeSessionId) session.runtimeSessionId = input.runtimeSessionId;
      return true;
    },

    heartbeat(input) {
      const session = sessions.get(input.runId);
      if (!session) return false;
      if (session.runGeneration !== input.runGeneration) return false;
      // 旧 epoch 的心跳不刷新当前 session（否则旧 socket 能延长自己寿命）。
      if (session.connectionEpoch !== input.connectionEpoch) return false;
      session.lastHeartbeatAt = input.at;
      if (input.activitySummary) session.lastActivitySummary = input.activitySummary;
      return true;
    },

    detach(input) {
      const session = sessions.get(input.runId);
      if (!session) return null;
      sessions.delete(input.runId);
      return session;
    },

    resolve(input) {
      const session = sessions.get(input.runId);
      if (!session) return { status: "no-attachment" };
      if (session.runGeneration !== input.runGeneration) return { status: "stale" };
      if (
        input.connectionEpoch !== undefined &&
        session.connectionEpoch !== input.connectionEpoch
      ) {
        return { status: "stale" };
      }
      if ((input.requireReady ?? true) && !session.ready) return { status: "not-ready" };
      return { status: "ok", session };
    },

    current(runId) {
      return sessions.get(runId) ?? null;
    },

    list() {
      return [...sessions.values()];
    },

    listHeartbeatExpired(now, timeoutMs) {
      return [...sessions.values()].filter(
        (session) =>
          session.lastHeartbeatAt !== undefined && now - session.lastHeartbeatAt >= timeoutMs,
      );
    },
  };
}

/** 由地址构造 session（bridge.hello 接管时使用；直接复用 shared 的地址形状）。 */
export function sessionFromAddress(input: {
  address: CloudAttachmentAddress;
  at: number;
}): AttachmentSession {
  return {
    taskId: input.address.taskId,
    runId: input.address.runId,
    runGeneration: input.address.runGeneration,
    connectionEpoch: input.address.connectionEpoch,
    address: input.address,
    // welcome 只证明认证；ready 由 bridge.ready 门控后置位（02 §5.3）。
    ready: false,
    connectedAt: input.at,
  };
}

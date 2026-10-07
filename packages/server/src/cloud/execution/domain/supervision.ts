/**
 * 进程监督分类与重连预算（specs/cloud-agent/02 §3/§8 故障表、07 §2.7/§10，W6 §5 边界）。
 *
 * 三条沙箱专用机制只允许归因到：传输、生命周期、无人值守恢复。本文件把「断开之后
 * 能不能碰 runtime」收敛成一张判定表，任何网络原因都不得升级为「给 zcode-server 写
 * stdin EOF / 销毁唯一 stdio 管道」（02 §2 不变量 7、§3）。
 */

export type DisconnectReason =
  | "socket-close"
  | "socket-error"
  | "welcome-timeout"
  | "heartbeat-missing"
  /** 控制面显式拒绝（鉴权/代际/协议）：仍是网络侧事实，不因此杀 runtime。 */
  | "auth-rejected"
  | "protocol-error"
  /** 本地 runtime 进程退出：真实退出诊断，不能宣称换网络连接即可恢复。 */
  | "runtime-exit"
  /** Bridge 自身异常：v1 不承诺重新接管原 stdio 子进程（02 §3）。 */
  | "bridge-crash";

export interface DisconnectPolicy {
  /** 释放网络 facade（heartbeat/订阅/relay 会话），保留 stdio/runtime/WAL。 */
  releaseNetworkFacade: boolean;
  /** 是否允许触碰本地 stdio 管道（网络原因一律 false）。 */
  touchLocalStdio: boolean;
  /** 是否重启 runtime。 */
  restartRuntime: boolean;
  /** 是否自动重连。 */
  reconnect: boolean;
  /** 是否上报 run 级 terminal fault（只有真实执行节点退出才是终态证据）。 */
  reportTerminal: boolean;
}

const NETWORK_REASONS: readonly DisconnectReason[] = [
  "socket-close",
  "socket-error",
  "welcome-timeout",
  "heartbeat-missing",
  "auth-rejected",
  "protocol-error",
];

/**
 * 分类处置：网络原因 = 只释放网络 facade + 退避重连；runtime 退出 = 真实退出；
 * bridge 崩溃 = 交给 provider 监督核验进程树（不在本进程内盲目 spawn 第二套）。
 */
export function classifyDisconnect(reason: DisconnectReason): DisconnectPolicy {
  if (NETWORK_REASONS.includes(reason)) {
    return {
      releaseNetworkFacade: true,
      touchLocalStdio: false,
      restartRuntime: false,
      reconnect: true,
      reportTerminal: false,
    };
  }
  if (reason === "runtime-exit") {
    return {
      releaseNetworkFacade: true,
      touchLocalStdio: true,
      restartRuntime: false,
      reconnect: true,
      reportTerminal: true,
    };
  }
  return {
    releaseNetworkFacade: true,
    touchLocalStdio: false,
    restartRuntime: false,
    reconnect: false,
    reportTerminal: true,
  };
}

/** 心跳周期（02 §8 实施数值：心跳可取 30s）。 */
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** 退避上限（02 §8：退避上限 60s），timer 只触发探测/恢复，不证明死亡。 */
export const MAX_RECONNECT_DELAY_MS = 60_000;

const BASE_RECONNECT_DELAY_MS = 1_000;

/**
 * 有界指数退避 + jitter。`jitter` 取值 [0,1)（调用方注入随机源，测试可固定）。
 * 1s, 2s, 4s, 8s, 16s, 32s, 60s(封顶)，再加 0..25% 抖动。
 */
export function nextReconnectDelayMs(attempt: number, jitter: number): number {
  const exponent = Math.max(0, Math.min(attempt, 6));
  const base = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** exponent, MAX_RECONNECT_DELAY_MS);
  const boundedJitter = Math.min(Math.max(jitter, 0), 0.999);
  return Math.round(base * (1 + 0.25 * boundedJitter));
}

/**
 * 断网时长是否已越过「Run 不得自动 expired」的判定线（02 §11 B-02：断网 >2 分钟）。
 * 本函数只回答「是否超过阈值」，不裁决 Run 状态——Run 状态所有权在控制面（03 §2）。
 */
export const OFFLINE_EXPIRY_GUARD_MS = 120_000;

export function offlineBeyondGuard(offlineSinceMs: number, nowMs: number): boolean {
  return nowMs - offlineSinceMs > OFFLINE_EXPIRY_GUARD_MS;
}

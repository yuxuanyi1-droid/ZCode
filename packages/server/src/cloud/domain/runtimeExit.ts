/**
 * runtime 进程退出事实的消费判定（D4-2 恢复阶梯中间步；specs/cloud-agent/02 §3/§8）。
 *
 * 背景：supervision.ts 的 runtime-exit 分类在 bridge 侧是死代码——runtime 进程退出
 * 的事实（心跳 `processAlive=false`，02 §4）生产后无人消费；控制面无法区分「断网」
 * 与「runtime 死了」，后续恢复决策（重拉 supervisor 属第 2 批之后）没有依据。
 *
 * 本中间步只把**事实**落到连接与 run，不做恢复动作：
 * - bridge.heartbeat 是 v1 唯一的事实通道（02 定稿「不加新帧」，显式退出帧不存在）；
 * - 控制面连续 N 拍 `processAlive=false` 即确认 runtime 退出事实并告警；
 * - 该连接最终关闭时按 runtime-exit 语义标注 run（经 `markDisconnected` 落到
 *   run.endReason——run 记录上最后一次断连原因的持久标注，即 lastDisconnectReason），
 *   与「bridge-socket-closed」这类网络断开区分开。
 */

/** run 上最后一次断连原因的 runtime-exit 标注值（与 supervision.ts 的分类名对齐）。 */
export const RUNTIME_EXIT_DISCONNECT_REASON = "runtime-exit" as const;

/** 网络侧断开的既有标注值（bridgeChannel 关闭路径的缺省）。 */
export const SOCKET_CLOSE_DISCONNECT_REASON = "bridge-socket-closed" as const;

/**
 * 连续多少拍 `processAlive=false` 判定 runtime 已退出。心跳周期 30s（02 §8），
 * 两连报 ≈60s：跨过一次正常暂停/退避的余量，又不至于把真实退出拖到硬期限。
 */
export const RUNTIME_EXIT_DEAD_STREAK_LIMIT = 2 as const;

/** 纯判定：消费一拍心跳后的连续死亡计数（processAlive 恢复 true 即清零）。 */
export function nextRuntimeDeadStreak(input: {
  processAlive: boolean;
  currentStreak: number;
}): number {
  return input.processAlive ? 0 : input.currentStreak + 1;
}

/** 纯判定：连续死亡计数是否已达确认线。 */
export function runtimeExitConfirmed(streak: number): boolean {
  return streak >= RUNTIME_EXIT_DEAD_STREAK_LIMIT;
}

/**
 * 连接关闭时的断连语义归类（D4-2）：连接生命周期内确认过 runtime 退出事实的，
 * 按 runtime-exit 标注；其余维持网络侧的「socket 关闭」。不做恢复决策（那是
 * 第 2 批之后的事），只让 run 上的事实可区分。
 */
export function bridgeCloseDisconnectReason(input: { runtimeExitConfirmed: boolean }): string {
  return input.runtimeExitConfirmed
    ? RUNTIME_EXIT_DISCONNECT_REASON
    : SOCKET_CLOSE_DISCONNECT_REASON;
}

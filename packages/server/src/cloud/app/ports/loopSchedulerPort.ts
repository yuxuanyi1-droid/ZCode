/**
 * 生命周期循环的调度端口（03 §8 启动/关闭顺序、§9 背压；W1 §4 `startCloudLifecycleLoops`）。
 *
 * app 的循环体是纯编排（探测/恢复/对账），「定时器」是 adapter 关注点：由 W5 注入
 * 真实调度器（setInterval + jitter），测试注入手动调度器逐拍驱动，
 * 不用真实 sleep 等状态（10 §5）。
 *
 * 约定：同一循环的两次 tick 不重叠（实现方在上一拍未结束时跳过本拍），
 * 且 tick 抛错不得终止后续调度。
 */
export interface LoopSchedulerPort {
  /** 注册周期任务并返回取消函数；`stop()` 后不再触发新 tick。 */
  schedule(intervalMs: number, task: () => Promise<void>): () => void;
  /** 单次延迟触发（启动对账等一次性动作）。 */
  delay(delayMs: number, task: () => Promise<void>): () => void;
}

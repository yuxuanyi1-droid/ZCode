/**
 * 浏览器观看事实端口（08 §7「闲置且无客户端连接 → pause」的连接事实源）。
 *
 * 修复依据（2026-10-07 复核缺陷 1）：空闲 pause 的「有客户端连接」判定曾错接
 * `AttachmentRegistry.current(runId)`——该注册表只登记 bridge ws（沙箱监管 socket），
 * 沙箱存活期间 bridge 永远在线，导致空闲 pause 永不触发。08 §7 的语义是
 * 「无**浏览器客户端**观看连接」：浏览器经 `/ws/cloud/tasks/:taskId` 打开的 rpc 流
 * （每条浏览器连接恰对应一条流，adapters/ws/browserStreams.ts 的多路复用器是唯一
 * 登记点）。事实由实现（bridge 通道）注入，app 层只消费；连接关闭即清，不持久。
 */
export interface BrowserWatchPort {
  /** 该 run 当前是否存在打开的浏览器观看连接（任务通道 rpc 流）。 */
  hasWatcher(runId: string): boolean;
}

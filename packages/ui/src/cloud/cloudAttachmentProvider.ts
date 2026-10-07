/**
 * 当前 Run attachment 的提供方（specs/cloud-agent/04 §3.0.1、07 §9、03 §7.1）。
 *
 * 这是 UI 与 attachment 传输之间的**唯一接缝**：W9 用
 * `createCloudClient({ origin, token, taskId }).attach` 实现它（SDK 已提供
 * connect/close/onDidChangeState 与 ChannelClient 语义），UI 不 import SDK。
 *
 * 语义约束（04 §3.0.1）：
 * - 浏览器只 attach，**不 autoSend**；打开订阅不等于投递输入。
 * - 断连只释放网络订阅，**不停止沙箱内 stdio owner**：因此 `close` 只做本地释放。
 * - 没有 ready run 时 `open` 返回 null（而不是造一个空 channel）。
 */
import type { CloudAttachmentAccessor } from "./cloudBrowserServices.js";

export interface CloudAttachmentProvider {
  /**
   * 为任务建立 attachment。返回 `null` 表示当前没有可 attach 的 run
   * （例如仍处于 provisioning），这不是错误，执行域保持 unavailable。
   */
  open(taskId: string): Promise<CloudAttachmentAccessor | null>;
  /** 本地释放：离开任务 / 关页；不发送任何停止沙箱的指令。 */
  close(taskId: string): void;
  /** 连接状态变化（重连成功/断开）；控制器据此重新评估执行域。 */
  onDidChange?(listener: () => void): () => void;
}

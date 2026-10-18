/**
 * 控制面回执的语义辅助（specs/cloud-agent 03 §6.2、02 §6.3）。
 *
 * 单独成文件的原因：`cloudControlPlaneClient.ts` 已接近 max-lines 门禁；这些函数
 * 只解释 receipt 状态，不依赖传输，SDK 与既有调用方经 client 公开入口使用同一份实现。
 */
import type { CloudInteractionDecisionReceipt, InputReceipt } from "@zcode/shared";

/**
 * 输入提交结果：`httpStatus` 是 HTTP 事实（202 = 控制面已持久接收），
 * `receipt` 是权威投递投影（`deliveryStatus` 才是语义）。二者都不是 runtime ACK。
 */
export interface CloudInputSubmission {
  readonly httpStatus: number;
  readonly receipt: InputReceipt;
}

/**
 * 交互决定提交结果：`httpStatus` 只是 HTTP 事实（202 = 控制面持久接纳），
 * `receipt.deliveryStatus` 才是投递语义；二者都不是 runtime CommandAck（03 §7.2）。
 */
export interface CloudInteractionDecisionSubmission {
  readonly httpStatus: number;
  readonly receipt: CloudInteractionDecisionReceipt;
}

/**
 * runtime 是否已准入该命令（02 §6.2）：控制面投递投影为 `admitted`，或 runtime 自己的
 * CommandAck 已返回 accepted/duplicate。`deliveryStatus="accepted"` 只表示控制面持久接收，
 * 不能被当成 runtime ACK（03 §6.2）。
 */
export function isRuntimeAdmitted(receipt: InputReceipt): boolean {
  if (receipt.deliveryStatus === "admitted") return true;
  const status = receipt.runtimeAck?.status;
  return status === "accepted" || status === "duplicate";
}

/** 仍需要对账的投递状态：accepted/delivering 未确认，uncertain 必须先查询再决定（02 §6.3）。 */
export function isRuntimeAckPending(receipt: InputReceipt): boolean {
  return (
    receipt.deliveryStatus === "accepted" ||
    receipt.deliveryStatus === "delivering" ||
    receipt.deliveryStatus === "uncertain"
  );
}

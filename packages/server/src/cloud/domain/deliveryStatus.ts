/**
 * 投递状态机的单向推进规则（specs/cloud-agent 02 §6.3 ACK 丢失与执行节点退出、
 * 03 §6.2 投递与响应）。
 *
 * 这是投递状态机的**唯一**边表：app 层（`deliveryControl`、决定投递/取消命令）、
 * 测试 fake 与真实 SQLite 仓储（`InputRepo.markDelivery`、
 * `InteractionDecisionRepo.setDecisionDeliveryStatus`）共用同一份。
 * 曾经 storage 侧存在第二份边表且边集不一致（accepted 缺 admitted/uncertain、
 * uncertain 缺 accepted/cancelled），导致 app 层按本表写入的合法迁移在真实
 * 存储上被 CAS 拒绝后静默丢弃；修复即统一到本表（02 §6.3 为准）。
 *
 * 同一套口径同时约束正文输入（`InputRepo.markDelivery`）与交互决定
 * （`InteractionDecisionRepo.setDecisionDeliveryStatus`）：
 * - 只允许状态机内的前进；终态（admitted/rejected/cancelled）不再改变；
 * - `accepted → admitted/rejected` 是合法推进：runtime 的 ACK 可能快于控制面的
 *   `delivering` 写入，ACK 是权威结论，不能被「中间态还没写」挡掉；
 * - `uncertain` 是**待对账**状态：允许退回 `accepted`（对账确认未到达后由
 *   dispatcher 重投，02 §6.3），也允许对账后落 `admitted/rejected/cancelled`。
 */
import type { InputDeliveryStatus } from "@zcode/shared";

export const INPUT_DELIVERY_TRANSITIONS: Readonly<
  Record<InputDeliveryStatus, readonly InputDeliveryStatus[]>
> = {
  accepted: ["delivering", "admitted", "rejected", "uncertain", "cancelled"],
  delivering: ["admitted", "rejected", "uncertain"],
  // uncertain → delivering：对账确认未到达后，用同一 commandId 直接重投（02 §6.3
  // 「unknown 且确认同 Run/runtime 可安全去重才重发原信封」）；uncertain → cancelled：
  // 已投递但 ACK 未知的取消先对账，对账确认 runtime 无该命令事实后落 cancelled（CP-14）。
  uncertain: ["accepted", "delivering", "admitted", "rejected", "cancelled"],
  admitted: [],
  rejected: [],
  cancelled: [],
};

export function canAdvanceDeliveryStatus(
  from: InputDeliveryStatus,
  to: InputDeliveryStatus,
): boolean {
  if (from === to) return true;
  return INPUT_DELIVERY_TRANSITIONS[from].includes(to);
}

/**
 * 输入占用事实（08 §7 修订 2026-10-09 生命周期 v2 审计第一批，domain 唯一谓词）：
 * `accepted | delivering | uncertain` 都算「工作面仍有待完成输入」——uncertain 可能
 * 已在沙箱执行（结果未知待对账，03 §8），delivering 是投递在途。三个消费方共用本
 * 谓词保证同一口径（08 §7「保守口径，多处同改」的单一实现）：
 * - paused 自驱 resume 的触发判定（03 §6 修订：非 accepted 态也构成用户等待意图）；
 * - 空闲 pause 拍的 pendingInputCount（有占用事实不 pause）；
 * - idle drain 的 pendingInputCount（有占用事实不归档）。
 * 只数 accepted 会让带 uncertain/delivering 输入的 run 被空闲暂停且无法自驱恢复。
 */
export function occupiesWorkspaceByInput(status: InputDeliveryStatus): boolean {
  return status === "accepted" || status === "delivering" || status === "uncertain";
}

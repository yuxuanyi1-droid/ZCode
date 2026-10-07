/**
 * 投递状态机的单向推进规则（specs/cloud-agent 02 §6.3 ACK 丢失与执行节点退出、
 * 03 §6.2 投递与响应）。
 *
 * 同一套口径同时约束正文输入（`InputRepo.markDelivery`）与交互决定
 * （`InteractionDecisionRepo.setDecisionDeliveryStatus`）：
 * - 只允许状态机内的前进；终态（admitted/rejected/cancelled）不再改变；
 * - `uncertain` 是**待对账**状态：允许退回 `accepted` 重投同 commandId（02 §6.3），
 *   也允许对账后落 `admitted/rejected/cancelled`；
 * - `accepted → admitted/rejected` 是合法推进：runtime 的 ACK 可能快于控制面的
 *   `delivering` 写入，ACK 是权威结论，不能被「中间态还没写」挡掉。
 */
import type { InputDeliveryStatus } from "@zcode/shared";

export const INPUT_DELIVERY_TRANSITIONS: Readonly<
  Record<InputDeliveryStatus, readonly InputDeliveryStatus[]>
> = {
  accepted: ["delivering", "admitted", "rejected", "uncertain", "cancelled"],
  delivering: ["admitted", "rejected", "uncertain"],
  uncertain: ["accepted", "admitted", "rejected", "cancelled"],
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

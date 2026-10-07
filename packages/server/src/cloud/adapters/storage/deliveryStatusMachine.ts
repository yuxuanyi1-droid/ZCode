/**
 * 投递状态机（02 §6.1/§6.3、03 §6.2）：正文输入与交互决定共用同一状态词表与前进规则。
 *
 * 独立成文件的原因：这是两个 repository 的共享规则，放在任一侧都会让另一侧反向
 * 依赖实现文件（并可能成环）；也便于测试直接对照状态表。
 */
import type { InputDeliveryStatus } from "@zcode/shared";

/**
 * 允许的投递状态迁移（02 §6.1/§6.3、03 §6.2）。
 * - accepted → rejected：确定未投递的环境准备失败收口；
 * - delivering → uncertain：已发出但结果未知，只能对账，不能报 cancelled；
 * - uncertain → delivering：查明确未到达后才能用同 commandId 重投。
 */
export const DELIVERY_TRANSITIONS: Readonly<
  Record<InputDeliveryStatus, readonly InputDeliveryStatus[]>
> = {
  accepted: ["delivering", "rejected", "cancelled"],
  delivering: ["admitted", "rejected", "uncertain"],
  uncertain: ["delivering", "admitted", "rejected"],
  admitted: [],
  rejected: [],
  cancelled: [],
};

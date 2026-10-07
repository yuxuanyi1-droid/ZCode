/**
 * 契约用法示例：bridge 侧判定一条入站控制帧是否可处理。
 * 只依赖公开契约（shared 的帧 schema + 方向表），不含 WSS/stdio 实现细节（02 §4）。
 */
import { CLOUD_BRIDGE_FRAME_DIRECTIONS } from "@zcode/shared";
import {
  cloudBridgeControlFrameSchema,
  isCloudBridgeFrameInboundAllowed,
  type CloudBridgeControlFrame,
  type CloudBridgeFrameType,
} from "./contract.js";

export type InboundFrameDecision<Frame> =
  | { action: "accept"; frame: Frame }
  | { action: "reject"; reason: "schema" | "unknown-type" | "wrong-direction" };

export function decodeInboundBridgeFrame(
  raw: unknown,
): InboundFrameDecision<CloudBridgeControlFrame> {
  const parsed = cloudBridgeControlFrameSchema.safeParse(raw);
  if (!parsed.success) {
    // 未知版本、未知字段或未知帧类型都属于整帧拒绝，不做字段猜测（02 §4 尾段）。
    const source =
      typeof raw === "object" && raw !== null ? (raw as { type?: unknown }).type : null;
    const known = typeof source === "string" && isKnownFrameType(source);
    return { action: "reject", reason: known ? "schema" : "unknown-type" };
  }
  if (!isCloudBridgeFrameInboundAllowed(parsed.data.type, "bridge")) {
    return { action: "reject", reason: "wrong-direction" };
  }
  return { action: "accept", frame: parsed.data };
}

/** 帧型集合的唯一来源是 shared 的方向表，示例不复制一份帧清单。 */
function isKnownFrameType(type: string): type is CloudBridgeFrameType {
  return Object.hasOwn(CLOUD_BRIDGE_FRAME_DIRECTIONS, type);
}

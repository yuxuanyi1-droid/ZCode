/**
 * Bridge 帧编解码与方向校验（specs/cloud-agent/02 §4 帧表与尾段、§9 安全）。
 *
 * wire 形状唯一事实源是 `@zcode/shared` 的 cloud 公开入口；本文件只做：
 * 1. 有界文本帧的严格解析（未知版本/未知字段/尺寸越界整帧拒绝，fail-closed）；
 * 2. 方向校验（收到本方向之外的帧即整条连接作废，不能只忽略单帧）；
 * 3. 路由判别（控制帧 vs RPC 帧），供会话把两类帧分别交给对应处理方。
 */
import {
  CLOUD_RPC_PAYLOAD_MAX_BASE64_CHARS,
  cloudBridgeControlFrameSchema,
  cloudRpcFrameSchema,
  isCloudBridgeFrameInboundAllowed,
  isCloudRpcFrameInboundAllowed,
  type CloudBridgeControlFrame,
  type CloudRpcFrame,
} from "@zcode/shared";

/** 单条控制帧的文本上限：投影 payload 512 KiB + 帧头余量（02 §8 有界批次）。 */
export const BRIDGE_CONTROL_FRAME_MAX_CHARS = 1024 * 1024;
/** 单条 RPC 帧上限与 shared 冻结的 base64 上界同源（4 MiB 原始字节）。 */
export const BRIDGE_RPC_FRAME_MAX_CHARS = CLOUD_RPC_PAYLOAD_MAX_BASE64_CHARS + 1024;

export type BridgeInboundFrame =
  | { kind: "control"; frame: CloudBridgeControlFrame }
  | { kind: "rpc"; frame: CloudRpcFrame };

export type BridgeDecodeResult =
  | { ok: true; value: BridgeInboundFrame }
  | { ok: false; reason: "oversized" | "not-json" | "invalid-frame" | "wrong-direction" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 解析一条入站文本帧。`maxChars` 由调用方按已知帧类型给出；未知类型走控制帧上限。
 */
export function decodeBridgeFrame(
  text: string,
  receiver: "control-plane" | "bridge",
): BridgeDecodeResult {
  if (text.length > BRIDGE_RPC_FRAME_MAX_CHARS) {
    return { ok: false, reason: "oversized" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (!isRecord(raw) || typeof raw.type !== "string") {
    return { ok: false, reason: "invalid-frame" };
  }
  if (raw.type.startsWith("rpc.")) {
    if (text.length > BRIDGE_RPC_FRAME_MAX_CHARS) return { ok: false, reason: "oversized" };
    const parsed = cloudRpcFrameSchema.safeParse(raw);
    if (!parsed.success) return { ok: false, reason: "invalid-frame" };
    if (!isCloudRpcFrameInboundAllowed(parsed.data.type, receiver)) {
      return { ok: false, reason: "wrong-direction" };
    }
    return { ok: true, value: { kind: "rpc", frame: parsed.data } };
  }
  if (text.length > BRIDGE_CONTROL_FRAME_MAX_CHARS) {
    return { ok: false, reason: "oversized" };
  }
  const parsed = cloudBridgeControlFrameSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: "invalid-frame" };
  if (!isCloudBridgeFrameInboundAllowed(parsed.data.type, receiver)) {
    return { ok: false, reason: "wrong-direction" };
  }
  return { ok: true, value: { kind: "control", frame: parsed.data } };
}

/** 出站编码：控制帧与 RPC 帧共用同一 JSON 文本通道（不额外分包，帧自带判别字段）。 */
export function encodeBridgeFrame(frame: CloudBridgeControlFrame | CloudRpcFrame): string {
  return JSON.stringify(frame);
}

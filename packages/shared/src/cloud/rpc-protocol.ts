/**
 * Cloud RPC 帧契约（specs/cloud-agent 02 §0「原 Web UI 的受控 RPC 承载」、§4 尾段；
 * 14 §4.2 `serviceScope` 分面）。
 *
 * 复用既有 Channel RPC 的序列化、事件与取消，不另建文件/Git/终端业务协议：
 * 控制面只转发已鉴权浏览器 streamId 的有界字节（`client` scope），并可用**同一套**帧
 * 以 `control-plane` scope 调用沙箱 runtime 的既有 sync 服务（连接期用户资源同步，
 * 14 §4.1/§4.2）；每条 rpc 会话在每一帧上验证当前 ready attachment，旧代际帧拒绝
 * （02 §2 不变量 3）。浏览器用原 ChannelClient，沙箱用常驻 stdio client 组成
 * ChannelServer，不重启 runtime。
 */
import { z } from "zod";
import { cloudUuidSchema } from "./identity.js";

export const CLOUD_RPC_PROTOCOL_VERSION = 1 as const;

export const cloudRpcProtocolVersionSchema = z.literal(CLOUD_RPC_PROTOCOL_VERSION);

/** 单帧 RPC 字节上限（未压缩），与 PersistentProtocol 的未确认缓冲预算同量级（02 §8）。 */
export const CLOUD_RPC_PAYLOAD_MAX_BYTES = 4 * 1024 * 1024;

/** base64 编码后的字符上限：保证解码后不超过 CLOUD_RPC_PAYLOAD_MAX_BYTES。 */
export const CLOUD_RPC_PAYLOAD_MAX_BASE64_CHARS = Math.ceil(CLOUD_RPC_PAYLOAD_MAX_BYTES / 3) * 4;

/**
 * 规范 base64 的线性校验（长度/字符集/padding 位置）。
 * 不用整体正则：多 MiB payload 上的分组正则会把栈打爆（W0 实测
 * `Maximum call stack size exceeded`），RPC 帧必须能承载满额负载。
 */
function isCanonicalBase64(value: string): boolean {
  if (value.length < 4 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bodyEnd = value.length - padding;
  for (let index = 0; index < bodyEnd; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!allowed) return false;
  }
  for (let index = bodyEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

const base64PayloadSchema = z
  .string()
  .max(CLOUD_RPC_PAYLOAD_MAX_BASE64_CHARS)
  .refine(isCanonicalBase64, "payload must be canonical base64");

const rpcAddress = {
  protocolVersion: cloudRpcProtocolVersionSchema,
  /** 当前 Run 路由键；控制面按它解析当前有效 attachment。 */
  runId: cloudUuidSchema,
  runGeneration: z.number().int().positive(),
  connectionEpoch: z.number().int().positive(),
  /** 已鉴权浏览器的 ChannelClient stream 键：控制面据此回投 rpc.response。 */
  streamId: cloudUuidSchema,
};

/**
 * rpc 会话的发起方分面（14 §4.2，A 批冻结）。**唯一构造方是控制面**：浏览器字节只作为
 * 有界 payload 被包装，不能在帧里自报 scope——因此控制面为浏览器流固定写 `"client"`。
 *
 * - `client`：已鉴权浏览器（`CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`，现状不变）；
 * - `control-plane`：控制面自身发起的用户资源同步会话（`CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST`）。
 *
 * 两份白名单不得混用；denylist `CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS` 对两面生效。
 */
export const cloudRpcServiceScopeSchema = z.enum(["client", "control-plane"]);
export type CloudRpcServiceScope = z.infer<typeof cloudRpcServiceScopeSchema>;

/** 帧全集；每帧校验地址代际与尺寸后才路由。 */
export const cloudRpcFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("rpc.open"),
      ...rpcAddress,
      serviceScope: cloudRpcServiceScopeSchema,
    })
    .strict(),
  z.object({ type: z.literal("rpc.close"), ...rpcAddress }).strict(),
  z
    .object({
      type: z.literal("rpc.request"),
      ...rpcAddress,
      payload: base64PayloadSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("rpc.response"),
      ...rpcAddress,
      payload: base64PayloadSchema,
    })
    .strict(),
]);
export type CloudRpcFrame = z.infer<typeof cloudRpcFrameSchema>;
export type CloudRpcFrameType = CloudRpcFrame["type"];

/**
 * 帧方向（相对沙箱 attachment）：open/request 由浏览器经控制面转发，
 * response 由沙箱回投，close 两侧都可能发起。反向帧必须拒绝（02 §0）。
 */
export type CloudRpcFrameDirection = "control-plane-to-bridge" | "bridge-to-control-plane" | "both";

export const CLOUD_RPC_FRAME_DIRECTIONS: Readonly<
  Record<CloudRpcFrameType, CloudRpcFrameDirection>
> = {
  "rpc.open": "control-plane-to-bridge",
  "rpc.request": "control-plane-to-bridge",
  "rpc.response": "bridge-to-control-plane",
  "rpc.close": "both",
};

export function isCloudRpcFrameInboundAllowed(
  type: CloudRpcFrameType,
  receiver: "control-plane" | "bridge",
): boolean {
  const direction = CLOUD_RPC_FRAME_DIRECTIONS[type];
  if (direction === "both") return true;
  return receiver === "control-plane"
    ? direction === "bridge-to-control-plane"
    : direction === "control-plane-to-bridge";
}

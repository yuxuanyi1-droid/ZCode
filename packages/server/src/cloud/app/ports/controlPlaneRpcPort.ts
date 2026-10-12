/**
 * 控制面 RPC 会话端口（M8 连接期同步；specs/cloud-agent 14 §4.2/§4.6）。
 *
 * 用户资源同步 = 控制面经 bridge 认证通道用 `rpc.*` 帧（`serviceScope: "control-plane"`）
 * 调用沙箱 runtime 的**既有** sync 服务（14 §4.1）——本端口只描述「在某个 Run 的当前
 * ready 连接上做一次通道调用」。帧编码、streamId 分配、逐帧连接代际围栏都在
 * adapters/ws 的实现里（`controlPlaneRpcChannel.ts`），app 层只消费调用结论。
 *
 * 语义纪律：
 * - 未接线（测试/嵌入装配）→ `not-wired`：同步整体结构化失败，不伪装成功；
 * - 无有效连接/未 ready/旧代际 → `no-attachment`/`not-ready`/`stale`，外层按条目记 failed
 *   （不重试；恢复手段 = 连接态手动同步或下次连接自动同步，14 §4.6）；
 * - 超时/断连 → `closed`（结论未知，绝不伪装成功）。
 */
export type ControlPlaneRpcFailureReason =
  | "not-wired"
  | "channel-denied"
  | "no-attachment"
  | "not-ready"
  | "stale"
  | "closed";

export type ControlPlaneRpcCallResult =
  | { status: "ok"; result: unknown }
  | { status: "failed"; reason: ControlPlaneRpcFailureReason; message: string };

export interface ControlPlaneRpcCallRequest {
  runId: string;
  runGeneration: number;
  connectionEpoch: number;
  /** 沙箱服务通道名（`ServiceChannels` 的既有值；白名单预检在 app 层）。 */
  channel: string;
  method: string;
  /** 通道调用的**参数数组**（Channel 调用约定：`call(method, args)`）。 */
  args: readonly unknown[];
}

export interface ControlPlaneRpcPort {
  /**
   * 一次通道调用；同一 Run 的同步序列由调用方（`profileSyncService`）串行化，
   * 因此实现只需保证「同 Run 单流顺序调用」（14 §4.2 调用序列化）。
   */
  call(request: ControlPlaneRpcCallRequest): Promise<ControlPlaneRpcCallResult>;
}

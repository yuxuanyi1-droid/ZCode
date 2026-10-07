/**
 * runtime 命令事实查询端口（03 §7.2：`queryConversationCommandsV4` 与 cloud receipt
 * 一起用于对账；命令发送超时先查询 commandId，不能生成新 ID 重试。02 §6.3：
 * RPC timeout/断连不是 runtime rejected，先置 uncertain 再查同 command key）。
 *
 * W0 只冻结了 `AttachmentSendResult`（投递结论），没有查询面；ACK 丢失对账与
 * CP-06 需要读取 runtime 的持久命令事实，因此 W1 在此补一个窄端口（实现归
 * 沙箱 attachment/RPC 侧，W5 装配注入）。
 */
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";

export type RuntimeCommandQueryResult =
  | { status: "found"; ack: CommandAck }
  /** runtime 明确没有该命令事实：可按同 Run/runtime 去重安全重发原信封（02 §6.3）。 */
  | { status: "unknown" }
  /** 运行时不可达或已退出：保持 uncertain，不跨 Run 重放（02 §6.3）。 */
  | { status: "unavailable"; retryable: boolean };

export interface RuntimeCommandQueryPort {
  /**
   * 按 commandId 查询 runtime 的唯一裁决（`CommandAck`），query key 与投递时一致
   * （02 §6.2：控制面保存 receipt commandId 与 runtime query key/sessionId 的映射，
   * 不因重连重造会话）。实现必须按当前 run/generation 校验，旧代际返回 unavailable。
   */
  queryCommand(request: {
    taskId: string;
    runId: string;
    runGeneration: number;
    commandId: string;
    runtimeSessionId?: string;
  }): Promise<RuntimeCommandQueryResult>;
}

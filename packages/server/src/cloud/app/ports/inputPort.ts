/**
 * TaskInput 与交互决定的持久端口（specs/cloud-agent 03 §4 task_inputs /
 * task_input_interaction_decisions 表、§6.1/§6.2 投递与收口、02 §6.3）。W2 实现。
 */
import type { CloudTaskInputRecord } from "@zcode/shared";
import type { CursorPage } from "./cursorPage.js";

export interface InputRepo {
  get(taskId: string, commandId: string): Promise<CloudTaskInputRecord | null>;
  list(
    taskId: string,
    page: { cursor?: string; limit: number },
  ): Promise<CursorPage<CloudTaskInputRecord>>;
  /** 投递状态 CAS：只允许状态机内的前进，uncertain 必须先对账（02 §6.3）。 */
  markDelivery(request: {
    taskId: string;
    commandId: string;
    to: CloudTaskInputRecord["deliveryStatus"];
    runtimeAck?: CloudTaskInputRecord["runtimeAck"];
    runId?: string;
    runtimeSessionId?: string;
    lastError?: string;
    now: number;
  }): Promise<CloudTaskInputRecord | null>;
  /** 撤销未开始投递的输入：事务 CAS 标 cancelled，dispatcher 不再取出（02 §6.3）。 */
  cancelPending(request: {
    taskId: string;
    commandId: string;
    now: number;
  }): Promise<CloudTaskInputRecord | null>;
  /**
   * 终态扫尾（08 §8.1「生命周期对确定未执行输入收口，unknown 保留对账」、审计 D4-3）：
   * run 收口为终态时对该 run 残留的 deliverable 输入做确定性收口——
   * - `accepted`（确定未投递：ready 门控/停止屏障/终态都挡住投递）→ `cancelled`
   *   （lastError=run-ended）；
   * - `delivering`（已发送但 ACK 随运行终止不可得，结果不明）→ `uncertain`
   *   （与启动对账「delivering 收口为 uncertain」同口径），**不**伪称 cancelled；
   * - 已是 `uncertain` 的行保持不动（结果不明的诚实事实由 receipt 呈现「运行已结束」）。
   * 只作用于绑定本 run（或未绑定）的输入，不触碰绑定到新一代 run 的输入。
   * 幂等：可重复调用（覆盖终态转换与收口之间崩溃的窗口）。
   */
  settleForEndedRun(request: {
    taskId: string;
    runId: string;
    now: number;
  }): Promise<{ cancelled: number; unknown: number }>;
  /** 投递顺序：Task 内 acceptanceSeq 递增（03 §6.2），不是 runtime admission 顺序。 */
  listDeliverable(taskId: string): Promise<CloudTaskInputRecord[]>;
}

// ── 交互决定（W1 CR-3；03 §4 task_input_interaction_decisions 表、02 §6.3、04 §3.4.1）──
//
// 决定必须**可恢复投递**：只存 hash 满足不了崩溃/重启后重建 payload 的要求，因此
// 记录同时保存有界载荷与 fingerprint。两条记录各自成键：
// per (taskId, interactionId) 的决定记录 + per (taskId, commandId) 的取消意图。

/**
 * `payloadJson` 的上限（16 KiB）：内容由 app 层用既有严格 decision schema 校验后写入；
 * **不得**把凭据/token 放进该载荷（01 §9 秘密边界）。
 */
export const CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS = 16 * 1024;

export interface InteractionDecisionRecord {
  taskId: string;
  /** ≡ V4 interactionId（快照 pendingInteractions[].interactionId），本记录的唯一键之一。 */
  interactionId: string;
  /**
   * 提交投递时使用的 commandId：runtime 的 CommandAck 按 commandId 回投，控制面据它把
   * `delivery_status` 写回本记录（与 `cancelCommandId` 对称）。唯一约束
   * `(task_id, delivery_command_id)` 支持反查。
   */
  deliveryCommandId: string;
  kind: "permission" | "elicitation";
  /**
   * 决定载荷（permission 的 optionId / elicitation 的 action + 原 freeText 等）：
   * **持久保存**，dispatcher 崩溃/重启后据此重建投递内容（04 §3.4.1）。
   * 有界；写前由 app 层按既有严格 decision schema 校验；不得含凭据/token。
   */
  payloadJson: string;
  /** 对 `payloadJson` 的规范化 fingerprint：同键不同内容拒绝（幂等比对），语义不变。 */
  payloadHash: string;
  runId?: string;
  runGeneration?: number;
  deliveryStatus: CloudTaskInputRecord["deliveryStatus"];
  lastError?: string;
  recordedAt: number;
}

/** 取消意图：per (taskId, commandId) 一条，与决定记录分开保存。 */
export interface InteractionCancelIntent {
  taskId: string;
  commandId: string;
  /** 独立命令键：不删除 runtime 已接受的事实，也不把原决定伪造成 cancelled（02 §6.3）。 */
  cancelCommandId: string;
  recordedAt: number;
}

/**
 * 交互决定的持久投递端口（唯一约束：决定 `(task_id, interaction_id)`、
 * `(task_id, delivery_command_id)`；取消意图 `(task_id, command_id)`）。
 * 审计/时效时间用 worker 真实时钟，方法不接受 `now`（W2 口径确认）。
 */
export interface InteractionDecisionRepo {
  /** 写入决定：同键同 payloadHash 幂等，不同 payloadHash 拒绝（调用方比对后决定）。 */
  recordDecision(request: {
    taskId: string;
    interactionId: string;
    /** 提交投递用的 commandId；runtime ACK 按它回投，反查键之一。 */
    deliveryCommandId: string;
    kind: InteractionDecisionRecord["kind"];
    /** 有界 JSON 载荷；上限见 `CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS`。 */
    payloadJson: string;
    payloadHash: string;
    runId?: string;
    runGeneration?: number;
  }): Promise<InteractionDecisionRecord>;
  getDecision(taskId: string, interactionId: string): Promise<InteractionDecisionRecord | null>;
  /**
   * 按投递 commandId 反查（`(task_id, delivery_command_id)` 唯一）：`recordRuntimeAck`
   * 据此把 ACK 回写到对应决定记录。
   */
  findDecisionByDeliveryCommandId(
    taskId: string,
    deliveryCommandId: string,
  ): Promise<InteractionDecisionRecord | null>;
  /** 投递状态 CAS：与 InputRepo.markDelivery 同一状态机与语义（02 §6.3）。 */
  setDecisionDeliveryStatus(request: {
    taskId: string;
    interactionId: string;
    status: InteractionDecisionRecord["deliveryStatus"];
    lastError?: string;
  }): Promise<InteractionDecisionRecord | null>;
  /** 记录取消意图（独立 cancelCommandId）；重复记录返回既有意图。 */
  recordCancelIntent(request: {
    taskId: string;
    commandId: string;
    cancelCommandId: string;
  }): Promise<InteractionCancelIntent>;
  getCancelIntent(taskId: string, commandId: string): Promise<InteractionCancelIntent | null>;
}

/** 投递时读持久正文（02 §6.1）：正文不进 receipt 投影，也不进日志。 */
export interface InputPayloadRead {
  readInputPayload(request: {
    taskId: string;
    commandId: string;
  }): Promise<{ prompt: string; attachmentIds?: string[] } | null>;
}

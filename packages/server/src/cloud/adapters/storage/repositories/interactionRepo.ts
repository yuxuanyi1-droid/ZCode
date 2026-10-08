/**
 * 交互决定仓储（02 §6.3「断网时控制面不代替 runtime 完成取消/审批」、03 §4
 * `task_input_interaction_decisions`、04 §3.4.1；`InteractionDecisionRepo` 端口）。
 *
 * 关键点（端口 JSDoc 即契约）：
 * - 决定按 `(taskId, interactionId)` 唯一；`payloadJson` 与 `payloadHash` 一起持久，
 *   dispatcher 崩溃/重启后据此重建投递内容（只留 hash 无法恢复投递）；
 * - `recordDecision` 幂等返回既有记录：同键不同 payloadHash 的判定由**调用方**比对
 *   后决定（端口口径），仓储不覆盖既有载荷；
 * - 投递状态与 `InputRepo` 同一状态机、只允许前进（02 §6.3）；
 * - 取消走独立 `cancelCommandId`，与决定记录分开成键，不把原决定伪造成 cancelled；
 * - 端口不接受 `now`：审计时间用 worker 真实时钟（W2 口径）。
 */
import { CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS } from "../../../app/ports/inputPort.js";
import type {
  InteractionCancelIntent,
  InteractionDecisionRecord,
  InteractionDecisionRepo,
} from "../../../app/ports/inputPort.js";
import { INPUT_DELIVERY_TRANSITIONS } from "../../../domain/deliveryStatus.js";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { readInt, readOptionalInt, readOptionalText, readText } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

/** 校验失败一律 fail closed：抛结构化错误，不返回半成品记录。 */
function invalid(message: string): never {
  throw new CloudStorageError({ code: "validation_failed", reason: "invalid-record", message });
}

function optional<Key extends string, Value>(key: Key, value: Value | undefined) {
  return (value === undefined ? {} : { [key]: value }) as { [K in Key]?: Value };
}

function mapDecisionRow(row: SqlRow): InteractionDecisionRecord {
  const payloadJson = row["payload_json"];
  if (typeof payloadJson !== "string") invalid("决定载荷缺失（payload_json）");
  return {
    taskId: readText(row, "task_id"),
    interactionId: readText(row, "interaction_id"),
    kind: readText(row, "kind") as InteractionDecisionRecord["kind"],
    payloadJson,
    payloadHash: readText(row, "payload_hash"),
    deliveryCommandId: readText(row, "delivery_command_id"),
    ...optional("runId", readOptionalText(row, "run_id")),
    ...optional("runGeneration", readOptionalInt(row, "run_generation")),
    deliveryStatus: readText(row, "delivery_status") as InteractionDecisionRecord["deliveryStatus"],
    ...optional("lastError", readOptionalText(row, "last_error")),
    recordedAt: readInt(row, "recorded_at"),
  };
}

function mapCancelIntentRow(row: SqlRow): InteractionCancelIntent {
  return {
    taskId: readText(row, "task_id"),
    commandId: readText(row, "command_id"),
    cancelCommandId: readText(row, "cancel_command_id"),
    recordedAt: readInt(row, "recorded_at"),
  };
}

function selectDecision(
  context: StorageContext,
  taskId: string,
  interactionId: string,
): SqlRow | undefined {
  return context.db
    .prepare(
      "SELECT * FROM task_input_interaction_decisions WHERE task_id = ? AND interaction_id = ?",
    )
    .get(taskId, interactionId);
}

/** 载荷校验：有界、合法 JSON、fingerprint 形状（内容由 app 层严格 schema 校验）。 */
function validateDecisionPayload(payloadJson: string, payloadHash: string): void {
  if (
    payloadJson.length === 0 ||
    payloadJson.length > CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS
  ) {
    invalid(`决定载荷长度必须在 1..${CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS} 之间`);
  }
  try {
    JSON.parse(payloadJson);
  } catch {
    invalid("决定载荷必须是合法 JSON");
  }
  if (!/^[0-9a-f]{64}$/.test(payloadHash)) invalid("payloadHash 必须是 sha256 十六进制");
}

export const interactionRepoHandlers = {
  /** 写入决定：同键已存在时返回既有记录（不覆盖载荷），由调用方比对 payloadHash。 */
  "interactions.recordDecision": (context, params): InteractionDecisionRecord => {
    validateDecisionPayload(params.payloadJson, params.payloadHash);
    if (params.deliveryCommandId.trim().length === 0) invalid("deliveryCommandId 不能为空");
    if (params.kind !== "permission" && params.kind !== "elicitation") {
      invalid(`未知交互种类 ${params.kind}`);
    }
    if (params.runGeneration !== undefined && params.runGeneration < 1) {
      invalid("runGeneration 必须是正整数");
    }
    const now = Date.now();
    return withWriteTransaction(context, () => {
      const existing = selectDecision(context, params.taskId, params.interactionId);
      if (existing) return mapDecisionRow(existing);
      // 唯一约束先给结构化拒绝：同一 Task 内 deliveryCommandId 只能属于一个决定
      // （(task_id, delivery_command_id) 唯一索引仍是硬保证）。
      const commandOwner = context.db
        .prepare(
          "SELECT interaction_id FROM task_input_interaction_decisions WHERE task_id = ? AND delivery_command_id = ?",
        )
        .get(params.taskId, params.deliveryCommandId);
      if (commandOwner) {
        invalid("deliveryCommandId 已被同一 Task 的另一个决定占用");
      }
      context.db
        .prepare(
          `INSERT INTO task_input_interaction_decisions (
             task_id, interaction_id, kind, payload_json, payload_hash, delivery_command_id,
             run_id, run_generation, delivery_status, recorded_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'accepted', ?)`,
        )
        .run(
          params.taskId,
          params.interactionId,
          params.kind,
          params.payloadJson,
          params.payloadHash,
          params.deliveryCommandId,
          params.runId ?? null,
          params.runGeneration ?? null,
          now,
        );
      const inserted = selectDecision(context, params.taskId, params.interactionId);
      if (!inserted) invalid("决定持久化失败");
      return mapDecisionRow(inserted);
    });
  },

  "interactions.getDecision": (context, params): InteractionDecisionRecord | null => {
    const row = selectDecision(context, params.taskId, params.interactionId);
    return row ? mapDecisionRow(row) : null;
  },

  /**
   * 按投递 commandId 反查（请求/回包丢失后的对账入口）：查不到返回 null，
   * **不抛错**——「没有这条决定」是正常结论，不是异常。
   */
  "interactions.findDecisionByDeliveryCommandId": (
    context,
    params,
  ): InteractionDecisionRecord | null => {
    const row = context.db
      .prepare(
        "SELECT * FROM task_input_interaction_decisions WHERE task_id = ? AND delivery_command_id = ?",
      )
      .get(params.taskId, params.deliveryCommandId);
    return row ? mapDecisionRow(row) : null;
  },

  /** 投递状态 CAS：同状态幂等返回，非法回退/越级返回 null（02 §6.3）。 */
  "interactions.setDecisionDeliveryStatus": (context, params): InteractionDecisionRecord | null => {
    return withWriteTransaction(context, () => {
      const current = selectDecision(context, params.taskId, params.interactionId);
      if (!current) return null;
      const from = String(
        current["delivery_status"],
      ) as InteractionDecisionRecord["deliveryStatus"];
      if (from === params.status) {
        if (params.lastError === undefined) return mapDecisionRow(current);
        context.db
          .prepare(
            "UPDATE task_input_interaction_decisions SET last_error = ? WHERE task_id = ? AND interaction_id = ?",
          )
          .run(params.lastError, params.taskId, params.interactionId);
        const row = selectDecision(context, params.taskId, params.interactionId);
        return row ? mapDecisionRow(row) : null;
      }
      // 统一使用 domain 唯一边表（修复 2026-10-07 P1：storage 侧曾有第二份边表，
      // accepted→admitted/uncertain、uncertain→accepted/cancelled 在真实存储上被拒，
      // 导致 ACK 静默丢弃与 CP-14 决定取消路径失败）；02 §6.3 为准。
      if (!INPUT_DELIVERY_TRANSITIONS[from].includes(params.status)) return null;
      const changes = context.db
        .prepare(
          `UPDATE task_input_interaction_decisions SET delivery_status = ?, last_error = COALESCE(?, last_error)
           WHERE task_id = ? AND interaction_id = ? AND delivery_status = ?`,
        )
        .run(params.status, params.lastError ?? null, params.taskId, params.interactionId, from);
      if (Number(changes.changes) === 0) return null;
      const row = selectDecision(context, params.taskId, params.interactionId);
      return row ? mapDecisionRow(row) : null;
    });
  },

  /** 取消意向：`(taskId, commandId)` 唯一；重复记录返回既有意图（端口口径）。 */
  "interactions.recordCancelIntent": (context, params): InteractionCancelIntent => {
    if (params.cancelCommandId.trim().length === 0) invalid("cancelCommandId 不能为空");
    const now = Date.now();
    return withWriteTransaction(context, () => {
      const existing = context.db
        .prepare(
          "SELECT * FROM task_input_interaction_cancel_intents WHERE task_id = ? AND command_id = ?",
        )
        .get(params.taskId, params.commandId);
      if (existing) return mapCancelIntentRow(existing);
      context.db
        .prepare(
          `INSERT INTO task_input_interaction_cancel_intents (
             task_id, command_id, cancel_command_id, recorded_at
           ) VALUES (?, ?, ?, ?)`,
        )
        .run(params.taskId, params.commandId, params.cancelCommandId, now);
      const inserted = context.db
        .prepare(
          "SELECT * FROM task_input_interaction_cancel_intents WHERE task_id = ? AND command_id = ?",
        )
        .get(params.taskId, params.commandId);
      if (!inserted) invalid("取消意向持久化失败");
      return mapCancelIntentRow(inserted);
    });
  },

  "interactions.getCancelIntent": (context, params): InteractionCancelIntent | null => {
    const row = context.db
      .prepare(
        "SELECT * FROM task_input_interaction_cancel_intents WHERE task_id = ? AND command_id = ?",
      )
      .get(params.taskId, params.commandId);
    return row ? mapCancelIntentRow(row) : null;
  },
} satisfies Pick<
  StorageHandlerTable,
  | "interactions.recordDecision"
  | "interactions.getDecision"
  | "interactions.findDecisionByDeliveryCommandId"
  | "interactions.setDecisionDeliveryStatus"
  | "interactions.recordCancelIntent"
  | "interactions.getCancelIntent"
>;

/** 供装配层复用的端口类型别名（端口为唯一事实源）。 */
export type { InteractionDecisionRepo };

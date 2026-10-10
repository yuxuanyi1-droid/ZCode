/**
 * TaskInput repository（03 §4 task_inputs 表、§6.1/§6.2 投递与收口、02 §6）。
 *
 * 持久投递状态机只允许前进（02 §6.1：accepted → delivering → admitted/rejected/
 * uncertain/cancelled），DB 拒绝非法回退与越级，避免控制面内存表替投递顺序。
 * 正文（prompt）只在本仓储内保存并经受控读取返回，不进入 receipt 投影与日志。
 */
import type { CloudTaskInputRecord } from "@zcode/shared";
import { inputDeliveryStatusSchema } from "@zcode/shared";
import type { InputDeliveryStatus } from "@zcode/shared";
import { canAdvanceDeliveryStatus } from "../../../domain/deliveryStatus.js";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import { decodeCursor, encodeCursor, normalizeLimit } from "../sqlite/cursor.js";
import { mapInputRow, toJsonColumn } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

const PAGE_LIMIT_MAX = 100;

function selectInput(
  context: StorageContext,
  taskId: string,
  commandId: string,
): SqlRow | undefined {
  return context.db
    .prepare("SELECT * FROM task_inputs WHERE task_id = ? AND command_id = ?")
    .get(taskId, commandId);
}

export const inputRepoHandlers = {
  "inputs.get": (context, params): CloudTaskInputRecord | null => {
    const row = selectInput(context, params.taskId, params.commandId);
    return row ? mapInputRow(row) : null;
  },

  "inputs.list": (context, params): { items: CloudTaskInputRecord[]; nextCursor?: string } => {
    const limit = normalizeLimit(params.page.limit, PAGE_LIMIT_MAX);
    const after = params.page.cursor ? decodeCursor(params.page.cursor) : 0;
    const rows = context.db
      .prepare(
        `SELECT * FROM task_inputs WHERE task_id = ? AND acceptance_seq > ?
         ORDER BY acceptance_seq LIMIT ?`,
      )
      .all(params.taskId, typeof after === "number" ? after : 0, limit + 1);
    const items = rows.slice(0, limit).map(mapInputRow);
    const last = rows.length > limit ? rows[limit - 1] : undefined;
    return last ? { items, nextCursor: encodeCursor([Number(last["acceptance_seq"])]) } : { items };
  },

  /** 投递状态 CAS：只允许状态机内的前进，越级/回退返回 null（02 §6.3）。 */
  "inputs.markDelivery": (context, params): CloudTaskInputRecord | null => {
    const to = inputDeliveryStatusSchema.parse(params.to);
    return withWriteTransaction(context, () => {
      const current = selectInput(context, params.taskId, params.commandId);
      if (!current) return null;
      const from = String(current["delivery_status"]) as InputDeliveryStatus;
      // 与 app 层、内存 fake 共用 domain 唯一裁决 `canAdvanceDeliveryStatus`（修复
      // 2026-10-07 P1 的同一份边表 + 同态幂等例外）：此前这里直接查边表，缺「同态
      // 幂等改写」例外，与 fake 语义不一致——预算耗尽闭环降级要把已按 run-ended 落
      // cancelled 的触发输入补注可读 last_error（03 修订审计第二批）就被 CAS 拒掉。
      // 同态改写只覆盖 COALESCE 字段（last_error 等），状态不回退、不越级。
      if (!canAdvanceDeliveryStatus(from, to)) return null;
      const changes = context.db
        .prepare(
          `UPDATE task_inputs SET
             delivery_status = ?,
             runtime_ack_json = COALESCE(?, runtime_ack_json),
             target_run_id = COALESCE(?, target_run_id),
             runtime_session_id = COALESCE(?, runtime_session_id),
             last_error = COALESCE(?, last_error),
             updated_at = ?
           WHERE task_id = ? AND command_id = ? AND delivery_status = ?`,
        )
        .run(
          to,
          params.runtimeAck === undefined ? null : toJsonColumn(params.runtimeAck),
          params.runId ?? null,
          params.runtimeSessionId ?? null,
          params.lastError ?? null,
          params.now,
          params.taskId,
          params.commandId,
          from,
        );
      if (Number(changes.changes) === 0) return null;
      const row = selectInput(context, params.taskId, params.commandId);
      return row ? mapInputRow(row) : null;
    });
  },

  /**
   * 撤销未开始投递的输入（02 §6.3）：只允许 accepted → cancelled。
   * 已 delivering/admitted 的输入不能被"撤销"成 cancelled，必须走独立 cancelCommandId。
   * 重复撤销是幂等的：已是 cancelled 时返回原记录。
   */
  "inputs.cancelPending": (context, params): CloudTaskInputRecord | null => {
    return withWriteTransaction(context, () => {
      const current = selectInput(context, params.taskId, params.commandId);
      if (!current) return null;
      if (String(current["delivery_status"]) === "cancelled") return mapInputRow(current);
      const changes = context.db
        .prepare(
          `UPDATE task_inputs SET delivery_status = 'cancelled', updated_at = ?
           WHERE task_id = ? AND command_id = ? AND delivery_status = 'accepted'`,
        )
        .run(params.now, params.taskId, params.commandId);
      if (Number(changes.changes) === 0) return null;
      const row = selectInput(context, params.taskId, params.commandId);
      return row ? mapInputRow(row) : null;
    });
  },

  /**
   * 待投递输入：Task 内按 acceptanceSeq 递增（03 §6.2）。包含 delivering/uncertain
   * ——崩溃或响应丢失后这些行仍需收口，调用方必须先按 commandId 查询 runtime
   * （03 §8），确认未到达才用同一 commandId 重投，不得静默丢弃。
   */
  "inputs.listDeliverable": (context, params): CloudTaskInputRecord[] =>
    context.db
      .prepare(
        `SELECT * FROM task_inputs
         WHERE task_id = ? AND delivery_status IN ('accepted','delivering','uncertain')
         ORDER BY acceptance_seq`,
      )
      .all(params.taskId)
      .map(mapInputRow),

  /**
   * 终态扫尾（08 §8.1「生命周期对确定未执行输入收口，unknown 保留对账」、审计 D4-3）：
   * run 收口为终态后，`accepted` 是「确定未执行」（投递被 ready 门控/停止屏障/终态挡住），
   * 收口为 cancelled（reason=run-ended 落 last_error）；`delivering/uncertain` 结果不明
   * ——delivering 统一收口为 uncertain（与启动对账同口径），uncertain 保持不动，
   * 不伪称 cancelled。范围限定本 run（target_run_id 绑定）或未绑定行，新一代 run 的
   * 输入不受影响。幂等：重复调用只补齐尚未收口的行。
   */
  "inputs.settleForEndedRun": (context, params): { cancelled: number; unknown: number } => {
    return withWriteTransaction(context, () => {
      const runScope = "(target_run_id IS NULL OR target_run_id = ?)";
      const cancelled = context.db
        .prepare(
          `UPDATE task_inputs SET delivery_status = 'cancelled', last_error = 'run-ended', updated_at = ?
           WHERE task_id = ? AND delivery_status = 'accepted' AND ${runScope}`,
        )
        .run(params.now, params.taskId, params.runId);
      // delivering → uncertain 是状态机内的合法推进（domain/deliveryStatus.ts）；
      // ACK 已随运行终止不可得，与启动对账「delivering 收口为 uncertain」同口径。
      const delivered = context.db
        .prepare(
          `UPDATE task_inputs SET delivery_status = 'uncertain', last_error = 'run-ended', updated_at = ?
           WHERE task_id = ? AND delivery_status = 'delivering' AND ${runScope}`,
        )
        .run(params.now, params.taskId, params.runId);
      return {
        cancelled: Number(cancelled.changes),
        unknown: Number(delivered.changes),
      };
    });
  },

  /** 投递只读持久正文（02 §6.1）：正文不进 receipt 投影，也不进日志。 */
  "payloads.readInputPayload": (
    context,
    params,
  ): { prompt: string; attachmentIds?: string[] } | null => {
    const row = selectInput(context, params.taskId, params.commandId);
    if (!row) return null;
    const record = mapInputRow(row);
    const prompt = row["prompt"];
    if (typeof prompt !== "string") return null;
    return record.attachmentRefs
      ? { prompt, attachmentIds: [...record.attachmentRefs] }
      : { prompt };
  },
} satisfies Pick<
  StorageHandlerTable,
  | "inputs.get"
  | "inputs.list"
  | "inputs.markDelivery"
  | "inputs.cancelPending"
  | "inputs.settleForEndedRun"
  | "inputs.listDeliverable"
  | "payloads.readInputPayload"
>;

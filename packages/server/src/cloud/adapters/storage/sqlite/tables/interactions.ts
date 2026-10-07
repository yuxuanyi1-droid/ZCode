/**
 * 交互决定表与取消意向表（02 §6.3、04 §3.4.1、`InteractionDecisionRepo` 端口）。
 *
 * - 决定按 `(task_id, interaction_id)` 唯一：同键返回既有记录、同键不同 `payload_hash`
 *   由调用方比对后拒绝；
 * - 载荷正文（`payload_json`）必须持久，且与 fingerprint 一起写入——dispatcher 崩溃
 *   重启后据此重建投递内容（只留 fingerprint 会让待投递决定不可恢复）；
 * - 取消走**独立** `cancel_command_id`，与决定记录分开成键：不删除 runtime 已接受的
 *   事实，也不把原决定伪造成 cancelled（02 §6.3）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 */
import { DELIVERY_STATUS } from "./constants.js";

export const interactionTables = `
CREATE TABLE task_input_interaction_decisions (
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  interaction_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('permission','elicitation')),
  -- 决定载荷的规范 JSON（有界，不含凭据/token；上限见端口常量）。
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  -- 提交投递用的 commandId（与 cancel_command_id 对称）：支持按 commandId 反查决定。
  delivery_command_id TEXT NOT NULL,
  run_id TEXT,
  run_generation INTEGER,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN (${DELIVERY_STATUS})),
  last_error TEXT,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, interaction_id)
) STRICT;
-- per (taskId, deliveryCommandId) 唯一：请求丢失后按投递命令键反查既有决定。
CREATE UNIQUE INDEX task_input_interaction_decisions_delivery_command ON task_input_interaction_decisions (task_id, delivery_command_id);
-- 收口扫描按状态筛同一 Task 的待投递决定（02 §6.3）。
CREATE INDEX task_input_interaction_decisions_status ON task_input_interaction_decisions (task_id, delivery_status);

CREATE TABLE task_input_interaction_cancel_intents (
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  command_id TEXT NOT NULL,
  cancel_command_id TEXT NOT NULL,
  recorded_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, command_id)
) STRICT;
`;

/**
 * 输入表：commandId 幂等、acceptanceSeq 与投递状态机（03 §6.1/§6.2、02 §6）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 */
import { DELIVERY_STATUS } from "./constants.js";

export const inputTables = `
CREATE TABLE task_inputs (
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  command_id TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  intent TEXT NOT NULL CHECK (intent IN ('start','append','reopen')),
  payload_hash TEXT NOT NULL,
  prompt TEXT NOT NULL,
  attachment_ids_json TEXT,
  requested_config_json TEXT,
  resolved_execution_config_json TEXT,
  resolved_authorization_ref TEXT,
  retry_of_command_id TEXT,
  acceptance_seq INTEGER NOT NULL CHECK (acceptance_seq >= 1),
  accepted_at INTEGER NOT NULL,
  target_run_id TEXT,
  runtime_session_id TEXT,
  delivery_status TEXT NOT NULL CHECK (delivery_status IN (${DELIVERY_STATUS})),
  runtime_ack_json TEXT,
  last_error TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, command_id)
) STRICT;


-- owner 由 tasks.owner_principal_id 决定，故 (task_id, command_id) 唯一即
-- (owner, task, commandId) 唯一（03 §4 task_inputs 行）；acceptanceSeq 在 Task 内唯一。
CREATE UNIQUE INDEX task_inputs_acceptance_seq ON task_inputs (task_id, acceptance_seq);


CREATE INDEX task_inputs_deliverable ON task_inputs (task_id, acceptance_seq) WHERE delivery_status IN ('accepted','delivering','uncertain');
`;

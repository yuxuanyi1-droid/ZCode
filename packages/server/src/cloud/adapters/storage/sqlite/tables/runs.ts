/**
 * run 表：执行载体、代际与唯一有效写 run（08 §3.2/§4.2）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 */
import { RUN_STATUS } from "./constants.js";

export const runTables = `
CREATE TABLE runs (
  run_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  run_generation INTEGER NOT NULL CHECK (run_generation >= 1),
  execution_kind TEXT NOT NULL CHECK (execution_kind IN ('sandbox')),
  first_input_command_id TEXT,
  execution_recipe_json TEXT,
  stop_requested INTEGER NOT NULL DEFAULT 0 CHECK (stop_requested IN (0, 1)),
  stop_operation_id TEXT,
  provider TEXT NOT NULL,
  provider_handle TEXT,
  workspace_path TEXT,
  status TEXT NOT NULL CHECK (status IN (${RUN_STATUS})),
  connection_epoch INTEGER NOT NULL CHECK (connection_epoch >= 1),
  runtime_session_id TEXT,
  expires_at INTEGER,
  deadline_estimate INTEGER,
  deadline_confidence TEXT CHECK (deadline_confidence IS NULL OR deadline_confidence IN ('low','medium','high')),
  hard_deadline_at INTEGER,
  last_business_activity_at INTEGER,
  end_reason TEXT,
  last_error TEXT,
  data_at_risk INTEGER NOT NULL DEFAULT 0 CHECK (data_at_risk IN (0, 1)),
  quota_released_at INTEGER,
  quota_release_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;


CREATE UNIQUE INDEX runs_task_generation ON runs (task_id, run_generation);


-- 每 Task 至多一个有效写 run：断网不授权第二个 run（08 §4.2、02 §2 不变量 4）。
CREATE UNIQUE INDEX runs_single_active_writer ON runs (task_id) WHERE status IN ('provisioning','ready','disconnected','draining');


CREATE INDEX runs_recovery_scan ON runs (status) WHERE status IN ('provisioning','ready','disconnected','draining');
`;

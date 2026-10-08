/**
 * run 表：执行载体、代际与唯一有效写 run（08 §3.2/§4.2）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 *
 * 两段 DDL（E-1，2026-10-09 生命周期 v2）：
 * - `runTables` 是 `0001` 的初建 DDL：status CHECK 用冻结词表 `RUN_STATUS_LEGACY`
 *  （已应用迁移不可改写，checksum 账本会拒绝被改写的历史）；
 * - `runPausedRebuildTables` 是 `0007` 的表重建：SQLite 无 ALTER CHECK，按
 *   create-new/copy/drop/rename 惯例重建 runs 表使 CHECK 含 `paused`，并同步重建
 *   两个部分唯一/扫描索引（single_active_writer / recovery_scan 必须含 paused，
 *   否则 paused run 既不占「唯一有效写 run」名额也进不了恢复扫描）。
 */
import { ACTIVE_RUN_STATUSES, RUN_STATUS, RUN_STATUS_LEGACY } from "./constants.js";

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
  status TEXT NOT NULL CHECK (status IN (${RUN_STATUS_LEGACY})),
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

/** 0007 重建表的活动状态部分索引谓词（单一来源：ACTIVE_RUN_STATUSES，含 paused）。 */
const ACTIVE_STATUS_SQL_0007 = ACTIVE_RUN_STATUSES.map((status) => `'${status}'`).join(",");

export const runPausedRebuildTables = `
-- 0007（2026-10-09 生命周期 v2，E-1）：runs 表重建使 status CHECK 含 paused。
-- SQLite 不支持 ALTER CHECK；按 create-new/copy/drop/rename 惯例重建，列集与 0001 逐列一致。
CREATE TABLE runs_v2_paused (
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

INSERT INTO runs_v2_paused (
  run_id, task_id, run_generation, execution_kind, first_input_command_id,
  execution_recipe_json, stop_requested, stop_operation_id, provider,
  provider_handle, workspace_path, status, connection_epoch, runtime_session_id,
  expires_at, deadline_estimate, deadline_confidence, hard_deadline_at,
  last_business_activity_at, end_reason, last_error, data_at_risk,
  quota_released_at, quota_release_reason, created_at, updated_at
) SELECT
  run_id, task_id, run_generation, execution_kind, first_input_command_id,
  execution_recipe_json, stop_requested, stop_operation_id, provider,
  provider_handle, workspace_path, status, connection_epoch, runtime_session_id,
  expires_at, deadline_estimate, deadline_confidence, hard_deadline_at,
  last_business_activity_at, end_reason, last_error, data_at_risk,
  quota_released_at, quota_release_reason, created_at, updated_at
FROM runs;

DROP TABLE runs;

ALTER TABLE runs_v2_paused RENAME TO runs;

CREATE UNIQUE INDEX runs_task_generation ON runs (task_id, run_generation);

-- 每 Task 至多一个有效写 run：paused 也占「唯一有效写 run」名额（08 §3.2/§6 修订）。
CREATE UNIQUE INDEX runs_single_active_writer ON runs (task_id) WHERE status IN (${ACTIVE_STATUS_SQL_0007});

CREATE INDEX runs_recovery_scan ON runs (status) WHERE status IN (${ACTIVE_STATUS_SQL_0007});
`;

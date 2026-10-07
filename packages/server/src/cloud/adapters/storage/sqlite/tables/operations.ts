/**
 * 外部操作 outbox：provider/生命周期分面 + GitHub effect 分面（03 §5、09 §5.2）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 */
import { OPERATION_KINDS, OPERATION_STATES } from "./constants.js";

export const operationTables = `
CREATE TABLE external_operations (
  operation_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN (${OPERATION_KINDS})),
  idempotency_key TEXT NOT NULL,
  business_key TEXT,
  task_id TEXT,
  run_id TEXT,
  run_generation INTEGER,
  repository_id INTEGER,
  task_branch TEXT,
  base_branch TEXT,
  desired_revision INTEGER,
  expected_head_sha TEXT,
  payload_ref TEXT,
  remote_id TEXT,
  state TEXT NOT NULL CHECK (state IN (${OPERATION_STATES})),
  attempt INTEGER NOT NULL DEFAULT 0 CHECK (attempt >= 0),
  next_attempt_at INTEGER,
  lease_token TEXT,
  lease_expires_at INTEGER,
  result_ref TEXT,
  error_code TEXT,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  settled_at INTEGER
) STRICT;


CREATE UNIQUE INDEX external_operations_idempotency_key ON external_operations (idempotency_key);


-- GitHub effect 分面的业务键（09 §5.2 第 1 条）：provider 操作没有该键，故为部分唯一索引。
CREATE UNIQUE INDEX external_operations_business_key ON external_operations (business_key) WHERE business_key IS NOT NULL;


CREATE INDEX external_operations_lease ON external_operations (state, lease_expires_at, next_attempt_at);


CREATE INDEX external_operations_task ON external_operations (task_id, kind);
`;

/**
 * git grant 表（01 §7.1/§7.2、09 §4：单次兑换、只持久 hash 与元数据）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 */

export const grantTables = `
CREATE TABLE git_grants (
  grant_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  run_generation INTEGER NOT NULL CHECK (run_generation >= 1),
  repository_id INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('clone','fetch','push')),
  status TEXT NOT NULL CHECK (status IN ('issued','redeemed','revoked')),
  proof_hash TEXT,
  issued_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  redeemed_at INTEGER,
  revoked_at INTEGER,
  token_issued_at INTEGER,
  token_expires_at INTEGER,
  last_error_code TEXT,
  last_error_message TEXT,
  revoke_outcome_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- 只持久 grantId/purpose/issuedAt/expiresAt 等元数据，不持久 raw token
  -- （01 §7.2）；token_hash 列按同一理由在端口定稿后移除。
  CHECK (status <> 'redeemed' OR redeemed_at IS NOT NULL)
) STRICT;
-- 兑换入口按 (runId, purpose) 取 issuedAt 最新的一条（GitGrantStore.findCurrentForRun）。
CREATE INDEX git_grants_run_purpose ON git_grants (run_id, purpose, issued_at DESC);
CREATE INDEX git_grants_task ON git_grants (task_id);
`;

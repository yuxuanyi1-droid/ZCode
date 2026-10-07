/**
 * bridge 凭据表（02 §5.1/§5.2：只持久 hash 与旋转元数据）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 */

export const credentialTables = `
CREATE TABLE run_credentials (
  run_id TEXT PRIMARY KEY REFERENCES runs (run_id),
  run_generation INTEGER NOT NULL CHECK (run_generation >= 1),
  credential_hash TEXT NOT NULL,
  candidate_hash TEXT,
  hello_attempt_id TEXT,
  rotation_id TEXT,
  bootstrap_operation_id TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  revoked_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

/**
 * 账号域投影与 webhook 收件箱（03 §4；M7 条件性）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 */

export const accountTables = `
CREATE TABLE account_installations (
  principal_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  account_login TEXT,
  repositories_json TEXT,
  availability TEXT NOT NULL CHECK (availability IN ('available','stale','unavailable')),
  last_checked_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (principal_id, installation_id)
) STRICT;



CREATE TABLE webhook_inbox (
  delivery_id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  authorization_result TEXT,
  processing_state TEXT NOT NULL CHECK (processing_state IN ('received','authorized','rejected','processed','failed')),
  last_error TEXT,
  received_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

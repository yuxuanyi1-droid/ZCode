/**
 * 受控附件元数据表（03 §4：内容地址/大小/类型/owner）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 */

export const attachmentTables = `
CREATE TABLE attachment_objects (
  sha256 TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  file_name TEXT NOT NULL,
  mime TEXT NOT NULL,
  byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
  state TEXT NOT NULL CHECK (state IN ('staged','published')),
  task_id TEXT,
  created_at INTEGER NOT NULL,
  published_at INTEGER,
  referenced_at INTEGER,
  last_referenced_task_id TEXT,
  PRIMARY KEY (owner_principal_id, sha256),
  CHECK (state <> 'published' OR published_at IS NOT NULL)
) STRICT;
CREATE INDEX attachment_objects_sweep ON attachment_objects (state, created_at);
`;

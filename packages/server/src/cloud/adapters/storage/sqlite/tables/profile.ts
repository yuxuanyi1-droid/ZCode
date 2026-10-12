/**
 * 用户资源 profile 表族（M8；specs/cloud-agent 14 §9.2①；`0008_user_profile`）。
 *
 * 两表 + 一条 runs 列 + 一个空版本种子：
 * - `profile_entries`：**内容寻址**条目行，物理主键 `(category, entry_id, sha256)`。
 *   冻结文本里的 "PRIMARY KEY(category, entry_id)" 语义 = 同一键的"当前内容"唯一
 *   （由最高 profileVersion 的 manifest 指定）；物理上允许旧 sha 行共存，否则
 *   "保留最近 8 个版本可解析"在条目被替换后立即失效（14 §9.2①）。
 *   正文统一 TEXT 存储：`archive-base64`（canonical base64，仅 skills/plugins）/
 *   `mcp-config`（JSON 文本）/ `markdown`（commands/subagents 单文件正文，14 §4.5）/
 *   `agents-md`（正文）；sha256/bytes 由写入侧从正文派生（客户端不能自报）。
 * - `profile_versions`：版本 manifest（全量条目元数据数组的 JSON 文本，不含正文）；
 *   版本号单调递增、由写事务 `MAX+1` 分配。
 * - `runs.resources_profile_version`：**已废弃**（2026-10-11 简化定调，14 §4.8/§9.5）：
 *   Run 不再追踪 profile 版本（同步永远取最新 profile），列**保留不写不读**，迁移
 *   不回滚（历史值不再被任何读路径使用）。
 * - 种子：迁移种下空版本 1（`manifest_json = '[]'`），使 `GET /user-profile` 与
 *   "尚无任何上传"（空 profile）语义闭合。
 */
export const PROFILE_ENTRY_CATEGORIES_SQL =
  "'mcp','skills','commands','plugins','subagents','agents-md'";

export const profileTables = `
CREATE TABLE profile_entries (
  category TEXT NOT NULL CHECK (category IN (${PROFILE_ENTRY_CATEGORIES_SQL})),
  entry_id TEXT NOT NULL,
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  bytes INTEGER NOT NULL CHECK (bytes > 0),
  content_kind TEXT NOT NULL CHECK (content_kind IN ('archive-base64', 'mcp-config', 'markdown', 'agents-md')),
  content TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (category, entry_id, sha256)
) STRICT;


-- 当前内容按 (category, entry_id) 反查（manifest 解析与修剪引用计数都走它）。
CREATE INDEX profile_entries_by_key ON profile_entries (category, entry_id);


CREATE TABLE profile_versions (
  profile_version INTEGER PRIMARY KEY CHECK (profile_version >= 1),
  manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;


-- 空版本 1：GET 快照与"尚无任何上传"语义闭合（14 §9.2①）。
INSERT INTO profile_versions (profile_version, manifest_json, created_at)
VALUES (1, '[]', CAST(strftime('%s', 'now') AS INTEGER) * 1000);


-- 已废弃列（14 §4.8）：保留不写不读，迁移不回滚（Run 不再冻结 profile 版本）。
ALTER TABLE runs ADD COLUMN resources_profile_version INTEGER;
`;

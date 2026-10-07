/**
 * 控制面核心表：principals / projects / tasks（03 §3/§4、11 §4/§5）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 */
import { TASK_STATUS } from "./constants.js";

export const coreTables = `
CREATE TABLE principals (
  principal_id TEXT PRIMARY KEY,
  disabled INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  display_name TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;



CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('github-repo')),
  repository_id INTEGER,
  installation_id INTEGER,
  repo_owner TEXT,
  repo_name TEXT,
  default_branch TEXT,
  display_name TEXT,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (repository_id IS NOT NULL AND repo_owner IS NOT NULL AND repo_name IS NOT NULL)
) STRICT;


CREATE UNIQUE INDEX projects_owner_repository ON projects (owner_principal_id, repository_id);



CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY,
  owner_principal_id TEXT NOT NULL,
  project_id TEXT NOT NULL REFERENCES projects (project_id),
  title TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN (${TASK_STATUS})),
  creation_key TEXT NOT NULL,
  draft_start_config_json TEXT,
  base_branch TEXT,
  base_sha TEXT,
  task_branch TEXT,
  workspace_identity TEXT NOT NULL,
  active_run_id TEXT,
  next_run_generation INTEGER NOT NULL CHECK (next_run_generation >= 1),
  last_checkpoint_sha TEXT,
  complete_requested INTEGER CHECK (complete_requested IN (0, 1)),
  pr_ref TEXT,
  archived_from_status TEXT CHECK (archived_from_status IS NULL OR archived_from_status IN (${TASK_STATUS})),
  revision INTEGER NOT NULL CHECK (revision >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;


CREATE UNIQUE INDEX tasks_owner_creation_key ON tasks (owner_principal_id, creation_key);


CREATE INDEX tasks_project ON tasks (project_id, created_at DESC, task_id DESC);
`;

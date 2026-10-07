/**
 * 投影与产物表：事件、ingest 水位、快照、checkpoint、产物（02 §7、03 §4）。
 *
 * 表定义与 CHECK 就近放在表族文件里（W2 §3「sqlite/ schema 定义」）；
 * 迁移编号、语句顺序与对外导出面由 `../schema.ts` 统一维持（10 §7 编号纪律）。
 */

export const projectionTables = `
CREATE TABLE projection_events (
  event_seq INTEGER PRIMARY KEY AUTOINCREMENT,
  schema_version INTEGER NOT NULL,
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  run_generation INTEGER NOT NULL,
  runtime_incarnation TEXT NOT NULL,
  topic TEXT NOT NULL,
  log_epoch TEXT NOT NULL,
  source_seq INTEGER NOT NULL CHECK (source_seq >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('snapshot','delta','command-result','lifecycle')),
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  ingested_at INTEGER NOT NULL
) STRICT;


-- 去重键 (runId, runtimeIncarnation, topic, logEpoch, sourceSeq)：重复投递幂等（02 §7.1）。
CREATE UNIQUE INDEX projection_events_dedup ON projection_events (run_id, runtime_incarnation, topic, log_epoch, source_seq);


CREATE INDEX projection_events_history ON projection_events (task_id, event_seq);



CREATE TABLE projection_ingest_cursors (
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  topic TEXT NOT NULL,
  log_epoch TEXT NOT NULL,
  source_seq INTEGER NOT NULL CHECK (source_seq >= 0),
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (run_id, topic, log_epoch)
) STRICT;



CREATE TABLE projection_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  topic TEXT NOT NULL,
  log_epoch TEXT NOT NULL,
  covered_source_seq INTEGER NOT NULL CHECK (covered_source_seq >= 0),
  schema_version INTEGER NOT NULL,
  snapshot_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;


CREATE UNIQUE INDEX projection_snapshots_scope ON projection_snapshots (task_id, topic, log_epoch);



CREATE TABLE checkpoints (
  operation_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  run_id TEXT NOT NULL REFERENCES runs (run_id),
  run_generation INTEGER NOT NULL CHECK (run_generation >= 1),
  state TEXT NOT NULL CHECK (state IN ('none','pending','saving','saved','failed')),
  included_files_json TEXT NOT NULL DEFAULT '[]',
  local_sha TEXT,
  confirmed_remote_sha TEXT,
  risk_summary TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  -- saved 必须有远端 SHA 证据（08 §8.2）：远端 ref 查询确认前不得写 saved。
  CHECK (state <> 'saved' OR confirmed_remote_sha IS NOT NULL)
) STRICT;


CREATE INDEX checkpoints_task ON checkpoints (task_id, created_at);



CREATE TABLE task_artifacts (
  task_id TEXT NOT NULL REFERENCES tasks (task_id),
  kind TEXT NOT NULL CHECK (kind IN ('code','noChanges')),
  task_branch TEXT,
  pr_head TEXT,
  pr_base TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_status TEXT NOT NULL CHECK (pr_status IN ('none','creating','draft','open','merged','closed','publication-failed')),
  published_sha TEXT,
  summary_ref TEXT,
  last_checked_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, kind),
  -- 无差异输出保存摘要，不创建空 PR（08 §9）。
  CHECK (kind <> 'noChanges' OR summary_ref IS NOT NULL)
) STRICT;
`;

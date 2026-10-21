import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { CloudInputIntent, CloudRunStatus, CloudTaskStatus } from "@zcode/cloud-protocol";

import type {
  ArtifactRecord,
  InputRecord,
  ProjectRecord,
  ProjectionRecord,
  RunRecord,
  TaskRecord,
} from "../../domain/types.js";

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  repo_owner TEXT NOT NULL,
  repo_name TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  task_stable_id TEXT NOT NULL UNIQUE,
  workspace_identity TEXT NOT NULL,
  base_branch TEXT,
  base_sha TEXT,
  task_branch TEXT,
  active_run_id TEXT,
  next_run_generation INTEGER NOT NULL DEFAULT 1,
  revision INTEGER NOT NULL DEFAULT 1,
  archived_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  generation INTEGER NOT NULL,
  status TEXT NOT NULL,
  provider TEXT NOT NULL,
  provider_handle TEXT,
  template_version TEXT NOT NULL,
  checkout_path TEXT NOT NULL,
  attach_token_enc TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  ready_at INTEGER,
  ended_at INTEGER,
  end_reason TEXT,
  last_error TEXT,
  data_at_risk INTEGER NOT NULL DEFAULT 0,
  UNIQUE (task_id, generation)
);

CREATE TABLE IF NOT EXISTS inputs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  command_id TEXT NOT NULL,
  intent TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  acceptance_seq INTEGER NOT NULL,
  delivery_status TEXT NOT NULL,
  target_run_id TEXT,
  delivered_at INTEGER,
  runtime_acked_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE (task_id, command_id)
);

CREATE TABLE IF NOT EXISTS projections (
  task_id TEXT NOT NULL REFERENCES tasks(id),
  log_epoch INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  ingested_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, log_epoch, seq)
);

CREATE TABLE IF NOT EXISTS artifacts (
  task_id TEXT PRIMARY KEY REFERENCES tasks(id),
  kind TEXT NOT NULL,
  task_branch TEXT,
  pr_number INTEGER,
  pr_url TEXT,
  pr_status TEXT,
  published_sha TEXT,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_runs_task ON runs(task_id);
CREATE INDEX IF NOT EXISTS idx_inputs_task_seq ON inputs(task_id, acceptance_seq);
CREATE INDEX IF NOT EXISTS idx_projections_task ON projections(task_id, log_epoch, seq);
`;

function rowToProject(row: Record<string, unknown>): ProjectRecord {
  return {
    id: String(row["id"]),
    name: String(row["name"]),
    repoUrl: String(row["repo_url"]),
    repoOwner: String(row["repo_owner"]),
    repoName: String(row["repo_name"]),
    defaultBranch: String(row["default_branch"]),
    createdAt: Number(row["created_at"]),
  };
}

function rowToTask(row: Record<string, unknown>): TaskRecord {
  return {
    id: String(row["id"]),
    projectId: String(row["project_id"]),
    title: String(row["title"]),
    status: String(row["status"]) as CloudTaskStatus,
    provider: String(row["provider"]),
    taskStableId: String(row["task_stable_id"]),
    workspaceIdentity: String(row["workspace_identity"]),
    baseBranch: row["base_branch"] == null ? null : String(row["base_branch"]),
    baseSha: row["base_sha"] == null ? null : String(row["base_sha"]),
    taskBranch: row["task_branch"] == null ? null : String(row["task_branch"]),
    activeRunId: row["active_run_id"] == null ? null : String(row["active_run_id"]),
    nextRunGeneration: Number(row["next_run_generation"]),
    revision: Number(row["revision"]),
    archivedAt: row["archived_at"] == null ? null : Number(row["archived_at"]),
    createdAt: Number(row["created_at"]),
    updatedAt: Number(row["updated_at"]),
  };
}

function rowToRun(row: Record<string, unknown>): RunRecord {
  return {
    id: String(row["id"]),
    taskId: String(row["task_id"]),
    generation: Number(row["generation"]),
    status: String(row["status"]) as CloudRunStatus,
    provider: String(row["provider"]),
    providerHandle: row["provider_handle"] == null ? null : String(row["provider_handle"]),
    templateVersion: String(row["template_version"]),
    checkoutPath: String(row["checkout_path"]),
    attachTokenEnc: String(row["attach_token_enc"]),
    createdAt: Number(row["created_at"]),
    readyAt: row["ready_at"] == null ? null : Number(row["ready_at"]),
    endedAt: row["ended_at"] == null ? null : Number(row["ended_at"]),
    endReason: row["end_reason"] == null ? null : String(row["end_reason"]),
    lastError: row["last_error"] == null ? null : String(row["last_error"]),
    dataAtRisk: Number(row["data_at_risk"]) === 1,
  };
}

function rowToInput(row: Record<string, unknown>): InputRecord {
  return {
    id: String(row["id"]),
    taskId: String(row["task_id"]),
    commandId: String(row["command_id"]),
    intent: String(row["intent"]) as CloudInputIntent,
    payloadJson: String(row["payload_json"]),
    payloadHash: String(row["payload_hash"]),
    acceptanceSeq: Number(row["acceptance_seq"]),
    deliveryStatus: String(row["delivery_status"]) as InputRecord["deliveryStatus"],
    targetRunId: row["target_run_id"] == null ? null : String(row["target_run_id"]),
    deliveredAt: row["delivered_at"] == null ? null : Number(row["delivered_at"]),
    runtimeAckedAt: row["runtime_acked_at"] == null ? null : Number(row["runtime_acked_at"]),
    lastError: row["last_error"] == null ? null : String(row["last_error"]),
    createdAt: Number(row["created_at"]),
  };
}

export class CloudStore {
  private readonly db: DatabaseSync;

  public constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(SCHEMA);
  }

  public close(): void {
    this.db.close();
  }

  // ── projects ────────────────────────────────────────────────

  public listProjects(): ProjectRecord[] {
    return this.db
      .prepare("SELECT * FROM projects ORDER BY created_at ASC")
      .all()
      .map(rowToProject);
  }

  public getProject(id: string): ProjectRecord | null {
    const row = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id);
    return row ? rowToProject(row) : null;
  }

  public createProject(input: {
    name: string;
    repoUrl: string;
    repoOwner: string;
    repoName: string;
    defaultBranch: string;
  }): ProjectRecord {
    const record: ProjectRecord = {
      id: randomUUID(),
      name: input.name,
      repoUrl: input.repoUrl,
      repoOwner: input.repoOwner,
      repoName: input.repoName,
      defaultBranch: input.defaultBranch,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        "INSERT INTO projects (id, name, repo_url, repo_owner, repo_name, default_branch, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(
        record.id,
        record.name,
        record.repoUrl,
        record.repoOwner,
        record.repoName,
        record.defaultBranch,
        record.createdAt,
      );
    return record;
  }

  public deleteProject(id: string): void {
    this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
  }

  // ── tasks ───────────────────────────────────────────────────

  public listTasks(projectId?: string): TaskRecord[] {
    const rows = projectId
      ? this.db
          .prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY created_at DESC LIMIT 200")
          .all(projectId)
      : this.db.prepare("SELECT * FROM tasks ORDER BY created_at DESC LIMIT 200").all();
    return rows.map(rowToTask);
  }

  public getTask(id: string): TaskRecord | null {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? rowToTask(row) : null;
  }

  public createTask(input: {
    projectId: string;
    title: string;
    provider: string;
    taskStableId: string;
    workspaceIdentity: string;
    baseBranch: string;
    taskBranch: string;
  }): TaskRecord {
    const now = Date.now();
    const record: TaskRecord = {
      id: randomUUID(),
      projectId: input.projectId,
      title: input.title,
      status: "draft",
      provider: input.provider,
      taskStableId: input.taskStableId,
      workspaceIdentity: input.workspaceIdentity,
      baseBranch: input.baseBranch,
      baseSha: null,
      taskBranch: input.taskBranch,
      activeRunId: null,
      nextRunGeneration: 1,
      revision: 1,
      archivedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db
      .prepare(
        `INSERT INTO tasks (id, project_id, title, status, provider, task_stable_id, workspace_identity,
          base_branch, base_sha, task_branch, active_run_id, next_run_generation, revision, archived_at,
          created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.projectId,
        record.title,
        record.status,
        input.provider,
        record.taskStableId,
        record.workspaceIdentity,
        record.baseBranch,
        record.baseSha,
        record.taskBranch,
        record.activeRunId,
        record.nextRunGeneration,
        record.revision,
        record.archivedAt,
        record.createdAt,
        record.updatedAt,
      );
    return record;
  }

  public setTaskStatus(id: string, status: CloudTaskStatus): void {
    this.db
      .prepare("UPDATE tasks SET status = ?, updated_at = ?, revision = revision + 1 WHERE id = ?")
      .run(status, Date.now(), id);
  }

  public archiveTask(id: string): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE tasks SET status = 'archived', archived_at = ?, updated_at = ?, revision = revision + 1 WHERE id = ?",
      )
      .run(now, now, id);
  }

  public beginRun(taskId: string, runId: string, generation: number): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          "UPDATE tasks SET active_run_id = ?, next_run_generation = ?, status = 'active', updated_at = ?, revision = revision + 1 WHERE id = ?",
        )
        .run(runId, generation + 1, Date.now(), taskId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  public clearActiveRun(taskId: string, runId: string): void {
    this.db
      .prepare(
        "UPDATE tasks SET active_run_id = NULL, updated_at = ? WHERE id = ? AND active_run_id = ?",
      )
      .run(Date.now(), taskId, runId);
  }

  // ── runs ────────────────────────────────────────────────────

  public createRun(input: {
    id: string;
    taskId: string;
    generation: number;
    provider: string;
    templateVersion: string;
    checkoutPath: string;
    attachTokenEnc: string;
  }): RunRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO runs (id, task_id, generation, status, provider, provider_handle, template_version,
          checkout_path, attach_token_enc, created_at, ready_at, ended_at, end_reason, last_error, data_at_risk)
         VALUES (?, ?, ?, 'provisioning', ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL, NULL, 0)`,
      )
      .run(
        input.id,
        input.taskId,
        input.generation,
        input.provider,
        input.templateVersion,
        input.checkoutPath,
        input.attachTokenEnc,
        now,
      );
    this.beginRun(input.taskId, input.id, input.generation);
    return this.requireRun(input.id);
  }

  public getRun(id: string): RunRecord | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? rowToRun(row) : null;
  }

  private requireRun(id: string): RunRecord {
    const run = this.getRun(id);
    if (!run) throw new Error(`run not found: ${id}`);
    return run;
  }

  public listRuns(taskId: string): RunRecord[] {
    return this.db
      .prepare("SELECT * FROM runs WHERE task_id = ? ORDER BY generation DESC LIMIT 50")
      .all(taskId)
      .map(rowToRun);
  }

  public updateRun(
    id: string,
    patch: Partial<
      Pick<
        RunRecord,
        | "status"
        | "providerHandle"
        | "readyAt"
        | "endedAt"
        | "endReason"
        | "lastError"
        | "dataAtRisk"
      >
    >,
  ): void {
    const current = this.requireRun(id);
    this.db
      .prepare(
        `UPDATE runs SET status = ?, provider_handle = ?, ready_at = ?, ended_at = ?, end_reason = ?,
          last_error = ?, data_at_risk = ? WHERE id = ?`,
      )
      .run(
        patch.status ?? current.status,
        patch.providerHandle === undefined ? current.providerHandle : patch.providerHandle,
        patch.readyAt === undefined ? current.readyAt : patch.readyAt,
        patch.endedAt === undefined ? current.endedAt : patch.endedAt,
        patch.endReason === undefined ? current.endReason : patch.endReason,
        patch.lastError === undefined ? current.lastError : patch.lastError,
        (patch.dataAtRisk ?? current.dataAtRisk) ? 1 : 0,
        id,
      );
  }

  // ── inputs ──────────────────────────────────────────────────

  public appendInput(input: {
    taskId: string;
    commandId: string;
    intent: CloudInputIntent;
    payloadJson: string;
    payloadHash: string;
  }): InputRecord {
    const existing = this.getInput(input.taskId, input.commandId);
    if (existing) {
      return existing;
    }
    const max = this.db
      .prepare("SELECT COALESCE(MAX(acceptance_seq), 0) AS seq FROM inputs WHERE task_id = ?")
      .get(input.taskId) as { seq: number } | undefined;
    const record: InputRecord = {
      id: randomUUID(),
      taskId: input.taskId,
      commandId: input.commandId,
      intent: input.intent,
      payloadJson: input.payloadJson,
      payloadHash: input.payloadHash,
      acceptanceSeq: Number(max?.seq ?? 0) + 1,
      deliveryStatus: "accepted",
      targetRunId: null,
      deliveredAt: null,
      runtimeAckedAt: null,
      lastError: null,
      createdAt: Date.now(),
    };
    this.db
      .prepare(
        `INSERT INTO inputs (id, task_id, command_id, intent, payload_json, payload_hash, acceptance_seq,
          delivery_status, target_run_id, delivered_at, runtime_acked_at, last_error, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        record.id,
        record.taskId,
        record.commandId,
        record.intent,
        record.payloadJson,
        record.payloadHash,
        record.acceptanceSeq,
        record.deliveryStatus,
        record.targetRunId,
        record.deliveredAt,
        record.runtimeAckedAt,
        record.lastError,
        record.createdAt,
      );
    return record;
  }

  public getInput(taskId: string, commandId: string): InputRecord | null {
    const row = this.db
      .prepare("SELECT * FROM inputs WHERE task_id = ? AND command_id = ?")
      .get(taskId, commandId);
    return row ? rowToInput(row) : null;
  }

  public listDeliverableInputs(taskId: string, _runId: string): InputRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM inputs
         WHERE task_id = ? AND delivery_status IN ('accepted', 'delivered')
         ORDER BY acceptance_seq ASC LIMIT 100`,
      )
      .all(taskId)
      .map(rowToInput);
  }

  public markInputDelivered(id: string, runId: string): void {
    this.db
      .prepare(
        "UPDATE inputs SET delivery_status = 'delivered', target_run_id = ?, delivered_at = ? WHERE id = ?",
      )
      .run(runId, Date.now(), id);
  }

  public markInputAcked(id: string): void {
    this.db
      .prepare("UPDATE inputs SET delivery_status = 'acked', runtime_acked_at = ? WHERE id = ?")
      .run(Date.now(), id);
  }

  public markInputFailed(id: string, message: string): void {
    this.db
      .prepare("UPDATE inputs SET delivery_status = 'failed', last_error = ? WHERE id = ?")
      .run(message, id);
  }

  public hasInputIntent(taskId: string, intent: CloudInputIntent): boolean {
    const row = this.db
      .prepare("SELECT 1 AS present FROM inputs WHERE task_id = ? AND intent = ? LIMIT 1")
      .get(taskId, intent) as { present: number } | undefined;
    return Boolean(row);
  }

  // ── artifacts ───────────────────────────────────────────────

  public setArtifact(input: {
    taskId: string;
    kind: "code" | "noChanges";
    taskBranch?: string | null;
    prNumber?: number | null;
    prUrl?: string | null;
    prStatus?: string | null;
    publishedSha?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO artifacts (task_id, kind, task_branch, pr_number, pr_url, pr_status, published_sha, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.taskId,
        input.kind,
        input.taskBranch ?? null,
        input.prNumber ?? null,
        input.prUrl ?? null,
        input.prStatus ?? null,
        input.publishedSha ?? null,
        Date.now(),
      );
  }

  public getArtifact(taskId: string): ArtifactRecord | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE task_id = ?").get(taskId);
    if (!row) {
      return null;
    }
    return {
      taskId: String(row["task_id"]),
      kind: String(row["kind"]) as ArtifactRecord["kind"],
      taskBranch: row["task_branch"] == null ? null : String(row["task_branch"]),
      prNumber: row["pr_number"] == null ? null : Number(row["pr_number"]),
      prUrl: row["pr_url"] == null ? null : String(row["pr_url"]),
      prStatus: row["pr_status"] == null ? null : String(row["pr_status"]),
      publishedSha: row["published_sha"] == null ? null : String(row["published_sha"]),
      updatedAt: Number(row["updated_at"]),
    };
  }

  // ── projections ─────────────────────────────────────────────

  public appendProjection(input: {
    taskId: string;
    logEpoch: number;
    seq: number;
    kind: string;
    payloadJson: string;
  }): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO projections (task_id, log_epoch, seq, kind, payload_json, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.taskId, input.logEpoch, input.seq, input.kind, input.payloadJson, Date.now());
  }

  public listProjections(taskId: string, after: string | null, limit: number): ProjectionRecord[] {
    const capped = Math.min(Math.max(limit, 1), 500);
    if (!after) {
      return this.db
        .prepare(
          "SELECT * FROM projections WHERE task_id = ? ORDER BY log_epoch ASC, seq ASC LIMIT ?",
        )
        .all(taskId, capped)
        .map((row) => ({
          taskId: String(row["task_id"]),
          logEpoch: Number(row["log_epoch"]),
          seq: Number(row["seq"]),
          kind: String(row["kind"]),
          payloadJson: String(row["payload_json"]),
          ingestedAt: Number(row["ingested_at"]),
        }));
    }
    const [epochPart, seqPart] = after.split(":");
    const epoch = Number(epochPart);
    const seq = Number(seqPart);
    if (!Number.isFinite(epoch) || !Number.isFinite(seq)) {
      return [];
    }
    return this.db
      .prepare(
        `SELECT * FROM projections WHERE task_id = ? AND (log_epoch > ? OR (log_epoch = ? AND seq > ?))
         ORDER BY log_epoch ASC, seq ASC LIMIT ?`,
      )
      .all(taskId, epoch, epoch, seq, capped)
      .map((row) => ({
        taskId: String(row["task_id"]),
        logEpoch: Number(row["log_epoch"]),
        seq: Number(row["seq"]),
        kind: String(row["kind"]),
        payloadJson: String(row["payload_json"]),
        ingestedAt: Number(row["ingested_at"]),
      }));
  }
}

/**
 * 行 ↔ 领域记录映射（08 §2 字段语义、03 §4 表约束、W2 §4）。
 *
 * 读取一律经共享严格 schema 校验再返回：DB 里出现非法值属于「持久事实与 wire
 * 契约不一致」，必须立刻暴露，不得把坏行当作合法记录投给 app 层。
 * JSON 列只承载协议已声明的结构化字段（配置、recipe、payload、ack），不承载 secret。
 */
import {
  cloudCheckpointRecordSchema,
  cloudProjectRecordSchema,
  cloudProjectionRecordSchema,
  cloudRunRecordSchema,
  cloudTaskInputRecordSchema,
  cloudTaskRecordSchema,
} from "@zcode/shared";
import type {
  CloudCheckpointRecord,
  CloudProjectRecord,
  CloudProjectionRecord,
  CloudRunRecord,
  CloudTaskInputRecord,
  CloudTaskRecord,
} from "@zcode/shared";
import type { ExternalOperationRecord } from "../../../app/ports/operationOutboxPort.js";
import { CloudStorageError } from "../cloudStorageError.js";

/** node:sqlite 返回的行；列值域由 SQLite 决定，读取函数负责收窄。 */
export type SqlRow = Record<string, unknown>;

export function readText(row: SqlRow, column: string): string {
  const value = row[column];
  if (typeof value === "string") return value;
  throw invalidColumn(row, column, "text");
}

export function readOptionalText(row: SqlRow, column: string): string | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string") return value;
  throw invalidColumn(row, column, "text?");
}

export function readInt(row: SqlRow, column: string): number {
  const value = row[column];
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  throw invalidColumn(row, column, "integer");
}

export function readOptionalInt(row: SqlRow, column: string): number | undefined {
  const value = row[column];
  if (value === null || value === undefined) return undefined;
  return readInt(row, column);
}

function readBool(row: SqlRow, column: string): boolean {
  return readInt(row, column) !== 0;
}

function readOptionalBool(row: SqlRow, column: string): boolean | undefined {
  const value = readOptionalInt(row, column);
  return value === undefined ? undefined : value !== 0;
}

function invalidColumn(row: SqlRow, column: string, expected: string): CloudStorageError {
  return new CloudStorageError({
    code: "validation_failed",
    reason: "invalid-record",
    message: `列 ${column} 期望 ${expected}，实际 ${typeof row[column]}`,
  });
}

/** JSON 列序列化：undefined 写 NULL，不写 "null" 字符串。 */
export function toJsonColumn(value: unknown): string | null {
  return value === undefined ? null : JSON.stringify(value);
}

function parseJsonColumn(row: SqlRow, column: string): unknown {
  const raw = row[column];
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw !== "string") throw invalidColumn(row, column, "json");
  try {
    return JSON.parse(raw);
  } catch (cause) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-record",
      message: `列 ${column} 不是合法 JSON`,
      cause,
    });
  }
}

/** 用共享严格 schema 解析记录；失败即持久事实与契约漂移。 */
function parseRecord<T>(parse: () => T, source: string): T {
  try {
    return parse();
  } catch (cause) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-record",
      message: `${source} 记录不符合共享契约`,
      cause,
    });
  }
}

export function mapProjectRow(row: SqlRow): CloudProjectRecord {
  return parseRecord(
    () =>
      cloudProjectRecordSchema.parse({
        projectId: readText(row, "project_id"),
        ownerPrincipalId: readText(row, "owner_principal_id"),
        kind: readText(row, "kind"),
        repositoryId: readOptionalInt(row, "repository_id"),
        installationId: readOptionalInt(row, "installation_id"),
        repoOwner: readOptionalText(row, "repo_owner"),
        repoName: readOptionalText(row, "repo_name"),
        defaultBranch: readOptionalText(row, "default_branch"),
        displayName: readOptionalText(row, "display_name"),
        revision: readInt(row, "revision"),
        createdAt: readInt(row, "created_at"),
        updatedAt: readInt(row, "updated_at"),
      }),
    "project",
  );
}

export function mapTaskRow(row: SqlRow): CloudTaskRecord {
  return parseRecord(
    () =>
      cloudTaskRecordSchema.parse({
        taskId: readText(row, "task_id"),
        ownerPrincipalId: readText(row, "owner_principal_id"),
        projectId: readText(row, "project_id"),
        title: readText(row, "title"),
        status: readText(row, "status"),
        creationKey: readText(row, "creation_key"),
        draftStartConfig: parseJsonColumn(row, "draft_start_config_json"),
        baseBranch: readOptionalText(row, "base_branch"),
        baseSha: readOptionalText(row, "base_sha"),
        taskBranch: readOptionalText(row, "task_branch"),
        workspaceIdentity: readText(row, "workspace_identity"),
        activeRunId: readOptionalText(row, "active_run_id"),
        nextRunGeneration: readInt(row, "next_run_generation"),
        lastCheckpointSha: readOptionalText(row, "last_checkpoint_sha"),
        completeRequested: readOptionalBool(row, "complete_requested"),
        prRef: readOptionalText(row, "pr_ref"),
        archivedFromStatus: readOptionalText(row, "archived_from_status"),
        revision: readInt(row, "revision"),
        createdAt: readInt(row, "created_at"),
        updatedAt: readInt(row, "updated_at"),
      }),
    "task",
  );
}

export function mapRunRow(row: SqlRow): CloudRunRecord {
  return parseRecord(
    () =>
      cloudRunRecordSchema.parse({
        runId: readText(row, "run_id"),
        taskId: readText(row, "task_id"),
        runGeneration: readInt(row, "run_generation"),
        executionKind: readText(row, "execution_kind"),
        firstInputCommandId: readOptionalText(row, "first_input_command_id"),
        executionRecipe: parseJsonColumn(row, "execution_recipe_json"),
        stopRequested: readOptionalBool(row, "stop_requested"),
        stopOperationId: readOptionalText(row, "stop_operation_id"),
        provider: readOptionalText(row, "provider"),
        providerHandle: readOptionalText(row, "provider_handle"),
        workspacePath: readOptionalText(row, "workspace_path"),
        status: readText(row, "status"),
        connectionEpoch: readInt(row, "connection_epoch"),
        runtimeSessionId: readOptionalText(row, "runtime_session_id"),
        expiresAt: readOptionalInt(row, "expires_at"),
        deadlineEstimate: readOptionalInt(row, "deadline_estimate"),
        deadlineConfidence: readOptionalText(row, "deadline_confidence"),
        hardDeadlineAt: readOptionalInt(row, "hard_deadline_at"),
        lastBusinessActivityAt: readOptionalInt(row, "last_business_activity_at"),
        endReason: readOptionalText(row, "end_reason"),
        lastError: readOptionalText(row, "last_error"),
        dataAtRisk: readBool(row, "data_at_risk"),
        createdAt: readInt(row, "created_at"),
        updatedAt: readInt(row, "updated_at"),
      }),
    "run",
  );
}

export function mapInputRow(row: SqlRow): CloudTaskInputRecord {
  return parseRecord(
    () =>
      cloudTaskInputRecordSchema.parse({
        taskId: readText(row, "task_id"),
        commandId: readText(row, "command_id"),
        intent: readText(row, "intent"),
        payloadHash: readText(row, "payload_hash"),
        acceptanceSeq: readInt(row, "acceptance_seq"),
        attachmentRefs: parseJsonColumn(row, "attachment_ids_json"),
        requestedConfig: parseJsonColumn(row, "requested_config_json"),
        resolvedExecutionConfig: parseJsonColumn(row, "resolved_execution_config_json"),
        resolvedAuthorizationRef: readOptionalText(row, "resolved_authorization_ref"),
        retryOfCommandId: readOptionalText(row, "retry_of_command_id"),
        acceptedAt: readInt(row, "accepted_at"),
        targetRunId: readOptionalText(row, "target_run_id"),
        runtimeSessionId: readOptionalText(row, "runtime_session_id"),
        deliveryStatus: readText(row, "delivery_status"),
        runtimeAck: parseJsonColumn(row, "runtime_ack_json"),
        lastError: readOptionalText(row, "last_error"),
      }),
    "input",
  );
}

export function mapCheckpointRow(row: SqlRow): CloudCheckpointRecord {
  return parseRecord(
    () =>
      cloudCheckpointRecordSchema.parse({
        operationId: readText(row, "operation_id"),
        taskId: readText(row, "task_id"),
        runId: readText(row, "run_id"),
        runGeneration: readInt(row, "run_generation"),
        state: readText(row, "state"),
        includedFiles: parseJsonColumn(row, "included_files_json") ?? [],
        localSha: readOptionalText(row, "local_sha"),
        confirmedRemoteSha: readOptionalText(row, "confirmed_remote_sha"),
        riskSummary: readOptionalText(row, "risk_summary"),
        createdAt: readInt(row, "created_at"),
        updatedAt: readInt(row, "updated_at"),
      }),
    "checkpoint",
  );
}

export function mapProjectionRow(row: SqlRow): CloudProjectionRecord {
  return parseRecord(
    () =>
      cloudProjectionRecordSchema.parse({
        schemaVersion: readInt(row, "schema_version"),
        taskId: readText(row, "task_id"),
        runId: readText(row, "run_id"),
        runGeneration: readInt(row, "run_generation"),
        runtimeIncarnation: readText(row, "runtime_incarnation"),
        topic: readText(row, "topic"),
        logEpoch: readText(row, "log_epoch"),
        sourceSeq: readInt(row, "source_seq"),
        kind: readText(row, "kind"),
        payload: parseJsonColumn(row, "payload_json"),
        contentHash: readText(row, "content_hash"),
      }),
    "projection",
  );
}

export function mapOperationRow(row: SqlRow): ExternalOperationRecord {
  return {
    operationId: readText(row, "operation_id"),
    kind: readText(row, "kind") as ExternalOperationRecord["kind"],
    idempotencyKey: readText(row, "idempotency_key"),
    taskId: readOptionalText(row, "task_id"),
    runId: readOptionalText(row, "run_id"),
    runGeneration: readOptionalInt(row, "run_generation"),
    state: readText(row, "state") as ExternalOperationRecord["state"],
    attempt: readInt(row, "attempt"),
    leaseExpiresAt: readOptionalInt(row, "lease_expires_at"),
    resultRef: readOptionalText(row, "result_ref"),
    errorCode: readOptionalText(row, "error_code") as ExternalOperationRecord["errorCode"],
    createdAt: readInt(row, "created_at"),
    updatedAt: readInt(row, "updated_at"),
  };
}

/**
 * 用户资源 profile repository 的内部共享件（specs/cloud-agent 14 §9.2①/§9.4）。
 *
 * 拆出独立文件的原因：`userProfileRepo.ts` 触及架构门禁的 max-file-lines（400 原始行）。
 * 本文件只放「派生 sha256/bytes、manifest 解析、版本行读取、条目行映射、版本修剪」这些
 * 被多个写事务共用的纯/IO 小件；写事务与 handler 表仍在 `userProfileRepo.ts`。
 * 不导出到仓储之外（`storageWorkerRuntime` 只消费 handler 表）。
 */
import { createHash } from "node:crypto";
import {
  CLOUD_USER_PROFILE_RETAINED_VERSIONS,
  cloudUserProfileEntrySchema,
  cloudUserProfileSnapshotSchema,
  type CloudUserProfileEntry,
  type CloudUserProfileSnapshot,
} from "@zcode/shared";
import {
  sortUserProfileEntries,
  userProfileMcpConfigByteLength,
  userProfileUtf8ByteLength,
  type UserProfileEntryContentKind,
} from "../../../domain/userProfile.js";
import type { UserProfileEntryRecord } from "../../../app/ports/userProfileStorePort.js";
import type { StorageContext } from "../sqlite/database.js";
import { readInt, readText } from "../sqlite/rowMapping.js";
import type { SqlRow } from "../sqlite/rowMapping.js";
import { CloudStorageError } from "../cloudStorageError.js";

// ── 派生与行映射 ──

export function sha256OfUtf8(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** 正文 → `{sha256, bytes}`（口径见文件头；归档按**解码后**字节，文本类按 UTF-8 字节）。 */
export function deriveContentFacts(
  contentKind: UserProfileEntryContentKind,
  content: string,
): { sha256: string; bytes: number } {
  if (contentKind === "archive-base64") {
    const decoded = Buffer.from(content, "base64");
    return {
      sha256: createHash("sha256").update(decoded).digest("hex"),
      bytes: decoded.byteLength,
    };
  }
  if (contentKind === "mcp-config") {
    return { sha256: sha256OfUtf8(content), bytes: userProfileMcpConfigByteLength(content) };
  }
  // `markdown`（commands/subagents 单文件正文）与 `agents-md`：UTF-8 字节口径同一（14 §4.5）。
  return { sha256: sha256OfUtf8(content), bytes: userProfileUtf8ByteLength(content) };
}

export function invalidRecord(message: string, cause?: unknown): CloudStorageError {
  return new CloudStorageError({
    code: "validation_failed",
    reason: "invalid-record",
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

/** manifest 解析：坏 JSON/坏条目是持久事实与契约漂移，立刻抛错（不静默跳过）。 */
export function parseManifest(manifestJson: string): CloudUserProfileEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(manifestJson);
  } catch (cause) {
    throw invalidRecord("profile_versions.manifest_json 不是合法 JSON", cause);
  }
  if (!Array.isArray(parsed)) throw invalidRecord("profile_versions.manifest_json 必须是数组");
  try {
    return parsed.map((entry) => cloudUserProfileEntrySchema.parse(entry));
  } catch (cause) {
    throw invalidRecord("profile manifest 条目不符合共享契约", cause);
  }
}

export interface VersionRow {
  row: SqlRow;
  profileVersion: number;
  manifest: CloudUserProfileEntry[];
  createdAtMs: number;
}

export function selectVersionRow(
  context: StorageContext,
  profileVersion: number,
): VersionRow | undefined {
  const row = context.db
    .prepare("SELECT * FROM profile_versions WHERE profile_version = ?")
    .get(profileVersion);
  if (!row) return undefined;
  return {
    row,
    profileVersion: readInt(row, "profile_version"),
    manifest: parseManifest(readText(row, "manifest_json")),
    createdAtMs: readInt(row, "created_at"),
  };
}

export function requireCurrentVersionRow(context: StorageContext): VersionRow {
  const row = context.db
    .prepare("SELECT * FROM profile_versions ORDER BY profile_version DESC LIMIT 1")
    .get();
  if (!row) {
    // 迁移种下空版本 1（tables/profile.ts），缺席即持久层损坏：fail-closed。
    throw invalidRecord("profile_versions 缺少当前版本行（迁移种子丢失）");
  }
  return {
    row,
    profileVersion: readInt(row, "profile_version"),
    manifest: parseManifest(readText(row, "manifest_json")),
    createdAtMs: readInt(row, "created_at"),
  };
}

export function snapshotOf(version: VersionRow): CloudUserProfileSnapshot {
  const entries = sortUserProfileEntries(version.manifest);
  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  return cloudUserProfileSnapshotSchema.parse({
    profileVersion: version.profileVersion,
    entries,
    totalBytes,
    createdAtMs: version.createdAtMs,
  });
}

export function entryKey(category: string, entryId: string, sha256: string): string {
  return `${category}\u0000${entryId}\u0000${sha256}`;
}

export function readEntryRow(
  context: StorageContext,
  entry: CloudUserProfileEntry,
): SqlRow | undefined {
  return context.db
    .prepare("SELECT * FROM profile_entries WHERE category = ? AND entry_id = ? AND sha256 = ?")
    .get(entry.category, entry.entryId, entry.sha256);
}

/**
 * 条目记录 = **manifest 元数据** + 内容寻址行的正文（14 §9.2①：manifest 是该版本的
 * 全量条目元数据数组，`enabled`/`displayName`/`bytes` 属版本事实）。
 *
 * 为什么不是"从行里读全部元数据"：条目行按 `(category, entry_id, sha256)` 内容寻址，
 * 同一 sha 会被多个版本引用（替换/开关后旧版本仍须可解析，14 §9.2①）。元数据若取自行，
 * 一次开关就会改写旧版本在途 Run 看到的值，U-08「运行中 Run 不变」随即失效（P20 修复：
 * 原实现经 `recordOfRow` 从行取 `enabled`）。
 */
export function recordOfManifestEntry(
  entry: CloudUserProfileEntry,
  row: SqlRow,
): UserProfileEntryRecord {
  return {
    ...entry,
    contentKind: readText(row, "content_kind") as UserProfileEntryContentKind,
    content: readText(row, "content"),
  };
}

// ── 修剪（14 §9.2①：保留窗口 + 引用计数）──

export function pruneProfileVersions(context: StorageContext): void {
  const versions = context.db
    .prepare("SELECT profile_version FROM profile_versions ORDER BY profile_version DESC")
    .all()
    .map((row) => readInt(row as SqlRow, "profile_version"));
  const retained = versions.slice(0, CLOUD_USER_PROFILE_RETAINED_VERSIONS);
  if (versions.length > retained.length) {
    const placeholders = retained.map(() => "?").join(", ");
    context.db
      .prepare(`DELETE FROM profile_versions WHERE profile_version NOT IN (${placeholders})`)
      .run(...retained);
  }
  // 引用计数：保留窗口内任一 manifest 引用到的条目行保留，其余（含被替换的旧 sha 行）
  // 删除；正文不入 manifest，引用键 = (category, entry_id, sha256)。
  const referenced = new Set<string>();
  for (const profileVersion of retained) {
    const version = selectVersionRow(context, profileVersion);
    if (!version) continue;
    for (const entry of version.manifest) {
      referenced.add(entryKey(entry.category, entry.entryId, entry.sha256));
    }
  }
  const rows = context.db.prepare("SELECT category, entry_id, sha256 FROM profile_entries").all();
  const remove = context.db.prepare(
    "DELETE FROM profile_entries WHERE category = ? AND entry_id = ? AND sha256 = ?",
  );
  for (const row of rows as SqlRow[]) {
    const category = readText(row, "category");
    const entryId = readText(row, "entry_id");
    const sha256 = readText(row, "sha256");
    if (!referenced.has(entryKey(category, entryId, sha256))) {
      remove.run(category, entryId, sha256);
    }
  }
}

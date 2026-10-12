/**
 * 用户资源 profile repository（M8；specs/cloud-agent 14 §9.2①/§9.4；`profile_entries`/`profile_versions`）。
 *
 * 唯一写入方是控制面 profile store（本文件）；写事务内完成：派生 sha256/bytes → 幂等判定
 * （同 key 同内容不递增）→ 聚合上限判定 → 条目行 upsert → 版本 manifest 递增 → 修剪
 * （保留 8 个版本 + 按 `(category, entry_id, sha256)` 引用计数删无引用条目行）。
 *
 * P20 追加（14 §9.4）：`readEntry`（当前版本单条元数据 + 正文，UI 编辑回显）与
 * `setEntryEnabled`（条目级开关，同事务改 manifest + 同步行冗余列 + 值变化才递增版本）。
 *
 * 派生规则（14 §9.2①，客户端不能自报 `sha256`/`bytes`）：
 * - `archive-base64`：解码后归档字节的 sha256/字节数（skills/plugins）；
 * - `mcp-config`：JSON 文本 UTF-8 字节的 sha256，`bytes` 取 JSON 字符数（§9.1④ 口径）；
 * - `markdown` / `agents-md`：正文 UTF-8 字节的 sha256/字节数（14 §4.5 同一口径）。
 *
 * 元数据权威（14 §9.2①）：**manifest 是版本的条目元数据**（`enabled`/`displayName`/`bytes`/`sha256`），
 * 内容寻址行只提供正文与 `content_kind`；读路径统一经 `recordOfManifestEntry` 组装，
 * 行上的元数据列只是当前版本的冗余投影，不参与决策。
 *
 * 读取一律经共享严格 schema 校验（坏行立刻暴露，不把漂移投给 app 层）；
 * `readVersionEntries` 对**任一** manifest 条目的正文行缺失返回 null（整版本不可解析，
 * 调用方按结构化失败收口，14 §9.2④）。
 */
import {
  CLOUD_USER_PROFILE_MAX_ENTRIES,
  CLOUD_USER_PROFILE_TOTAL_MAX_BYTES,
  cloudUserProfileCategorySchema,
  type CloudUserProfileEntry,
  type CloudUserProfileSnapshot,
} from "@zcode/shared";
import {
  sortUserProfileEntries,
  userProfileContentKindOf,
  userProfileEntryBytesExceedLimit,
} from "../../../domain/userProfile.js";
import type {
  UserProfileDeleteResult,
  UserProfileEntryRecord,
  UserProfileSetEnabledResult,
  UserProfileUpsertRequest,
  UserProfileUpsertResult,
} from "../../../app/ports/userProfileStorePort.js";
import {
  deriveContentFacts,
  invalidRecord,
  pruneProfileVersions,
  readEntryRow,
  recordOfManifestEntry,
  requireCurrentVersionRow,
  selectVersionRow,
  snapshotOf,
} from "./userProfileRepoHelpers.js";
import { withWriteTransaction } from "../sqlite/database.js";
import type { StorageContext } from "../sqlite/database.js";
import type { StorageHandlerTable } from "../storageMethodTypes.js";

// ── 写路径（调用方必须已在写事务内）──

function upsertEntryInTransaction(
  context: StorageContext,
  request: UserProfileUpsertRequest,
): UserProfileUpsertResult {
  const category = cloudUserProfileCategorySchema.safeParse(request.category);
  if (!category.success) {
    return { status: "rejected", code: "invalid_entry", reason: "invalid-category" };
  }
  const contentKind = userProfileContentKindOf(category.data);
  if (contentKind !== request.contentKind) {
    return { status: "rejected", code: "invalid_entry", reason: "content-kind-mismatch" };
  }
  const facts = deriveContentFacts(contentKind, request.content);
  if (userProfileEntryBytesExceedLimit(category.data, facts.bytes)) {
    // 写事务内以真实值判定（14 §9.2①）：单条超类别上限 → 413 口径。
    return {
      status: "rejected",
      code: "payload_too_large",
      reason: `${category.data}-entry-too-large`,
    };
  }
  const entry: CloudUserProfileEntry = {
    category: category.data,
    entryId: request.entryId,
    ...(request.displayName === undefined ? {} : { displayName: request.displayName }),
    enabled: request.enabled,
    sha256: facts.sha256,
    bytes: facts.bytes,
  };

  const current = requireCurrentVersionRow(context);
  const existing = current.manifest.find(
    (item) => item.category === entry.category && item.entryId === entry.entryId,
  );
  if (
    existing &&
    existing.sha256 === entry.sha256 &&
    existing.enabled === entry.enabled &&
    existing.displayName === entry.displayName
  ) {
    // 幂等整条替换（14 §9.2①）：同 key 同内容/元数据 → 不递增版本，返回当前版本。
    return { status: "ok", entry: existing, profileVersion: current.profileVersion };
  }

  const nextManifest = sortUserProfileEntries([
    ...current.manifest.filter(
      (item) => !(item.category === entry.category && item.entryId === entry.entryId),
    ),
    entry,
  ]);
  if (nextManifest.length > CLOUD_USER_PROFILE_MAX_ENTRIES) {
    return {
      status: "rejected",
      code: "profile_entries_exceeded",
      reason: "profile-entries-exceeded",
    };
  }
  const totalBytes = nextManifest.reduce((sum, item) => sum + item.bytes, 0);
  if (totalBytes > CLOUD_USER_PROFILE_TOTAL_MAX_BYTES) {
    return { status: "rejected", code: "profile_total_exceeded", reason: "profile-total-exceeded" };
  }

  context.db
    .prepare(
      `INSERT INTO profile_entries (
         category, entry_id, sha256, display_name, enabled, bytes, content_kind, content, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(category, entry_id, sha256) DO UPDATE SET
         display_name = excluded.display_name,
         enabled = excluded.enabled,
         bytes = excluded.bytes,
         content_kind = excluded.content_kind,
         content = excluded.content,
         updated_at = excluded.updated_at`,
    )
    .run(
      entry.category,
      entry.entryId,
      entry.sha256,
      entry.displayName ?? null,
      entry.enabled ? 1 : 0,
      entry.bytes,
      contentKind,
      request.content,
      request.now,
    );
  const profileVersion = current.profileVersion + 1;
  context.db
    .prepare(
      "INSERT INTO profile_versions (profile_version, manifest_json, created_at) VALUES (?, ?, ?)",
    )
    .run(profileVersion, JSON.stringify(nextManifest), request.now);
  pruneProfileVersions(context);
  return { status: "ok", entry, profileVersion };
}

function deleteEntryInTransaction(
  context: StorageContext,
  request: { category: string; entryId: string; now: number },
): UserProfileDeleteResult {
  const category = cloudUserProfileCategorySchema.safeParse(request.category);
  if (!category.success) {
    return { status: "rejected", code: "invalid_entry", reason: "invalid-category" };
  }
  const current = requireCurrentVersionRow(context);
  const target = current.manifest.find(
    (item) => item.category === category.data && item.entryId === request.entryId,
  );
  if (!target) {
    // 键不存在：整条幂等无操作（版本不变），不制造空版本噪声。
    return { status: "ok", profileVersion: current.profileVersion, deleted: false };
  }
  const nextManifest = sortUserProfileEntries(
    current.manifest.filter(
      (item) => !(item.category === category.data && item.entryId === request.entryId),
    ),
  );
  const profileVersion = current.profileVersion + 1;
  context.db
    .prepare(
      "INSERT INTO profile_versions (profile_version, manifest_json, created_at) VALUES (?, ?, ?)",
    )
    .run(profileVersion, JSON.stringify(nextManifest), request.now);
  // 条目行不立即删除：旧版本 manifest 仍引用它；窗口外由引用计数修剪（pruneProfileVersions）。
  pruneProfileVersions(context);
  return { status: "ok", profileVersion, deleted: true };
}

/**
 * 条目级开关（14 §9.4①）：同事务内改 manifest 的 `enabled` + 递增版本 + 修剪。
 *
 * 三个要点：
 * - 交付集合（manifest 的 enabled 子集）是版本事实，所以**值变化才递增**；请求值等于当前值
 *   时按"重复提交同结果"返回当前版本（幂等，与 PUT 的同 key 同内容不递增同型）；
 * - 内容寻址行的 `enabled` 列同步写（它是"当前版本"的冗余投影，供人肉排查；权威读路径
 *   一律以 manifest 为准，见 `recordOfManifestEntry`）；
 * - 键不在当前 manifest → `not_found`，不制造空版本。
 */
function setEntryEnabledInTransaction(
  context: StorageContext,
  request: { category: string; entryId: string; enabled: boolean; now: number },
): UserProfileSetEnabledResult {
  const category = cloudUserProfileCategorySchema.safeParse(request.category);
  if (!category.success) {
    return { status: "rejected", code: "invalid_entry", reason: "invalid-category" };
  }
  const current = requireCurrentVersionRow(context);
  const target = current.manifest.find(
    (item) => item.category === category.data && item.entryId === request.entryId,
  );
  if (!target) return { status: "not_found" };
  if (target.enabled === request.enabled) {
    // 幂等：重复提交同一开关值不产生新版本（请求意图已在当前版本里成立）。
    return { status: "ok", entry: target, profileVersion: current.profileVersion };
  }

  const updated: CloudUserProfileEntry = { ...target, enabled: request.enabled };
  const nextManifest = sortUserProfileEntries(
    current.manifest.map((item) =>
      item.category === updated.category && item.entryId === updated.entryId ? updated : item,
    ),
  );
  const profileVersion = current.profileVersion + 1;
  context.db
    .prepare(
      "INSERT INTO profile_versions (profile_version, manifest_json, created_at) VALUES (?, ?, ?)",
    )
    .run(profileVersion, JSON.stringify(nextManifest), request.now);
  context.db
    .prepare(
      "UPDATE profile_entries SET enabled = ?, updated_at = ? WHERE category = ? AND entry_id = ? AND sha256 = ?",
    )
    .run(request.enabled ? 1 : 0, request.now, updated.category, updated.entryId, updated.sha256);
  pruneProfileVersions(context);
  return { status: "ok", entry: updated, profileVersion };
}

export const userProfileRepoHandlers = {
  "userProfile.snapshot": (context: StorageContext): CloudUserProfileSnapshot =>
    snapshotOf(requireCurrentVersionRow(context)),

  "userProfile.readVersion": (
    context: StorageContext,
    params: { profileVersion: number },
  ): CloudUserProfileSnapshot | null => {
    const version = selectVersionRow(context, params.profileVersion);
    return version ? snapshotOf(version) : null;
  },

  "userProfile.readVersionEntries": (
    context: StorageContext,
    params: { profileVersion: number },
  ): UserProfileEntryRecord[] | null => {
    const version = selectVersionRow(context, params.profileVersion);
    if (!version) return null;
    const records: UserProfileEntryRecord[] = [];
    for (const entry of version.manifest) {
      const row = readEntryRow(context, entry);
      // 任一条目正文不可解析 ⇒ 整版本不可解析（fail-closed，不装半份）。
      if (!row) return null;
      records.push(recordOfManifestEntry(entry, row));
    }
    return records;
  },

  "userProfile.readEntry": (
    context: StorageContext,
    params: { category: string; entryId: string },
  ): UserProfileEntryRecord | null => {
    const current = requireCurrentVersionRow(context);
    const entry = current.manifest.find(
      (item) => item.category === params.category && item.entryId === params.entryId,
    );
    if (!entry) return null;
    const row = readEntryRow(context, entry);
    if (!row) {
      // 当前版本引用的正文行缺失 = 持久层损坏（写入与 manifest 同事务），fail-closed。
      throw invalidRecord(
        `profile entry content row missing for ${params.category}/${params.entryId}`,
      );
    }
    return recordOfManifestEntry(entry, row);
  },

  "userProfile.upsertEntry": (
    context: StorageContext,
    params: UserProfileUpsertRequest,
  ): UserProfileUpsertResult =>
    withWriteTransaction(context, () => upsertEntryInTransaction(context, params)),

  "userProfile.deleteEntry": (
    context: StorageContext,
    params: { category: string; entryId: string; now: number },
  ): UserProfileDeleteResult =>
    withWriteTransaction(context, () => deleteEntryInTransaction(context, params)),

  "userProfile.setEntryEnabled": (
    context: StorageContext,
    params: { category: string; entryId: string; enabled: boolean; now: number },
  ): UserProfileSetEnabledResult =>
    withWriteTransaction(context, () => setEntryEnabledInTransaction(context, params)),
} satisfies Pick<
  StorageHandlerTable,
  | "userProfile.snapshot"
  | "userProfile.readVersion"
  | "userProfile.readVersionEntries"
  | "userProfile.readEntry"
  | "userProfile.upsertEntry"
  | "userProfile.deleteEntry"
  | "userProfile.setEntryEnabled"
>;

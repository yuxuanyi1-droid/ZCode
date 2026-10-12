/**
 * M8 用户资源 profile store 测试替身（specs/cloud-agent 14 §9.2①/§9.4；W11）。
 *
 * 拆出独立文件以保持 `cloudCoreAdapterFakes.ts` 的单文件行数预算（与
 * `cloudCoreGitGrantFakes.ts`/`cloudCoreDriverFake.ts` 同样的拆分理由）；本文件不是测试文件
 * （不匹配 `*.test.ts`，故 max-lines 仍适用）。由 `cloudCoreAdapterFakes.ts` 统一转出，
 * 测试只 import 那个入口。
 */
import type { UserProfileEntryRecord } from "../src/cloud/app/ports/userProfileStorePort.js";
import type {
  UserProfileDeleteResult,
  UserProfileSetEnabledResult,
  UserProfileStorePort,
  UserProfileUpsertRequest,
  UserProfileUpsertResult,
} from "../src/cloud/app/ports/userProfileStorePort.js";
import { sortUserProfileEntries } from "../src/cloud/domain/userProfile.js";

/**
 * 内存版本表 + 可注入的"被修剪"版本：直接摆放某版本的条目（含正文与 sha256/bytes），
 * 供下发组装用例使用；HTTP/SQLite 用例走真实 store（`openTestStorage().userProfile`）。
 */
export interface FakeUserProfileStore extends UserProfileStorePort {
  readonly versions: Map<number, UserProfileEntryRecord[]>;
  /** 被"修剪"的版本号：readVersion/readVersionEntries 返回 null（14 §9.2④ fail-closed）。 */
  readonly pruned: Set<number>;
  current: number;
  snapshotCreatedAtMs: number;
  /** 写路径拒绝注入（上限错误码的正反例）；null 表示按内存语义正常写。 */
  rejectUpsert: UserProfileUpsertResult | null;
  readonly upserts: UserProfileUpsertRequest[];
  readonly deletes: { category: string; entryId: string; now: number }[];
  /** PATCH 开关记录（14 §9.4①）：断言"开关请求确实到了 store"。 */
  readonly enabledPatches: {
    category: string;
    entryId: string;
    enabled: boolean;
    now: number;
  }[];
}

export function createFakeUserProfileStore(initial?: {
  profileVersion?: number;
  entries?: UserProfileEntryRecord[];
}): FakeUserProfileStore {
  const versions = new Map<number, UserProfileEntryRecord[]>();
  const pruned = new Set<number>();
  const upserts: UserProfileUpsertRequest[] = [];
  const deletes: { category: string; entryId: string; now: number }[] = [];
  const enabledPatches: {
    category: string;
    entryId: string;
    enabled: boolean;
    now: number;
  }[] = [];
  const fake: FakeUserProfileStore = {
    versions,
    pruned,
    current: initial?.profileVersion ?? 1,
    snapshotCreatedAtMs: 1_700_000_000_000,
    rejectUpsert: null,
    upserts,
    deletes,
    enabledPatches,
    async snapshot() {
      const entries = sortUserProfileEntries(versions.get(fake.current) ?? []);
      return {
        profileVersion: fake.current,
        entries: entries.map(({ contentKind: _kind, content: _content, ...entry }) => entry),
        totalBytes: entries.reduce((sum, entry) => sum + entry.bytes, 0),
        createdAtMs: fake.snapshotCreatedAtMs,
      };
    },
    async readVersion(profileVersion) {
      if (pruned.has(profileVersion)) return null;
      const entries = versions.get(profileVersion);
      if (!entries) return null;
      const sorted = sortUserProfileEntries(entries);
      return {
        profileVersion,
        entries: sorted.map(({ contentKind: _kind, content: _content, ...entry }) => entry),
        totalBytes: sorted.reduce((sum, entry) => sum + entry.bytes, 0),
        createdAtMs: fake.snapshotCreatedAtMs,
      };
    },
    async readVersionEntries(profileVersion) {
      if (pruned.has(profileVersion)) return null;
      const entries = versions.get(profileVersion);
      return entries ? sortUserProfileEntries(entries) : null;
    },
    async readEntry(request) {
      const entries = versions.get(fake.current) ?? [];
      const found = entries.find(
        (entry) => entry.category === request.category && entry.entryId === request.entryId,
      );
      return found ?? null;
    },
    async upsertEntry(request) {
      upserts.push(request);
      if (fake.rejectUpsert) return fake.rejectUpsert;
      throw new Error("fake user profile upsert is not implemented; use the SQLite store");
    },
    async deleteEntry(request): Promise<UserProfileDeleteResult> {
      deletes.push(request);
      throw new Error("fake user profile delete is not implemented; use the SQLite store");
    },
    async setEntryEnabled(request): Promise<UserProfileSetEnabledResult> {
      enabledPatches.push(request);
      const entries = versions.get(fake.current) ?? [];
      const target = entries.find(
        (entry) => entry.category === request.category && entry.entryId === request.entryId,
      );
      // 语义与 SQLite store 对齐：键不存在 not_found；同值不递增；变化则写新版本 manifest。
      if (!target) return { status: "not_found" };
      if (target.enabled === request.enabled) {
        return { status: "ok", entry: target, profileVersion: fake.current };
      }
      const updated: UserProfileEntryRecord = { ...target, enabled: request.enabled };
      versions.set(
        fake.current + 1,
        sortUserProfileEntries(entries.map((entry) => (entry === target ? updated : entry))),
      );
      fake.current += 1;
      return { status: "ok", entry: updated, profileVersion: fake.current };
    },
  };
  if (initial?.entries) {
    versions.set(initial.profileVersion ?? 1, [...initial.entries]);
  } else {
    versions.set(initial?.profileVersion ?? 1, []);
  }
  return fake;
}

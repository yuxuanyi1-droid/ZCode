/**
 * 云用户资源投影缓存（specs/cloud-agent/14 §3.2/§9.4；W11 §12、W8 §5 的"只投影 + optimistic overlay"）。
 *
 * 权威始终是控制面 profile store（`profileVersion` 由服务端单调递增）：本 store 只缓存
 * **快照投影**（条目元数据 + 版本）与三类客户端事实：
 * - pending：正在进行的写操作（按条目键），用于禁用重复提交；
 * - optimistic overlay：开关切换与删除的临时显示，直到响应回来为止；
 * - 结构化错误：按 code/reason 记录（UI 不解析服务端文案，04 §6）。
 *
 * 回填规则（不建第二权威）：任何写操作的成功响应（`{entry, profileVersion}` /
 * `{profileVersion}`）都按响应覆盖本地投影，并清掉该键的 overlay；**失败时回滚 overlay**
 * 但不改写版本（服务端版本没有变，本地不能自己发明）。
 */
import { create } from "zustand";
import type {
  CloudUserProfileEntry,
  CloudUserProfileEntryPayload,
  CloudUserProfileSnapshot,
} from "@zcode/shared";
import { userResourceEntryKey, type CloudUserResourcesError } from "@/cloud/userResourcesModel.js";

/** 正在进行的写操作（用于禁用对应控件；不阻塞其他条目）。 */
export type CloudUserResourcePendingAction =
  | "upload"
  | "markdown-text"
  | "mcp-json"
  | "agents-md-text"
  | "toggle"
  | "delete";

export interface CloudUserResourceEntryContent {
  readonly payload: CloudUserProfileEntryPayload;
  /** 该条目的 `sha256`：内容缓存与版本事实对不上时作废（避免显示旧版本正文）。 */
  readonly sha256: string;
}

interface CloudUserResourcesState {
  principalId: string | null;
  status: "idle" | "loading" | "ready" | "error";
  /** 整体加载失败（列表级）；条目级失败走 `errorByKey`。 */
  error: CloudUserResourcesError | null;
  profileVersion: number | null;
  totalBytes: number;
  createdAtMs: number | null;
  entries: readonly CloudUserProfileEntry[];
  pendingByKey: Record<string, CloudUserResourcePendingAction>;
  /** 开关的临时显示（true/false）；响应回来后清掉并以响应回填。 */
  enabledOverlay: Record<string, boolean>;
  /** 删除的临时显示：列表里先隐藏，失败回滚。 */
  removedOverlay: Record<string, true>;
  errorByKey: Record<string, CloudUserResourcesError>;
  /** 编辑回显缓存（GET 条目正文）：键 = 条目键，失效条件 = 版本事实（sha256）不符。 */
  contentByKey: Record<string, CloudUserResourceEntryContent>;
  contentStatusByKey: Record<string, "loading" | "ready" | "error">;

  setPrincipal(principalId: string | null): void;
  beginLoad(): void;
  applySnapshot(snapshot: CloudUserProfileSnapshot): void;
  failLoad(error: CloudUserResourcesError): void;
  beginWrite(key: string, action: CloudUserResourcePendingAction): void;
  /** 写失败：撤销该键的 overlay 与 pending，记录结构化错误（版本不动）。 */
  failWrite(key: string, error: CloudUserResourcesError): void;
  /** 写成功回填：以响应为准更新条目元数据与版本，清 pending/overlay/错误。 */
  applyEntryResult(entry: CloudUserProfileEntry, profileVersion: number): void;
  applyDeleteResult(key: string, profileVersion: number): void;
  setEnabledOverlay(key: string, enabled: boolean): void;
  markRemovedOverlay(key: string): void;
  beginContentLoad(key: string): void;
  applyContent(key: string, content: CloudUserResourceEntryContent): void;
  failContent(key: string, error: CloudUserResourcesError): void;
  reset(): void;
}

const INITIAL: Pick<
  CloudUserResourcesState,
  | "principalId"
  | "status"
  | "error"
  | "profileVersion"
  | "totalBytes"
  | "createdAtMs"
  | "entries"
  | "pendingByKey"
  | "enabledOverlay"
  | "removedOverlay"
  | "errorByKey"
  | "contentByKey"
  | "contentStatusByKey"
> = {
  principalId: null,
  status: "idle",
  error: null,
  profileVersion: null,
  totalBytes: 0,
  createdAtMs: null,
  entries: [],
  pendingByKey: {},
  enabledOverlay: {},
  removedOverlay: {},
  errorByKey: {},
  contentByKey: {},
  contentStatusByKey: {},
};

/** 去掉对象里的一个键（不原地改，保证 zustand 状态不可变）。 */
function withoutKey<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record;
  const next = { ...record };
  delete next[key];
  return next;
}

/** 按 `(category, entryId)` 覆盖或追加条目（快照投影的唯一写入形式）。 */
function withEntry(
  entries: readonly CloudUserProfileEntry[],
  entry: CloudUserProfileEntry,
): readonly CloudUserProfileEntry[] {
  const without = entries.filter(
    (candidate) => !(candidate.category === entry.category && candidate.entryId === entry.entryId),
  );
  return [...without, entry];
}

export const useCloudUserResourcesStore = create<CloudUserResourcesState>((set) => ({
  ...INITIAL,

  setPrincipal(principalId) {
    // 主体变化 = 另一个账号的 profile：整体清空，绝不跨主体复用投影（04 §3.4.1 同款规则）。
    set((state) => (state.principalId === principalId ? state : { ...INITIAL, principalId }));
  },

  beginLoad() {
    set((state) => ({ ...state, status: "loading", error: null }));
  },

  applySnapshot(snapshot) {
    set((state) => ({
      ...state,
      status: "ready",
      error: null,
      profileVersion: snapshot.profileVersion,
      totalBytes: snapshot.totalBytes,
      createdAtMs: snapshot.createdAtMs,
      entries: snapshot.entries,
      // 快照是权威投影：已到达的响应不再需要 overlay；未完成的写操作保留 pending。
      enabledOverlay: {},
      removedOverlay: {},
      errorByKey: {},
      contentByKey: Object.fromEntries(
        Object.entries(state.contentByKey).filter(([key, content]) => {
          const [category, entryId] = key.split("\u0000");
          const entry = snapshot.entries.find(
            (candidate) => candidate.category === category && candidate.entryId === entryId,
          );
          return entry !== undefined && entry.sha256 === content.sha256;
        }),
      ),
    }));
  },

  failLoad(error) {
    // 加载失败不改写既有投影（保留 last-known），只标记错误状态。
    set((state) => ({ ...state, status: "error", error }));
  },

  beginWrite(key, action) {
    set((state) => ({
      ...state,
      pendingByKey: { ...state.pendingByKey, [key]: action },
      errorByKey: withoutKey(state.errorByKey, key),
    }));
  },

  failWrite(key, error) {
    set((state) => ({
      ...state,
      pendingByKey: withoutKey(state.pendingByKey, key),
      enabledOverlay: withoutKey(state.enabledOverlay, key),
      removedOverlay: withoutKey(state.removedOverlay, key),
      errorByKey: { ...state.errorByKey, [key]: error },
    }));
  },

  applyEntryResult(entry, profileVersion) {
    const key = userResourceEntryKey(entry.category, entry.entryId);
    set((state) => ({
      ...state,
      profileVersion,
      totalBytes: state.entries.some(
        (candidate) => candidate.category === entry.category && candidate.entryId === entry.entryId,
      )
        ? state.totalBytes -
          (state.entries.find(
            (candidate) =>
              candidate.category === entry.category && candidate.entryId === entry.entryId,
          )?.bytes ?? 0) +
          entry.bytes
        : state.totalBytes + entry.bytes,
      entries: withEntry(state.entries, entry),
      pendingByKey: withoutKey(state.pendingByKey, key),
      enabledOverlay: withoutKey(state.enabledOverlay, key),
      removedOverlay: withoutKey(state.removedOverlay, key),
      errorByKey: withoutKey(state.errorByKey, key),
    }));
  },

  applyDeleteResult(key, profileVersion) {
    const [category, entryId] = key.split("\u0000");
    set((state) => {
      const removed = state.entries.find(
        (candidate) => candidate.category === category && candidate.entryId === entryId,
      );
      return {
        ...state,
        profileVersion,
        totalBytes: state.totalBytes - (removed?.bytes ?? 0),
        entries: state.entries.filter(
          (candidate) => !(candidate.category === category && candidate.entryId === entryId),
        ),
        pendingByKey: withoutKey(state.pendingByKey, key),
        enabledOverlay: withoutKey(state.enabledOverlay, key),
        removedOverlay: withoutKey(state.removedOverlay, key),
        errorByKey: withoutKey(state.errorByKey, key),
        contentByKey: withoutKey(state.contentByKey, key),
        contentStatusByKey: withoutKey(state.contentStatusByKey, key),
      };
    });
  },

  setEnabledOverlay(key, enabled) {
    set((state) => ({ ...state, enabledOverlay: { ...state.enabledOverlay, [key]: enabled } }));
  },

  markRemovedOverlay(key) {
    set((state) => ({ ...state, removedOverlay: { ...state.removedOverlay, [key]: true } }));
  },

  beginContentLoad(key) {
    set((state) => ({
      ...state,
      contentStatusByKey: { ...state.contentStatusByKey, [key]: "loading" },
      errorByKey: withoutKey(state.errorByKey, key),
    }));
  },

  applyContent(key, content) {
    set((state) => ({
      ...state,
      contentByKey: { ...state.contentByKey, [key]: content },
      contentStatusByKey: { ...state.contentStatusByKey, [key]: "ready" },
      errorByKey: withoutKey(state.errorByKey, key),
    }));
  },

  failContent(key, error) {
    set((state) => ({
      ...state,
      contentStatusByKey: { ...state.contentStatusByKey, [key]: "error" },
      errorByKey: { ...state.errorByKey, [key]: error },
    }));
  },

  reset() {
    set({ ...INITIAL });
  },
}));

/** 展示用条目 = 快照投影 ⊖ removedOverlay ⊕ enabledOverlay（只在渲染层叠加，不改权威）。 */
export function selectVisibleUserResourceEntries(
  state: Pick<CloudUserResourcesState, "entries" | "removedOverlay" | "enabledOverlay">,
): readonly CloudUserProfileEntry[] {
  return state.entries
    .filter(
      (entry) => state.removedOverlay[userResourceEntryKey(entry.category, entry.entryId)] !== true,
    )
    .map((entry) => {
      const overlay = state.enabledOverlay[userResourceEntryKey(entry.category, entry.entryId)];
      return overlay === undefined ? entry : { ...entry, enabled: overlay };
    });
}

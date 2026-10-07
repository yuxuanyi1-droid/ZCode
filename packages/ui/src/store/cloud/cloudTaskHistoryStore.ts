/**
 * Cloud 对话历史投影缓存（specs/cloud-agent/04 §3.3/§5、03 §9）。
 *
 * 以 taskId 为键缓存控制面持久投影的折叠结果与游标：刷新、断线重连、换设备恢复
 * 都从这里恢复，而不是把 SSE 心跳当业务保活（03 §7）。
 *
 * 缺口与保留窗越界不静默处理：`resyncRequired` 到达时清掉该 task 的折叠并标
 * `requiresResync`，由调用方重新读快照（03 §9）。
 */
import { create } from "zustand";
import type { CloudHistoryItem } from "@zcode/shared";
import {
  createEmptyCloudConversationFold,
  foldCloudConversationItems,
  type CloudConversationFold,
} from "./cloudConversationFold.js";

export type CloudTaskHistoryStatus = "idle" | "loading" | "ready" | "error";

export interface CloudTaskHistoryEntry {
  readonly fold: CloudConversationFold;
  readonly status: CloudTaskHistoryStatus;
  readonly error: string | null;
  /** 服务端游标：下一页从这里继续；缺省表示已到末尾。 */
  readonly nextCursor: string | undefined;
  /** 保留窗越界 / 缺口：必须重读快照，不能继续追加增量。 */
  readonly requiresResync: boolean;
}

interface CloudTaskHistoryState {
  principalId: string | null;
  byTask: Record<string, CloudTaskHistoryEntry>;
  setPrincipal(principalId: string | null): void;
  beginLoad(principalId: string, taskId: string): void;
  /** 首页/刷新：以 replace 语义重建折叠（权威基线）。 */
  applyHistoryPage(
    principalId: string,
    taskId: string,
    page: {
      readonly items: readonly CloudHistoryItem[];
      readonly nextCursor?: string;
      readonly resyncRequired?: boolean;
    },
    options?: { readonly append?: boolean },
  ): void;
  /** events 增量：append 语义 + 缺口检测。 */
  applyHistoryDelta(principalId: string, taskId: string, items: readonly CloudHistoryItem[]): void;
  markResyncRequired(principalId: string, taskId: string): void;
  fail(principalId: string, taskId: string, message: string): void;
  reset(): void;
}

const INITIAL: Pick<CloudTaskHistoryState, "principalId" | "byTask"> = {
  principalId: null,
  byTask: {},
};

function createEntry(): CloudTaskHistoryEntry {
  return {
    fold: createEmptyCloudConversationFold(),
    status: "idle",
    error: null,
    nextCursor: undefined,
    requiresResync: false,
  };
}

export const useCloudTaskHistoryStore = create<CloudTaskHistoryState>((set) => ({
  ...INITIAL,

  setPrincipal(principalId) {
    set((state) => (state.principalId === principalId ? state : { ...INITIAL, principalId }));
  },

  beginLoad(principalId, taskId) {
    set((state) => {
      if (state.principalId !== principalId) {
        return state;
      }
      const entry = state.byTask[taskId] ?? createEntry();
      return {
        ...state,
        byTask: { ...state.byTask, [taskId]: { ...entry, status: "loading", error: null } },
      };
    });
  },

  applyHistoryPage(principalId, taskId, page, options) {
    set((state) => {
      if (state.principalId !== principalId) {
        return state;
      }
      const entry = state.byTask[taskId] ?? createEntry();
      const append = options?.append === true;
      // 服务端声明越界时，本地折叠整体作废：不能把不连续的两段缝起来，
      // 也不能把「空的 resync 响应」当成「这段历史确实为空」（03 §9）。
      // 分页翻页则是 append：同一持久流继续往后读，已有折叠保留。
      const fold =
        page.resyncRequired === true
          ? createEmptyCloudConversationFold(entry.fold.topic)
          : foldCloudConversationItems(entry.fold, page.items, append ? "append" : "replace");
      return {
        ...state,
        byTask: {
          ...state.byTask,
          [taskId]: {
            fold,
            status: "ready",
            error: null,
            nextCursor: page.nextCursor,
            // 服务端显式声明越界，或折叠检测到缺口，都要求重读快照。
            requiresResync: page.resyncRequired === true || fold.gap,
          },
        },
      };
    });
  },

  applyHistoryDelta(principalId, taskId, items) {
    set((state) => {
      if (state.principalId !== principalId) {
        return state;
      }
      const entry = state.byTask[taskId];
      if (!entry || entry.requiresResync) {
        // 已知不连续时不继续缝增量：等快照重建基线。
        return state;
      }
      const fold = foldCloudConversationItems(entry.fold, items, "append");
      return {
        ...state,
        byTask: {
          ...state.byTask,
          [taskId]: { ...entry, fold, requiresResync: fold.gap },
        },
      };
    });
  },

  markResyncRequired(principalId, taskId) {
    set((state) => {
      if (state.principalId !== principalId) {
        return state;
      }
      const entry = state.byTask[taskId] ?? createEntry();
      return {
        ...state,
        byTask: {
          ...state.byTask,
          [taskId]: { ...entry, requiresResync: true, fold: createEmptyCloudConversationFold() },
        },
      };
    });
  },

  fail(principalId, taskId, message) {
    set((state) => {
      if (state.principalId !== principalId) {
        return state;
      }
      const entry = state.byTask[taskId] ?? createEntry();
      return {
        ...state,
        byTask: { ...state.byTask, [taskId]: { ...entry, status: "error", error: message } },
      };
    });
  },

  reset() {
    set({ ...INITIAL });
  },
}));

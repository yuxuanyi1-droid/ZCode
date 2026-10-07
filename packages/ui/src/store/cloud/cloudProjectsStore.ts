/**
 * Cloud Project 投影缓存（specs/cloud-agent/04 §3.1、W8 §5）。
 *
 * 只缓存控制面返回的 Project 列表与分页游标——没有第二条写入路径、没有本地
 * 权威状态。Project 不持有沙箱、不显示连接状态（04 §3.1），因此这里也不存任何
 * attachment/run 字段。
 *
 * 主体围栏：所有写入都带 `principalId`，与当前主体不一致的响应被丢弃
 * （登出/换主体后迟到的响应不得把上一个主体的项目灌回来，04 §3.4.1）。
 */
import { create } from "zustand";
import type { CloudProjectRecord } from "@zcode/shared";

export type CloudProjectsStatus = "idle" | "loading" | "ready" | "error";

interface CloudProjectsState {
  principalId: string | null;
  status: CloudProjectsStatus;
  error: string | null;
  items: readonly CloudProjectRecord[];
  nextCursor: string | undefined;
  /** 切主体时清空全部投影；不同主体的列表不能混在一起。 */
  setPrincipal(principalId: string | null): void;
  beginLoad(principalId: string): void;
  /** 首页或分页结果；`append=false` 表示重连/刷新后的全量对账替换列表。 */
  applyPage(
    principalId: string,
    page: { readonly items: readonly CloudProjectRecord[]; readonly nextCursor?: string },
    options?: { readonly append?: boolean },
  ): void;
  /** 单条 upsert（创建/改名响应）；已存在则按 revision 覆盖。 */
  upsert(principalId: string, project: CloudProjectRecord): void;
  remove(principalId: string, projectId: string): void;
  fail(principalId: string, message: string): void;
  reset(): void;
}

const INITIAL: Pick<
  CloudProjectsState,
  "principalId" | "status" | "error" | "items" | "nextCursor"
> = {
  principalId: null,
  status: "idle",
  error: null,
  items: [],
  nextCursor: undefined,
};

function isCurrentPrincipal(state: CloudProjectsState, principalId: string): boolean {
  return state.principalId === principalId;
}

export const useCloudProjectsStore = create<CloudProjectsState>((set) => ({
  ...INITIAL,

  setPrincipal(principalId) {
    set((state) => {
      if (state.principalId === principalId) {
        return state;
      }
      // 换主体（含登出清空）一律丢弃旧投影，避免跨账号串数据。
      return { ...INITIAL, principalId };
    });
  },

  beginLoad(principalId) {
    set((state) => {
      if (!isCurrentPrincipal(state, principalId)) {
        return state;
      }
      return { ...state, status: "loading", error: null };
    });
  },

  applyPage(principalId, page, options) {
    set((state) => {
      if (!isCurrentPrincipal(state, principalId)) {
        return state;
      }
      const append = options?.append === true;
      const merged = append
        ? // 分页追加：按 projectId 去重（多端并发创建可能让同一项目出现在两页）。
          dedupeProjects([...state.items, ...page.items])
        : dedupeProjects([...page.items]);
      return {
        ...state,
        status: "ready",
        error: null,
        items: merged,
        nextCursor: page.nextCursor,
      };
    });
  },

  upsert(principalId, project) {
    set((state) => {
      if (!isCurrentPrincipal(state, principalId)) {
        return state;
      }
      const existingIndex = state.items.findIndex((item) => item.projectId === project.projectId);
      if (existingIndex === -1) {
        return { ...state, items: [...state.items, project] };
      }
      const existing = state.items[existingIndex];
      // revision 只增不减：迟到响应不得把新状态盖回旧 revision。
      if (!existing || existing.revision > project.revision) {
        return state;
      }
      const items = [...state.items];
      items[existingIndex] = project;
      return { ...state, items };
    });
  },

  remove(principalId, projectId) {
    set((state) => {
      if (!isCurrentPrincipal(state, principalId)) {
        return state;
      }
      return { ...state, items: state.items.filter((item) => item.projectId !== projectId) };
    });
  },

  fail(principalId, message) {
    set((state) => {
      if (!isCurrentPrincipal(state, principalId)) {
        return state;
      }
      return { ...state, status: "error", error: message };
    });
  },

  reset() {
    set({ ...INITIAL });
  },
}));

function dedupeProjects(items: readonly CloudProjectRecord[]): readonly CloudProjectRecord[] {
  const byId = new Map<string, CloudProjectRecord>();
  for (const item of items) {
    const existing = byId.get(item.projectId);
    if (!existing || existing.revision <= item.revision) {
      byId.set(item.projectId, item);
    }
  }
  return [...byId.values()];
}

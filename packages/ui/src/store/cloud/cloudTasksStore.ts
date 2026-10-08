/**
 * Cloud Task / Run 投影缓存（specs/cloud-agent/04 §3.3、08 §3、W8 §5）。
 *
 * 缓存的是控制面事实的**投影**：Task 列表、当前 Task 详情（task + activeRun +
 * execution + latestCheckpoint + artifact）。这里没有第二条权威状态，也没有
 * 乐观创建——草稿 Task 必须等控制面返回才存在（04 §3.2.1「未收到 Task 时不伪造已创建」）。
 *
 * 两条被显式区分的语义：
 * - `Task.active` ≠ attachment ready（04 §3.3）：详情里 run 缺失只说明没有活跃执行载体，
 *   不能据此推导出 ready/stopped。
 * - execution 缺可靠 runtime 事实时保留 last-known 并标过期，UI 不猜 idle（08 §3.3）。
 */
import { create } from "zustand";
import type { CloudTaskRecord, TaskDetailResponse } from "@zcode/shared";

export type CloudTasksStatus = "idle" | "loading" | "ready" | "error";

export interface CloudTaskDetailCacheEntry {
  readonly detail: TaskDetailResponse;
  /** 控制面把这条投影交到客户端的本地时间；只用于展示「数据可能已过期」，不推断 run 状态。 */
  readonly receivedAt: number;
}

interface CloudTasksState {
  principalId: string | null;
  statusByProject: Record<string, CloudTasksStatus>;
  errorByProject: Record<string, string | null>;
  itemsByProject: Record<string, readonly CloudTaskRecord[]>;
  nextCursorByProject: Record<string, string | undefined>;
  detailByTask: Record<string, CloudTaskDetailCacheEntry>;

  setPrincipal(principalId: string | null): void;
  beginLoadProject(principalId: string, projectId: string): void;
  applyProjectTasks(
    principalId: string,
    projectId: string,
    page: { readonly items: readonly CloudTaskRecord[]; readonly nextCursor?: string },
    options?: { readonly append?: boolean },
  ): void;
  failProject(principalId: string, projectId: string, message: string): void;
  /** 详情写入：Task 投影同时回填到所属项目列表，保持两处一致。 */
  applyTaskDetail(principalId: string, detail: TaskDetailResponse, receivedAt: number): void;
  reset(): void;
}

const INITIAL: Pick<
  CloudTasksState,
  | "principalId"
  | "statusByProject"
  | "errorByProject"
  | "itemsByProject"
  | "nextCursorByProject"
  | "detailByTask"
> = {
  principalId: null,
  statusByProject: {},
  errorByProject: {},
  itemsByProject: {},
  nextCursorByProject: {},
  detailByTask: {},
};

function isCurrentPrincipal(state: CloudTasksState, principalId: string): boolean {
  return state.principalId === principalId;
}

function mergeTasks(
  existing: readonly CloudTaskRecord[],
  incoming: readonly CloudTaskRecord[],
): readonly CloudTaskRecord[] {
  const byId = new Map<string, CloudTaskRecord>();
  for (const task of [...existing, ...incoming]) {
    const current = byId.get(task.taskId);
    if (!current || current.revision <= task.revision) {
      byId.set(task.taskId, task);
    }
  }
  return [...byId.values()];
}

export const useCloudTasksStore = create<CloudTasksState>((set) => ({
  ...INITIAL,

  setPrincipal(principalId) {
    set((state) => (state.principalId === principalId ? state : { ...INITIAL, principalId }));
  },

  beginLoadProject(principalId, projectId) {
    set((state) => {
      if (!isCurrentPrincipal(state, principalId)) {
        return state;
      }
      return {
        ...state,
        statusByProject: { ...state.statusByProject, [projectId]: "loading" },
        errorByProject: { ...state.errorByProject, [projectId]: null },
      };
    });
  },

  applyProjectTasks(principalId, projectId, page, options) {
    set((state) => {
      if (!isCurrentPrincipal(state, principalId)) {
        return state;
      }
      const append = options?.append === true;
      const existing = append ? (state.itemsByProject[projectId] ?? []) : [];
      return {
        ...state,
        statusByProject: { ...state.statusByProject, [projectId]: "ready" },
        errorByProject: { ...state.errorByProject, [projectId]: null },
        itemsByProject: {
          ...state.itemsByProject,
          [projectId]: mergeTasks(existing, page.items),
        },
        nextCursorByProject: { ...state.nextCursorByProject, [projectId]: page.nextCursor },
      };
    });
  },

  failProject(principalId, projectId, message) {
    set((state) => {
      if (!isCurrentPrincipal(state, principalId)) {
        return state;
      }
      return {
        ...state,
        statusByProject: { ...state.statusByProject, [projectId]: "error" },
        errorByProject: { ...state.errorByProject, [projectId]: message },
      };
    });
  },

  applyTaskDetail(principalId, detail, receivedAt) {
    set((state) => {
      if (!isCurrentPrincipal(state, principalId)) {
        return state;
      }
      const { task } = detail;
      const existingList = state.itemsByProject[task.projectId] ?? [];
      return {
        ...state,
        detailByTask: {
          ...state.detailByTask,
          [task.taskId]: { detail, receivedAt },
        },
        itemsByProject: {
          ...state.itemsByProject,
          [task.projectId]: mergeTasks(existingList, [task]),
        },
      };
    });
  },

  reset() {
    set({ ...INITIAL });
  },
}));

/** 读取单个项目的 Task 投影；未加载过返回空数组而不是 undefined。 */
export function selectCloudTasksForProject(
  state: Pick<CloudTasksState, "itemsByProject">,
  projectId: string,
): readonly CloudTaskRecord[] {
  return state.itemsByProject[projectId] ?? [];
}

/**
 * 按 taskId 读取任务状态（04 §3 2026-10-08 巡检修订）。
 *
 * 详情投影优先（选中/打开过的任务必然有），否则扫项目列表兜底（侧栏展开过的项目）。
 * 两处都没有时返回 null——调用方按「状态未知」处理，不猜。
 */
export function selectCloudTaskStatusById(
  state: Pick<CloudTasksState, "detailByTask" | "itemsByProject">,
  taskId: string,
): CloudTaskRecord["status"] | null {
  const detailEntry = state.detailByTask[taskId];
  if (detailEntry) {
    return detailEntry.detail.task.status;
  }
  for (const items of Object.values(state.itemsByProject)) {
    const found = items.find((task) => task.taskId === taskId);
    if (found) {
      return found.status;
    }
  }
  return null;
}

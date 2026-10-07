/**
 * Cloud 草稿与冻结提交记录（specs/cloud-agent/04 §3.2/§3.4/§3.4.1、11 §5/§7）。
 *
 * 客户端 owner 的三样东西，全部按**稳定 scope**（principal + controlPlaneOrigin +
 * taskId，见 `cloudDraftScope.ts`）隔离：
 *
 * 1. **未提交正文草稿**：客户端本地可编辑，不是服务端队列（04 §3.4 表）。
 * 2. **冻结 submit attempt**：HTTP 之前持久化完整请求与 `commandId`；本地写入失败时
 *    返回 false，调用方必须阻止提交并解释恢复限制（04 §3.4.1）。
 * 3. **pending optimistic overlay**：`202` 只表示控制面已持久接收，恢复必须靠
 *    `receipt` 对账，**不合成 CommandAck**（04 §3.0.1、03 §6.2）。
 *
 * receipt 只清「本次正文版本」：等待期间的新编辑不受迟到响应影响（04 §3.2.6）。
 * unknown 的 attempt 保留原 commandId 与完整 payload，刷新后先查询再决定，
 * 不允许重新组装或自动换 key（04 §3.2.3、§3.4.1）。
 */
import { create } from "zustand";
import type { InputReceipt, ReopenCloudTaskRequest, SubmitTaskInput } from "@zcode/shared";
import {
  createCloudLocalStore,
  createMemoryCloudLocalStore,
  type CloudLocalStore,
} from "./cloudLocalPersistence.js";

/** 提交阶段：冻结 → 已提交(HTTP 事实) → 已知结果 / 未知（需对账）。 */
export type CloudSubmitPhase = "frozen" | "persisted" | "unknown" | "rejected";

/**
 * 冻结的提交请求：闭合联合，保留原始 intent，不在恢复时重新组装。
 * `reopen` 走独立端点，但共用同一份冻结/对账机制（04 §3.4.1）。
 */
export type CloudSubmitRequest =
  | { readonly kind: "input"; readonly body: SubmitTaskInput }
  | { readonly kind: "reopen"; readonly body: ReopenCloudTaskRequest };

export interface CloudSubmitAttempt {
  readonly scopeKey: string;
  readonly commandId: string;
  readonly request: CloudSubmitRequest;
  /** 冻结时该 scope 的正文版本；receipt 只允许清掉这个版本（04 §3.2.6）。 */
  readonly bodyVersion: number;
  readonly phase: CloudSubmitPhase;
  readonly frozenAt: number;
  /** HTTP 事实：202 = 控制面已持久接收；**不是** runtime ACK。 */
  readonly httpStatus?: number;
  readonly receipt?: InputReceipt;
  readonly lastError?: string;
}

export interface CloudDraftRecord {
  readonly scopeKey: string;
  readonly body: string;
  readonly bodyVersion: number;
  readonly updatedAt: number;
}

/**
 * 一次 HTTP 尝试的收口结果：
 * - `persisted`：拿到了响应（202 或 reopen 的 detail）——仍不是 runtime ACK；
 * - `rejected`：服务端给出明确结论，保留正文、理由可见；
 * - `unknown`：结果不明，保留原 commandId 先对账（03 §5）。
 */
export type CloudSubmitSettlement =
  | {
      readonly phase: "persisted";
      readonly httpStatus: number;
      readonly receipt: InputReceipt;
    }
  | { readonly phase: "rejected"; readonly message: string }
  | { readonly phase: "unknown"; readonly message: string };

interface CloudDraftState {
  /** scopeKey → 草稿正文 */
  drafts: Record<string, CloudDraftRecord>;
  /** scopeKey → commandId → 冻结/在途 attempt */
  attempts: Record<string, Record<string, CloudSubmitAttempt>>;
  /** 已 hydrate 的 scope（避免重复读本地存储）。 */
  hydratedScopes: Record<string, true>;

  /** 从本地存储恢复该 scope 的草稿与 unknown attempt（刷新/换设备首步）。 */
  hydrate(scopeKey: string, stores?: CloudDraftLocalStores): void;
  setBody(scopeKey: string, body: string, stores?: CloudDraftLocalStores): boolean;
  getRecord(scopeKey: string): CloudDraftRecord | undefined;
  /**
   * 冻结 attempt。返回 true 才允许继续发 HTTP；false 表示本地持久化失败，
   * 调用方必须阻止 Cloud 提交（04 §3.4.1）。
   */
  freezeAttempt(
    scopeKey: string,
    attempt: Omit<CloudSubmitAttempt, "scopeKey" | "phase" | "frozenAt">,
    stores?: CloudDraftLocalStores,
  ): boolean;
  /** HTTP 返回后记录事实；unknown 表示结果不明，保留原 key 待对账。 */
  settleAttempt(
    scopeKey: string,
    commandId: string,
    settlement: CloudSubmitSettlement,
    stores?: CloudDraftLocalStores,
  ): void;
  /**
   * 对账成功后按正文版本清理：只有与 attempt 冻结版本相同的正文才被清掉，
   * 等待期间的新编辑不受影响（04 §3.2.6）。
   */
  applyReceipt(
    scopeKey: string,
    commandId: string,
    receipt: InputReceipt,
    stores?: CloudDraftLocalStores,
  ): void;
  /** 未决（frozen/unknown）的 attempt；刷新后必须先把它们查清楚。 */
  pendingAttempts(scopeKey: string): readonly CloudSubmitAttempt[];
  clearScope(scopeKey: string, stores?: CloudDraftLocalStores): void;
  reset(): void;
}

const DRAFT_STORE_KIND = "draft";
const ATTEMPT_STORE_KIND = "submit-attempt";

/**
 * 草稿与 attempt 各自独立的本地命名空间。
 *
 * 两者**必须分开**：attempt 写入失败要阻止提交，而草稿写入失败只影响恢复体验；
 * 共用一份记录会让后写的 attempt 覆盖掉正文（04 §3.4/§3.4.1 是两条不同的持久化要求）。
 */
export interface CloudDraftLocalStores {
  readonly draft: CloudLocalStore;
  readonly attempt: CloudLocalStore;
}

let sharedStores: CloudDraftLocalStores | null = null;
function defaultStores(): CloudDraftLocalStores {
  sharedStores ??= {
    draft: createCloudLocalStore(DRAFT_STORE_KIND),
    attempt: createCloudLocalStore(ATTEMPT_STORE_KIND),
  };
  return sharedStores;
}

function resolveStores(stores?: CloudDraftLocalStores): CloudDraftLocalStores {
  return stores ?? defaultStores();
}

const INITIAL: Pick<CloudDraftState, "drafts" | "attempts" | "hydratedScopes"> = {
  drafts: {},
  attempts: {},
  hydratedScopes: {},
};

interface PersistedDraftRecord {
  readonly body: string;
  readonly bodyVersion: number;
  readonly updatedAt: number;
}

function parsePersistedDraft(raw: string | null): PersistedDraftRecord | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<PersistedDraftRecord>;
    if (
      typeof parsed.body !== "string" ||
      typeof parsed.bodyVersion !== "number" ||
      typeof parsed.updatedAt !== "number"
    ) {
      return null;
    }
    return { body: parsed.body, bodyVersion: parsed.bodyVersion, updatedAt: parsed.updatedAt };
  } catch {
    // 本地记录损坏时丢弃这条草稿：宁可让用户重打，也不接上一个不可信的正文。
    return null;
  }
}

function parsePersistedAttempts(raw: string | null, scopeKey: string): CloudSubmitAttempt[] {
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter((entry): entry is CloudSubmitAttempt => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const candidate = entry as Partial<CloudSubmitAttempt>;
      return (
        candidate.scopeKey === scopeKey &&
        typeof candidate.commandId === "string" &&
        typeof candidate.bodyVersion === "number" &&
        typeof candidate.frozenAt === "number" &&
        (candidate.phase === "frozen" ||
          candidate.phase === "persisted" ||
          candidate.phase === "unknown" ||
          candidate.phase === "rejected") &&
        Boolean(candidate.request)
      );
    });
  } catch {
    return [];
  }
}

function persistAttempts(
  store: CloudLocalStore,
  scopeKey: string,
  attempts: Readonly<Record<string, CloudSubmitAttempt>>,
): boolean {
  return store.write(scopeKey, JSON.stringify(Object.values(attempts)));
}

export const useCloudDraftStore = create<CloudDraftState>((set, get) => ({
  ...INITIAL,

  hydrate(scopeKey, stores) {
    if (get().hydratedScopes[scopeKey]) {
      return;
    }
    const { draft: draftStore, attempt: attemptStore } = resolveStores(stores);
    const persistedDraft = parsePersistedDraft(draftStore.read(scopeKey));
    const persistedAttempts = parsePersistedAttempts(attemptStore.read(scopeKey), scopeKey);
    set((state) => ({
      hydratedScopes: { ...state.hydratedScopes, [scopeKey]: true },
      drafts: persistedDraft
        ? {
            ...state.drafts,
            [scopeKey]: {
              scopeKey,
              body: persistedDraft.body,
              bodyVersion: persistedDraft.bodyVersion,
              updatedAt: persistedDraft.updatedAt,
            },
          }
        : state.drafts,
      attempts:
        persistedAttempts.length === 0
          ? state.attempts
          : {
              ...state.attempts,
              [scopeKey]: {
                ...state.attempts[scopeKey],
                ...Object.fromEntries(
                  persistedAttempts.map((attempt) => [attempt.commandId, attempt]),
                ),
              },
            },
    }));
  },

  setBody(scopeKey, body, stores) {
    const { draft: draftStore } = resolveStores(stores);
    const current = get().drafts[scopeKey];
    const next: CloudDraftRecord = {
      scopeKey,
      body,
      // 版本号只增不减：每次编辑都是一版新正文，迟到回执只能清它冻结时的那一版。
      bodyVersion: (current?.bodyVersion ?? 0) + 1,
      updatedAt: Date.now(),
    };
    const persisted = draftStore.write(
      scopeKey,
      JSON.stringify({ body: next.body, bodyVersion: next.bodyVersion, updatedAt: next.updatedAt }),
    );
    // 写入失败也更新内存：用户继续编辑不能丢，但调用方知道这次没落盘。
    set((state) => ({ drafts: { ...state.drafts, [scopeKey]: next } }));
    return persisted;
  },

  getRecord(scopeKey) {
    return get().drafts[scopeKey];
  },

  freezeAttempt(scopeKey, attempt, stores) {
    const { attempt: attemptStore } = resolveStores(stores);
    const frozen: CloudSubmitAttempt = {
      ...attempt,
      scopeKey,
      phase: "frozen",
      frozenAt: Date.now(),
    };
    const nextForScope = { ...get().attempts[scopeKey], [attempt.commandId]: frozen };
    // 先落盘再改内存：落盘失败时返回 false，调用方必须阻止 HTTP（04 §3.4.1）。
    if (!persistAttempts(attemptStore, scopeKey, nextForScope)) {
      return false;
    }
    set((state) => ({ attempts: { ...state.attempts, [scopeKey]: nextForScope } }));
    return true;
  },

  settleAttempt(scopeKey, commandId, settlement, stores) {
    const { attempt: attemptStore } = resolveStores(stores);
    const existing = get().attempts[scopeKey]?.[commandId];
    if (!existing) {
      return;
    }
    const settled: CloudSubmitAttempt =
      settlement.phase === "persisted"
        ? {
            ...existing,
            phase: "persisted",
            httpStatus: settlement.httpStatus,
            receipt: settlement.receipt,
          }
        : { ...existing, phase: settlement.phase, lastError: settlement.message };
    const nextForScope = { ...get().attempts[scopeKey], [commandId]: settled };
    persistAttempts(attemptStore, scopeKey, nextForScope);
    set((state) => ({ attempts: { ...state.attempts, [scopeKey]: nextForScope } }));
  },

  applyReceipt(scopeKey, commandId, receipt, stores) {
    const { draft: draftStore, attempt: attemptStore } = resolveStores(stores);
    const attempt = get().attempts[scopeKey]?.[commandId];
    const currentDraft = get().drafts[scopeKey];

    if (attempt) {
      const settled: CloudSubmitAttempt = { ...attempt, receipt, phase: "persisted" };
      const nextForScope = { ...get().attempts[scopeKey], [commandId]: settled };
      persistAttempts(attemptStore, scopeKey, nextForScope);
      set((state) => ({ attempts: { ...state.attempts, [scopeKey]: nextForScope } }));
    }

    // 只有「正文没有被重新编辑过」时才清正文：版本不同说明用户在等待期间又写了新内容。
    if (currentDraft && attempt && currentDraft.bodyVersion === attempt.bodyVersion) {
      const cleared: CloudDraftRecord = {
        ...currentDraft,
        body: "",
        bodyVersion: currentDraft.bodyVersion + 1,
        updatedAt: Date.now(),
      };
      draftStore.write(
        scopeKey,
        JSON.stringify({
          body: cleared.body,
          bodyVersion: cleared.bodyVersion,
          updatedAt: cleared.updatedAt,
        }),
      );
      set((state) => ({ drafts: { ...state.drafts, [scopeKey]: cleared } }));
    }
  },

  pendingAttempts(scopeKey) {
    const forScope = get().attempts[scopeKey] ?? {};
    return Object.values(forScope).filter(
      (attempt) => attempt.phase === "frozen" || attempt.phase === "unknown",
    );
  },

  clearScope(scopeKey, stores) {
    const { draft: draftStore, attempt: attemptStore } = resolveStores(stores);
    draftStore.remove(scopeKey);
    attemptStore.remove(scopeKey);
    set((state) => {
      const { [scopeKey]: _draft, ...restDrafts } = state.drafts;
      const { [scopeKey]: _attempts, ...restAttempts } = state.attempts;
      const { [scopeKey]: _hydrated, ...restHydrated } = state.hydratedScopes;
      return { drafts: restDrafts, attempts: restAttempts, hydratedScopes: restHydrated };
    });
  },

  reset() {
    set({ ...INITIAL });
  },
}));

/** 仅测试使用：清掉共享的 localStorage store，避免用例之间串数据。 */
export function resetCloudDraftStoresForTests(): void {
  sharedStores = null;
}

/** 仅测试使用：内存版的两份本地 store（draft / attempt 各自独立命名空间）。 */
export function createMemoryCloudDraftLocalStores(options?: {
  readonly failAttemptWrites?: boolean;
  readonly failDraftWrites?: boolean;
}): CloudDraftLocalStores {
  return {
    draft: createMemoryCloudLocalStore({ failWrites: options?.failDraftWrites === true }),
    attempt: createMemoryCloudLocalStore({ failWrites: options?.failAttemptWrites === true }),
  };
}

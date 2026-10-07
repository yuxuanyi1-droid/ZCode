/**
 * Cloud UI 本地持久化的唯一出口（specs/cloud-agent/04 §3.2/§3.4.1）。
 *
 * 为什么不用既有 `writeSafeLocalStorage`：它按「偏好类」语义吞掉失败，而
 * 04 §3.4.1 要求 **attempt 持久冻结失败必须阻止 Cloud 提交**并解释恢复限制。
 * 这里因此返回布尔结果，由调用方决定是否放行 HTTP。
 *
 * 只持久化**客户端自己的**东西：未提交正文草稿、冻结 submit attempt、pending
 * optimistic overlay。Task/Run/receipt 等权威事实只来自控制面，不进这里（W8 §5）。
 */
/**
 * 安全取 localStorage 的**本地**实现。
 *
 * 为什么不复用 `@/lib/browserEnvironment.js` 的 `getSafeLocalStorage`：
 * 1. 该模块的语义是「偏好类读取，失败即静默」，与本文件要求的「写入必须报告成败」
 *    不一致（04 §3.4.1 要求冻结失败阻止提交）；
 * 2. `@/` 别名在 `node --import tsx` 的用例环境不可解析，store 层保持零别名依赖，
 *    使 `packages/ui/test/cloud*.test.ts` 能直接覆盖投影与对账逻辑。
 */
function readLocalStorageCandidate(): Storage | null {
  try {
    if (typeof globalThis === "undefined") {
      return null;
    }
    const storage = (globalThis as { localStorage?: Storage }).localStorage;
    return storage && typeof storage.getItem === "function" && typeof storage.setItem === "function"
      ? storage
      : null;
  } catch {
    return null;
  }
}

export interface CloudLocalStore {
  readonly kind: string;
  read(key: string): string | null;
  /** true 表示确实落盘；false 时调用方必须按「不可恢复的本地写入失败」处理。 */
  write(key: string, value: string): boolean;
  remove(key: string): boolean;
}

const CLOUD_LOCAL_KEY_PREFIX = "zcode-cloud";

export function buildCloudLocalKey(kind: string, scopeKey: string): string {
  return `${CLOUD_LOCAL_KEY_PREFIX}:${kind}:${scopeKey}`;
}

/** 基于 localStorage 的 store；环境不可用时读写都是显式失败而不是静默降级。 */
export function createCloudLocalStore(kind: string): CloudLocalStore {
  return {
    kind,
    read(key) {
      return readLocalStorageCandidate()?.getItem(buildCloudLocalKey(kind, key)) ?? null;
    },
    write(key, value) {
      const storage = readLocalStorageCandidate();
      if (!storage) {
        return false;
      }
      try {
        storage.setItem(buildCloudLocalKey(kind, key), value);
        return true;
      } catch {
        // 配额超限 / 隐私模式：返回 false，调用方据此阻止提交。
        return false;
      }
    },
    remove(key) {
      const storage = readLocalStorageCandidate() as
        | (Storage & { removeItem?(k: string): void })
        | null;
      if (!storage?.removeItem) {
        return false;
      }
      try {
        storage.removeItem(buildCloudLocalKey(kind, key));
        return true;
      } catch {
        return false;
      }
    },
  };
}

/** 测试与 SSR 用的内存 store：语义与 localStorage 版一致（含「写入失败」注入点）。 */
export function createMemoryCloudLocalStore(options?: {
  readonly failWrites?: boolean;
}): CloudLocalStore & { snapshot(): Readonly<Record<string, string>> } {
  const entries = new Map<string, string>();
  return {
    kind: "memory",
    read(key) {
      return entries.get(key) ?? null;
    },
    write(key, value) {
      if (options?.failWrites) {
        return false;
      }
      entries.set(key, value);
      return true;
    },
    remove(key) {
      return entries.delete(key);
    },
    snapshot() {
      return Object.fromEntries(entries);
    },
  };
}

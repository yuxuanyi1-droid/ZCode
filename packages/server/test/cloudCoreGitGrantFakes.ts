/**
 * git grant 测试替身（01 §7.2）：内存 store + 真实 W4 broker 的组合。
 * 拆出独立文件以保持单文件行数预算；不是测试文件（不匹配 `*.test.ts`）。
 */
import type {
  GitGrantPurpose,
  GitGrantRecord,
  GitGrantStore,
} from "../src/cloud/app/ports/gitGrantPort.js";
import { createGitGrantBroker } from "../src/cloud/adapters/secret/gitGrantBroker.js";

/**
 * git grant store fake（W2 `GitGrantStore` 的内存实现）：语义与端口 JSDoc 一致——
 * 单次兑换 CAS、按 (runId, purpose) 取最新记录、只记元数据不记 token。
 */
export function createFakeGitGrantStore(): GitGrantStore & {
  readonly records: GitGrantRecord[];
  /** 调用顺序记录（供"签发必须先于启动 supervisor"这类顺序断言）。 */
  readonly events: string[];
} {
  const records: GitGrantRecord[] = [];
  const events: string[] = [];
  return {
    records,
    events,
    async insert(record) {
      records.push(record);
      events.push(`grant-issued:${record.purpose}:${record.grantId}`);
    },
    async get(grantId) {
      return records.find((item) => item.grantId === grantId) ?? null;
    },
    async findCurrentForRun(request) {
      // 与 W2 真实实现同序：`ORDER BY issued_at DESC, grant_id DESC`（`gitGrantRepo.ts`）。
      // 缺第二排序键时，同一毫秒内的两条记录会退化成插入顺序，与真实 store 不一致，
      // 会让「补签后仍复用当前 grant」的幂等断言在 tie 场景下失真。
      const candidates = records
        .filter((item) => item.runId === request.runId && item.purpose === request.purpose)
        .sort(
          (left, right) =>
            right.issuedAt - left.issuedAt || (left.grantId < right.grantId ? 1 : -1),
        );
      return candidates[0] ?? null;
    },
    async claimRedemption(request) {
      const record = records.find((item) => item.grantId === request.grantId);
      if (!record) return null;
      if (record.status !== "issued") return null;
      if (record.taskId !== request.taskId || record.runId !== request.runId) return null;
      if (record.runGeneration !== request.runGeneration) return null;
      if (request.now > record.expiresAt) return null;
      record.status = "redeemed";
      record.redeemedAt = request.now;
      return record;
    },
    async recordIssuedToken(request) {
      const record = records.find((item) => item.grantId === request.grantId);
      if (!record) return;
      record.tokenIssuedAt = request.tokenIssuedAt;
      record.tokenExpiresAt = request.tokenExpiresAt;
    },
    async recordFailure(request) {
      const record = records.find((item) => item.grantId === request.grantId);
      if (!record) return;
      record.lastErrorCode = request.code;
    },
    async recordRevokeOutcome(request) {
      const record = records.find((item) => item.grantId === request.grantId);
      if (!record) return;
      record.revokedAt = request.now;
      record.revokeOutcome = { revoked: request.revoked, reason: request.reason, at: request.now };
    },
    async listByRun(runId) {
      return records.filter((item) => item.runId === runId);
    },
  };
}

/** W4 broker 的 fake 依赖：mint 回固定 token，revoke 记录调用。 */
export function createFakeGitGrantBrokerDeps() {
  const minted: { repositoryId: number; installationId: number; purpose: GitGrantPurpose }[] = [];
  const revoked: string[] = [];
  return {
    minted,
    revoked,
    mint: async (request: {
      repositoryId: number;
      installationId: number;
      purpose: GitGrantPurpose;
    }) => {
      minted.push(request);
      return {
        token: `ghs_fake_${request.purpose}_${request.repositoryId}`,
        expiresAt: Number.MAX_SAFE_INTEGER,
        permissions: request.purpose === "push" ? ["contents:write"] : ["contents:read"],
      };
    },
    revokeToken: async (token: string) => {
      revoked.push(token);
      return { revoked: true, reason: "ok" };
    },
  };
}

/** 真实 W4 broker + 内存 store 的组合（签发/兑换语义用真实实现，便于断言单次兑换/过期）。 */
export function createFakeGitGrantBroker(options: { now: () => number; newGrantId: () => string }) {
  const store = createFakeGitGrantStore();
  const deps = createFakeGitGrantBrokerDeps();
  const broker = createGitGrantBroker({
    store,
    mint: deps.mint,
    revokeToken: deps.revokeToken,
    now: options.now,
    newGrantId: options.newGrantId,
  });
  return { store, broker, deps };
}

/**
 * git grant broker 与兑换端点用例（specs/cloud-agent 01 §7.1/§7.2、09 §3、
 * W4 §6「单次兑换、重放拒绝、过期拒绝、旧 run 领取拒绝、磁盘/日志无 token」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cloudGitGrantResponseSchema } from "@zcode/shared";
import {
  constantTimeEqualHex,
  createGitGrantBroker,
  sha256Hex,
} from "../src/cloud/adapters/secret/gitGrantBroker.js";
import {
  GIT_GRANT_TTL_MS,
  type GitGrantRecord,
  type GitGrantStore,
} from "../src/cloud/app/ports/gitGrantPort.js";
import {
  createGitGrantRouteHandler,
  type GitGrantRouteRequest,
} from "../src/cloud/adapters/secret/gitGrantRoute.js";
import { createCapturingLogger } from "./cloudGithubTestSupport.js";

const TOKEN = "ghs_grant_token_0123456789abcdefghijklmnopqrstuvwxyz";
const ISSUED_AT = 1_000_000;

interface StoreCall {
  method: string;
  args: unknown;
}

function createMemoryGrantStore() {
  const records = new Map<string, GitGrantRecord>();
  const calls: StoreCall[] = [];
  const store: GitGrantStore = {
    async insert(record) {
      calls.push({ method: "insert", args: record });
      records.set(record.grantId, { ...record });
    },
    async get(grantId) {
      calls.push({ method: "get", args: { grantId } });
      const record = records.get(grantId);
      return record ? { ...record } : null;
    },
    async findCurrentForRun(request) {
      calls.push({ method: "findCurrentForRun", args: request });
      let latest: GitGrantRecord | null = null;
      for (const record of records.values()) {
        if (record.runId !== request.runId || record.purpose !== request.purpose) continue;
        if (!latest || record.issuedAt >= latest.issuedAt) latest = record;
      }
      return latest ? { ...latest } : null;
    },
    async claimRedemption(request) {
      calls.push({ method: "claimRedemption", args: request });
      const record = records.get(request.grantId);
      if (!record || record.status !== "issued") return null;
      if (
        record.taskId !== request.taskId ||
        record.runId !== request.runId ||
        record.runGeneration !== request.runGeneration
      ) {
        return null;
      }
      record.status = "redeemed";
      record.redeemedAt = request.now;
      return { ...record };
    },
    async recordIssuedToken(request) {
      calls.push({ method: "recordIssuedToken", args: request });
      const record = records.get(request.grantId);
      if (record) {
        record.tokenIssuedAt = request.tokenIssuedAt;
        record.tokenExpiresAt = request.tokenExpiresAt;
      }
    },
    async recordFailure(request) {
      calls.push({ method: "recordFailure", args: request });
      const record = records.get(request.grantId);
      if (record) record.lastErrorCode = request.code;
    },
    async recordRevokeOutcome(request) {
      calls.push({ method: "recordRevokeOutcome", args: request });
      const record = records.get(request.grantId);
      if (record) {
        record.revokeOutcome = {
          revoked: request.revoked,
          reason: request.reason,
          at: request.now,
        };
      }
    },
    async listByRun(runId) {
      calls.push({ method: "listByRun", args: { runId } });
      return [...records.values()]
        .filter((record) => record.runId === runId)
        .map((r) => ({ ...r }));
    },
  };
  return { store, records, calls };
}

function setup(options?: { ttlMs?: number }) {
  let clock = ISSUED_AT;
  const memory = createMemoryGrantStore();
  const capture = createCapturingLogger();
  const minted: Array<{ repositoryId: number; installationId: number; purpose: string }> = [];
  const revokedTokens: string[] = [];
  let mintFails = false;
  const broker = createGitGrantBroker({
    store: memory.store,
    mint: async (request) => {
      minted.push(request);
      if (mintFails) {
        const error = new Error("mint rejected") as Error & { code: string };
        error.code = "permission_revoked";
        throw error;
      }
      return {
        token: TOKEN,
        expiresAt: clock + 3_600_000,
        permissions: ["contents:read", "metadata:read"],
      };
    },
    revokeToken: async (token) => {
      revokedTokens.push(token);
      return { revoked: true, reason: "revoked" };
    },
    ttlMs: options?.ttlMs,
    now: () => clock,
    newGrantId: (() => {
      let counter = 0;
      return () => `grant-${++counter}`;
    })(),
    logger: capture.logger,
  });
  return {
    broker,
    memory,
    capture,
    minted,
    revokedTokens,
    advance: (ms: number) => {
      clock += ms;
    },
    failNextMint: () => {
      mintFails = true;
    },
  };
}

const ISSUE_REQUEST = {
  taskId: "11111111-2222-3333-4444-555555555555",
  runId: "run-1",
  runGeneration: 1,
  repositoryId: 777,
  installationId: 4242,
  purpose: "clone" as const,
};

test("a grant redeems exactly once and never returns the token again", async () => {
  const { broker, minted, memory } = setup();
  const issued = await broker.issue(ISSUE_REQUEST);
  assert.equal(issued.expiresAt, ISSUED_AT + GIT_GRANT_TTL_MS);

  const first = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  assert.equal(first.ok, true);
  assert.equal(first.ok && first.token, TOKEN);
  assert.equal(minted.length, 1);

  const replay = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.reason, "already-redeemed");
  assert.equal(minted.length, 1, "a replay must not mint a second token");
  assert.equal(memory.records.get("grant-1")?.status, "redeemed");
});

test("an expired grant is refused even though the record still exists", async () => {
  const { broker, advance, minted } = setup();
  await broker.issue(ISSUE_REQUEST);
  advance(GIT_GRANT_TTL_MS + 1);
  const result = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "expired");
  assert.equal(result.ok === false && result.code, "stale");
  assert.equal(minted.length, 0);
});

test("an older run generation cannot claim the grant", async () => {
  const { broker, minted, memory } = setup();
  await broker.issue(ISSUE_REQUEST);
  const result = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 2,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "binding-mismatch");
  assert.equal(result.ok === false && result.code, "stale");
  assert.equal(minted.length, 0);
  assert.equal(memory.records.get("grant-1")?.status, "issued", "binding failure consumes nothing");
});

test("a grant is bound to its repository and purpose", async () => {
  const { broker, minted } = setup();
  await broker.issue(ISSUE_REQUEST);
  const wrongRepo = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: 888,
    purpose: "clone",
  });
  assert.equal(wrongRepo.ok === false && wrongRepo.reason, "binding-mismatch");

  const wrongPurpose = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "push",
  });
  assert.equal(wrongPurpose.ok, false);
  assert.equal(minted.length, 0);
});

test("a revoked grant is refused", async () => {
  const { broker, memory, minted } = setup();
  await broker.issue(ISSUE_REQUEST);
  memory.records.get("grant-1")!.status = "revoked";
  const result = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.code, "permission_revoked");
  assert.equal(minted.length, 0);
});

test("a proof binding rejects a mismatching credential in constant time", async () => {
  const { broker, minted } = setup();
  await broker.issue({ ...ISSUE_REQUEST, proofHash: sha256Hex("run-proof-1") });
  const wrong = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
    proof: "run-proof-2",
  });
  assert.equal(wrong.ok, false);
  assert.equal(wrong.ok === false && wrong.reason, "bad-proof");
  assert.equal(minted.length, 0);

  const right = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
    proof: "run-proof-1",
  });
  assert.equal(right.ok, true);
  assert.equal(constantTimeEqualHex(sha256Hex("a"), sha256Hex("b")), false);
  assert.equal(constantTimeEqualHex("abc", "abcd"), false);
});

test("a failed mint consumes the grant instead of allowing a silent retry", async () => {
  const { broker, memory, failNextMint, minted } = setup();
  await broker.issue(ISSUE_REQUEST);
  failNextMint();
  const failed = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false && failed.code, "permission_revoked");
  assert.equal(memory.records.get("grant-1")?.lastErrorCode, "permission_revoked");
  assert.equal(memory.records.get("grant-1")?.status, "redeemed");

  const again = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  assert.equal(again.ok, false);
  assert.equal(minted.length, 1, "no uncontrolled re-mint after a failed redemption");
});

test("a run without an issued grant is denied", async () => {
  const { broker, minted } = setup();
  const result = await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: "run-without-grant",
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "no-issued-grant");
  assert.equal(minted.length, 0);
});

test("raw tokens never reach the store, the logs or the grant record", async () => {
  const { broker, memory, capture } = setup();
  await broker.issue(ISSUE_REQUEST);
  await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  await broker.revoke({ grantId: "grant-1", reason: "test" });

  const persisted = JSON.stringify([...memory.records.values()]);
  assert.ok(!persisted.includes(TOKEN), "the grant record must not contain the raw token");
  for (const call of memory.calls) {
    assert.ok(
      !JSON.stringify(call.args).includes(TOKEN),
      `store call leaked a token: ${call.method}`,
    );
  }
  for (const line of capture.lines) {
    assert.ok(!line.includes(TOKEN), `log line leaked a token: ${line}`);
  }
});

test("revocation is best effort: held tokens are revoked, forgotten ones are reported honestly", async () => {
  const { broker, memory, revokedTokens } = setup();
  await broker.issue(ISSUE_REQUEST);
  await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  assert.deepEqual(await broker.revoke({ grantId: "grant-1", reason: "run-stopped" }), {
    revoked: true,
    reason: "revoked",
  });
  assert.deepEqual(revokedTokens, [TOKEN]);

  // 第二次撤销时 broker 已不再持有 token：如实说明，不伪造完成（01 §7.2）。
  const second = await broker.revoke({ grantId: "grant-1", reason: "run-stopped" });
  assert.equal(second.revoked, false);
  assert.equal(second.reason, "token-not-held");
  assert.equal(memory.records.get("grant-1")?.revokeOutcome?.revoked, false);
});

test("revokeRun sweeps every grant of a run and reports the split", async () => {
  const { broker } = setup();
  const first = await broker.issue(ISSUE_REQUEST);
  await broker.redeem({
    taskId: ISSUE_REQUEST.taskId,
    runId: ISSUE_REQUEST.runId,
    runGeneration: 1,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });
  await broker.issue({ ...ISSUE_REQUEST, purpose: "push" });
  const outcome = await broker.revokeRun({ runId: ISSUE_REQUEST.runId, reason: "run-ended" });
  assert.equal(outcome.revoked, 1);
  assert.equal(outcome.notHeld, 1);
  assert.ok(first.grantId);
});

// ── 端点 ──

function routeRequest(overrides: Partial<GitGrantRouteRequest> = {}): GitGrantRouteRequest {
  return { runId: "run-1", credential: "run-scoped-credential", purpose: "clone", ...overrides };
}

function createRoute(broker: ReturnType<typeof setup>["broker"]) {
  return createGitGrantRouteHandler({
    broker,
    resolveRunPrincipal: async (request) =>
      request.credential === "run-scoped-credential"
        ? {
            ok: true,
            principal: {
              taskId: ISSUE_REQUEST.taskId,
              runId: "run-1",
              runGeneration: 1,
              repositoryId: ISSUE_REQUEST.repositoryId,
            },
          }
        : { ok: false, code: "unauthenticated", message: "missing run credential" },
  });
}

test("the git grant endpoint returns the frozen response shape once", async () => {
  const { broker, memory } = setup();
  await broker.issue(ISSUE_REQUEST);
  const handle = createRoute(broker);

  const response = await handle(routeRequest());
  assert.equal(response.status, 200);
  const parsed = cloudGitGrantResponseSchema.safeParse(response.body);
  assert.equal(parsed.success, true, "response must satisfy the frozen shared schema");
  assert.deepEqual(parsed.success && parsed.data, {
    grantId: "grant-1",
    token: TOKEN,
    expiresAt: memory.records.get("grant-1")?.tokenExpiresAt,
    repositoryId: ISSUE_REQUEST.repositoryId,
    purpose: "clone",
  });

  const replay = await handle(routeRequest());
  assert.equal(replay.status, 403);
  assert.equal(
    replay.body && "code" in replay.body && replay.body.code,
    "unauthorized",
    "a replay is denied, never re-issued",
  );
});

test("the endpoint denies credentials that do not belong to the path run", async () => {
  const { broker, memory } = setup();
  await broker.issue(ISSUE_REQUEST);
  const handle = createGitGrantRouteHandler({
    broker,
    resolveRunPrincipal: async () => ({
      ok: true,
      principal: {
        taskId: ISSUE_REQUEST.taskId,
        runId: "another-run",
        runGeneration: 1,
        repositoryId: ISSUE_REQUEST.repositoryId,
      },
    }),
  });
  const response = await handle(routeRequest());
  assert.equal(response.status, 403);
  assert.equal(response.body && "code" in response.body && response.body.code, "unauthorized");
  assert.equal(memory.records.get("grant-1")?.status, "issued", "nothing was redeemed");
});

test("the endpoint maps an unauthenticated principal to 401 with the error envelope", async () => {
  const { broker } = setup();
  await broker.issue(ISSUE_REQUEST);
  const handle = createRoute(broker);
  const response = await handle(routeRequest({ credential: "nope" }));
  assert.equal(response.status, 401);
  assert.deepEqual(response.body, {
    code: "unauthenticated",
    message: "missing run credential",
    retryable: false,
    traceId: response.body && "traceId" in response.body ? response.body.traceId : undefined,
  });
});

/**
 * GitHubEffect outbox 执行器用例（specs/cloud-agent 09 §5.2 六条、§5.3 外部修改、
 * §8 恢复；10 §6 B09「PR 创建未知」「外部 branch 改动」「不覆盖产物」）。
 *
 * store 是测试内存实现：只验证执行器的幂等键、租约、expectedHeadSha 与对账语义，
 * 真实落表属 W2（`external_operations`）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  GitHubEffectEnqueueRequest,
  GitHubEffectRecord,
  GitHubEffectSettleOutcome,
  GitHubEffectStore,
  LeasedGitHubEffect,
} from "../src/cloud/app/ports/gitHubEffectPort.js";
import { draftPullRequestBusinessKey } from "../src/cloud/app/ports/gitHubEffectPort.js";
import { GitHubApiError } from "../src/cloud/adapters/github/http.js";
import type { EffectTargetResolution } from "../src/cloud/adapters/github/effects/effectExecutor.js";
import {
  TEST_REPOSITORY_ID,
  TEST_TASK_ID,
  branchBody,
  compareBody,
  createFakeGitHub,
  createTestAdapter,
  installEchoMintRoute,
  installRepositoryRoute,
  markerBody,
  pullRequestBody,
  respond,
} from "./cloudGithubTestSupport.js";

const REPO_PATH = "/repos/acme/repo";
const PULLS_PATH = `${REPO_PATH}/pulls`;
const TASK_BRANCH = "zcode/task-1-slug";
const BASE_BRANCH = "main";
const EXPECTED_SHA = "2".repeat(40);

function createMemoryEffectStore(): GitHubEffectStore & {
  records: Map<string, GitHubEffectRecord>;
} {
  const records = new Map<string, GitHubEffectRecord>();
  const byBusinessKey = new Map<string, string>();
  let leaseCounter = 0;

  function clone(record: GitHubEffectRecord): GitHubEffectRecord {
    return { ...record };
  }

  return {
    records,
    async enqueue(request: GitHubEffectEnqueueRequest) {
      const existingId = byBusinessKey.get(request.businessKey);
      if (existingId) {
        return { effect: clone(records.get(existingId)!), created: false };
      }
      const record: GitHubEffectRecord = {
        effectId: request.effectId,
        businessKey: request.businessKey,
        kind: request.kind,
        taskId: request.taskId,
        runId: request.runId,
        runGeneration: request.runGeneration,
        repositoryId: request.repositoryId,
        taskBranch: request.taskBranch,
        baseBranch: request.baseBranch,
        desiredRevision: request.desiredRevision,
        expectedHeadSha: request.expectedHeadSha,
        payloadRef: request.payloadRef,
        status: "pending",
        attempts: 0,
        nextAttemptAt: request.now,
        createdAt: request.now,
        updatedAt: request.now,
      };
      records.set(record.effectId, record);
      byBusinessKey.set(record.businessKey, record.effectId);
      return { effect: clone(record), created: true };
    },
    async get(effectId) {
      const record = records.get(effectId);
      return record ? clone(record) : null;
    },
    async leaseNext({ kinds, leaseMs, now }): Promise<LeasedGitHubEffect | null> {
      for (const record of records.values()) {
        if (!kinds.includes(record.kind)) continue;
        const expiredLease = record.status === "leased" && (record.leaseExpiresAt ?? 0) <= now;
        if (record.status !== "pending" && record.status !== "ambiguous" && !expiredLease) continue;
        if (record.nextAttemptAt > now) continue;
        leaseCounter += 1;
        const leaseToken = `lease-${leaseCounter}`;
        record.status = "leased";
        record.leaseToken = leaseToken;
        record.leaseExpiresAt = now + leaseMs;
        record.attempts += 1;
        record.updatedAt = now;
        return { effect: clone(record), leaseToken, leaseExpiresAt: record.leaseExpiresAt };
      }
      return null;
    },
    async settle(request: {
      effectId: string;
      leaseToken: string;
      outcome: GitHubEffectSettleOutcome;
      remoteId?: string;
      resultRef?: string;
      errorCode?: GitHubEffectRecord["lastErrorCode"];
      errorMessage?: string;
      nextAttemptAt?: number;
      now: number;
    }) {
      const record = records.get(request.effectId);
      if (!record || record.leaseToken !== request.leaseToken) return false;
      record.status =
        request.outcome === "settled"
          ? "settled"
          : request.outcome === "retry"
            ? "pending"
            : request.outcome;
      record.remoteId = request.remoteId ?? record.remoteId;
      record.resultRef = request.resultRef ?? record.resultRef;
      record.lastErrorCode = request.errorCode;
      record.lastError = request.errorMessage;
      record.nextAttemptAt = request.nextAttemptAt ?? record.nextAttemptAt;
      record.leaseToken = undefined;
      record.leaseExpiresAt = undefined;
      record.updatedAt = request.now;
      return true;
    },
    async listUnsettled() {
      return [...records.values()]
        .filter((record) => record.status !== "settled" && record.status !== "failed")
        .map(clone);
    },
  };
}

async function enqueuePullRequestEffect(
  store: GitHubEffectStore,
  overrides: Partial<GitHubEffectEnqueueRequest> = {},
) {
  return store.enqueue({
    effectId: "effect-1",
    kind: "pull-request",
    businessKey: draftPullRequestBusinessKey({
      repositoryId: TEST_REPOSITORY_ID,
      taskId: TEST_TASK_ID,
      taskBranch: TASK_BRANCH,
    }),
    taskId: TEST_TASK_ID,
    runId: "run-1",
    runGeneration: 1,
    repositoryId: TEST_REPOSITORY_ID,
    taskBranch: TASK_BRANCH,
    baseBranch: BASE_BRANCH,
    desiredRevision: 3,
    expectedHeadSha: EXPECTED_SHA,
    now: 1_000,
    ...overrides,
  });
}

function target(): EffectTargetResolution {
  return {
    ok: true,
    target: {
      repositoryId: TEST_REPOSITORY_ID,
      taskId: TEST_TASK_ID,
      taskBranch: TASK_BRANCH,
      baseBranch: BASE_BRANCH,
      title: "Task 1",
      managed: "cloud task link",
      expectedHeadSha: EXPECTED_SHA,
    },
  };
}

function setup(options?: { maxAttempts?: number }) {
  const fake = createFakeGitHub();
  installEchoMintRoute(fake);
  installRepositoryRoute(fake);
  let clock = 1_000_000;
  const adapter = createTestAdapter({ fake, now: () => clock });
  const store = createMemoryEffectStore();
  const executor = adapter.createEffectExecutor({
    store,
    resolvePullRequestTarget: async () => target(),
    workerId: "worker-1",
    maxAttempts: options?.maxAttempts ?? 3,
  });
  return {
    fake,
    adapter,
    store,
    executor,
    advance: (ms: number) => {
      clock += ms;
    },
  };
}

function branchRoute(fake: ReturnType<typeof createFakeGitHub>, sha = EXPECTED_SHA) {
  fake.on("GET", `${REPO_PATH}/branches/${encodeURIComponent(TASK_BRANCH)}`, () =>
    respond(branchBody(TASK_BRANCH, sha)),
  );
}

test("a checkpoint publication settles with the created pull request id", async () => {
  const { fake, store, executor } = setup();
  await enqueuePullRequestEffect(store);
  branchRoute(fake);
  fake.on("GET", PULLS_PATH, () => respond([]));
  fake.on("POST", PULLS_PATH, () =>
    respond(
      pullRequestBody({
        number: 42,
        head: TASK_BRANCH,
        base: BASE_BRANCH,
        body: markerBody(TEST_TASK_ID),
      }),
    ),
  );

  const result = await executor.runOnce();
  assert.equal(result.outcome, "settled");
  assert.equal(result.outcome === "settled" && result.remoteId, "42");
  const stored = store.records.get("effect-1");
  assert.equal(stored?.status, "settled");
  assert.equal(stored?.remoteId, "42");
});

test("business key uniqueness prevents a second publication worker target", async () => {
  const { store } = setup();
  const first = await enqueuePullRequestEffect(store);
  const second = await enqueuePullRequestEffect(store, { effectId: "effect-2" });
  assert.equal(first.created, true);
  assert.equal(second.created, false);
  assert.equal(second.effect.effectId, "effect-1");
});

test("the port enqueueEffect turns a descriptor into a persistent effect", async () => {
  const fake = createFakeGitHub();
  const store = createMemoryEffectStore();
  const adapter = createTestAdapter({ fake, effectStore: store, now: () => 1_000_000 });
  const enqueued = await adapter.port.enqueueEffect({
    kind: "pull-request",
    repositoryId: TEST_REPOSITORY_ID,
    taskId: TEST_TASK_ID,
    runId: "run-1",
    runGeneration: 1,
    taskBranch: TASK_BRANCH,
    baseBranch: BASE_BRANCH,
    desiredRevision: 7,
    expectedHeadSha: EXPECTED_SHA,
    payloadRef: "checkpoint:cp-1",
  });
  assert.equal(
    enqueued.businessKey,
    draftPullRequestBusinessKey({
      repositoryId: TEST_REPOSITORY_ID,
      taskId: TEST_TASK_ID,
      taskBranch: TASK_BRANCH,
    }),
  );
  const stored = store.records.get(enqueued.effectId);
  assert.equal(stored?.desiredRevision, 7, "the descriptor revision must reach the store");
  assert.equal(stored?.expectedHeadSha, EXPECTED_SHA);
  assert.equal(stored?.status, "pending");
  assert.equal(fake.requests.length, 0, "enqueueing is a store write, not a GitHub call");
});

test("the port enqueueEffect is idempotent per business key", async () => {
  const fake = createFakeGitHub();
  const store = createMemoryEffectStore();
  const adapter = createTestAdapter({ fake, effectStore: store });
  const descriptor = {
    kind: "pull-request" as const,
    repositoryId: TEST_REPOSITORY_ID,
    taskId: TEST_TASK_ID,
    taskBranch: TASK_BRANCH,
    baseBranch: BASE_BRANCH,
    desiredRevision: 3,
  };
  const first = await adapter.port.enqueueEffect(descriptor);
  const second = await adapter.port.enqueueEffect({ ...descriptor, desiredRevision: 4 });
  assert.equal(
    second.effectId,
    first.effectId,
    "same business key must not create a second target",
  );
  assert.equal(store.records.size, 1);
});

test("the port enqueueEffect rejects descriptors that miss kind-required fields", async () => {
  const fake = createFakeGitHub();
  const adapter = createTestAdapter({ fake, effectStore: createMemoryEffectStore() });
  await assert.rejects(
    () =>
      adapter.port.enqueueEffect({
        kind: "pull-request",
        repositoryId: TEST_REPOSITORY_ID,
        taskId: TEST_TASK_ID,
        desiredRevision: 1,
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "validation_failed",
  );
  await assert.rejects(
    () =>
      adapter.port.enqueueEffect({
        kind: "token-revoke",
        repositoryId: TEST_REPOSITORY_ID,
        desiredRevision: 1,
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "validation_failed",
  );
});

test("enqueueEffect without the W2 store is not_implemented instead of silently dropped", async () => {
  const fake = createFakeGitHub();
  const adapter = createTestAdapter({ fake });
  await assert.rejects(
    () =>
      adapter.port.enqueueEffect({
        kind: "pull-request",
        repositoryId: TEST_REPOSITORY_ID,
        taskId: TEST_TASK_ID,
        taskBranch: TASK_BRANCH,
        baseBranch: BASE_BRANCH,
        desiredRevision: 1,
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "not_implemented",
  );
});

test("an already associated pull request settles without a second create", async () => {
  const { fake, store, executor } = setup();
  await enqueuePullRequestEffect(store);
  branchRoute(fake);
  fake.on("GET", PULLS_PATH, () =>
    respond([
      pullRequestBody({
        number: 5,
        head: TASK_BRANCH,
        base: BASE_BRANCH,
        body: markerBody(TEST_TASK_ID),
      }),
    ]),
  );
  const result = await executor.runOnce();
  assert.equal(result.outcome === "settled" && result.remoteId, "5");
  assert.equal(fake.hits("POST", PULLS_PATH), 0);
});

test("an externally advanced task branch pauses publication with a conflict", async () => {
  const { fake, store, executor } = setup();
  await enqueuePullRequestEffect(store);
  const aheadSha = "3".repeat(40);
  branchRoute(fake, aheadSha);
  fake.on("GET", `${REPO_PATH}/compare/${EXPECTED_SHA}...${aheadSha}`, () =>
    respond(compareBody({ status: "ahead", aheadBy: 1 })),
  );

  const result = await executor.runOnce();
  assert.equal(result.outcome, "failed");
  assert.equal(result.outcome === "failed" && result.code, "branch_conflict");
  assert.equal(fake.hits("POST", PULLS_PATH), 0);
  assert.equal(store.records.get("effect-1")?.status, "failed");
});

test("a rewritten task branch fails as non_fast_forward without forcing anything", async () => {
  for (const status of ["behind", "diverged"] as const) {
    const { fake, store, executor } = setup();
    await enqueuePullRequestEffect(store);
    const rewrittenSha = "4".repeat(40);
    branchRoute(fake, rewrittenSha);
    fake.on("GET", `${REPO_PATH}/compare/${EXPECTED_SHA}...${rewrittenSha}`, () =>
      respond(compareBody({ status, aheadBy: 1, behindBy: 1 })),
    );
    const result = await executor.runOnce();
    assert.equal(result.outcome, "failed", status);
    assert.equal(result.outcome === "failed" && result.code, "non_fast_forward", status);
    assert.equal(fake.hits("POST", PULLS_PATH), 0);
  }
});

test("a missing task branch is a conflict, not a silent re-create", async () => {
  const { fake, store, executor } = setup();
  await enqueuePullRequestEffect(store);
  fake.on("GET", `${REPO_PATH}/branches/${encodeURIComponent(TASK_BRANCH)}`, () => ({
    status: 404,
    body: {},
  }));
  const result = await executor.runOnce();
  assert.equal(result.outcome === "failed" && result.code, "branch_conflict");
  assert.equal(fake.hits("POST", PULLS_PATH), 0);
});

test("no diff settles as no-changes rather than a failed publication", async () => {
  const { fake, store, executor } = setup();
  await enqueuePullRequestEffect(store);
  branchRoute(fake);
  fake.on("GET", PULLS_PATH, () => respond([]));
  fake.on("POST", PULLS_PATH, () => ({
    status: 422,
    body: { message: `No commits between ${BASE_BRANCH} and ${TASK_BRANCH}` },
  }));
  const result = await executor.runOnce();
  assert.equal(result.outcome, "settled");
  assert.equal(result.outcome === "settled" && result.resultRef, "no-changes");
  assert.equal(store.records.get("effect-1")?.status, "settled");
});

test("a lost create response is reconciled by querying before any retry", async () => {
  const { fake, store, executor } = setup();
  await enqueuePullRequestEffect(store);
  branchRoute(fake);
  // PR 已在 GitHub 建好，只是响应在回程丢失：第一次查询还看不到，创建时才出现。
  let createdServerSide = false;
  fake.on("POST", PULLS_PATH, () => {
    createdServerSide = true;
    return { throws: new Error("socket hang up") };
  });
  fake.on("GET", PULLS_PATH, () =>
    respond(
      createdServerSide
        ? [
            pullRequestBody({
              number: 77,
              head: TASK_BRANCH,
              base: BASE_BRANCH,
              body: markerBody(TEST_TASK_ID),
            }),
          ]
        : [],
    ),
  );
  const result = await executor.runOnce();
  assert.equal(result.outcome, "settled");
  assert.equal(result.outcome === "settled" && result.remoteId, "77");
  assert.equal(fake.hits("POST", PULLS_PATH), 1, "the create is never retried blindly");
  assert.equal(store.records.get("effect-1")?.status, "settled");
});

test("an unknown create result becomes ambiguous and reconciles on a later lease", async () => {
  const { fake, store, executor, advance } = setup();
  await enqueuePullRequestEffect(store);
  branchRoute(fake);
  let visible = false;
  fake.on("POST", PULLS_PATH, () => ({ throws: new Error("socket hang up") }));
  fake.on("GET", PULLS_PATH, () =>
    respond(
      visible
        ? [
            pullRequestBody({
              number: 78,
              head: TASK_BRANCH,
              base: BASE_BRANCH,
              body: markerBody(TEST_TASK_ID),
            }),
          ]
        : [],
    ),
  );
  const first = await executor.runOnce();
  assert.equal(first.outcome, "ambiguous", "unknown must not be written as failed");
  assert.equal(store.records.get("effect-1")?.status, "ambiguous");

  // 对账阶段重新读 GitHub 事实：PR 确实存在 → 关联而不是再建一次。
  visible = true;
  advance(60_000);
  const second = await executor.runOnce();
  assert.equal(second.outcome, "settled");
  assert.equal(second.outcome === "settled" && second.remoteId, "78");
  assert.equal(fake.hits("POST", PULLS_PATH), 1);
});

test("rate limiting schedules a bounded retry instead of a blind loop", async () => {
  const { fake, store, executor } = setup();
  await enqueuePullRequestEffect(store);
  branchRoute(fake);
  fake.on("GET", PULLS_PATH, () => ({ status: 403, body: {}, headers: { "retry-after": "30" } }));
  const result = await executor.runOnce();
  assert.equal(result.outcome, "retried");
  assert.equal(result.outcome === "retried" && result.code, "rate_limited");
  const stored = store.records.get("effect-1");
  assert.equal(stored?.status, "pending");
  assert.ok((stored?.nextAttemptAt ?? 0) >= 1_030_000, "retry-after must be honoured");
});

test("retryable failures stop after the attempt budget", async () => {
  const { fake, store, executor, advance } = setup({ maxAttempts: 2 });
  await enqueuePullRequestEffect(store);
  branchRoute(fake);
  fake.on("GET", PULLS_PATH, () => ({ status: 403, body: {}, headers: { "retry-after": "1" } }));
  await executor.runOnce();
  advance(5_000);
  const second = await executor.runOnce();
  assert.equal(second.outcome, "failed");
  assert.equal(second.outcome === "failed" && second.code, "rate_limited");
  const stored = store.records.get("effect-1");
  assert.equal(stored?.status, "failed");
  assert.equal(stored?.attempts, 2);
});

test("a task that is no longer the latest revision fails instead of publishing stale work", async () => {
  const fake = createFakeGitHub();
  installEchoMintRoute(fake);
  installRepositoryRoute(fake);
  const adapter = createTestAdapter({ fake });
  const store = createMemoryEffectStore();
  const executor = adapter.createEffectExecutor({
    store,
    resolvePullRequestTarget: async () => ({
      ok: false,
      code: "stale",
      message: "effect revision 3 is superseded by 4",
    }),
    workerId: "worker-1",
  });
  await enqueuePullRequestEffect(store);
  const result = await executor.runOnce();
  assert.equal(result.outcome, "failed");
  assert.equal(result.outcome === "failed" && result.code, "stale");
  assert.equal(fake.hits("POST", PULLS_PATH), 0);
});

test("M7-conditional kinds fail explicitly instead of pretending success", async () => {
  for (const kind of ["check", "comment"] as const) {
    const { store, executor } = setup();
    await store.enqueue({
      effectId: `effect-${kind}`,
      kind,
      businessKey: `key-${kind}`,
      taskId: TEST_TASK_ID,
      desiredRevision: 0,
      now: 1_000,
    });
    const result = await executor.runOnce();
    assert.equal(result.outcome, "failed");
    assert.equal(result.outcome === "failed" && result.code, "not_implemented");
    assert.equal(store.records.get(`effect-${kind}`)?.status, "failed");
  }
});

test("token revoke effects run through the injected grant broker callback", async () => {
  const fake = createFakeGitHub();
  const adapter = createTestAdapter({ fake });
  const store = createMemoryEffectStore();
  const revoked: string[] = [];
  const executor = adapter.createEffectExecutor({
    store,
    resolvePullRequestTarget: async () => ({ ok: false, code: "stale", message: "unused" }),
    workerId: "worker-1",
    revokeGrantToken: async ({ grantId }) => {
      revoked.push(grantId);
      return { settled: true, detail: "revoked" };
    },
  });
  await store.enqueue({
    effectId: "effect-revoke",
    kind: "token-revoke",
    businessKey: "revoke-grant-1",
    payloadRef: "grant-1",
    desiredRevision: 0,
    now: 1_000,
  });
  const result = await executor.runOnce();
  assert.deepEqual(revoked, ["grant-1"]);
  assert.equal(result.outcome, "settled");
  assert.equal(result.outcome === "settled" && result.resultRef, "revoked");
});

test("token revoke without a broker is not_implemented rather than silently dropped", async () => {
  const fake = createFakeGitHub();
  const adapter = createTestAdapter({ fake });
  const store = createMemoryEffectStore();
  const executor = adapter.createEffectExecutor({
    store,
    resolvePullRequestTarget: async () => ({ ok: false, code: "stale", message: "unused" }),
    workerId: "worker-1",
  });
  await store.enqueue({
    effectId: "effect-revoke",
    kind: "token-revoke",
    businessKey: "revoke-grant-1",
    desiredRevision: 0,
    now: 1_000,
  });
  const result = await executor.runOnce();
  assert.equal(result.outcome === "failed" && result.code, "not_implemented");
});

test("a revoked app permission blocks the publication instead of being retried", async () => {
  const { fake, store, executor } = setup();
  await enqueuePullRequestEffect(store);
  branchRoute(fake);
  fake.on("GET", PULLS_PATH, () => respond([]));
  fake.on("POST", PULLS_PATH, () => ({
    status: 403,
    body: { message: "Resource not accessible by integration" },
  }));
  const result = await executor.runOnce();
  assert.equal(result.outcome, "failed");
  assert.equal(result.outcome === "failed" && result.code, "permission_revoked");
  assert.equal(store.records.get("effect-1")?.status, "failed");
  assert.equal(fake.hits("POST", PULLS_PATH), 1, "403 must not be retried blindly");
});

test("runOnce is idle when there is nothing to lease", async () => {
  const { executor } = setup();
  assert.deepEqual(await executor.runOnce(), { outcome: "idle" });
});

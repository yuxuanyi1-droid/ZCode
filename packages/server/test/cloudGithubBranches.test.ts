/**
 * refs / baseSha 冻结 / taskBranch 核验用例（specs/cloud-agent 09 §4.1 不可变基线、
 * §4.2 单活 writer、§5.3 外部修改对账、10 §6 B09「base 改名」「外部 branch 改动」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cloudBranchPageSchema } from "@zcode/shared";
import { GitHubApiError } from "../src/cloud/adapters/github/http.js";
import {
  TEST_REPOSITORY_ID,
  branchBody,
  compareBody,
  createFakeGitHub,
  createTestAdapter,
  installEchoMintRoute,
  installRepositoryRoute,
  respond,
} from "./cloudGithubTestSupport.js";

const REPO_PATH = `/repos/acme/repo`;
const BASE_SHA = "1".repeat(40);
const HEAD_SHA = "2".repeat(40);

function setup(options?: { repository?: boolean }) {
  const fake = createFakeGitHub();
  installEchoMintRoute(fake);
  if (options?.repository !== false) installRepositoryRoute(fake);
  return { fake, adapter: createTestAdapter({ fake }) };
}

test("branch head reads are percent-encoded so task branches with slashes work", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", `${REPO_PATH}/branches/zcode%2Ftask-1-slug`, () =>
    respond(branchBody("zcode/task-1-slug", HEAD_SHA)),
  );
  const head = await adapter.port.getBranchHead({
    repositoryId: TEST_REPOSITORY_ID,
    branch: "zcode/task-1-slug",
  });
  assert.equal(head?.exists, true);
  assert.equal(head?.sha, HEAD_SHA);
  assert.equal(head?.name, "zcode/task-1-slug");
});

test("a missing branch is exists:false rather than an error", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", `${REPO_PATH}/branches/gone`, () => ({ status: 404, body: {} }));
  const head = await adapter.port.getBranchHead({
    repositoryId: TEST_REPOSITORY_ID,
    branch: "gone",
  });
  assert.equal(head?.exists, false);
  assert.equal(head?.sha, "");
});

test("base sha is resolved from the branch head and a missing base is a conflict", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", `${REPO_PATH}/branches/main`, () => respond(branchBody("main", BASE_SHA)));
  fake.on("GET", `${REPO_PATH}/branches/renamed-away`, () => ({ status: 404, body: {} }));
  assert.deepEqual(
    await adapter.branches.resolveBaseSha({ repositoryId: TEST_REPOSITORY_ID, baseBranch: "main" }),
    { baseBranch: "main", sha: BASE_SHA },
  );
  await assert.rejects(
    () =>
      adapter.branches.resolveBaseSha({
        repositoryId: TEST_REPOSITORY_ID,
        baseBranch: "renamed-away",
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "branch_conflict",
  );
});

test("a frozen base commit that is no longer fetchable fails explicitly", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", `${REPO_PATH}/commits/${BASE_SHA}`, () => respond({ sha: BASE_SHA }));
  fake.on("GET", `${REPO_PATH}/commits/${HEAD_SHA}`, () => ({ status: 404, body: {} }));
  assert.equal(
    await adapter.branches.isCommitFetchable({ repositoryId: TEST_REPOSITORY_ID, sha: BASE_SHA }),
    true,
  );
  assert.equal(
    await adapter.branches.isCommitFetchable({ repositoryId: TEST_REPOSITORY_ID, sha: HEAD_SHA }),
    false,
  );
});

test("compare maps ahead/behind/diverged and drives fast-forward判断", async () => {
  const { fake, adapter } = setup();
  const comparisons = new Map<string, unknown>([
    [
      `${REPO_PATH}/compare/${BASE_SHA}...${HEAD_SHA}`,
      compareBody({ status: "ahead", aheadBy: 3 }),
    ],
    [
      `${REPO_PATH}/compare/${HEAD_SHA}...${BASE_SHA}`,
      compareBody({ status: "behind", behindBy: 3 }),
    ],
    [`${HEAD_SHA}...${HEAD_SHA}`, compareBody({ status: "identical" })],
  ]);
  fake.on("GET", `${REPO_PATH}/compare/${BASE_SHA}...${HEAD_SHA}`, () =>
    respond(comparisons.get(`${REPO_PATH}/compare/${BASE_SHA}...${HEAD_SHA}`)),
  );
  fake.on("GET", `${REPO_PATH}/compare/${HEAD_SHA}...${BASE_SHA}`, () =>
    respond(compareBody({ status: "behind", behindBy: 3 })),
  );
  fake.on("GET", `${REPO_PATH}/compare/${HEAD_SHA}...${"3".repeat(40)}`, () =>
    respond(compareBody({ status: "diverged", aheadBy: 1, behindBy: 1 })),
  );

  const ahead = await adapter.branches.compare({
    repositoryId: TEST_REPOSITORY_ID,
    base: BASE_SHA,
    head: HEAD_SHA,
  });
  assert.equal(ahead.status, "ahead");
  assert.equal(ahead.aheadBy, 3);

  assert.equal(
    await adapter.branches.isFastForward({
      repositoryId: TEST_REPOSITORY_ID,
      from: BASE_SHA,
      to: HEAD_SHA,
    }),
    true,
  );
  assert.equal(
    await adapter.branches.isFastForward({
      repositoryId: TEST_REPOSITORY_ID,
      from: HEAD_SHA,
      to: BASE_SHA,
    }),
    false,
  );
  assert.equal(
    await adapter.branches.isFastForward({
      repositoryId: TEST_REPOSITORY_ID,
      from: HEAD_SHA,
      to: "3".repeat(40),
    }),
    false,
  );
  assert.equal(
    await adapter.branches.isFastForward({
      repositoryId: TEST_REPOSITORY_ID,
      from: HEAD_SHA,
      to: HEAD_SHA,
    }),
    true,
  );
});

test("task branch verification classifies untouched, externally advanced and rewritten heads", async () => {
  const { fake, adapter } = setup();
  const advanced = "3".repeat(40);
  fake.on("GET", `${REPO_PATH}/branches/zcode%2Ftask-1`, () =>
    respond(branchBody("zcode/task-1", HEAD_SHA)),
  );
  fake.on("GET", `${REPO_PATH}/branches/zcode%2Fmissing`, () => ({ status: 404, body: {} }));
  fake.on("GET", `${REPO_PATH}/compare/${"9".repeat(40)}...${HEAD_SHA}`, () =>
    respond(compareBody({ status: "ahead", aheadBy: 1 })),
  );
  fake.on("GET", `${REPO_PATH}/compare/${"8".repeat(40)}...${HEAD_SHA}`, () =>
    respond(compareBody({ status: "behind", behindBy: 2 })),
  );
  fake.on("GET", `${REPO_PATH}/compare/${"7".repeat(40)}...${HEAD_SHA}`, () =>
    respond(compareBody({ status: "diverged", aheadBy: 1, behindBy: 1 })),
  );

  const identical = await adapter.branches.verifyTaskBranch({
    repositoryId: TEST_REPOSITORY_ID,
    branch: "zcode/task-1",
    expectedSha: HEAD_SHA,
  });
  assert.equal(identical.relation, "identical");

  const ahead = await adapter.branches.verifyTaskBranch({
    repositoryId: TEST_REPOSITORY_ID,
    branch: "zcode/task-1",
    expectedSha: "9".repeat(40),
  });
  assert.equal(ahead.relation, "advanced", "someone pushed on top of the confirmed sha");

  const rewound = await adapter.branches.verifyTaskBranch({
    repositoryId: TEST_REPOSITORY_ID,
    branch: "zcode/task-1",
    expectedSha: "8".repeat(40),
  });
  assert.equal(rewound.relation, "rewound");

  const diverged = await adapter.branches.verifyTaskBranch({
    repositoryId: TEST_REPOSITORY_ID,
    branch: "zcode/task-1",
    expectedSha: "7".repeat(40),
  });
  assert.equal(diverged.relation, "diverged");

  const missing = await adapter.branches.verifyTaskBranch({
    repositoryId: TEST_REPOSITORY_ID,
    branch: "zcode/missing",
    expectedSha: advanced,
  });
  assert.equal(missing.relation, "missing");
});

test("an unrecognized compare status fails closed instead of passing the publication gate", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", `${REPO_PATH}/branches/zcode%2Ftask-1`, () =>
    respond(branchBody("zcode/task-1", HEAD_SHA)),
  );
  fake.on("GET", `${REPO_PATH}/compare/${"9".repeat(40)}...${HEAD_SHA}`, () =>
    respond({ status: "who-knows", ahead_by: 0, behind_by: 0 }),
  );
  await assert.rejects(
    () =>
      adapter.branches.verifyTaskBranch({
        repositoryId: TEST_REPOSITORY_ID,
        branch: "zcode/task-1",
        expectedSha: "9".repeat(40),
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "validation_failed",
  );
});

// ── 分支枚举（03 §6 `GET /api/cloud/repositories/:repoId/branches`）──

const BRANCH_LIST_PATH = `${REPO_PATH}/branches`;

function branchListBody(entries: { name: string; sha: string }[]): unknown {
  return entries.map((entry) => ({ name: entry.name, commit: { sha: entry.sha } }));
}

function nextPageLink(page: number): string {
  return `<https://api.github.test${BRANCH_LIST_PATH}?per_page=2&page=${page}>; rel="next", <https://api.github.test${BRANCH_LIST_PATH}?per_page=2&page=${page}>; rel="last"`;
}

test("branch enumeration pages with an honest cursor and marks the default branch", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", BRANCH_LIST_PATH, (request) => {
    const page = request.query["page"];
    return page === "2"
      ? respond(branchListBody([{ name: "release/1.x", sha: "c".repeat(40) }]))
      : {
          ...respond(
            branchListBody([
              { name: "main", sha: BASE_SHA },
              { name: "feature/one", sha: HEAD_SHA },
            ]),
          ),
          headers: { link: nextPageLink(2) },
        };
  });

  const first = await adapter.branches.listBranches({
    repositoryId: TEST_REPOSITORY_ID,
    limit: 2,
  });
  assert.deepEqual(first.items, [
    { name: "main", sha: BASE_SHA, isDefault: true },
    { name: "feature/one", sha: HEAD_SHA, isDefault: false },
  ]);
  assert.ok(first.nextCursor, "a next link must produce a cursor");
  assert.equal(fake.requests.at(-1)!.query["per_page"], "2");

  const second = await adapter.branches.listBranches({
    repositoryId: TEST_REPOSITORY_ID,
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(second.items, [{ name: "release/1.x", sha: "c".repeat(40), isDefault: false }]);
  assert.equal(second.nextCursor, undefined, "the last page must not carry a fake cursor");
  assert.equal(fake.requests.at(-1)!.query["page"], "2");
});

test("branch enumeration output satisfies the frozen cloudBranchPageSchema", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", BRANCH_LIST_PATH, () =>
    respond(branchListBody([{ name: "main", sha: BASE_SHA }])),
  );
  const page = await adapter.branches.listBranches({ repositoryId: TEST_REPOSITORY_ID, limit: 50 });
  const parsed = cloudBranchPageSchema.safeParse(page);
  assert.equal(parsed.success, true, JSON.stringify(page));
  assert.deepEqual(parsed.success && parsed.data.items[0], {
    name: "main",
    sha: BASE_SHA,
    isDefault: true,
  });
});

test("an empty repository and an empty branch list both return empty items", async () => {
  const { fake, adapter } = setup();
  let status = 200;
  fake.on("GET", BRANCH_LIST_PATH, () =>
    status === 409 ? { status: 409, body: { message: "Git Repository is empty." } } : respond([]),
  );
  const empty = await adapter.branches.listBranches({
    repositoryId: TEST_REPOSITORY_ID,
    limit: 10,
  });
  assert.deepEqual(empty, { items: [] });

  status = 409;
  const unreachable = await adapter.branches.listBranches({
    repositoryId: TEST_REPOSITORY_ID,
    limit: 10,
  });
  assert.deepEqual(unreachable, { items: [] }, "empty repo is not an error");
});

test("branch enumeration normalizes revoked / missing repositories and clamps the page size", async () => {
  const { fake, adapter } = setup();
  let status = 403;
  fake.on("GET", BRANCH_LIST_PATH, () =>
    status === 403 ? { status: 403, body: { message: "Forbidden" } } : { status: 404, body: {} },
  );
  await assert.rejects(
    () => adapter.branches.listBranches({ repositoryId: TEST_REPOSITORY_ID, limit: 10 }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "permission_revoked",
  );
  status = 404;
  await assert.rejects(
    () => adapter.branches.listBranches({ repositoryId: TEST_REPOSITORY_ID, limit: 10 }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "repo_not_found",
  );

  status = 200;
  fake.on("GET", BRANCH_LIST_PATH, () => respond(branchListBody([])));
  await adapter.branches.listBranches({ repositoryId: TEST_REPOSITORY_ID, limit: 5_000 });
  assert.equal(
    fake.requests.at(-1)!.query["per_page"],
    "100",
    "per_page must stay within GitHub limits",
  );
});

test("the default-branch flag reuses cached repository facts instead of a second lookup", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", BRANCH_LIST_PATH, () =>
    respond(branchListBody([{ name: "main", sha: BASE_SHA }])),
  );
  const first = await adapter.branches.listBranches({
    repositoryId: TEST_REPOSITORY_ID,
    limit: 10,
  });
  assert.equal(first.items[0]?.isDefault, true);
  const repositoryLookups = fake.hits("GET", `/repositories/${TEST_REPOSITORY_ID}`);

  const second = await adapter.branches.listBranches({
    repositoryId: TEST_REPOSITORY_ID,
    limit: 10,
  });
  assert.equal(second.items[0]?.isDefault, true);
  assert.equal(
    fake.hits("GET", `/repositories/${TEST_REPOSITORY_ID}`),
    repositoryLookups,
    "default branch must come from the cached facts (09 §2.2 短期缓存)",
  );
});

test("branch enumeration rejects a malformed cursor and skips unusable entries", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", BRANCH_LIST_PATH, () =>
    respond([
      { name: "main", commit: { sha: BASE_SHA } },
      { name: "", commit: { sha: HEAD_SHA } },
      { name: "no-sha", commit: {} },
      { name: "not-hex", commit: { sha: "zzzz" } },
      { name: "x".repeat(300), commit: { sha: HEAD_SHA } },
    ]),
  );
  const page = await adapter.branches.listBranches({ repositoryId: TEST_REPOSITORY_ID, limit: 10 });
  assert.deepEqual(
    page.items.map((item) => item.name),
    ["main"],
    "entries that cannot enter the frozen wire schema are skipped",
  );

  await assert.rejects(
    () =>
      adapter.branches.listBranches({
        repositoryId: TEST_REPOSITORY_ID,
        limit: 10,
        cursor: "!!not-a-cursor",
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "validation_failed",
  );
  await assert.rejects(
    () =>
      adapter.branches.listBranches({
        repositoryId: TEST_REPOSITORY_ID,
        limit: 10,
        cursor: Buffer.from(JSON.stringify({ v: 1, p: 0 }), "utf8").toString("base64url"),
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "validation_failed",
  );
});

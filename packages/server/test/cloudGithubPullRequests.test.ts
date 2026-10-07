/**
 * draft PR 创建/更新/读取与对账用例（specs/cloud-agent 09 §5.1 无变更、§5.2 幂等 effect、
 * §5.3 外部修改、§4.1 head/base；10 §6 B09「PR 创建未知」「无 diff」「单 PR」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError } from "../src/cloud/adapters/github/http.js";
import {
  MANAGED_SECTION_MARKERS,
  mergeManagedSection,
  readTaskMarker,
  renderManagedSection,
} from "../src/cloud/adapters/github/pullRequests.js";
import {
  TEST_REPOSITORY_ID,
  TEST_TASK_ID,
  createFakeGitHub,
  createTestAdapter,
  installEchoMintRoute,
  installRepositoryRoute,
  branchBody,
  compareBody,
  markerBody,
  pullRequestBody,
  respond,
} from "./cloudGithubTestSupport.js";

const REPO_PATH = "/repos/acme/repo";
const PULLS_PATH = `${REPO_PATH}/pulls`;
const PORT_SHA = "5".repeat(40);
const OTHER_TASK_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const HEAD_BRANCH = "zcode/task-1-slug";
const BASE_BRANCH = "main";

function setup() {
  const fake = createFakeGitHub();
  installEchoMintRoute(fake);
  installRepositoryRoute(fake);
  return { fake, adapter: createTestAdapter({ fake }) };
}

type TestAdapter = ReturnType<typeof createTestAdapter>;

async function create(
  adapter: TestAdapter,
  overrides: Partial<Parameters<TestAdapter["pullRequests"]["createDraftPullRequest"]>[0]> = {},
) {
  return adapter.pullRequests.createDraftPullRequest({
    repositoryId: TEST_REPOSITORY_ID,
    taskId: TEST_TASK_ID,
    head: HEAD_BRANCH,
    base: BASE_BRANCH,
    title: "Task 1",
    managed: "cloud task link",
    ...overrides,
  });
}

test("draft pull request carries head/base, draft flag and the controlled marker section", async () => {
  const { fake, adapter } = setup();
  fake.on("POST", PULLS_PATH, () =>
    respond(
      pullRequestBody({
        number: 42,
        head: HEAD_BRANCH,
        base: BASE_BRANCH,
        body: markerBody(TEST_TASK_ID),
      }),
    ),
  );
  const result = await create(adapter);
  assert.equal(result.kind, "created");
  assert.equal(result.kind === "created" && result.pullRequest.prNumber, 42);
  assert.equal(result.kind === "created" && result.pullRequest.status, "draft");
  assert.equal(result.kind === "created" && result.pullRequest.head, HEAD_BRANCH);
  assert.equal(result.kind === "created" && result.pullRequest.base, BASE_BRANCH);

  const body = fake.requests.find((item) => item.method === "POST" && item.path === PULLS_PATH)
    ?.body as {
    draft: boolean;
    head: string;
    base: string;
    body: string;
  };
  assert.equal(body.draft, true);
  assert.equal(body.head, HEAD_BRANCH);
  assert.equal(body.base, BASE_BRANCH);
  assert.equal(readTaskMarker(body.body), TEST_TASK_ID);
  assert.ok(body.body.includes(MANAGED_SECTION_MARKERS.start));
  assert.ok(body.body.includes(MANAGED_SECTION_MARKERS.end));
});

test("head equal to base is refused before any GitHub write", async () => {
  const { fake, adapter } = setup();
  await assert.rejects(
    () => create(adapter, { base: HEAD_BRANCH }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "branch_conflict",
  );
  assert.equal(fake.hits("POST", PULLS_PATH), 0);
});

test("no diff ends as no-changes instead of an empty pull request", async () => {
  const { fake, adapter } = setup();
  fake.on("POST", PULLS_PATH, () => ({
    status: 422,
    body: { message: `No commits between ${BASE_BRANCH} and ${HEAD_BRANCH}` },
  }));
  const result = await create(adapter);
  assert.equal(result.kind, "no-changes");
  assert.equal(fake.hits("POST", PULLS_PATH), 1, "no empty commit / no retry");
});

test("an existing pull request with the task marker is reused instead of duplicated", async () => {
  const { fake, adapter } = setup();
  fake.on("POST", PULLS_PATH, () => ({
    status: 422,
    body: { message: `A pull request already exists for acme:${HEAD_BRANCH}` },
  }));
  fake.on("GET", PULLS_PATH, () =>
    respond([
      pullRequestBody({
        number: 7,
        head: HEAD_BRANCH,
        base: BASE_BRANCH,
        body: markerBody(TEST_TASK_ID),
      }),
    ]),
  );
  const result = await create(adapter);
  assert.equal(result.kind, "existing");
  assert.equal(result.kind === "existing" && result.pullRequest.prNumber, 7);
  assert.equal(fake.hits("POST", PULLS_PATH), 1);
  assert.equal(fake.hits("GET", PULLS_PATH), 1);
});

test("a third-party pull request on the same branch is never adopted", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", PULLS_PATH, () =>
    respond([
      pullRequestBody({
        number: 9,
        head: HEAD_BRANCH,
        base: BASE_BRANCH,
        body: markerBody(OTHER_TASK_ID),
      }),
      pullRequestBody({ number: 10, head: HEAD_BRANCH, base: BASE_BRANCH, body: "human pr" }),
    ]),
  );
  assert.equal(
    await adapter.pullRequests.findTaskPullRequest({
      repositoryId: TEST_REPOSITORY_ID,
      taskId: TEST_TASK_ID,
      head: HEAD_BRANCH,
      base: BASE_BRANCH,
    }),
    null,
  );
  assert.equal(fake.hits("POST", PULLS_PATH), 0);
});

test("a lost create response is reconciled by query before any second create", async () => {
  const { fake, adapter } = setup();
  // 服务端其实已经建好了 PR，只是响应在回程丢了。
  let created = false;
  fake.on("POST", PULLS_PATH, () => {
    created = true;
    return { throws: new Error("socket hang up") };
  });
  fake.on("GET", PULLS_PATH, () =>
    respond(
      created
        ? [
            pullRequestBody({
              number: 11,
              head: HEAD_BRANCH,
              base: BASE_BRANCH,
              body: markerBody(TEST_TASK_ID),
            }),
          ]
        : [],
    ),
  );
  const result = await create(adapter);
  assert.equal(result.kind, "existing", "the same pull request must be associated, not recreated");
  assert.equal(result.kind === "existing" && result.pullRequest.prNumber, 11);
  assert.equal(fake.hits("POST", PULLS_PATH), 1);
});

test("a lost create response with no matching pull request stays an unknown result", async () => {
  const { fake, adapter } = setup();
  fake.on("POST", PULLS_PATH, () => ({ throws: new Error("socket hang up") }));
  fake.on("GET", PULLS_PATH, () => respond([]));
  await assert.rejects(
    () => create(adapter),
    (error: unknown) => error instanceof GitHubApiError && error.code === "network_unknown",
  );
});

test("pull request status projects merged/closed/open from GitHub facts", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", `${PULLS_PATH}/1`, () =>
    respond(
      pullRequestBody({
        number: 1,
        head: HEAD_BRANCH,
        base: BASE_BRANCH,
        merged: true,
        state: "closed",
        draft: false,
      }),
    ),
  );
  fake.on("GET", `${PULLS_PATH}/2`, () =>
    respond(pullRequestBody({ number: 2, head: HEAD_BRANCH, base: BASE_BRANCH, draft: false })),
  );
  fake.on("GET", `${PULLS_PATH}/3`, () => ({ status: 404, body: {} }));

  assert.equal(
    (await adapter.port.getPullRequest({ repositoryId: TEST_REPOSITORY_ID, prNumber: 1 }))?.status,
    "merged",
  );
  assert.equal(
    (await adapter.port.getPullRequest({ repositoryId: TEST_REPOSITORY_ID, prNumber: 2 }))?.status,
    "open",
  );
  assert.equal(
    await adapter.port.getPullRequest({ repositoryId: TEST_REPOSITORY_ID, prNumber: 3 }),
    null,
  );
});

test("managed body updates never overwrite user written content", async () => {
  const { fake, adapter } = setup();
  const userText = "## Notes\n\nplease review the migration";
  fake.on("GET", `${PULLS_PATH}/5`, () =>
    respond(
      pullRequestBody({
        number: 5,
        head: HEAD_BRANCH,
        base: BASE_BRANCH,
        body: `${userText}\n\n${markerBody(TEST_TASK_ID, "old status")}`,
      }),
    ),
  );
  let patched: string | undefined;
  fake.on("PATCH", `${PULLS_PATH}/5`, (request) => {
    patched = (request.body as { body: string }).body;
    return respond(
      pullRequestBody({ number: 5, head: HEAD_BRANCH, base: BASE_BRANCH, body: patched }),
    );
  });

  await adapter.pullRequests.updateManagedBody({
    repositoryId: TEST_REPOSITORY_ID,
    taskId: TEST_TASK_ID,
    prNumber: 5,
    managed: "new status",
  });
  assert.ok(patched?.includes(userText), "user content must survive");
  assert.ok(patched?.includes("new status"));
  assert.ok(!patched?.includes("old status"));
  assert.equal(readTaskMarker(patched), TEST_TASK_ID);
});

test("an unchanged managed section performs no write at all", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", `${PULLS_PATH}/6`, () =>
    respond(
      pullRequestBody({
        number: 6,
        head: HEAD_BRANCH,
        base: BASE_BRANCH,
        body: markerBody(TEST_TASK_ID, "same status"),
      }),
    ),
  );
  await adapter.pullRequests.updateManagedBody({
    repositoryId: TEST_REPOSITORY_ID,
    taskId: TEST_TASK_ID,
    prNumber: 6,
    managed: "same status",
  });
  assert.equal(fake.hits("PATCH", `${PULLS_PATH}/6`), 0);
});

test("updating a pull request that belongs to another task is refused", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", `${PULLS_PATH}/8`, () =>
    respond(
      pullRequestBody({
        number: 8,
        head: HEAD_BRANCH,
        base: BASE_BRANCH,
        body: markerBody(OTHER_TASK_ID),
      }),
    ),
  );
  await assert.rejects(
    () =>
      adapter.pullRequests.updateManagedBody({
        repositoryId: TEST_REPOSITORY_ID,
        taskId: TEST_TASK_ID,
        prNumber: 8,
        managed: "x",
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "validation_failed",
  );
  assert.equal(fake.hits("PATCH", `${PULLS_PATH}/8`), 0);
});

test("the port publish returns the frozen union: no-changes is a result, not an exception", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", `${REPO_PATH}/branches/${encodeURIComponent(HEAD_BRANCH)}`, () =>
    respond(branchBody(HEAD_BRANCH, PORT_SHA)),
  );
  fake.on("GET", PULLS_PATH, () => respond([]));
  fake.on("POST", PULLS_PATH, () => ({
    status: 422,
    body: { message: `No commits between ${BASE_BRANCH} and ${HEAD_BRANCH}` },
  }));
  const result = await adapter.port.publishDraftPullRequest({
    idempotencyKey: `publish-pr:run-1:cp-1`,
    taskId: TEST_TASK_ID,
    runId: "run-1",
    repositoryId: TEST_REPOSITORY_ID,
    installationId: 4242,
    base: BASE_BRANCH,
    head: HEAD_BRANCH,
    expectedHeadSha: PORT_SHA,
    title: "Task 1",
  });
  assert.deepEqual(result, { status: "no-changes" });
});

test("the port publish returns the projection and refuses a drifted task branch", async () => {
  const { fake, adapter } = setup();
  fake.on("GET", `${REPO_PATH}/branches/${encodeURIComponent(HEAD_BRANCH)}`, () =>
    respond(branchBody(HEAD_BRANCH, PORT_SHA)),
  );
  fake.on("GET", PULLS_PATH, () => respond([]));
  fake.on("POST", PULLS_PATH, () =>
    respond(
      pullRequestBody({
        number: 42,
        head: HEAD_BRANCH,
        base: BASE_BRANCH,
        body: markerBody(TEST_TASK_ID),
      }),
    ),
  );
  const request = {
    idempotencyKey: `publish-pr:run-1:cp-2`,
    taskId: TEST_TASK_ID,
    runId: "run-1",
    repositoryId: TEST_REPOSITORY_ID,
    installationId: 4242,
    base: BASE_BRANCH,
    head: HEAD_BRANCH,
    expectedHeadSha: PORT_SHA,
    title: "Task 1",
  };
  const published = await adapter.port.publishDraftPullRequest(request);
  assert.equal(published.status === "published" && published.pullRequest.prNumber, 42);

  // 外部 push 使分支前进：发布必须停下（09 §5.3），而不是覆盖或继续建 PR。
  const advancedSha = "6".repeat(40);
  fake.on("GET", `${REPO_PATH}/branches/${encodeURIComponent(HEAD_BRANCH)}`, () =>
    respond(branchBody(HEAD_BRANCH, advancedSha)),
  );
  fake.on("GET", `${REPO_PATH}/compare/${PORT_SHA}...${advancedSha}`, () =>
    respond(compareBody({ status: "ahead", aheadBy: 1 })),
  );
  const before = fake.hits("POST", PULLS_PATH);
  await assert.rejects(
    () => adapter.port.publishDraftPullRequest(request),
    (error: unknown) => error instanceof GitHubApiError && error.code === "branch_conflict",
  );
  assert.equal(fake.hits("POST", PULLS_PATH), before, "drift must not create another pull request");
});

test("managed section merge keeps a broken structure by appending", () => {
  const section = renderManagedSection({ taskId: TEST_TASK_ID, managed: "status" });
  const withoutEnd = `hand written\n${MANAGED_SECTION_MARKERS.start}\nleft over`;
  const merged = mergeManagedSection({ existingBody: withoutEnd, section });
  assert.ok(merged.startsWith("hand written"));
  assert.ok(merged.includes(section));

  const empty = mergeManagedSection({ existingBody: "   ", section });
  assert.equal(empty, section);

  const closed = mergeManagedSection({
    existingBody: markerBody(TEST_TASK_ID, "old"),
    section,
  });
  assert.equal(closed, section);
});

test("task marker parsing only accepts uuid payloads", () => {
  assert.equal(readTaskMarker(markerBody(TEST_TASK_ID)), TEST_TASK_ID);
  assert.equal(readTaskMarker("<!-- zcode:task:not-a-uuid -->"), null);
  assert.equal(readTaskMarker(undefined), null);
  assert.equal(readTaskMarker(`prefix ${markerBody(OTHER_TASK_ID)} suffix`), OTHER_TASK_ID);
});

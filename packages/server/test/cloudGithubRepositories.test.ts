/**
 * 仓库列表与授权用例（specs/cloud-agent 09 §2.1 可信单用户 allowlist、§2.2 installation
 * 投影与 stale 语义、03 §6 `repositories` 的 not_configured、10 §6 B08「恶意 repo 借 broker」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError } from "../src/cloud/adapters/github/http.js";
import {
  TEST_INSTALLATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_REPOSITORY_ID,
  createFakeGitHub,
  createTestAdapter,
  repositoryBody,
  respond,
} from "./cloudGithubTestSupport.js";

const MINT_PATH = `/app/installations/${TEST_INSTALLATION_ID}/access_tokens`;
const INSTALLATION_REPOS = "/installation/repositories";
const OTHER_REPOSITORY_ID = 888;

function repositoryListBody(ids: number[]): unknown {
  return {
    total_count: ids.length,
    repository_selection: "selected",
    repositories: ids.map((id) => repositoryBody({ id, name: `repo-${id}` })),
  };
}

function metadataTokenBody(repositoryIds?: number[]): unknown {
  return {
    token: "ghs_installation_metadata_token",
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    permissions: { metadata: "read" },
    repositories: (repositoryIds ?? [TEST_REPOSITORY_ID]).map((id) =>
      repositoryBody({ id, name: `repo-${id}` }),
    ),
  };
}

test("an empty installation allowlist is not_configured, not an empty list", async () => {
  const fake = createFakeGitHub();
  const adapter = createTestAdapter({ fake, allowedInstallationIds: [] });
  assert.equal(adapter.catalog.isConfigured(), false);
  await assert.rejects(
    () => adapter.port.listRepositories({ principalId: TEST_PRINCIPAL_ID, limit: 10 }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "not_configured",
  );
  assert.equal(fake.requests.length, 0);
});

test("listRepositories denies principals other than the configured deployment principal", async () => {
  const fake = createFakeGitHub();
  const adapter = createTestAdapter({ fake });
  await assert.rejects(
    () => adapter.port.listRepositories({ principalId: "someone-else", limit: 10 }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "unauthorized",
  );
  assert.equal(fake.requests.length, 0, "authorization must be decided before any GitHub call");
});

test("repository or installation outside the allowlist is denied without contacting GitHub", () => {
  const fake = createFakeGitHub();
  const adapter = createTestAdapter({
    fake,
    allowedRepositoryIds: [TEST_REPOSITORY_ID],
  });
  assert.throws(
    () => adapter.catalog.assertAuthorized({ repositoryId: OTHER_REPOSITORY_ID }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "unauthorized",
  );
  assert.throws(
    () =>
      adapter.catalog.assertAuthorized({ repositoryId: TEST_REPOSITORY_ID, installationId: 999 }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "unauthorized",
  );
  assert.equal(fake.requests.length, 0);
});

test("listing reads only the authorized installation with a metadata-only token", async () => {
  const fake = createFakeGitHub();
  fake.on("POST", MINT_PATH, () => respond(metadataTokenBody()));
  fake.on("GET", INSTALLATION_REPOS, () =>
    respond(repositoryListBody([TEST_REPOSITORY_ID, OTHER_REPOSITORY_ID])),
  );
  const adapter = createTestAdapter({ fake, allowedRepositoryIds: [TEST_REPOSITORY_ID] });

  const page = await adapter.port.listRepositories({ principalId: TEST_PRINCIPAL_ID, limit: 10 });
  assert.deepEqual(
    page.items.map((item) => item.repositoryId),
    [TEST_REPOSITORY_ID],
  );
  assert.equal(page.items[0]?.owner, "acme");
  assert.equal(page.items[0]?.availability, "available");

  // mint 必须是 metadata:read 且不带 repository_ids（09 §3：没有单 repo 就只能是元数据读）。
  assert.deepEqual(fake.requests.find((item) => item.method === "POST")?.body, {
    permissions: { metadata: "read" },
  });
  // 不得用 App JWT 全量列举 installation，也不得知晓 installation 列表（09 §2.1）。
  const enumeration = fake.requests.filter(
    (item) =>
      item.path === "/app/installations" ||
      (item.method === "GET" && /^\/app\/installations\/\d+$/.test(item.path)),
  );
  assert.deepEqual(enumeration, [], "app must not enumerate installations");
  // 只有 mint 会碰 /app/installations/*，且必须是 POST access_tokens。
  for (const item of fake.requests) {
    if (item.path.startsWith("/app/installations")) {
      assert.equal(item.method, "POST");
      assert.match(item.path, /\/access_tokens$/);
    }
  }
  assert.ok(
    !fake.requests.some(
      (item) => item.path === "/installation/repositories" && item.method !== "GET",
    ),
  );
});

test("listing paginates with an opaque cursor", async () => {
  const fake = createFakeGitHub();
  const ids = [TEST_REPOSITORY_ID, OTHER_REPOSITORY_ID, 999];
  fake.on("POST", MINT_PATH, () => respond(metadataTokenBody(ids)));
  fake.on("GET", INSTALLATION_REPOS, () => respond(repositoryListBody(ids)));
  const adapter = createTestAdapter({ fake });

  const first = await adapter.port.listRepositories({ principalId: TEST_PRINCIPAL_ID, limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  const second = await adapter.port.listRepositories({
    principalId: TEST_PRINCIPAL_ID,
    limit: 2,
    cursor: first.nextCursor,
  });
  assert.deepEqual(
    second.items.map((item) => item.repositoryId),
    [999],
  );
  assert.equal(second.nextCursor, undefined);

  await assert.rejects(
    () => adapter.port.listRepositories({ principalId: TEST_PRINCIPAL_ID, limit: 2, cursor: "!!" }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "validation_failed",
  );
});

test("a GitHub outage serves the cached projection as stale instead of declaring repos gone", async () => {
  const fake = createFakeGitHub();
  let clock = 1_000;
  let failing = false;
  fake.on("POST", MINT_PATH, () =>
    failing ? { status: 500, body: { message: "server error" } } : respond(metadataTokenBody()),
  );
  fake.on("GET", INSTALLATION_REPOS, () => respond(repositoryListBody([TEST_REPOSITORY_ID])));
  const adapter = createTestAdapter({ fake, cacheTtlMs: 5_000, now: () => clock });

  const fresh = await adapter.port.listRepositories({ principalId: TEST_PRINCIPAL_ID, limit: 10 });
  assert.equal(fresh.items[0]?.availability, "available");

  clock += 10_000;
  failing = true;
  const stale = await adapter.port.listRepositories({ principalId: TEST_PRINCIPAL_ID, limit: 10 });
  assert.equal(stale.items.length, 1);
  assert.equal(stale.items[0]?.availability, "stale", "outage must not look like a deletion");
});

test("locate resolves authoritative facts through a single-repo metadata token", async () => {
  const fake = createFakeGitHub();
  fake.on("POST", MINT_PATH, () => respond(metadataTokenBody([TEST_REPOSITORY_ID])));
  fake.on("GET", `/repositories/${TEST_REPOSITORY_ID}`, () =>
    respond(repositoryBody({ id: TEST_REPOSITORY_ID, name: "renamed", defaultBranch: "trunk" })),
  );
  const adapter = createTestAdapter({ fake });
  const facts = await adapter.catalog.locate(TEST_REPOSITORY_ID);
  assert.equal(facts?.name, "renamed");
  assert.equal(facts?.defaultBranch, "trunk");
  assert.deepEqual(fake.requests.find((item) => item.method === "POST")?.body, {
    repository_ids: [TEST_REPOSITORY_ID],
    permissions: { metadata: "read" },
  });
});

test("locate returns null (repo_not_found downstream) when the installation cannot see the repo", async () => {
  const fake = createFakeGitHub();
  fake.on("POST", MINT_PATH, () => respond(metadataTokenBody()));
  fake.on("GET", `/repositories/${TEST_REPOSITORY_ID}`, () => ({ status: 404, body: {} }));
  const adapter = createTestAdapter({ fake });
  assert.equal(await adapter.catalog.locate(TEST_REPOSITORY_ID), null);
  await assert.rejects(
    () => adapter.port.getBranchHead({ repositoryId: TEST_REPOSITORY_ID, branch: "main" }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "repo_not_found",
  );
});

test("mintForPurpose refuses a repository that is not in the allowlist", async () => {
  const fake = createFakeGitHub();
  const adapter = createTestAdapter({ fake, allowedRepositoryIds: [TEST_REPOSITORY_ID] });
  await assert.rejects(
    () =>
      adapter.port.mintToken({
        repositoryId: OTHER_REPOSITORY_ID,
        installationId: TEST_INSTALLATION_ID,
        purpose: "clone",
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "unauthorized",
  );
  assert.equal(fake.requests.length, 0);
});

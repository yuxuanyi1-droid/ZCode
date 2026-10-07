/**
 * `repositories` / `repositories/:repoId/branches` 端点（03 §6、09 §2.1/§2.2、11 §5）：
 * 接 W4 的 `catalog`/分支来源，覆盖分页游标、空列表、撤权 403、限流 429、越权 404、
 * 未配置 503，并断言响应能过冻结 schema、正文不含凭据。
 *
 * 两条路径都验证：① 假 catalog 直插路由（错误映射与形状）；② 真实 W4 适配器 + fake fetch
 * （URL/鉴权/JSON 解析/归一都被真实执行）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { Hono } from "hono";
import { cloudRepositoryPageSchema, cloudBranchPageSchema } from "@zcode/shared";
import { registerCloudHttpRoutes } from "../src/cloud/adapters/http/routes.js";
import type { CloudHttpRouteDeps } from "../src/cloud/adapters/http/support.js";
import type { CloudBridgeChannel } from "../src/cloud/adapters/ws/bridgeChannel.js";
import { buildTestPlane } from "./cloudCoreFakes.js";
import {
  TEST_INSTALLATION_ID,
  TEST_PRINCIPAL_ID,
  TEST_REPOSITORY_ID,
  branchBody,
  createFakeGitHub,
  createTestAdapter,
  installEchoMintRoute,
  installRepositoryRoute,
  repositoryBody,
  respond,
} from "./cloudGithubTestSupport.js";

const INSTALLATION_REPOS = "/installation/repositories";
const TEST_API_BASE = "https://api.github.test";
const GIT_SHA = "a".repeat(40);

/** 路由只用到 bridge 的 WS 能力；HTTP 用例不触发它（不构造真通道，避免无关依赖）。 */
const bridgeStub = {} as unknown as CloudBridgeChannel;

function buildApp(overrides: Partial<CloudHttpRouteDeps> = {}) {
  const context = buildTestPlane();
  const app = new Hono();
  registerCloudHttpRoutes(app, {
    plane: context.plane,
    router: context.plane.router,
    bridge: bridgeStub,
    principalId: TEST_PRINCIPAL_ID,
    githubConfigured: true,
    ...overrides,
  });
  return { app, context };
}

function repositoryFacts(id: number, name = `repo-${id}`) {
  return {
    repositoryId: id,
    installationId: 4242,
    owner: "acme",
    name,
    defaultBranch: "main",
    availability: "available" as const,
    lastCheckedAt: 1_700_000_000_000,
  };
}

test("repositories：未配置 GitHub 时 503 not_configured（不伪装空列表，03 §6）", async () => {
  const { app } = buildApp({ githubConfigured: false });
  const response = await app.request("/api/cloud/repositories");
  assert.equal(response.status, 503);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "not_configured");

  // catalog 注入了但适配器自报未配置 → 同样 503。
  const { app: app2 } = buildApp({
    repositoryCatalog: {
      isConfigured: () => false,
      listRepositories: async () => ({ items: [] }),
    },
  });
  assert.equal((await app2.request("/api/cloud/repositories")).status, 503);
});

test("repositories：分页游标透传、空列表、响应过冻结 schema", async () => {
  const calls: { cursor?: string; limit: number; principalId: string }[] = [];
  const { app } = buildApp({
    repositoryCatalog: {
      isConfigured: () => true,
      async listRepositories(request) {
        calls.push({
          ...(request.cursor ? { cursor: request.cursor } : {}),
          limit: request.limit,
          principalId: request.principalId,
        });
        return request.cursor
          ? { items: [repositoryFacts(778, "second")] }
          : { items: [repositoryFacts(777, "first")], nextCursor: "cursor-1" };
      },
    },
  });

  const first = await app.request("/api/cloud/repositories?limit=1");
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as {
    items: { repositoryId: number; name: string }[];
    nextCursor?: string;
  };
  assert.deepEqual(
    firstBody.items.map((item) => item.name),
    ["first"],
  );
  assert.equal(firstBody.nextCursor, "cursor-1");
  assert.equal(cloudRepositoryPageSchema.safeParse(firstBody).success, true, "过冻结 schema");
  assert.equal(JSON.stringify(firstBody).includes("token"), false, "正文不含凭据字段");

  const second = await app.request(
    `/api/cloud/repositories?limit=1&cursor=${encodeURIComponent("cursor-1")}`,
  );
  const secondBody = (await second.json()) as { items: { name: string }[]; nextCursor?: string };
  assert.deepEqual(
    secondBody.items.map((item) => item.name),
    ["second"],
  );
  assert.equal(secondBody.nextCursor, undefined);
  assert.deepEqual(calls, [
    { limit: 1, principalId: TEST_PRINCIPAL_ID },
    { cursor: "cursor-1", limit: 1, principalId: TEST_PRINCIPAL_ID },
  ]);

  // 空列表：200 + 空数组（不是 404/503）。
  const { app: emptyApp } = buildApp({
    repositoryCatalog: { isConfigured: () => true, listRepositories: async () => ({ items: [] }) },
  });
  const empty = await emptyApp.request("/api/cloud/repositories");
  assert.equal(empty.status, 200);
  const emptyBody = (await empty.json()) as { items: unknown[] };
  assert.deepEqual(emptyBody.items, []);
  assert.equal(cloudRepositoryPageSchema.safeParse(emptyBody).success, true);
});

test("repositories：撤权 403、限流 429、未知故障 502，均不透传 provider 原文", async () => {
  for (const [code, expectedStatus] of [
    ["permission_revoked", 403],
    ["installation_revoked", 403],
    ["rate_limited", 429],
    ["network_unknown", 502],
    ["validation_failed", 400],
  ] as const) {
    const { app } = buildApp({
      repositoryCatalog: {
        isConfigured: () => true,
        async listRepositories() {
          // 适配层的归一错误对象（GitHubApiError 形状）：路由只读 code。
          throw Object.assign(new Error(`github ${code}: raw provider text`), { code });
        },
      },
    });
    const response = await app.request("/api/cloud/repositories");
    assert.equal(response.status, expectedStatus, `${code} → ${expectedStatus}`);
    const body = (await response.json()) as { code: string; message: string; retryable: boolean };
    assert.equal(body.code, code);
    assert.equal(
      body.message.includes("raw provider text"),
      false,
      "不透传 provider 原始文案（09 §8）",
    );
    assert.equal(typeof body.retryable, "boolean");
  }
});

test("repositories/:repoId/branches：越权/不可见 404，不泄漏存在性（03 §3）", async () => {
  const { app } = buildApp({
    repositoryCatalog: {
      isConfigured: () => true,
      listRepositories: async () => ({ items: [] }),
      assertAuthorized() {
        throw Object.assign(new Error("not in allowlist"), { code: "permission_revoked" });
      },
    },
    branchCatalog: {
      listBranches: async () => ({ items: [{ name: "main", sha: GIT_SHA, isDefault: true }] }),
    },
  });
  const response = await app.request(`/api/cloud/repositories/${TEST_REPOSITORY_ID}/branches`);
  assert.equal(response.status, 404);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "not_found", "越权按 404，不泄漏仓库是否存在");

  const invalid = await app.request("/api/cloud/repositories/abc/branches");
  assert.equal(invalid.status, 400);
});

test("repositories/:repoId/branches：W4 未提供枚举时保持 501（不伪造空列表）", async () => {
  const { app } = buildApp({
    repositoryCatalog: {
      isConfigured: () => true,
      listRepositories: async () => ({ items: [] }),
      assertAuthorized: () => undefined,
    },
  });
  const response = await app.request(`/api/cloud/repositories/${TEST_REPOSITORY_ID}/branches`);
  assert.equal(response.status, 501);
  const body = (await response.json()) as { code: string; message: string };
  assert.equal(body.code, "not_implemented");
  assert.equal(body.message, "branch-enumeration-not-wired");
});

test("repositories/:repoId/branches：注入分支来源时返回冻结分页形状", async () => {
  const seen: { repositoryId: number; limit: number }[] = [];
  const { app } = buildApp({
    repositoryCatalog: {
      isConfigured: () => true,
      listRepositories: async () => ({ items: [] }),
      assertAuthorized: () => undefined,
    },
    branchCatalog: {
      async listBranches(request) {
        seen.push({ repositoryId: request.repositoryId, limit: request.limit });
        return {
          items: [
            { name: "main", sha: GIT_SHA, isDefault: true },
            { name: "feature/x", sha: "b".repeat(40), isDefault: false },
          ],
        };
      },
    },
  });
  const response = await app.request(
    `/api/cloud/repositories/${TEST_REPOSITORY_ID}/branches?limit=2`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { items: { name: string }[] };
  assert.deepEqual(
    body.items.map((item) => item.name),
    ["main", "feature/x"],
  );
  assert.equal(cloudBranchPageSchema.safeParse(body).success, true);
  assert.deepEqual(seen, [{ repositoryId: TEST_REPOSITORY_ID, limit: 2 }]);
});

test("真实 W4 适配器 + fake fetch：列表 → 建项目的仓库事实来自同一 catalog", async () => {
  const fake = createFakeGitHub();
  installEchoMintRoute(fake);
  fake.on("GET", INSTALLATION_REPOS, () =>
    respond({
      total_count: 1,
      repository_selection: "selected",
      repositories: [
        repositoryBody({ id: TEST_REPOSITORY_ID, name: "demo", defaultBranch: "trunk" }),
      ],
    }),
  );
  fake.on("GET", `/repositories/${TEST_REPOSITORY_ID}`, () =>
    respond(repositoryBody({ id: TEST_REPOSITORY_ID, name: "demo", defaultBranch: "trunk" })),
  );
  const adapter = createTestAdapter({ fake, principalId: TEST_PRINCIPAL_ID });
  assert.equal(adapter.catalog.isConfigured(), true);

  const { app } = buildApp({ repositoryCatalog: adapter.catalog });
  const response = await app.request("/api/cloud/repositories");
  assert.equal(response.status, 200);
  const body = (await response.json()) as {
    items: { repositoryId: number; owner: string; name: string; defaultBranch?: string }[];
  };
  assert.equal(cloudRepositoryPageSchema.safeParse(body).success, true);
  assert.equal(body.items.length, 1);
  const item = body.items[0];
  assert.equal(item?.repositoryId, TEST_REPOSITORY_ID);
  assert.equal(item?.installationId, TEST_INSTALLATION_ID);
  assert.equal(item?.owner, "acme");
  assert.equal(item?.name, "demo");
  assert.equal(item?.defaultBranch, "trunk");
  assert.equal(item?.availability, "available");
  // 建项目走的是同一 catalog（权威 owner/name/defaultBranch，11 §4.3）。
  const facts = await adapter.catalog.locate(TEST_REPOSITORY_ID);
  assert.equal(facts?.name, "demo");
  assert.equal(facts?.defaultBranch, "trunk");
});

test("真实 W4 分支枚举 + fake fetch：两页 + isDefault + 末页无游标，响应过冻结 schema", async () => {
  const fake = createFakeGitHub();
  installEchoMintRoute(fake);
  installRepositoryRoute(fake, { id: TEST_REPOSITORY_ID, name: "demo", defaultBranch: "trunk" });
  const branchesPath = "/repos/acme/demo/branches";
  fake.on("GET", branchesPath, (request) => {
    if (request.query.page === "2") {
      // 末页：GitHub 不再给 Link，W4 不造游标。
      return respond([branchBody("feature/x", "b".repeat(40))]);
    }
    return {
      body: [branchBody("trunk", "a".repeat(40)), branchBody("release/1.x", "c".repeat(40))],
      headers: {
        link: `<${TEST_API_BASE}${branchesPath}?per_page=2&page=2>; rel="next"`,
      },
    };
  });
  const adapter = createTestAdapter({ fake, principalId: TEST_PRINCIPAL_ID });
  const { app } = buildApp({
    repositoryCatalog: adapter.catalog,
    branchCatalog: adapter.branches,
  });

  const first = await app.request(`/api/cloud/repositories/${TEST_REPOSITORY_ID}/branches?limit=2`);
  assert.equal(first.status, 200);
  const firstBody = (await first.json()) as {
    items: { name: string; sha: string; isDefault: boolean }[];
    nextCursor?: string;
  };
  assert.equal(cloudBranchPageSchema.safeParse(firstBody).success, true, "过冻结 schema");
  assert.deepEqual(
    firstBody.items.map((item) => item.name),
    ["trunk", "release/1.x"],
  );
  assert.equal(
    firstBody.items[0]?.isDefault,
    true,
    "默认分支由仓库事实（defaultBranch=trunk）判定",
  );
  assert.equal(firstBody.items[1]?.isDefault, false);
  assert.equal(typeof firstBody.nextCursor, "string", "GitHub 给了 rel=next 才回游标");
  assert.equal(
    fake.requests.some((item) => item.path === `/repositories/${TEST_REPOSITORY_ID}`),
    true,
  );

  const second = await app.request(
    `/api/cloud/repositories/${TEST_REPOSITORY_ID}/branches?limit=2&cursor=${encodeURIComponent(firstBody.nextCursor ?? "")}`,
  );
  assert.equal(second.status, 200);
  const secondBody = (await second.json()) as {
    items: { name: string; isDefault: boolean }[];
    nextCursor?: string;
  };
  assert.equal(cloudBranchPageSchema.safeParse(secondBody).success, true);
  assert.deepEqual(
    secondBody.items.map((item) => item.name),
    ["feature/x"],
  );
  assert.equal(secondBody.nextCursor, undefined, "末页不造假游标");
  const branchCalls = fake.requests.filter((item) => item.path === branchesPath);
  assert.deepEqual(
    branchCalls.map((item) => item.query.page),
    ["1", "2"],
    "第二页真的带 page=2 打到 GitHub",
  );
});

test("未配置 GitHub：branches 端点仍 503 not_configured（不是空列表）", async () => {
  const { app } = buildApp({ githubConfigured: false });
  const response = await app.request(`/api/cloud/repositories/${TEST_REPOSITORY_ID}/branches`);
  assert.equal(response.status, 503);
  const body = (await response.json()) as { code: string };
  assert.equal(body.code, "not_configured");
});

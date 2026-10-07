/**
 * 权限矩阵用例（specs/cloud-agent 09 §3 完整权限矩阵与 §8 归一、01 §7.2 单 repo/撤销；
 * 10 §6 B08「App 撤权」「不扩大 fallback」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { GitHubApiError } from "../src/cloud/adapters/github/http.js";
import {
  GITHUB_TOKEN_PERMISSION_MATRIX,
  createGitHubTokenService,
} from "../src/cloud/adapters/github/tokens.js";
import {
  createCapturingLogger,
  createFakeGitHub,
  createTestTransport,
  installationTokenBody,
  respond,
} from "./cloudGithubTestSupport.js";

const INSTALLATION_ID = 4242;
const REPOSITORY_ID = 777;
const MINT_PATH = `/app/installations/${INSTALLATION_ID}/access_tokens`;
const TOKEN = "ghs_0123456789abcdefghijklmnopqrstuvwxyz";

function createService(
  fake = createFakeGitHub(),
  logger?: ReturnType<typeof createCapturingLogger>,
) {
  return {
    fake,
    tokens: createGitHubTokenService({
      transport: createTestTransport(fake, logger?.logger),
      appJwt: () => "app.jwt.value",
      logger: logger?.logger,
    }),
  };
}

test("each purpose mints exactly its minimal permission set on a single repository", async () => {
  for (const [purpose, permissions] of Object.entries(GITHUB_TOKEN_PERMISSION_MATRIX)) {
    const fake = createFakeGitHub();
    fake.on("POST", MINT_PATH, () =>
      respond(
        installationTokenBody({
          token: TOKEN,
          repositoryId: REPOSITORY_ID,
          permissions: { ...permissions },
        }),
      ),
    );
    const { tokens } = createService(fake);
    const minted = await tokens.mint({
      installationId: INSTALLATION_ID,
      repositoryId: REPOSITORY_ID,
      purpose: purpose as keyof typeof GITHUB_TOKEN_PERMISSION_MATRIX,
    });
    const request = fake.requests.at(-1)!;
    assert.deepEqual(request.body, {
      repository_ids: [REPOSITORY_ID],
      permissions: { ...permissions },
    });
    assert.deepEqual(
      minted.permissions,
      Object.entries(permissions)
        .map(([name, level]) => `${name}:${level}`)
        .sort(),
    );
  }
});

test("metadata-only token never carries repository_ids and cannot be asked for more", async () => {
  const fake = createFakeGitHub();
  fake.on("POST", MINT_PATH, () =>
    respond(
      installationTokenBody({
        token: TOKEN,
        repositoryId: REPOSITORY_ID,
        permissions: { metadata: "read" },
      }),
    ),
  );
  const { tokens } = createService(fake);
  await tokens.mintInstallationMetadataToken({ installationId: INSTALLATION_ID });
  assert.deepEqual(fake.requests.at(-1)!.body, { permissions: { metadata: "read" } });

  await tokens.mintRepositoryMetadataToken({
    installationId: INSTALLATION_ID,
    repositoryId: REPOSITORY_ID,
  });
  assert.deepEqual(fake.requests.at(-1)!.body, {
    repository_ids: [REPOSITORY_ID],
    permissions: { metadata: "read" },
  });
});

test("a revoked permission blocks the mint instead of falling back to a wider token", async () => {
  const fake = createFakeGitHub();
  // 第一次成功，随后 installation 撤掉 contents:write：必须明确失败且不重试无 scope 的请求。
  let call = 0;
  fake.on("POST", MINT_PATH, () => {
    call += 1;
    return call === 1
      ? respond(
          installationTokenBody({
            token: TOKEN,
            repositoryId: REPOSITORY_ID,
            permissions: { contents: "write", metadata: "read" },
          }),
        )
      : { status: 422, body: { message: "The permissions requested are not granted" } };
  });
  const { tokens } = createService(fake);
  const first = await tokens.mint({
    installationId: INSTALLATION_ID,
    repositoryId: REPOSITORY_ID,
    purpose: "push",
  });
  assert.ok(first.token.length > 0);

  await assert.rejects(
    () =>
      tokens.mint({
        installationId: INSTALLATION_ID,
        repositoryId: REPOSITORY_ID,
        purpose: "push",
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "permission_revoked",
  );
  // 只有两次 mint 请求：没有出现「去掉 repository_ids」或「请求全权限」的兜底重试。
  assert.equal(fake.hits("POST", MINT_PATH), 2);
  for (const request of fake.requests) {
    assert.ok(request.body && typeof request.body === "object", "mint body must be an object");
    assert.deepEqual((request.body as { repository_ids?: number[] }).repository_ids, [
      REPOSITORY_ID,
    ]);
  }
});

test("a response missing a requested permission fails closed", async () => {
  const fake = createFakeGitHub();
  fake.on("POST", MINT_PATH, () =>
    respond(
      installationTokenBody({
        token: TOKEN,
        repositoryId: REPOSITORY_ID,
        permissions: { metadata: "read" },
      }),
    ),
  );
  const { tokens } = createService(fake);
  await assert.rejects(
    () =>
      tokens.mint({
        installationId: INSTALLATION_ID,
        repositoryId: REPOSITORY_ID,
        purpose: "clone",
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "permission_revoked",
  );
});

test("a response granting more than requested is rejected (no widened token leaves the adapter)", async () => {
  const fake = createFakeGitHub();
  fake.on("POST", MINT_PATH, () =>
    respond(
      installationTokenBody({
        token: TOKEN,
        repositoryId: REPOSITORY_ID,
        permissions: { contents: "write", metadata: "read" },
      }),
    ),
  );
  const { tokens } = createService(fake);
  await assert.rejects(
    () =>
      tokens.mint({
        installationId: INSTALLATION_ID,
        repositoryId: REPOSITORY_ID,
        purpose: "clone",
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "validation_failed",
  );
});

test("a token scoped to another repository is rejected", async () => {
  const fake = createFakeGitHub();
  fake.on("POST", MINT_PATH, () =>
    respond(
      installationTokenBody({
        token: TOKEN,
        repositoryId: REPOSITORY_ID + 1,
        permissions: { contents: "read", metadata: "read" },
      }),
    ),
  );
  const { tokens } = createService(fake);
  await assert.rejects(
    () =>
      tokens.mint({
        installationId: INSTALLATION_ID,
        repositoryId: REPOSITORY_ID,
        purpose: "fetch",
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "validation_failed",
  );
});

test("installation 404/401 map to installation_revoked so callers stop new work", async () => {
  for (const status of [404, 401]) {
    const fake = createFakeGitHub();
    fake.on("POST", MINT_PATH, () => ({ status, body: { message: "not found" } }));
    const { tokens } = createService(fake);
    await assert.rejects(
      () =>
        tokens.mint({
          installationId: INSTALLATION_ID,
          repositoryId: REPOSITORY_ID,
          purpose: "clone",
        }),
      (error: unknown) => error instanceof GitHubApiError && error.code === "installation_revoked",
    );
  }
});

test("revocation is best effort and reports facts without throwing", async () => {
  const fake = createFakeGitHub();
  fake.on("DELETE", "/installation/token", () => ({ status: 204 }));
  const { tokens } = createService(fake);
  assert.deepEqual(await tokens.revoke({ token: TOKEN }), { revoked: true, reason: "revoked" });
  assert.equal(fake.requests.at(-1)!.headers["authorization"], `Bearer ${TOKEN}`);

  const invalid = createService(createFakeGitHub());
  invalid.fake.on("DELETE", "/installation/token", () => ({ status: 401, body: {} }));
  assert.deepEqual(await invalid.tokens.revoke({ token: TOKEN }), {
    revoked: true,
    reason: "already-invalid",
  });

  const offline = createService(createFakeGitHub());
  offline.fake.on("DELETE", "/installation/token", () => ({ throws: new Error("socket hang up") }));
  const outcome = await offline.tokens.revoke({ token: TOKEN });
  assert.equal(outcome.revoked, false);
  assert.equal(outcome.revoked === false && outcome.reason, "network-unknown");
  assert.equal(outcome.revoked === false && outcome.retryable, true);
});

test("tokens never reach logs or error messages, even when GitHub echoes them", async () => {
  const capture = createCapturingLogger();
  const fake = createFakeGitHub();
  fake.on("POST", MINT_PATH, () => ({
    status: 422,
    body: { message: `bad token ${TOKEN}`, echoed: TOKEN },
  }));
  const { tokens } = createService(fake, capture);
  await assert.rejects(() =>
    tokens.mint({ installationId: INSTALLATION_ID, repositoryId: REPOSITORY_ID, purpose: "clone" }),
  );

  const failed = await tokens.revoke({ token: TOKEN });
  assert.equal(failed.revoked, false);
  for (const line of capture.lines) {
    assert.ok(!line.includes(TOKEN), `log line leaked a token: ${line}`);
  }
  for (const request of fake.requests) {
    if (request.method === "POST") {
      assert.ok(!request.url.includes(TOKEN));
    }
  }
});

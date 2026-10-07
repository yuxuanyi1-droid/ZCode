/**
 * App JWT、installation 解析与权威仓库事实用例（specs/cloud-agent 09 §2.1、§3 首行、
 * 11 §4.3；10 §6 B08 的「App 撤权」与「伪 trusted role」侧）。
 */
import assert from "node:assert/strict";
import { createVerify } from "node:crypto";
import test from "node:test";
import {
  APP_JWT_MAX_LIFETIME_MS,
  createAppJwt,
  createGitHubAppAuth,
} from "../src/cloud/adapters/github/appAuth.js";
import { GitHubApiError } from "../src/cloud/adapters/github/http.js";
import { createFakeGitHub, createTestTransport, testAppKeys } from "./cloudGithubTestSupport.js";

const APP_ID = 987654;
const INSTALLATION_ID = 4242;
const REPOSITORY_ID = 777;

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("app jwt is RS256, backdated 60s and capped at 10 minutes", () => {
  const keys = testAppKeys();
  const now = 1_700_000_000_000;
  const jwt = createAppJwt({ appId: APP_ID, privateKeyPem: keys.privateKey, now });
  const [header, payload, signature] = jwt.split(".");
  assert.ok(header && payload && signature, "jwt must have three segments");

  const decodedHeader = decodeSegment(header!);
  assert.equal(decodedHeader["alg"], "RS256");
  assert.equal(decodedHeader["typ"], "JWT");

  const decodedPayload = decodeSegment(payload!);
  assert.equal(decodedPayload["iss"], APP_ID);
  assert.equal(decodedPayload["iat"], Math.floor((now - 60_000) / 1_000));
  const lifetimeMs = (Number(decodedPayload["exp"]) - Number(decodedPayload["iat"])) * 1_000;
  assert.ok(lifetimeMs <= APP_JWT_MAX_LIFETIME_MS, `exp-iat must stay <= 10min, got ${lifetimeMs}`);

  // 签名必须能用对应公钥验证：JWT 是真实凭据，不是占位串。
  const verifier = createVerify("RSA-SHA256").update(`${header}.${payload}`);
  assert.equal(verifier.verify(keys.publicKey, Buffer.from(signature!, "base64url")), true);
});

test("app jwt rejects non-RSA private keys", () => {
  const { privateKey } = (() => {
    // 只做形状验证：非 PEM 输入必须明确失败，不能静默产出无效 JWT。
    return { privateKey: "-----BEGIN PRIVATE KEY-----\nnot-a-key\n-----END PRIVATE KEY-----" };
  })();
  assert.throws(() => createAppJwt({ appId: APP_ID, privateKeyPem: privateKey, now: Date.now() }));
});

test("installation facts are parsed from the app-authenticated endpoint", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", `/app/installations/${INSTALLATION_ID}`, () => ({
    body: {
      id: INSTALLATION_ID,
      app_id: APP_ID,
      account: { id: 99, login: "acme", type: "Organization" },
      repository_selection: "selected",
      permissions: { contents: "read", metadata: "read" },
      suspended_at: null,
    },
  }));
  const auth = createGitHubAppAuth({
    transport: createTestTransport(fake),
    credentials: { appId: APP_ID, privateKeyPem: testAppKeys().privateKey },
  });

  const facts = await auth.getInstallation({ installationId: INSTALLATION_ID });
  assert.equal(facts?.installationId, INSTALLATION_ID);
  assert.equal(facts?.accountId, 99);
  assert.equal(facts?.accountLogin, "acme");
  assert.equal(facts?.repositorySelection, "selected");
  assert.equal(facts?.suspended, false);

  const request = fake.requests.at(-1)!;
  assert.equal(request.method, "GET");
  // App 级端点必须用 JWT（不是 installation token），且不能出现在 URL 里。
  assert.match(request.headers["authorization"] ?? "", /^Bearer eyJ/);
  assert.ok(!request.url.includes("eyJ"), "jwt must never appear in the url");
});

test("suspended installations are reported so callers can stop new grants", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", `/app/installations/${INSTALLATION_ID}`, () => ({
    body: {
      id: INSTALLATION_ID,
      app_id: APP_ID,
      account: { id: 99, login: "acme" },
      repository_selection: "all",
      permissions: {},
      suspended_at: "2026-10-06T00:00:00Z",
    },
  }));
  const auth = createGitHubAppAuth({
    transport: createTestTransport(fake),
    credentials: { appId: APP_ID, privateKeyPem: testAppKeys().privateKey },
  });
  const facts = await auth.getInstallation({ installationId: INSTALLATION_ID });
  assert.equal(facts?.suspended, true);
});

test("installation 404 is a null result, not a repo/host error leak", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", `/app/installations/${INSTALLATION_ID}`, () => ({ status: 404, body: {} }));
  const auth = createGitHubAppAuth({
    transport: createTestTransport(fake),
    credentials: { appId: APP_ID, privateKeyPem: testAppKeys().privateKey },
  });
  assert.equal(await auth.getInstallation({ installationId: INSTALLATION_ID }), null);
});

test("repository facts are authoritative owner/name/defaultBranch via installation token", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", `/repositories/${REPOSITORY_ID}`, () => ({
    body: {
      id: REPOSITORY_ID,
      node_id: "R_777",
      name: "renamed-repo",
      full_name: "acme/renamed-repo",
      private: true,
      archived: false,
      default_branch: "trunk",
      owner: { login: "acme", id: 1, type: "Organization" },
    },
  }));
  const auth = createGitHubAppAuth({
    transport: createTestTransport(fake),
    credentials: { appId: APP_ID, privateKeyPem: testAppKeys().privateKey },
  });
  const facts = await auth.getRepository({
    repositoryId: REPOSITORY_ID,
    installationId: INSTALLATION_ID,
    installationToken: "ghs_installation_token_value",
  });
  assert.equal(facts?.owner, "acme");
  assert.equal(facts?.name, "renamed-repo");
  assert.equal(facts?.defaultBranch, "trunk");
  assert.equal(facts?.installationId, INSTALLATION_ID);
  assert.equal(
    fake.requests.at(-1)!.headers["authorization"],
    "Bearer ghs_installation_token_value",
  );
});

test("repository 404 stays indistinguishable from no-permission", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", `/repositories/${REPOSITORY_ID}`, () => ({ status: 404, body: {} }));
  const auth = createGitHubAppAuth({
    transport: createTestTransport(fake),
    credentials: { appId: APP_ID, privateKeyPem: testAppKeys().privateKey },
  });
  assert.equal(
    await auth.getRepository({
      repositoryId: REPOSITORY_ID,
      installationId: INSTALLATION_ID,
      installationToken: "ghs_token",
    }),
    null,
  );
});

test("repository response for a different id is rejected instead of being trusted", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", `/repositories/${REPOSITORY_ID}`, () => ({
    body: {
      id: 999,
      node_id: "R_999",
      name: "other",
      full_name: "acme/other",
      private: true,
      archived: false,
      default_branch: "main",
      owner: { login: "acme", id: 1 },
    },
  }));
  const auth = createGitHubAppAuth({
    transport: createTestTransport(fake),
    credentials: { appId: APP_ID, privateKeyPem: testAppKeys().privateKey },
  });
  await assert.rejects(
    () =>
      auth.getRepository({
        repositoryId: REPOSITORY_ID,
        installationId: INSTALLATION_ID,
        installationToken: "ghs_token",
      }),
    (error: unknown) => error instanceof GitHubApiError && error.code === "validation_failed",
  );
});

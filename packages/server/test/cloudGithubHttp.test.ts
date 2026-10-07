/**
 * 传输层与错误归用例（specs/cloud-agent 09 §8 外部 API 错误归一、01 §7.2 秘密边界、
 * 02 §2 不变量 5「结果未知不是失败」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  GitHubApiError,
  createGitHubTransport,
  scrubGitHubSecrets,
} from "../src/cloud/adapters/github/http.js";
import { createFakeGitHub } from "./cloudGithubTestSupport.js";

const CREDENTIAL = { kind: "installation-token", token: "ghs_opaque_token_value" } as const;

function transportFor(fake: ReturnType<typeof createFakeGitHub>) {
  return createGitHubTransport({
    fetchImpl: fake.fetchImpl,
    apiBaseUrl: "https://api.github.test",
  });
}

test("http status codes are normalized to the frozen cloud error catalogue", async () => {
  const cases: Array<{
    status: number;
    headers?: Record<string, string>;
    expected: string;
    retryable: boolean;
  }> = [
    { status: 401, expected: "permission_revoked", retryable: false },
    { status: 403, expected: "permission_revoked", retryable: false },
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1000" },
      expected: "rate_limited",
      retryable: true,
    },
    { status: 404, expected: "repo_not_found", retryable: false },
    { status: 409, expected: "branch_conflict", retryable: false },
    { status: 422, expected: "validation_failed", retryable: false },
    { status: 500, expected: "network_unknown", retryable: true },
  ];
  for (const item of cases) {
    const fake = createFakeGitHub();
    fake.on("GET", "/repos", () => ({
      status: item.status,
      headers: item.headers,
      body: { message: "failure" },
    }));
    const response = await transportFor(fake).send({
      method: "GET",
      path: "/repos",
      credential: CREDENTIAL,
    });
    assert.equal(response.ok, false, `status ${item.status}`);
    assert.equal(response.failure?.code, item.expected, `status ${item.status}`);
    assert.equal(response.failure?.retryable, item.retryable, `status ${item.status}`);
    assert.equal(response.failure?.status, item.status);
  }
});

test("a transport failure is network_unknown and never a negative business answer", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", "/repos", () => ({ throws: new Error("socket hang up") }));
  const response = await transportFor(fake).send({
    method: "GET",
    path: "/repos",
    credential: CREDENTIAL,
  });
  assert.equal(response.ok, false);
  assert.equal(response.failure?.code, "network_unknown");
  assert.equal(response.failure?.retryable, true);
  assert.equal(response.failure?.status, undefined);
});

test("the credential travels only in the authorization header", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", "/repos", () => ({ body: { id: 1 } }));
  const response = await transportFor(fake).send({
    method: "GET",
    path: "/repos",
    query: { page: 2, per_page: 100 },
    credential: CREDENTIAL,
  });
  assert.equal(response.ok, true);
  const request = fake.requests.at(-1)!;
  assert.equal(request.headers["authorization"], `Bearer ${CREDENTIAL.token}`);
  assert.ok(!request.url.includes(CREDENTIAL.token), "token must not appear in the url");
  assert.deepEqual(request.query, { page: "2", per_page: "100" });
});

test("credential-like query keys and inline query strings are refused before sending", async () => {
  const fake = createFakeGitHub();
  const transport = transportFor(fake);
  const withQueryKey = await transport.send({
    method: "GET",
    path: "/repos",
    query: { access_token: "leak" },
    credential: CREDENTIAL,
  });
  assert.equal(withQueryKey.ok, false);
  assert.equal(withQueryKey.failure?.code, "validation_failed");

  const inlineQuery = await transport.send({
    method: "GET",
    path: "/repos?token=leak",
    credential: CREDENTIAL,
  });
  assert.equal(inlineQuery.ok, false);
  assert.equal(inlineQuery.failure?.code, "validation_failed");
  assert.equal(fake.requests.length, 0, "nothing is sent when the request shape is unsafe");
});

test("error messages are scrubbed of the exact credential before they leave the layer", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", "/repos", () => ({
    status: 422,
    body: { message: `rejected token ${CREDENTIAL.token}`, details: [{ value: CREDENTIAL.token }] },
  }));
  const response = await transportFor(fake).send({
    method: "GET",
    path: "/repos",
    credential: CREDENTIAL,
  });
  assert.equal(response.ok, false);
  assert.ok(!response.failure!.message.includes(CREDENTIAL.token));
  assert.ok(response.failure!.message.includes("[redacted]"));
});

test("scrubGitHubSecrets removes jwt and pem shaped material too", () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJpc3MiOjF9.c2lnbmF0dXJlLXNlZ21lbnQ";
  const pem = "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----";
  const scrubbed = scrubGitHubSecrets(`a ${jwt} b ${pem} c ghs_abcdefghijklmnopqrst`);
  assert.ok(!scrubbed.includes(jwt));
  assert.ok(!scrubbed.includes("MIIEvQIBADANBg"));
  assert.ok(!scrubbed.includes("ghs_abcdefghijklmnopqrst"));
});

test("a non-JSON success body is a protocol failure, not empty data", async () => {
  const fake = createFakeGitHub();
  fake.on("GET", "/repos", () => ({ body: "not-json" }));
  const transport = createGitHubTransport({
    fetchImpl: async () => new Response("<html>proxy error</html>", { status: 200 }),
  });
  const response = await transport.send({ method: "GET", path: "/repos", credential: CREDENTIAL });
  assert.equal(response.ok, false);
  assert.equal(response.failure?.code, "validation_failed");
});

test("GitHubApiError exposes normalized facts without the provider payload", () => {
  const error = new GitHubApiError({
    code: "rate_limited",
    retryable: true,
    status: 403,
    requestId: "req-1",
    retryAfterMs: 30_000,
    message: "rate limited",
  });
  assert.deepEqual(error.toFacts(), {
    code: "rate_limited",
    retryable: true,
    status: 403,
    requestId: "req-1",
  });
  assert.equal(error.retryAfterMs, 30_000);
});

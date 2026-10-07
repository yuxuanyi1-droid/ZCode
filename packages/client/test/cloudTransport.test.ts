/**
 * W7 传输层用例（specs/cloud-agent/03 §6/§6.2、04 §4「显式 origin」、§7 日志与凭据边界）。
 *
 * 断言的是「线上事实」：URL 里有没有 token、头带了什么、超时/取消归一成什么错误码、
 * 非信封响应是否 fail-closed。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudApiError,
  buildCloudRequestPath,
  buildCloudUrl,
  buildCloudWebSocketUrl,
  createCloudHttpTransport,
  isCloudApiError,
  normalizeCloudOrigin,
} from "../src/index.js";
import { createCloudFixtureServer, errorEnvelope } from "./cloudFixtures.js";

const ORIGIN = "https://cloud.example.test";
const TOKEN = "secret-bearer-token";

test("origin must be a bare absolute http(s) origin", () => {
  assert.equal(normalizeCloudOrigin("https://cloud.example.test"), ORIGIN);
  assert.equal(normalizeCloudOrigin("https://cloud.example.test/"), ORIGIN);
  assert.equal(normalizeCloudOrigin("http://127.0.0.1:3210"), "http://127.0.0.1:3210");
  for (const invalid of [
    "cloud.example.test",
    "ftp://cloud.example.test",
    "https://cloud.example.test/prefix",
    "https://user:pw@cloud.example.test",
  ]) {
    assert.throws(
      () => normalizeCloudOrigin(invalid),
      (error: unknown) => isCloudApiError(error) && error.code === "validation_failed",
      `origin ${invalid} must be rejected`,
    );
  }
});

test("path parameters are encoded and never escape the configured origin", () => {
  assert.equal(
    buildCloudRequestPath("/api/cloud/tasks/:taskId/inputs/:commandId", {
      taskId: "t-1",
      commandId: "c/2",
    }),
    "/api/cloud/tasks/t-1/inputs/c%2F2",
  );
  assert.throws(() => buildCloudRequestPath("/api/cloud/tasks/:taskId", {}));
  assert.throws(() =>
    buildCloudRequestPath("/api/cloud/tasks/:taskId", { taskId: "t", other: "x" }),
  );
  // 绝对 URL 只能被编码成路径段，不能把请求带出 origin。
  assert.equal(
    buildCloudUrl(ORIGIN, "/api/cloud/tasks/:taskId", { taskId: "https://evil.example.test" }),
    `${ORIGIN}/api/cloud/tasks/https%3A%2F%2Fevil.example.test`,
  );
  assert.throws(
    () => buildCloudUrl(ORIGIN, "//evil.example.test/api/cloud"),
    (error: unknown) => isCloudApiError(error) && error.source === "configuration",
  );
  assert.equal(
    buildCloudUrl(
      ORIGIN,
      "/api/cloud/tasks/:taskId",
      { taskId: "t-1" },
      { limit: 25, cursor: undefined },
    ),
    `${ORIGIN}/api/cloud/tasks/t-1?limit=25`,
  );
  assert.equal(
    buildCloudWebSocketUrl(ORIGIN, "/ws/cloud/tasks/:taskId", { taskId: "t-1" }),
    "wss://cloud.example.test/ws/cloud/tasks/t-1",
  );
});

test("bearer mode puts the token in the header only, cookie mode uses same-origin credentials", async () => {
  const server = createCloudFixtureServer();
  const bearer = createCloudHttpTransport({
    origin: ORIGIN,
    auth: { mode: "bearer", token: TOKEN },
    fetch: server.fetch,
  });
  await bearer.request({ endpointId: "capabilities" });
  const bearerRequest = server.requests[0];
  assert.equal(bearerRequest?.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(bearerRequest?.url.includes(TOKEN), false, "token must never reach the URL");
  assert.equal(bearerRequest?.url, `${ORIGIN}/api/cloud/capabilities`);

  const cookieServer = createCloudFixtureServer();
  const cookie = createCloudHttpTransport({ origin: ORIGIN, fetch: cookieServer.fetch });
  await cookie.request({ endpointId: "capabilities" });
  const cookieRequest = cookieServer.requests[0];
  assert.equal(cookieRequest?.headers.authorization, undefined);
  assert.equal(cookieRequest?.credentials, "include");
});

test("timeouts and caller aborts normalize into typed transport errors", async () => {
  const slowServer = createCloudFixtureServer({
    handlers: { capabilities: () => ({ status: 200, body: { mode: "cloud" }, delayMs: 60 }) },
  });
  const timeoutTransport = createCloudHttpTransport({
    origin: ORIGIN,
    fetch: slowServer.fetch,
    timeoutMs: 10,
  });
  const timeoutError = await timeoutTransport
    .request({ endpointId: "capabilities" })
    .then(() => undefined)
    .catch((error: unknown) => error);
  assert.ok(isCloudApiError(timeoutError));
  assert.equal(timeoutError.code, "network_unknown");
  assert.equal(timeoutError.retryable, true);
  assert.equal(timeoutError.source, "transport");
  assert.equal(timeoutError.canceled, false);

  const abortServer = createCloudFixtureServer({
    handlers: { capabilities: () => ({ status: 200, body: { mode: "cloud" }, delayMs: 60 }) },
  });
  const controller = new AbortController();
  const abortTransport = createCloudHttpTransport({ origin: ORIGIN, fetch: abortServer.fetch });
  const pending = abortTransport
    .request({ endpointId: "capabilities", signal: controller.signal })
    .then(() => undefined)
    .catch((error: unknown) => error);
  controller.abort();
  const abortError = await pending;
  assert.ok(isCloudApiError(abortError));
  assert.equal(abortError.code, "network_unknown");
  assert.equal(abortError.canceled, true);
  assert.equal(abortError.retryable, false);

  const preAborted = new AbortController();
  preAborted.abort();
  const preAbortError = await abortTransport
    .request({ endpointId: "capabilities", signal: preAborted.signal })
    .then(() => undefined)
    .catch((error: unknown) => error);
  assert.ok(isCloudApiError(preAbortError));
  assert.equal(preAbortError.canceled, true);
});

test("error envelope becomes a typed error without reading the message", async () => {
  const server = createCloudFixtureServer({
    handlers: {
      capabilities: () => ({
        status: 409,
        body: errorEnvelope("stale", {
          message: "run generation is no longer current",
          details: { expectedRunGeneration: 1 },
        }),
      }),
    },
  });
  const transport = createCloudHttpTransport({ origin: ORIGIN, fetch: server.fetch });
  const error = await transport
    .request({ endpointId: "capabilities" })
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(error instanceof CloudApiError);
  assert.equal(error.code, "stale");
  assert.equal(error.retryable, false);
  assert.equal(error.traceId, "trace-fixture-1");
  assert.equal(error.httpStatus, 409);
  assert.deepEqual(error.details, { expectedRunGeneration: 1 });
  // 文案变化不影响语义判定。
  assert.equal(error.toEnvelope().code, "stale");
});

test("responses that are not the frozen envelope or not JSON are rejected fail-closed", async () => {
  const htmlServer = createCloudFixtureServer({
    handlers: { capabilities: () => ({ status: 502, body: undefined }) },
  });
  const notJson = await createCloudHttpTransport({ origin: ORIGIN, fetch: htmlServer.fetch })
    .request({ endpointId: "capabilities" })
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(notJson));
  assert.equal(notJson.code, "protocol_incompatible");
  assert.equal(notJson.details?.endpointId, "capabilities");

  const unknownFieldServer = createCloudFixtureServer({
    handlers: { capabilities: () => ({ status: 200, body: { mode: "cloud", unexpected: true } }) },
  });
  const unknownField = await createCloudHttpTransport({
    origin: ORIGIN,
    fetch: unknownFieldServer.fetch,
  })
    .request({ endpointId: "capabilities" })
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(unknownField));
  assert.equal(unknownField.code, "protocol_incompatible");
  assert.deepEqual(unknownField.details?.endpointId, "capabilities");
  // 上报的 issue 只含 path/code，不回声收到的值或未知字段名。
  assert.equal(JSON.stringify(unknownField.details?.issues).includes("unexpected"), false);
});

test("transport rejects bodies on body-less endpoints and dual bodies", async () => {
  const server = createCloudFixtureServer();
  const transport = createCloudHttpTransport({ origin: ORIGIN, fetch: server.fetch });
  await assert.rejects(
    () => transport.request({ endpointId: "capabilities", json: { anything: 1 } }),
    (error: unknown) => isCloudApiError(error) && error.source === "validation",
  );
  await assert.rejects(
    () => transport.request({ endpointId: "submitInput", json: {}, body: new FormData() }),
    (error: unknown) => isCloudApiError(error) && error.code === "validation_failed",
  );
  assert.equal(server.requests.length, 0, "local validation must happen before any request");
});

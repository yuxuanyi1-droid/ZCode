/**
 * W9 入口解析与启动错误分类用例（specs/cloud-agent/modules/W9 §4/§5/§6；04 §2/§4/§5；03 §7.1）。
 *
 * 断言的是入口契约本身：mode/origin/token/route 只由显式来源决定，五类启动错误各自可分，
 * 且任何一类都**不会**变成「回落到本机 / 开发机」的计划。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CloudApiError, cloudTransportError } from "@zcode/client";
import type { CapabilitiesResponse } from "@zcode/shared";
import {
  CLOUD_BOOT_FAILURE_REASONS,
  CLOUD_CAPABILITIES_PATH,
  buildCloudHostChannelUrl,
  classifyCapabilitiesMismatch,
  classifyCloudBootError,
  classifyCloudBootHttpStatus,
  completeCloudTokenHandshake,
  createCloudBootFailure,
  resolveWebEntryBoot,
} from "../src/cloud/cloudBoot.js";

const RUNTIME_ORIGIN = "https://cloud.example.com";
const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
/** 当前主体：W0 已把它冻结进 `capabilitiesResponseSchema`，是草稿 scope 的唯一来源。 */
const PRINCIPAL_ID = "3c8a6d2b-0e4f-4a9b-8c1d-2e3f4a5b6c7d";

function resolve(search: string, extra?: { buildMode?: string; buildCloudOrigin?: string }) {
  return resolveWebEntryBoot({ search, runtimeOrigin: RUNTIME_ORIGIN, ...extra });
}

/** 能力信封按 frozen schema 构造：不再用 `as` 绕过类型，字段缺失必须当场暴露。 */
function capabilities(overrides: Partial<CapabilitiesResponse> = {}): CapabilitiesResponse {
  return {
    principalId: PRINCIPAL_ID,
    mode: "cloud",
    providers: [],
    features: ["durable-input"],
    protocolVersion: 1,
    taskOwnedAttachments: false,
    ...overrides,
  };
}

test("mode comes only from explicit URL/env; default stays the existing local path", () => {
  const base = resolve("?remote=abc");
  assert.equal(base.ok, true);
  assert.deepEqual(base.ok ? base.plan : null, { mode: "local", remoteId: "abc" });

  // 构建期声明 cloud，URL 未覆盖。
  const fromEnv = resolve("", { buildMode: "cloud" });
  assert.equal(fromEnv.ok && fromEnv.plan.mode, "cloud");

  // URL 覆盖优先于构建期，且 local 也是显式取值。
  const urlWins = resolve("?mode=cloud", { buildMode: "local" });
  assert.equal(urlWins.ok && urlWins.plan.mode, "cloud");
  const forcedLocal = resolve("?mode=local", { buildMode: "cloud" });
  assert.deepEqual(forcedLocal.ok ? forcedLocal.plan : null, { mode: "local" });
});

test("invalid mode fails closed instead of silently running as local", () => {
  for (const search of ["?mode=", "?mode=bogus"]) {
    const result = resolve(search);
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.failure.reason, "mode-invalid");
  }
  const badEnv = resolve("", { buildMode: "clod" });
  assert.equal(!badEnv.ok && badEnv.failure.reason, "mode-invalid");
});

test("cloud entry never serves ?remote= and never falls back to the local entry", () => {
  const result = resolve("?mode=cloud&remote=desktop-1");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.reason, "remote-unsupported");
  assert.deepEqual(!result.ok ? result.failure.recoveries : [], ["open-home"]);
});

test("cloud requires a same-origin runtime and rejects a build/runtime origin mismatch", () => {
  const match = resolve("?mode=cloud", { buildCloudOrigin: RUNTIME_ORIGIN });
  assert.equal(match.ok && match.plan.mode === "cloud" && match.plan.origin, RUNTIME_ORIGIN);

  const mismatch = resolve("?mode=cloud", { buildCloudOrigin: "https://preview.example.com" });
  assert.equal(mismatch.ok, false);
  assert.equal(!mismatch.ok && mismatch.failure.reason, "origin-mismatch");
  assert.deepEqual(!mismatch.ok ? mismatch.failure.detail : null, {
    buildOrigin: "https://preview.example.com",
    runtimeOrigin: RUNTIME_ORIGIN,
  });

  const invalid = resolve("?mode=cloud", { buildCloudOrigin: "not-an-origin" });
  assert.equal(!invalid.ok && invalid.failure.reason, "not-configured");
});

test("?task= is validated as a cloud task identity instead of being dropped", () => {
  const ok = resolve(`?mode=cloud&task=${TASK_ID}`);
  assert.equal(ok.ok && ok.plan.mode === "cloud" && ok.plan.taskId, TASK_ID);

  const bad = resolve("?mode=cloud&task=not-a-task");
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.failure.reason, "invalid-task-id");

  // identity 解析失败不得退化成「没有选中任务」的首页。
  assert.notEqual(!bad.ok && bad.failure.reason, "missing-token");
});

test("token is read from the deployment link and never required to be somewhere else", () => {
  const withToken = resolve("?mode=cloud&token=lite-token-value");
  assert.equal(
    withToken.ok && withToken.plan.mode === "cloud" && withToken.plan.token,
    "lite-token-value",
  );
  const withoutToken = resolve("?mode=cloud");
  assert.equal(withoutToken.ok && withoutToken.plan.mode, "cloud");
  assert.equal(
    withoutToken.ok && withoutToken.plan.mode === "cloud" ? withoutToken.plan.token : "no-plan",
    undefined,
  );
});

test("host channel address is same-origin /ws in ws(s) scheme, with no credential in the URL", () => {
  assert.equal(buildCloudHostChannelUrl(RUNTIME_ORIGIN), "wss://cloud.example.com/ws");
  assert.equal(buildCloudHostChannelUrl("http://localhost:3030"), "ws://localhost:3030/ws");
  assert.equal(buildCloudHostChannelUrl(RUNTIME_ORIGIN).includes("token"), false);
  assert.equal(CLOUD_CAPABILITIES_PATH, "/api/cloud/capabilities");
});

test("every boot failure reason carries an actionable recovery", () => {
  for (const reason of CLOUD_BOOT_FAILURE_REASONS) {
    const failure = createCloudBootFailure(reason);
    assert.ok(failure.recoveries.length > 0, `${reason} must expose a recovery action`);
    assert.equal(failure.reason, reason);
  }
});

test("auth failures split into 'missing' and 'invalid' by whether a token was provided", () => {
  const unauthorized = new CloudApiError({
    code: "unauthenticated",
    message: "Unauthorized",
    retryable: false,
    source: "envelope",
    httpStatus: 401,
  });
  assert.equal(
    classifyCloudBootError(unauthorized, { tokenProvided: false }).reason,
    "missing-token",
  );
  assert.equal(
    classifyCloudBootError(unauthorized, { tokenProvided: true }).reason,
    "invalid-token",
  );
  assert.equal(
    classifyCloudBootError(unauthorized, { tokenProvided: true }).code,
    "unauthenticated",
  );

  const forbidden = new CloudApiError({
    code: "permission_revoked",
    message: "revoked",
    retryable: false,
    source: "envelope",
    httpStatus: 403,
  });
  assert.equal(classifyCloudBootError(forbidden, { tokenProvided: true }).reason, "not-authorized");
});

test("version/protocol mismatch and unreachable backend stay distinct failure surfaces", () => {
  const incompatible = new CloudApiError({
    code: "protocol_incompatible",
    message: "unsupported protocol",
    retryable: false,
    source: "protocol",
  });
  assert.equal(
    classifyCloudBootError(incompatible, { tokenProvided: true }).reason,
    "incompatible-bundle",
  );

  const transport = cloudTransportError("fetch failed");
  const unreachable = classifyCloudBootError(transport, { tokenProvided: true });
  assert.equal(unreachable.reason, "backend-unreachable");
  // 未知异常同样停在失败面：网络失败不得变成本机入口。
  assert.equal(
    classifyCloudBootError(new Error("boom"), { tokenProvided: false }).reason,
    "backend-unreachable",
  );
});

test("not-configured deployment is reported from the envelope or a bare 404/503", () => {
  const notConfigured = new CloudApiError({
    code: "not_configured",
    message: "cloud mode is not configured",
    retryable: false,
    source: "envelope",
    httpStatus: 503,
  });
  assert.equal(
    classifyCloudBootError(notConfigured, { tokenProvided: true }).reason,
    "not-configured",
  );
  assert.equal(
    classifyCloudBootHttpStatus(404, undefined, { tokenProvided: true }).reason,
    "not-configured",
  );
  assert.equal(
    classifyCloudBootHttpStatus(401, undefined, { tokenProvided: false }).reason,
    "missing-token",
  );
});

test("capabilities must report cloud mode and a supported wire version", () => {
  assert.equal(classifyCapabilitiesMismatch(capabilities()), undefined);
  assert.equal(
    classifyCapabilitiesMismatch(capabilities({ mode: "local" }))?.reason,
    "not-configured",
  );
  const futureVersion = {
    ...capabilities(),
    protocolVersion: 99,
  } as unknown as CapabilitiesResponse;
  assert.equal(classifyCapabilitiesMismatch(futureVersion)?.reason, "incompatible-bundle");
});

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("token gate handshake exchanges the token for the lite-token cookie", async () => {
  const seen: string[] = [];
  const ok = await completeCloudTokenHandshake({
    origin: RUNTIME_ORIGIN,
    token: "lite-token-value",
    fetchImpl: ((input: RequestInfo | URL) => {
      seen.push(String(input));
      return Promise.resolve(jsonResponse(capabilities()));
    }) as typeof fetch,
  });
  assert.equal(ok.ok, true);
  assert.equal(seen[0], `${RUNTIME_ORIGIN}${CLOUD_CAPABILITIES_PATH}?token=lite-token-value`);
  // 同一次握手就把当前主体带回来（scope 隔离键的唯一来源，04 §3.4.1）。
  assert.equal(ok.ok && ok.capabilities.principalId, PRINCIPAL_ID);
});

test("token gate handshake fails closed on rejection, mismatch and unreachable backend", async () => {
  const rejected = await completeCloudTokenHandshake({
    origin: RUNTIME_ORIGIN,
    token: "wrong",
    fetchImpl: (() =>
      Promise.resolve(
        jsonResponse(
          { code: "unauthenticated", message: "Unauthorized", retryable: false, traceId: "t-1" },
          401,
        ),
      )) as typeof fetch,
  });
  assert.equal(!rejected.ok && rejected.failure.reason, "invalid-token");
  assert.equal(!rejected.ok ? rejected.failure.traceId : undefined, "t-1");

  const offline = await completeCloudTokenHandshake({
    origin: RUNTIME_ORIGIN,
    token: "lite",
    fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch,
  });
  assert.equal(!offline.ok && offline.failure.reason, "backend-unreachable");

  const notCloud = await completeCloudTokenHandshake({
    origin: RUNTIME_ORIGIN,
    token: "lite",
    fetchImpl: (() =>
      Promise.resolve(jsonResponse(capabilities({ mode: "local" })))) as typeof fetch,
  });
  assert.equal(!notCloud.ok && notCloud.failure.reason, "not-configured");

  const garbage = await completeCloudTokenHandshake({
    origin: RUNTIME_ORIGIN,
    token: "lite",
    fetchImpl: (() =>
      Promise.resolve(new Response("<html>502</html>", { status: 200 }))) as typeof fetch,
  });
  assert.equal(!garbage.ok && garbage.failure.reason, "incompatible-bundle");
});

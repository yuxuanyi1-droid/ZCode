/**
 * W9 入口探测与启动错误分类用例（specs/cloud-agent/04 §2.1；modules/W9 §4/§5/§6；03 §7.1）。
 *
 * 2026-10-07 修订：模式不再是客户端声明（`?mode=`/构建期 `VITE_*`/origin 一致性校验已作废），
 * 而是启动时同源探测 `GET /api/cloud/capabilities` 的结果。断言的是入口契约本身：
 * 探测的四种答案各自落到哪个入口，且**没有任何一种不确定会变成 local 计划**。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { CloudApiError, cloudTransportError } from "@zcode/client";
import { createLocalCapabilitiesResponse, type CapabilitiesResponse } from "@zcode/shared";
import {
  CLOUD_BOOT_FAILURE_REASONS,
  CLOUD_CAPABILITIES_PATH,
  bootWebEntry,
  buildCloudHostChannelUrl,
  classifyCapabilitiesMismatch,
  classifyCloudBootError,
  classifyCloudBootHttpStatus,
  completeCloudTokenHandshake,
  createCloudBootFailure,
  probeWebEntryMode,
  resolveWebEntryBoot,
} from "../src/cloud/cloudBoot.js";

const RUNTIME_ORIGIN = "https://cloud.example.com";
const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
/** 当前主体：W0 已把它冻结进 capabilities 的云分支（必填）。 */
const PRINCIPAL_ID = "3c8a6d2b-0e4f-4a9b-8c1d-2e3f4a5b6c7d";

type CloudCapabilities = Extract<CapabilitiesResponse, { mode: "cloud" }>;

/** 能力信封按 frozen schema 构造：不用 `as` 绕过类型，字段缺失必须当场暴露。 */
function cloudCapabilities(overrides: Partial<CloudCapabilities> = {}): CloudCapabilities {
  return {
    mode: "cloud",
    principalId: PRINCIPAL_ID,
    providers: [],
    features: ["durable-input"],
    protocolVersion: 1,
    taskOwnedAttachments: false,
    ...overrides,
  };
}

const LOCAL_CAPABILITIES = createLocalCapabilitiesResponse();

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** 用一份固定响应驱动探测，并把请求记下来供「同源、不带凭据」断言使用。 */
function probeWith(response: Response | Error): {
  fetchImpl: typeof fetch;
  seen: { url: string; init: RequestInit | undefined }[];
} {
  const seen: { url: string; init: RequestInit | undefined }[] = [];
  const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return response instanceof Error ? Promise.reject(response) : Promise.resolve(response);
  }) as typeof fetch;
  return { fetchImpl, seen };
}

test("探测：同源 capabilities 端点、不带凭据", async () => {
  const { fetchImpl, seen } = probeWith(jsonResponse(cloudCapabilities()));
  const result = await probeWebEntryMode({ origin: RUNTIME_ORIGIN, fetchImpl });
  assert.equal(result.kind, "mode");
  assert.equal(result.kind === "mode" && result.mode, "cloud");
  assert.deepEqual(
    seen.map((entry) => entry.url),
    [`${RUNTIME_ORIGIN}${CLOUD_CAPABILITIES_PATH}`],
  );
  // 探测不得携带 token：带 token 探测会把「需要凭据」的部署变成 200，模式分面随之丢失。
  assert.equal(seen[0]?.url.includes("token"), false);
  assert.equal(seen[0]?.init?.credentials, "same-origin");
});

test("探测四种答案：cloud / local / credential-required / failure，绝不假设 local", async () => {
  const cloud = await probeWebEntryMode({
    origin: RUNTIME_ORIGIN,
    fetchImpl: probeWith(jsonResponse(cloudCapabilities())).fetchImpl,
  });
  assert.deepEqual(cloud.kind === "mode" ? [cloud.kind, cloud.mode] : [cloud.kind], [
    "mode",
    "cloud",
  ]);

  const local = await probeWebEntryMode({
    origin: RUNTIME_ORIGIN,
    fetchImpl: probeWith(jsonResponse(LOCAL_CAPABILITIES)).fetchImpl,
  });
  assert.deepEqual(local.kind === "mode" ? [local.kind, local.mode] : [local.kind], [
    "mode",
    "local",
  ]);

  // 401/403 是「服务端在、但要求凭据」的明确回答，不是失败面。
  for (const status of [401, 403]) {
    const credential = await probeWebEntryMode({
      origin: RUNTIME_ORIGIN,
      fetchImpl: probeWith(
        jsonResponse(
          { code: "unauthenticated", message: "no", retryable: false, traceId: "t-1" },
          status,
        ),
      ).fetchImpl,
    });
    assert.equal(credential.kind, "credential-required", `status ${status}`);
  }

  // 404：地址不是入口 → 明确失败（而不是当本地、也不是当「没有模式」）。
  const notFound = await probeWebEntryMode({
    origin: RUNTIME_ORIGIN,
    fetchImpl: probeWith(new Response("not found", { status: 404 })).fetchImpl,
  });
  assert.equal(notFound.kind === "failure" && notFound.failure.reason, "not-configured");

  // 200 但不是契约响应体：不猜字段，也不回落本机。
  const garbage = await probeWebEntryMode({
    origin: RUNTIME_ORIGIN,
    fetchImpl: probeWith(new Response("<html>proxy</html>", { status: 200 })).fetchImpl,
  });
  assert.equal(garbage.kind === "failure" && garbage.failure.reason, "incompatible-bundle");

  // 不可达：失败面，不是 local。
  const unreachable = await probeWebEntryMode({
    origin: RUNTIME_ORIGIN,
    fetchImpl: probeWith(new Error("ECONNREFUSED")).fetchImpl,
  });
  assert.equal(unreachable.kind === "failure" && unreachable.failure.reason, "backend-unreachable");
});

test("探测到不支持的 wire 版本时 fail-closed", async () => {
  const result = await probeWebEntryMode({
    origin: RUNTIME_ORIGIN,
    fetchImpl: probeWith(jsonResponse({ ...cloudCapabilities(), protocolVersion: 99 })).fetchImpl,
  });
  // 未知版本在冻结 schema 层就被拒绝（`cloudWireProtocolVersionSchema` = literal 1），
  // 因此这里只有 incompatible-bundle 这个结论，没有可解析出的版本细节——不猜、不降级。
  assert.equal(result.kind === "failure" && result.failure.reason, "incompatible-bundle");
  assert.equal(result.kind === "failure" ? result.failure.detail : undefined, undefined);
});

test("启动：探测结果映射到三个入口（云壳 / 凭据门 / 本地路径）", async () => {
  const cloud = await bootWebEntry({
    search: `?task=${TASK_ID}`,
    runtimeOrigin: RUNTIME_ORIGIN,
    fetchImpl: probeWith(jsonResponse(cloudCapabilities())).fetchImpl,
  });
  assert.deepEqual(cloud.ok ? cloud.plan : null, {
    mode: "cloud",
    origin: RUNTIME_ORIGIN,
    credentialRequired: false,
    taskId: TASK_ID,
  });

  // 401 → 云壳 + 凭据门：`?token=` 仍作为凭据传入通道保留。
  const gate = await bootWebEntry({
    search: "?token=lite-token-value",
    runtimeOrigin: RUNTIME_ORIGIN,
    fetchImpl: probeWith(new Response("unauthorized", { status: 401 })).fetchImpl,
  });
  assert.deepEqual(gate.ok ? gate.plan : null, {
    mode: "cloud",
    origin: RUNTIME_ORIGIN,
    credentialRequired: true,
    token: "lite-token-value",
  });

  // 本地：原 Web 路径，`?remote=` 语义不变（探测结果说了算，不受 URL 左右）。
  const local = await bootWebEntry({
    search: "?remote=desktop-1",
    runtimeOrigin: RUNTIME_ORIGIN,
    fetchImpl: probeWith(jsonResponse(LOCAL_CAPABILITIES)).fetchImpl,
  });
  assert.deepEqual(local.ok ? local.plan : null, { mode: "local", remoteId: "desktop-1" });
});

test("探测不确定一律停在错误屏：404 / 非契约响应 / 5xx / 不可达都不回落 local", async () => {
  for (const response of [
    new Response("not found", { status: 404 }),
    new Response("<html>proxy</html>", { status: 200 }),
    new Response("boom", { status: 500 }),
    new Error("ECONNREFUSED"),
  ]) {
    const boot = await bootWebEntry({
      search: "",
      runtimeOrigin: RUNTIME_ORIGIN,
      fetchImpl: probeWith(response).fetchImpl,
    });
    assert.equal(boot.ok, false, String(response));
    // 失败面必须带可操作恢复动作（错误屏渲染的按钮），且不可能是 local 计划。
    assert.ok(!boot.ok && boot.failure.recoveries.length > 0, String(response));
  }
});

test("云入口不服务 ?remote=，也不回落本机入口", () => {
  const result = resolveWebEntryBoot({
    search: "?remote=desktop-1",
    runtimeOrigin: RUNTIME_ORIGIN,
    serverMode: "cloud",
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.failure.reason, "remote-unsupported");
  assert.deepEqual(!result.ok ? result.failure.recoveries : [], ["open-home"]);
});

test("?task= 按 cloud task 身份校验，不被静默丢弃", () => {
  const ok = resolveWebEntryBoot({
    search: `?task=${TASK_ID}`,
    runtimeOrigin: RUNTIME_ORIGIN,
    serverMode: "cloud",
  });
  assert.equal(ok.ok && ok.plan.mode === "cloud" && ok.plan.taskId, TASK_ID);

  const bad = resolveWebEntryBoot({
    search: "?task=not-a-task",
    runtimeOrigin: RUNTIME_ORIGIN,
    serverMode: "cloud",
  });
  assert.equal(bad.ok, false);
  assert.equal(!bad.ok && bad.failure.reason, "invalid-task-id");
  // identity 解析失败不得退化成「没有选中任务」的首页。
  assert.notEqual(!bad.ok && bad.failure.reason, "missing-token");

  // 本地模式不认云主路由：`?task=` 不参与、也不改变本地计划（原 Web 行为不变）。
  const local = resolveWebEntryBoot({
    search: "?task=not-a-task&remote=desktop-1",
    runtimeOrigin: RUNTIME_ORIGIN,
    serverMode: "local",
  });
  assert.deepEqual(local.ok ? local.plan : null, { mode: "local", remoteId: "desktop-1" });
});

test("host 通道地址：同源 /ws、ws(s) 协议、URL 不含凭据", () => {
  assert.equal(buildCloudHostChannelUrl(RUNTIME_ORIGIN), "wss://cloud.example.com/ws");
  assert.equal(buildCloudHostChannelUrl("http://localhost:3030"), "ws://localhost:3030/ws");
  assert.equal(buildCloudHostChannelUrl(RUNTIME_ORIGIN).includes("token"), false);
  assert.equal(CLOUD_CAPABILITIES_PATH, "/api/cloud/capabilities");
});

test("每个失败原因都带可操作恢复动作，且不含已作废的客户端模式失败类", () => {
  for (const reason of CLOUD_BOOT_FAILURE_REASONS) {
    const failure = createCloudBootFailure(reason);
    assert.ok(failure.recoveries.length > 0, `${reason} must expose a recovery action`);
    assert.equal(failure.reason, reason);
  }
  // 04 §2.1：`mode-invalid` / `origin-mismatch` 随客户端模式声明作废。
  assert.equal((CLOUD_BOOT_FAILURE_REASONS as readonly string[]).includes("mode-invalid"), false);
  assert.equal(
    (CLOUD_BOOT_FAILURE_REASONS as readonly string[]).includes("origin-mismatch"),
    false,
  );
});

test("认证失败按「是否提供过凭据」分成 missing 与 invalid", () => {
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

test("协议不兼容与后端不可达是各自独立的失败面", () => {
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

test("未配置部署由错误信封或裸 404/503 判定", () => {
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

test("能力不匹配只在调用方要求某个模式时才成立（探测两模式都合法）", () => {
  // 探测：两个模式都是合法答案，只有协议版本受约束（04 §2.1）。
  assert.equal(classifyCapabilitiesMismatch(cloudCapabilities()), undefined);
  assert.equal(classifyCapabilitiesMismatch(LOCAL_CAPABILITIES), undefined);
  // 云启动流程/凭据门要求云：本地答案在这里才是不匹配。
  assert.equal(
    classifyCapabilitiesMismatch(LOCAL_CAPABILITIES, { expectedMode: "cloud" })?.reason,
    "not-configured",
  );
  const futureVersion = {
    ...cloudCapabilities(),
    protocolVersion: 99,
  } as unknown as CapabilitiesResponse;
  assert.equal(classifyCapabilitiesMismatch(futureVersion)?.reason, "incompatible-bundle");
});

test("凭据门握手：令牌换成 lite-token cookie，并带回当前主体", async () => {
  const seen: string[] = [];
  const ok = await completeCloudTokenHandshake({
    origin: RUNTIME_ORIGIN,
    token: "lite-token-value",
    fetchImpl: ((input: RequestInfo | URL) => {
      seen.push(String(input));
      return Promise.resolve(jsonResponse(cloudCapabilities()));
    }) as typeof fetch,
  });
  assert.equal(ok.ok, true);
  assert.equal(seen[0], `${RUNTIME_ORIGIN}${CLOUD_CAPABILITIES_PATH}?token=lite-token-value`);
  assert.equal(
    ok.ok && ok.capabilities.mode === "cloud" && ok.capabilities.principalId,
    PRINCIPAL_ID,
  );
});

test("凭据门握手在拒绝、模式不符与不可达时 fail-closed", async () => {
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
    fetchImpl: (() => Promise.resolve(jsonResponse(LOCAL_CAPABILITIES))) as typeof fetch,
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

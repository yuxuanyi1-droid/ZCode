/**
 * W7 控制面 SDK 用例（specs/cloud-agent/W7 §6、03 §6/§6.1/§6.2、04 §9 W-05/W-07/W-09）。
 *
 * 覆盖：每个端点的正常/错误/未知字段 round-trip、未知协议版本拒绝、同 commandId 重试、
 * 不同 payload → 409、`202` 与 `admitted` 区分、cursor 越界 → resync-required。
 */
import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "@zcode/shared";
import {
  CLOUD_ATTACHMENT_UPLOAD_FORM,
  CLOUD_HTTP_ENDPOINTS,
  CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS,
  CLOUD_WIRE_PROTOCOL_VERSION,
  findCloudHttpEndpoint,
} from "@zcode/shared";
import {
  CLOUD_SDK_ENDPOINT_SCHEMAS,
  CLOUD_SDK_SUPPORTED_PROTOCOL_VERSIONS,
  CloudResyncRequiredError,
  assertSupportedCloudProtocolVersion,
  createCloudControlPlaneClient,
  createCloudHttpTransport,
  isCloudApiError,
  isCloudResyncRequiredError,
  isRuntimeAckPending,
  isRuntimeAdmitted,
  parseCloudResponse,
} from "../src/index.js";
import { CLOUD_SDK_INVOCATIONS } from "./cloudSdkInvocations.js";
import {
  COMMAND_ID,
  RUN_ID,
  TASK_ID,
  cloudEndpointPayload,
  cloudEndpointPayloadWith,
  createCloudFixtureServer,
  errorEnvelope,
  inputReceipt,
  withUnknownField,
  type CloudFixtureServer,
} from "./cloudFixtures.js";

const ORIGIN = "https://cloud.example.test";
const TOKEN = "secret-bearer-token";

function clientFor(server: CloudFixtureServer) {
  const transport = createCloudHttpTransport({
    origin: ORIGIN,
    auth: { mode: "bearer", token: TOKEN },
    fetch: server.fetch,
  });
  return { transport, client: createCloudControlPlaneClient(transport) };
}

test("SDK endpoint map consumes the frozen shared schemas without copying field names", () => {
  const namespace = shared as unknown as Record<string, unknown>;
  const entries = Object.entries(
    CLOUD_SDK_ENDPOINT_SCHEMAS as Record<string, { request: unknown; response: unknown }>,
  );
  assert.equal(entries.length > 0, true);
  for (const [endpointId, entry] of entries) {
    const descriptor = findCloudHttpEndpoint(endpointId);
    assert.ok(descriptor, `endpoint ${endpointId} must exist in the frozen matrix`);
    // 声明的 schema 常量名必须能在 shared 公开入口解析到同一个对象（禁止本地复制字段名）。
    const responseSchema = namespace[descriptor.response as string];
    assert.equal(entry.response, responseSchema, `${endpointId} response schema must be shared`);
    if (descriptor.request === null) {
      assert.equal(entry.request, null);
    } else {
      assert.equal(entry.request, namespace[descriptor.request], `${endpointId} request schema`);
    }
  }
  // 冻结矩阵里的写端点必须都在 SDK 索引里（避免 SDK 悄悄少一个端点）。
  for (const descriptor of CLOUD_HTTP_ENDPOINTS) {
    if (descriptor.request === null) continue;
    assert.ok(
      Object.prototype.hasOwnProperty.call(CLOUD_SDK_ENDPOINT_SCHEMAS, descriptor.id),
      `write endpoint ${descriptor.id} must be declared by the SDK`,
    );
  }
});

test("every fixture payload satisfies its frozen response schema", () => {
  // 契约加字段时先在这里精确失败（指出端点），而不是让无关的 round-trip 用例运行时才红。
  for (const invocation of CLOUD_SDK_INVOCATIONS) {
    assert.doesNotThrow(
      () => parseCloudResponse(invocation.endpointId, cloudEndpointPayload(invocation.endpointId)),
      `fixture payload for ${invocation.endpointId} must satisfy its frozen response schema`,
    );
  }
});

test("every implemented endpoint round-trips a valid response on its frozen method and path", async () => {
  const server = createCloudFixtureServer();
  const { client } = clientFor(server);
  for (const invocation of CLOUD_SDK_INVOCATIONS) {
    const before = server.requests.length;
    const result = await invocation.invoke(client);
    assert.notEqual(result, undefined, `${invocation.endpointId} must return a payload`);
    const request = server.requests[before];
    assert.ok(request, `${invocation.endpointId} must issue exactly one request`);
    const descriptor = findCloudHttpEndpoint(invocation.endpointId);
    assert.ok(descriptor);
    assert.equal(server.endpointIds[before], invocation.endpointId);
    assert.equal(request.method, descriptor.method);
    assert.equal(request.url.includes(TOKEN), false, "token must never appear in the URL");
    assert.equal(
      request.pathname.startsWith("/api/cloud"),
      true,
      `${invocation.endpointId} must call the cloud namespace`,
    );
    if (invocation.expectedSearch !== undefined) {
      assert.equal(request.search, invocation.expectedSearch);
    }
  }
  assert.equal(server.requests.length, CLOUD_SDK_INVOCATIONS.length);
});

test("every implemented endpoint surfaces a typed error from the frozen envelope", async () => {
  const server = createCloudFixtureServer({
    errorOverride: errorEnvelope("rate_limited"),
    errorStatus: 429,
  });
  const { client } = clientFor(server);
  for (const invocation of CLOUD_SDK_INVOCATIONS) {
    const error = await invocation.invoke(client).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    assert.ok(isCloudApiError(error), `${invocation.endpointId} must throw CloudApiError`);
    // 语义只来自 code/retryable，不解析文案。
    assert.equal(error.code, "rate_limited");
    assert.equal(error.retryable, true);
    assert.equal(error.httpStatus, 429);
    assert.equal(error.traceId, "trace-fixture-1");
  }
});

test("every implemented endpoint rejects a response with unknown fields", async () => {
  const server = createCloudFixtureServer({ transform: withUnknownField });
  const { client } = clientFor(server);
  for (const invocation of CLOUD_SDK_INVOCATIONS) {
    const error = await invocation.invoke(client).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    assert.ok(isCloudApiError(error), `${invocation.endpointId} must throw`);
    assert.equal(error.code, "protocol_incompatible");
    assert.equal(error.details?.endpointId, invocation.endpointId);
  }
});

test("an unsupported cloud protocol version is rejected instead of guessed", async () => {
  // 不在 shared 支持集内的版本：capabilities 的 literal schema 先拒绝（00 §8 fail-closed）。
  const server = createCloudFixtureServer({
    handlers: {
      capabilities: () => ({
        status: 200,
        body: cloudEndpointPayloadWith("capabilities", { protocolVersion: 99 }),
      }),
    },
  });
  const { client } = clientFor(server);
  const error = await client
    .getCapabilities()
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(error));
  assert.equal(error.code, "protocol_incompatible");
  assert.equal(error.details?.endpointId, "capabilities");

  // SDK 侧闸门与 shared 支持集同源（W7 CR-1），不自行声明版本。
  assert.deepEqual(
    [...CLOUD_SDK_SUPPORTED_PROTOCOL_VERSIONS],
    [...CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS],
  );
  assert.doesNotThrow(() => assertSupportedCloudProtocolVersion(CLOUD_WIRE_PROTOCOL_VERSION));
  assert.throws(
    () => assertSupportedCloudProtocolVersion(99),
    (thrown: unknown) =>
      isCloudApiError(thrown) &&
      thrown.code === "protocol_incompatible" &&
      thrown.details?.receivedProtocolVersion === 99,
  );
});

test("task detail actions are passed through verbatim", async () => {
  // 顺序、成员都不做客户端加工：不排序、不裁剪、不按 task 状态补全（04 §3.3 服务端裁决）。
  const actions = ["stop", "send-input", "restore"];
  const server = createCloudFixtureServer({
    handlers: {
      taskDetail: () => ({
        status: 200,
        body: cloudEndpointPayloadWith("taskDetail", { actions }),
      }),
    },
  });
  const detail = await clientFor(server).client.getTask(TASK_ID);
  assert.deepEqual(detail.actions, actions);
  assert.equal(server.requests.length, 1);
});

test("attachment upload uses the frozen multipart field names", async () => {
  const server = createCloudFixtureServer();
  const { client } = clientFor(server);
  const uploaded = await client.uploadAttachment(new Blob(["hello"]), { taskId: TASK_ID });
  assert.equal(uploaded.attachmentId, "att-1");
  const body = server.requests[0]?.body as FormData | undefined;
  assert.ok(body instanceof FormData, "SDK must build the multipart body itself");
  assert.equal(body.get(CLOUD_ATTACHMENT_UPLOAD_FORM.fileField) !== null, true);
  assert.equal(body.get(CLOUD_ATTACHMENT_UPLOAD_FORM.taskIdField), TASK_ID);
  assert.equal(server.endpointIds[0], "uploadAttachment");

  // 未声明 taskId 时只发文件字段（字段名仍来自 shared 常量）。
  const second = createCloudFixtureServer();
  await clientFor(second).client.uploadAttachment(new Blob(["hello"]));
  const bare = second.requests[0]?.body as FormData;
  assert.equal(bare.get(CLOUD_ATTACHMENT_UPLOAD_FORM.taskIdField), null);
  assert.equal(bare.get(CLOUD_ATTACHMENT_UPLOAD_FORM.fileField) !== null, true);
});

test("retry with the same commandId keeps one receipt; a different payload conflicts", async () => {
  let firstBody: unknown;
  const server = createCloudFixtureServer({
    handlers: {
      submitInput: ({ request }) => {
        if (firstBody === undefined) {
          firstBody = request.body;
          return { status: 202, body: inputReceipt() };
        }
        if (JSON.stringify(request.body) === JSON.stringify(firstBody)) {
          return { status: 200, body: inputReceipt({ deliveryStatus: "delivering" }) };
        }
        return { status: 409, body: errorEnvelope("idempotency_conflict") };
      },
    },
  });
  const { client } = clientFor(server);
  const body = {
    intent: "append" as const,
    commandId: COMMAND_ID,
    prompt: "继续处理",
    expectedRunGeneration: 1,
  };

  const first = await client.submitInput(TASK_ID, body);
  const retried = await client.submitInput(TASK_ID, body);
  // 同 key 同 payload：服务端返回同一 receipt 身份，SDK 不做任何 key 改写。
  assert.equal(first.receipt.commandId, retried.receipt.commandId);
  assert.equal(first.receipt.taskId, retried.receipt.taskId);
  assert.deepEqual(server.requests[0]?.body, body, "SDK must send the caller body verbatim");
  assert.deepEqual(server.requests[1]?.body, body);

  const conflict = await client
    .submitInput(TASK_ID, { ...body, prompt: "改了正文" })
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(conflict));
  assert.equal(conflict.code, "idempotency_conflict");
  assert.equal(conflict.retryable, false);
  // SDK 绝不自动重试写操作：三次调用正好三个请求。
  assert.equal(server.requests.length, 3);
});

test("rejected local request bodies never reach the wire", async () => {
  const server = createCloudFixtureServer();
  const { client } = clientFor(server);
  const error = await client
    .submitInput(TASK_ID, {
      intent: "append",
      prompt: "缺少 commandId",
      expectedRunGeneration: 1,
    } as never)
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(error));
  assert.equal(error.code, "validation_failed");
  assert.equal(error.source, "validation");
  assert.equal(server.requests.length, 0);

  const overLimit = await client
    .getTaskEvents(TASK_ID, { waitMs: 60_000 })
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(overLimit));
  assert.equal(overLimit.code, "validation_failed");
  assert.equal(server.requests.length, 0);
});

test("profile 条目上传：路径与正文 category 不一致在本地拒绝（不发出请求）", async () => {
  // 14 §9.2⑦：路径是路由事实、正文是自描述事实，矛盾必须 fail-closed，不能把两种事实都发到线上。
  const server = createCloudFixtureServer();
  const { client } = clientFor(server);
  const error = await client
    .putUserProfileEntry("mcp", "primary", {
      category: "agents-md",
      content: "正文",
    })
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(error));
  assert.equal(error.code, "validation_failed");
  assert.equal(server.requests.length, 0);

  // 合法调用：请求体按冻结 schema 原样发送，路径参数由矩阵模板展开。
  const uploaded = await client.putUserProfileEntry("mcp", "primary", {
    category: "mcp",
    config: { command: "npx" },
  });
  assert.equal(uploaded.profileVersion, 4);
  assert.equal(server.endpointIds[0], "putUserProfileEntry");
  assert.equal(server.requests[0]?.method, "PUT");
  assert.equal(server.requests[0]?.pathname, "/api/cloud/user-profile/entries/mcp/primary");
  // 请求体经冻结 schema 归一（`enabled` 默认 true 落成显式值）：SDK 与 schema 同源，不自行发明默认。
  assert.deepEqual(server.requests[0]?.body, {
    category: "mcp",
    config: { command: "npx" },
    enabled: true,
  });
});

test("profile 快照/版本读取与删除走冻结的 GET/DELETE 形状", async () => {
  const server = createCloudFixtureServer();
  const { client } = clientFor(server);
  const snapshot = await client.listUserProfile();
  assert.equal(snapshot.profileVersion, 3);
  assert.equal(snapshot.entries.length, 1);
  const version = await client.getUserProfileVersion();
  assert.equal(version.profileVersion, 3);
  const deleted = await client.deleteUserProfileEntry("mcp", "primary");
  assert.equal(deleted.profileVersion, 5);
  assert.deepEqual(
    server.requests.map((request) => `${request.method} ${request.pathname}`),
    [
      "GET /api/cloud/user-profile",
      "GET /api/cloud/user-profile/version",
      "DELETE /api/cloud/user-profile/entries/mcp/primary",
    ],
  );
});

test("202 persistence receipt is distinct from runtime admission", async () => {
  const server = createCloudFixtureServer({
    handlers: {
      submitInput: () => ({
        status: 202,
        body: inputReceipt({ deliveryStatus: "accepted" }),
      }),
      getInput: () => ({
        status: 200,
        body: inputReceipt({
          deliveryStatus: "admitted",
          runId: RUN_ID,
          runGeneration: 1,
          runtimeAck: { commandId: COMMAND_ID, status: "accepted", revisionAtDecision: 1 },
        }),
      }),
    },
  });
  const { client } = clientFor(server);
  const submission = await client.submitInput(TASK_ID, {
    intent: "append",
    commandId: COMMAND_ID,
    prompt: "继续处理",
    expectedRunGeneration: 1,
  });
  assert.equal(submission.httpStatus, 202);
  assert.equal(submission.receipt.deliveryStatus, "accepted");
  assert.equal(submission.receipt.runtimeAck, undefined);
  assert.equal(isRuntimeAdmitted(submission.receipt), false);
  assert.equal(isRuntimeAckPending(submission.receipt), true);

  const admitted = await client.getInput(TASK_ID, COMMAND_ID);
  assert.equal(isRuntimeAdmitted(admitted), true);
  assert.equal(isRuntimeAckPending(admitted), false);
});

test("a lost response is reconciled by querying the same commandId", async () => {
  let accepted = false;
  const server = createCloudFixtureServer({
    handlers: {
      // 首次提交：控制面已持久接受但回包丢失（模拟网络中断）。
      submitInput: () => {
        accepted = true;
        throw new TypeError("socket hang up");
      },
      getInput: () =>
        accepted
          ? {
              status: 200,
              body: inputReceipt({ deliveryStatus: "admitted", runId: RUN_ID, runGeneration: 1 }),
            }
          : { status: 404, body: errorEnvelope("not_found") },
    },
  });
  const { client } = clientFor(server);
  const body = {
    intent: "append" as const,
    commandId: COMMAND_ID,
    prompt: "响应丢失后对账",
    expectedRunGeneration: 1,
  };
  const lost = await client
    .submitInput(TASK_ID, body)
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(lost));
  assert.equal(lost.code, "network_unknown");
  assert.equal(lost.retryable, true);

  // 对账路径：不生成新 commandId，直接查原 key 的接收与投递状态（03 §6.2、02 §6.3）。
  const receipt = await client.getInput(TASK_ID, COMMAND_ID);
  assert.equal(receipt.commandId, body.commandId);
  assert.equal(isRuntimeAdmitted(receipt), true);
  assert.equal(server.requests.length, 2);
  assert.equal(server.requests[1]?.pathname, `/api/cloud/tasks/${TASK_ID}/inputs/${COMMAND_ID}`);
});

test("a cursor outside the retention window raises resync-required", async () => {
  const server = createCloudFixtureServer({
    handlers: {
      taskHistory: () => ({
        status: 200,
        body: { items: [], nextCursor: "epoch-9:12", resyncRequired: true },
      }),
    },
  });
  const { client } = clientFor(server);
  const error = await client
    .getTaskHistory(TASK_ID, { topic: "conversation", cursor: "epoch-1:1" })
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudResyncRequiredError(error));
  assert.ok(error instanceof CloudResyncRequiredError);
  assert.equal(error.reason, "retention-window");
  assert.equal(error.topic, "conversation");
  assert.equal(server.requests.length, 1);

  const healthy = createCloudFixtureServer();
  const healthyClient = clientFor(healthy).client;
  const page = await healthyClient.getTaskHistory(TASK_ID, { topic: "conversation" });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, "epoch-1:0");
});

test("profile 条目级开关与回显走冻结的 PATCH/GET 形状（14 §9.4①）", async () => {
  const server = createCloudFixtureServer();
  const { client } = clientFor(server);

  const toggled = await client.setUserProfileEntryEnabled("mcp", "primary", false);
  assert.equal(server.endpointIds[0], "patchUserProfileEntryEnabled");
  assert.equal(server.requests[0]?.method, "PATCH");
  assert.equal(server.requests[0]?.pathname, "/api/cloud/user-profile/entries/mcp/primary");
  // body 只含 enabled：toggle 不重发正文（重发会让 sha256 依赖客户端缓存）。
  assert.deepEqual(server.requests[0]?.body, { enabled: false });
  assert.equal(toggled.entry.enabled, true, "响应由服务端决定，SDK 不做本地乐观改写");
  assert.equal(toggled.profileVersion, 4);

  const read = await client.getUserProfileEntry("mcp", "primary");
  assert.equal(server.endpointIds[1], "readUserProfileEntry");
  assert.equal(server.requests[1]?.method, "GET");
  assert.equal(server.requests[1]?.pathname, "/api/cloud/user-profile/entries/mcp/primary");
  assert.equal(server.requests[1]?.body, undefined, "GET 不携带请求体");
  assert.equal(read.entry.entryId, "primary");
  assert.equal(read.payload.category, "mcp");

  // 本地形状违约（enabled 非布尔）在发出请求前拒绝，不把半合法 body 送到线上。
  const invalid = await client
    .setUserProfileEntryEnabled("mcp", "primary", "false" as never)
    .then(() => undefined)
    .catch((thrown: unknown) => thrown);
  assert.ok(isCloudApiError(invalid));
  assert.equal(invalid.code, "validation_failed");
  assert.equal(server.requests.length, 2);
});

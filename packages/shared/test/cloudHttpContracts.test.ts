// Cloud HTTP 请求契约与端点矩阵用例（specs/cloud-agent/03 §6/§6.1、11 §5/§6、
// 03 §7.1 通道分面）：round-trip、非法输入拒绝、矩阵/状态码/白名单一致性。
import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "../src/index.js";
import {
  CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS,
  CLOUD_ATTACHMENT_SERVICE_ALLOWLIST,
  CLOUD_ATTACHMENT_UPLOAD_FORM,
  CLOUD_ERROR_HTTP_STATUS,
  CLOUD_ERROR_HTTP_STATUS_DEFAULT,
  CLOUD_HTTP_ENDPOINTS,
  CLOUD_INPUT_LIMITS,
  CLOUD_SERVICE_CHANNEL_FACETS,
  CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS,
  CLOUD_WIRE_PROTOCOL_VERSION,
  capabilitiesResponseSchema,
  cloudCapabilitiesResponseSchema,
  cloudListQuerySchema,
  cloudRepositoriesQuerySchema,
  createCloudProjectRequestSchema,
  createLocalCapabilitiesResponse,
  findCloudHttpEndpoint,
  forceStopCloudTaskRequestSchema,
  isCloudAttachmentServiceAllowed,
  isSupportedCloudWireProtocolVersion,
  localCapabilitiesResponseSchema,
  patchCloudTaskRequestSchema,
  reopenCloudTaskRequestSchema,
  submitTaskInputSchema,
} from "../src/index.js";
import { COMMAND_ID, OPERATION_ID, PRINCIPAL_ID } from "./cloudFixtures.js";

const startInput = {
  intent: "start",
  commandId: COMMAND_ID,
  prompt: "实现一个示例变更",
  expectedTaskRevision: 0,
  start: { provider: "e2b", baseBranch: "main" },
} as const;

const appendInput = {
  intent: "append",
  commandId: COMMAND_ID,
  prompt: "继续处理测试失败",
  expectedRunGeneration: 1,
} as const;

test("submit input round-trip for start and append intents", () => {
  const start = submitTaskInputSchema.parse(startInput);
  assert.equal(start.intent, "start");
  assert.deepEqual(submitTaskInputSchema.parse(JSON.parse(JSON.stringify(start))), start);
  const append = submitTaskInputSchema.parse(appendInput);
  assert.equal(append.intent, "append");
});

test("submit input rejects intent/payload mismatches and oversized content", () => {
  // start 只属于 draft 首发，不能同时期待 run generation（03 §6）。
  assert.equal(
    submitTaskInputSchema.safeParse({ ...startInput, expectedRunGeneration: 1 }).success,
    false,
  );
  // append 必须绑定当前 generation，且不能携带启动选择。
  const { expectedRunGeneration: _generation, ...appendWithoutGeneration } = appendInput;
  assert.equal(submitTaskInputSchema.safeParse(appendWithoutGeneration).success, false);
  assert.equal(
    submitTaskInputSchema.safeParse({
      ...appendInput,
      start: { provider: "e2b", baseBranch: "main" },
    }).success,
    false,
  );
  assert.equal(submitTaskInputSchema.safeParse({ ...appendInput, unknownField: 1 }).success, false);
  assert.equal(submitTaskInputSchema.safeParse({ ...appendInput, prompt: "   " }).success, false);
  assert.equal(
    submitTaskInputSchema.safeParse({
      ...appendInput,
      prompt: "x".repeat(CLOUD_INPUT_LIMITS.promptMaxChars + 1),
    }).success,
    false,
  );
  assert.equal(
    submitTaskInputSchema.safeParse({
      ...appendInput,
      attachmentIds: Array.from(
        { length: CLOUD_INPUT_LIMITS.maxAttachmentIds + 1 },
        (_, index) => `attachment-${index}`,
      ),
    }).success,
    false,
  );
});

test("task/project request schemas keep revision CAS and reject client-controlled facts", () => {
  assert.equal(
    createCloudProjectRequestSchema.safeParse({ repositoryId: 42, owner: "attacker" }).success,
    false,
  );
  assert.equal(patchCloudTaskRequestSchema.safeParse({ expectedRevision: 1 }).success, false);
  assert.equal(
    patchCloudTaskRequestSchema.safeParse({ status: "completed", expectedRevision: 1 }).success,
    false,
  );
  assert.equal(
    patchCloudTaskRequestSchema.safeParse({ title: "新标题", expectedRevision: 2 }).success,
    true,
  );
  // reopen 必须显式声明恢复选择，不能由服务端静默重放旧输入（08 §9）。
  assert.equal(
    reopenCloudTaskRequestSchema.safeParse({
      commandId: COMMAND_ID,
      prompt: "继续",
      provider: "e2b",
      expectedTaskRevision: 1,
    }).success,
    false,
  );
  assert.equal(
    reopenCloudTaskRequestSchema.safeParse({
      commandId: COMMAND_ID,
      prompt: "继续",
      provider: "e2b",
      expectedTaskRevision: 1,
      resume: { mode: "restart-from-base" },
    }).success,
    true,
  );
  // force-stop 必须显式丢失确认（03 §6）。
  assert.equal(
    forceStopCloudTaskRequestSchema.safeParse({
      lossAcknowledgement: false,
      expectedRevision: 1,
      operationId: OPERATION_ID,
    }).success,
    false,
  );
});

test("query schemas bound pagination and cursors", () => {
  assert.equal(cloudListQuerySchema.safeParse({ limit: 0 }).success, false);
  assert.equal(cloudListQuerySchema.safeParse({ limit: 101 }).success, false);
  assert.equal(
    cloudRepositoriesQuerySchema.safeParse({ cursor: "ok", query: "zcode" }).success,
    true,
  );
  assert.equal(cloudRepositoriesQuerySchema.safeParse({ page: 1 }).success, false);
});

test("endpoint matrix is consistent and names resolvable schemas", () => {
  const ids = CLOUD_HTTP_ENDPOINTS.map((endpoint) => endpoint.id);
  assert.equal(new Set(ids).size, ids.length, "endpoint ids must be unique");
  for (const endpoint of CLOUD_HTTP_ENDPOINTS) {
    assert.match(endpoint.path, /^\/api\/cloud\//u);
    for (const name of [endpoint.request, endpoint.response]) {
      if (name === null) continue;
      assert.equal(
        typeof (shared as Record<string, unknown>)[name],
        "object",
        `${endpoint.id} references unknown schema ${name}`,
      );
    }
  }
  // 分阶段端点不得伪装成功（03 §6）。
  assert.equal(findCloudHttpEndpoint("repositories")?.availability, "not_configured");
  assert.equal(findCloudHttpEndpoint("taskEvents")?.availability, "not_implemented");
  assert.equal(findCloudHttpEndpoint("githubWebhook")?.availability, "not_implemented");
  assert.equal(findCloudHttpEndpoint("submitInput")?.response, "inputReceiptSchema");
  assert.equal(findCloudHttpEndpoint("taskDetail")?.response, "taskDetailResponseSchema");
});

test("error status mapping covers the frozen error catalogue", () => {
  for (const code of shared.CLOUD_ERROR_CODES) {
    assert.equal(
      typeof CLOUD_ERROR_HTTP_STATUS[code],
      "number",
      `error code ${code} must have an HTTP status`,
    );
  }
  assert.equal(CLOUD_ERROR_HTTP_STATUS.not_found, 404);
  assert.equal(CLOUD_ERROR_HTTP_STATUS.idempotency_conflict, 409);
  assert.equal(CLOUD_ERROR_HTTP_STATUS.not_implemented, 501);
  assert.equal(CLOUD_ERROR_HTTP_STATUS.not_configured, 503);
  assert.equal(CLOUD_ERROR_HTTP_STATUS_DEFAULT, 400);
});

test("service channel facets keep the two channels separate", () => {
  const host = CLOUD_SERVICE_CHANNEL_FACETS.host;
  const attachment = CLOUD_SERVICE_CHANNEL_FACETS.taskAttachment;
  assert.equal(host?.upgradePath, "/ws");
  assert.equal(attachment?.upgradePath, "/ws/cloud/tasks/:taskId");
  assert.ok(host?.domains.includes("oauth"));
  for (const denied of [
    "secret-read",
    "provider-provisioning-target",
    "main-native-operation",
    "host-local-workspace-fallback",
    "account-domain",
  ]) {
    assert.ok(attachment?.deniedCapabilities.includes(denied), `attachment must deny ${denied}`);
  }
  assert.ok(host?.deniedCapabilities.includes("cloud-task-execution-target"));
  assert.equal(CLOUD_SERVICE_CHANNEL_FACETS.bridge?.upgradePath, "/ws/cloud/bridge/:runId");
});

test("wire protocol version is single-sourced and fails closed on unknown versions", () => {
  assert.ok(
    (CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS as readonly number[]).includes(
      CLOUD_WIRE_PROTOCOL_VERSION,
    ),
  );
  assert.equal(isSupportedCloudWireProtocolVersion(CLOUD_WIRE_PROTOCOL_VERSION), true);
  assert.equal(isSupportedCloudWireProtocolVersion(CLOUD_WIRE_PROTOCOL_VERSION + 1), false);
  // capabilities 的协议版本引用同一来源：未知版本直接拒绝，不猜测解析。
  const capabilities = {
    mode: "cloud",
    principalId: PRINCIPAL_ID,
    providers: [],
    features: [],
    protocolVersion: CLOUD_WIRE_PROTOCOL_VERSION,
    taskOwnedAttachments: false,
  };
  assert.equal(capabilitiesResponseSchema.safeParse(capabilities).success, true);
  assert.equal(
    capabilitiesResponseSchema.safeParse({ ...capabilities, protocolVersion: 99 }).success,
    false,
  );
});

test("capabilities is a mode-discriminated union: local answers the probe without a principal", () => {
  // 04 §2.1（2026-10-07 修订）：模式判定服务端驱动——本地入口也必须回答同一个端点，
  // 否则客户端分不清「本地部署」与「不可达」。本地分支没有主体与能力，但保留云分支
  // 出现的所有非主体键（providers/features/protocolVersion/taskOwnedAttachments）。
  const local = createLocalCapabilitiesResponse();
  assert.deepEqual(local, {
    mode: "local",
    providers: [],
    features: [],
    protocolVersion: CLOUD_WIRE_PROTOCOL_VERSION,
    taskOwnedAttachments: false,
  });
  assert.equal(capabilitiesResponseSchema.safeParse(local).success, true);
  // 云分支仍要求主体：本地响应不能冒充云入口，云响应也不能漏发主体。
  assert.equal(cloudCapabilitiesResponseSchema.safeParse(local).success, false);
  assert.equal(
    cloudCapabilitiesResponseSchema.safeParse({
      ...local,
      mode: "cloud",
      principalId: PRINCIPAL_ID,
    }).success,
    true,
  );
  // 本地分支是空集语义与 strict 语义：塞主体/能力/未知字段一律拒绝，不靠忽略字段通过。
  assert.equal(
    localCapabilitiesResponseSchema.safeParse({ ...local, principalId: PRINCIPAL_ID }).success,
    false,
  );
  assert.equal(
    localCapabilitiesResponseSchema.safeParse({
      ...local,
      providers: [
        {
          provider: "e2b",
          createOperationLookup: "native-key",
          canInspect: true,
          canExtendDeadline: true,
          canConfirmTermination: true,
          deadlineSource: "provider",
          supportsOutboundWss: true,
        },
      ],
    }).success,
    false,
  );
  assert.equal(capabilitiesResponseSchema.safeParse({ ...local, mode: "bogus" }).success, false);
  // 协议版本只有一个来源：本地分支同样按支持集 fail-closed。
  assert.equal(
    capabilitiesResponseSchema.safeParse({ ...local, protocolVersion: 99 }).success,
    false,
  );
});

test("attachment allowlist reuses existing V4 channel names and never leaks account domain", () => {
  const known = new Set(Object.values(shared.ServiceChannels));
  for (const channel of CLOUD_ATTACHMENT_SERVICE_ALLOWLIST) {
    assert.ok(known.has(channel), `allowlist must use an existing V4 channel name: ${channel}`);
  }
  assert.equal(
    new Set(CLOUD_ATTACHMENT_SERVICE_ALLOWLIST).size,
    CLOUD_ATTACHMENT_SERVICE_ALLOWLIST.length,
  );
  for (const denied of CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS) {
    assert.ok(
      !(CLOUD_ATTACHMENT_SERVICE_ALLOWLIST as readonly string[]).includes(denied),
      `${denied} must not be exposed through the sandbox attachment`,
    );
  }
  assert.equal(isCloudAttachmentServiceAllowed(shared.ServiceChannels.File), true);
  assert.equal(isCloudAttachmentServiceAllowed(shared.ServiceChannels.Credential), false);
  assert.equal(
    isCloudAttachmentServiceAllowed(shared.ServiceChannels.ProviderProvisioningTarget),
    false,
  );
  // 分面的 domains 直接引用白名单，避免第二份服务清单漂移。
  assert.deepEqual(
    [...(CLOUD_SERVICE_CHANNEL_FACETS.taskAttachment?.domains ?? [])],
    [...CLOUD_ATTACHMENT_SERVICE_ALLOWLIST],
  );
});

test("attachment upload freezes the multipart field names", () => {
  assert.equal(CLOUD_ATTACHMENT_UPLOAD_FORM.contentType, "multipart/form-data");
  assert.equal(CLOUD_ATTACHMENT_UPLOAD_FORM.fileField, "file");
  assert.equal(CLOUD_ATTACHMENT_UPLOAD_FORM.taskIdField, "taskId");
  assert.equal(CLOUD_ATTACHMENT_UPLOAD_FORM.maxFiles, 1);
  assert.match(
    findCloudHttpEndpoint("uploadAttachment")?.note ?? "",
    /multipart\/form-data.*file.*taskId/u,
  );
  assert.equal(findCloudHttpEndpoint("uploadAttachment")?.request, null);
});

test("attachment and protocol error codes carry the frozen status and retryable semantics", () => {
  assert.equal(CLOUD_ERROR_HTTP_STATUS.attachment_unavailable, 503);
  assert.equal(shared.CLOUD_ERROR_RETRYABLE.attachment_unavailable, true);
  assert.equal(shared.isCloudErrorCode("attachment_unavailable"), true);
  // 非信封/非 JSON 响应（网关 502 HTML 等）归一为 protocol_incompatible（09 §8）。
  assert.equal(CLOUD_ERROR_HTTP_STATUS.protocol_incompatible, 409);
});

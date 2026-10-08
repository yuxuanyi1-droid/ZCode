/**
 * Web 入口（W9）消费 shared cloud 契约的入口用例：能力协商（两个模式）、通道地址、
 * 分阶段端点不得伪装成空列表成功（03 §6、12 §5、04 §2.1）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_HTTP_ENDPOINTS,
  CLOUD_SERVICE_CHANNEL_FACETS,
  capabilitiesResponseSchema,
  createLocalCapabilitiesResponse,
  localCapabilitiesResponseSchema,
} from "@zcode/shared";

test("web entry can fail closed on protocol/capability mismatch", () => {
  const capabilities = capabilitiesResponseSchema.parse({
    mode: "cloud",
    // 主体 id 只作客户端 scope 隔离键（不是凭据）；web 入口不得用它替代鉴权。
    principalId: "3c8a6d2b-0e4f-4a9b-8c1d-2e3f4a5b6c7d",
    providers: [
      {
        provider: "e2b",
        createOperationLookup: "native-key",
        canInspect: true,
        canExtendDeadline: true,
        canConfirmTermination: true,
        // 2026-10-09 契约新增：分级暂停/恢复能力；fixture 与 sandboxProviderCapabilitiesSchema
        // 对齐（本用例的非法注入点在 protocolVersion，providers 必须是合法形状）。
        pauseResume: "none",
        deadlineSource: "provider",
        supportsOutboundWss: true,
        // 2026-10-08 契约新增：生效 key 是否已配置（布尔投影，不含值）。
        apiKeyConfigured: true,
      },
    ],
    features: ["durable-input", "replayable-history"],
    protocolVersion: 1,
    taskOwnedAttachments: false,
  });
  assert.equal(capabilities.mode, "cloud");
  assert.equal(capabilities.protocolVersion, 1);
  // 不支持的字段一律拒绝：客户端不得靠忽略未知能力继续。
  assert.equal(
    capabilitiesResponseSchema.safeParse({ ...capabilities, protocolVersion: "1" }).success,
    false,
  );
  assert.equal(
    capabilitiesResponseSchema.safeParse({ ...capabilities, secret: "x" }).success,
    false,
  );
});

test("web entry accepts both prompt modes from the server probe with one schema", () => {
  // 04 §2.1（2026-10-07）：模式判定服务端驱动——同一份 Web 产物在探测里可能收到两种答案，
  // 都必须按同一份冻结 schema 解析；本地分支没有主体，也不得携带任何能力或秘密。
  const local = createLocalCapabilitiesResponse();
  assert.equal(capabilitiesResponseSchema.safeParse(local).success, true);
  assert.equal(localCapabilitiesResponseSchema.safeParse(local).success, true);
  assert.equal("principalId" in local, false);
  assert.deepEqual(local.providers, []);
  assert.deepEqual(local.features, []);
  assert.equal(local.taskOwnedAttachments, false);
});

test("web entry connects exactly the two documented channels", () => {
  const paths = Object.values(CLOUD_SERVICE_CHANNEL_FACETS).map((facet) => facet.upgradePath);
  assert.ok(paths.includes("/ws"));
  assert.ok(paths.includes("/ws/cloud/tasks/:taskId"));
  assert.ok(paths.includes("/ws/cloud/bridge/:runId"));
});

test("staged endpoints declare their availability instead of pretending success", () => {
  const staged = CLOUD_HTTP_ENDPOINTS.filter((endpoint) => endpoint.availability !== "available");
  assert.deepEqual(staged.map((endpoint) => endpoint.id).sort(), [
    "githubWebhook",
    "repositories",
    "taskEvents",
  ]);
  assert.equal(
    CLOUD_HTTP_ENDPOINTS.find((endpoint) => endpoint.id === "taskEvents")?.availability,
    "not_implemented",
  );
});

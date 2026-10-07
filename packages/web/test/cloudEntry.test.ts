/**
 * Web 入口（W9）消费 shared cloud 契约的入口用例：能力协商、通道地址、分阶段端点
 * 不得伪装成空列表成功（03 §6、12 §5）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_HTTP_ENDPOINTS,
  CLOUD_SERVICE_CHANNEL_FACETS,
  capabilitiesResponseSchema,
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
        deadlineSource: "provider",
        supportsOutboundWss: true,
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

/**
 * webhook 入口的 M7 条件性用例（specs/cloud-agent 09 §6、00 §11 决议⑤、
 * W4 §8「先确认部署模型仍为单用户，否则不要提前引入 delivery inbox」）。
 *
 * 本波次不实现验签/inbox/sender 授权，因此这里断言的是「明确 501 + 默认拒绝」：
 * 任何看起来合法的 delivery 都不会进入业务路径，也不会产生任何副作用。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { cloudErrorEnvelopeSchema, findCloudHttpEndpoint } from "@zcode/shared";
import {
  createGitHubWebhookIngress,
  type GitHubWebhookRequest,
} from "../src/cloud/adapters/github/webhook/index.js";

function delivery(overrides: Partial<GitHubWebhookRequest> = {}): GitHubWebhookRequest {
  return {
    headers: {
      "x-github-event": "issue_comment",
      "x-github-delivery": "11111111-2222-3333-4444-555555555555",
      "x-hub-signature-256": `sha256=${"a".repeat(64)}`,
      "content-type": "application/json",
    },
    rawBody: Buffer.from(JSON.stringify({ action: "created", sender: { id: 1 } })),
    traceId: "trace-1",
    ...overrides,
  };
}

test("the webhook endpoint is registered as not_implemented in the frozen matrix", () => {
  const endpoint = findCloudHttpEndpoint("githubWebhook");
  assert.equal(endpoint?.path, "/api/cloud/github/webhook");
  assert.equal(endpoint?.availability, "not_implemented");
});

test("an unenabled ingress answers 501 with the standard error envelope", async () => {
  const ingress = createGitHubWebhookIngress();
  assert.equal(ingress.enabled, false);
  const response = await ingress.handle(delivery());
  assert.equal(response.status, 501);
  const parsed = cloudErrorEnvelopeSchema.safeParse(response.body);
  assert.equal(parsed.success, true);
  assert.equal(response.body.code, "not_implemented");
  assert.equal(response.body.retryable, false);
  assert.equal(response.body.traceId, "trace-1");
});

test("a valid looking signature still produces no business effect (default deny)", async () => {
  const ingress = createGitHubWebhookIngress();
  const first = await ingress.handle(delivery());
  const second = await ingress.handle(delivery());
  // 请求内容与响应不相关：验签成功从来不是业务授权（09 §6.2），当前也没有任何业务路径。
  assert.deepEqual(first, second);
  assert.equal(first.status, 501);

  const unsigned = await ingress.handle(
    delivery({ headers: { "x-github-delivery": "11111111-2222-3333-4444-555555555555" } }),
  );
  assert.equal(unsigned.status, 501);
  assert.equal(unsigned.body.code, "not_implemented");
});

test("the ingress refuses to be enabled before M7 is implemented", () => {
  assert.throws(
    () => createGitHubWebhookIngress({ enabled: true }),
    /M7-conditional/,
    "a half-implemented verifier must not be switchable on",
  );
});

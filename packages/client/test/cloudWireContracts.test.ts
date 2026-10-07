/**
 * 客户端 SDK（W7）消费 shared cloud 契约的入口用例：端点覆盖、幂等与错误归一形状。
 * 只断言 SDK 依赖的 wire 事实，不复制 shared 的 schema 用例。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_HTTP_ENDPOINTS,
  cloudErrorEnvelopeSchema,
  inputReceiptSchema,
  type InputReceipt,
} from "@zcode/shared";

const SDK_ENDPOINT_IDS = [
  "capabilities",
  "repositories",
  "repositoryBranches",
  "listProjects",
  "createProject",
  "patchProject",
  "projectTasks",
  "createTask",
  "taskDetail",
  "patchTask",
  "submitInput",
  "listInputs",
  "getInput",
  "cancelInput",
  "reopenTask",
  "stopTask",
  "completeTask",
  "archiveTask",
  "taskHistory",
  "taskSnapshot",
  "uploadAttachment",
] as const;

test("SDK endpoint coverage is frozen in the shared matrix", () => {
  const ids = new Set(CLOUD_HTTP_ENDPOINTS.map((endpoint) => endpoint.id));
  for (const id of SDK_ENDPOINT_IDS) {
    assert.ok(ids.has(id), `SDK expects endpoint ${id} to be frozen`);
  }
  // 写操作必须显式声明请求体，SDK 不自行发明字段。
  for (const id of ["createTask", "submitInput", "reopenTask", "patchTask"] as const) {
    const endpoint = CLOUD_HTTP_ENDPOINTS.find((item) => item.id === id);
    assert.notEqual(endpoint?.request, null, `${id} must have a frozen request schema`);
  }
});

test("retry with the same commandId keeps receipt identity stable", () => {
  const first = inputReceiptSchema.parse({
    taskId: "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51",
    commandId: "2b7f5c1a-9d3e-4f8a-b1c2-d3e4f5a6b7c8",
    deliveryStatus: "accepted",
  });
  const retried: InputReceipt = inputReceiptSchema.parse(JSON.parse(JSON.stringify(first)));
  assert.equal(retried.commandId, first.commandId);
  // 202 接收不是 runtime 准入：accepted 与 admitted 是两个不同状态（02 §6）。
  assert.notEqual(retried.deliveryStatus, "admitted");
});

test("error envelope is enough to build typed errors without parsing text", () => {
  const envelope = cloudErrorEnvelopeSchema.parse({
    code: "stale",
    message: "run generation is no longer current",
    retryable: false,
    traceId: "trace-1",
  });
  assert.equal(envelope.retryable, false);
  assert.equal(typeof envelope.traceId, "string");
  // 文案不参与判定：改文案不影响 code/retryable。
  assert.equal(
    cloudErrorEnvelopeSchema.parse({ ...envelope, message: "另一个文案" }).code,
    envelope.code,
  );
});

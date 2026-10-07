/**
 * UI（W8）消费 shared cloud 投影的入口用例：状态全集、审批等待语义、通道分面边界。
 * UI 只从 hooks 读投影，不直连 Repo/Service（AGENTS「UI 与平台边界」）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_SERVICE_CHANNEL_FACETS,
  cloudExecutionStatusSchema,
  cloudTaskRecordSchema,
  cloudTaskStatusSchema,
  inputRecordPageSchema,
} from "@zcode/shared";

test("task/execution status enums cover exactly the states the UI renders", () => {
  assert.deepEqual(cloudTaskStatusSchema.options, [
    "draft",
    "active",
    "completed",
    "failed",
    "archived",
  ]);
  // 审批等待不是业务空闲：awaiting-input 必须与 idle/running 区分（08 §3.3）。
  assert.deepEqual(cloudExecutionStatusSchema.options, [
    "unknown",
    "idle",
    "running",
    "awaiting-input",
  ]);
});

test("UI reads task projections that never carry a client-controlled path", () => {
  const task = cloudTaskRecordSchema.parse({
    taskId: "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51",
    ownerPrincipalId: "3c8a6d2b-0e4f-4a9b-8c1d-2e3f4a5b6c7d",
    projectId: "4d9b7e3c-1f5a-4b0c-9d2e-3f4a5b6c7d8e",
    title: "示例任务",
    status: "active",
    creationKey: "creation-key-1",
    workspaceIdentity: "cloud-task:8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51",
    nextRunGeneration: 2,
    revision: 5,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_060_000,
  });
  assert.equal(task.workspaceIdentity, `cloud-task:${task.taskId}`);
  // 展示用 identity 不含路径：UI 不得从 identity 推导 cwd（08 §4.1）。
  assert.equal(task.workspaceIdentity.includes("/"), false);
  assert.equal(
    cloudTaskRecordSchema.safeParse({ ...task, workspacePath: "/tmp/ws" }).success,
    false,
  );
});

test("pagination envelope tells the UI when it reached the last page", () => {
  const page = inputRecordPageSchema.parse({ items: [] });
  assert.equal(page.nextCursor, undefined);
  assert.equal(inputRecordPageSchema.safeParse({ items: [], nextCursor: "" }).success, false);
});

test("attachment channel denies the capability families the UI must not offer", () => {
  const attachment = CLOUD_SERVICE_CHANNEL_FACETS.taskAttachment;
  assert.equal(attachment?.upgradePath, "/ws/cloud/tasks/:taskId");
  for (const denied of ["secret-read", "provider-provisioning-target", "main-native-operation"]) {
    assert.ok(attachment?.deniedCapabilities.includes(denied));
  }
  // 账号域只在 host 通道：UI 的登录/套餐/模型入口走 /ws。
  assert.ok(CLOUD_SERVICE_CHANNEL_FACETS.host?.domains.includes("oauth"));
  assert.equal(attachment?.deniedCapabilities.includes("account-domain"), true);
});

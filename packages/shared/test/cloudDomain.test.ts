// Cloud 领域状态与实体用例（specs/cloud-agent/08 §2/§3、00 §5）：
// round-trip、非法输入拒绝、未知状态值/未知字段拒绝。
import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudCheckpointRecordSchema,
  cloudRunRecordSchema,
  cloudTaskArtifactRecordSchema,
  cloudTaskInputRecordSchema,
  cloudTaskRecordSchema,
  cloudTaskStatusSchema,
  inputDeliveryStatusSchema,
} from "../src/index.js";
import {
  SHA1_HEX,
  TASK_WORKSPACE_IDENTITY,
  artifactFixture,
  checkpointFixture,
  inputRecordFixture,
  runRecordFixture,
  taskRecordFixture,
} from "./cloudFixtures.js";

test("domain round-trip: task/run/input/checkpoint/artifact survive JSON encoding", () => {
  const task = cloudTaskRecordSchema.parse(taskRecordFixture);
  assert.equal(task.workspaceIdentity, TASK_WORKSPACE_IDENTITY);
  assert.deepEqual(cloudTaskRecordSchema.parse(JSON.parse(JSON.stringify(task))), task);

  const run = cloudRunRecordSchema.parse(runRecordFixture);
  assert.deepEqual(cloudRunRecordSchema.parse(JSON.parse(JSON.stringify(run))), run);

  assert.deepEqual(cloudTaskInputRecordSchema.parse(inputRecordFixture).deliveryStatus, "accepted");
  assert.equal(cloudCheckpointRecordSchema.parse(checkpointFixture).confirmedRemoteSha, SHA1_HEX);
  assert.equal(cloudTaskArtifactRecordSchema.parse(artifactFixture).kind, "code");
});

test("domain rejects unknown fields and unknown state values", () => {
  assert.equal(
    cloudTaskRecordSchema.safeParse({ ...taskRecordFixture, status: "running" }).success,
    false,
  );
  assert.equal(
    cloudTaskRecordSchema.safeParse({ ...taskRecordFixture, unexpected: true }).success,
    false,
  );
  assert.equal(cloudTaskStatusSchema.safeParse("deleted").success, false);
  assert.equal(inputDeliveryStatusSchema.safeParse("completed").success, false);
});

test("domain keeps identity, provider and save evidence invariants", () => {
  // workspaceIdentity 必须与本任务 taskId 一致（08 §4.1）。
  assert.equal(
    cloudTaskRecordSchema.safeParse({
      ...taskRecordFixture,
      workspaceIdentity: `cloud-task:${"0".repeat(8)}-0000-0000-0000-000000000000`,
    }).success,
    false,
  );
  // sandbox run 必须有 provider（08 §2、§4.3：云侧只有沙箱执行）。
  const { provider: _provider, ...runWithoutProvider } = runRecordFixture;
  assert.equal(cloudRunRecordSchema.safeParse(runWithoutProvider).success, false);
  // saved 必须有远端 SHA 证据，不允许伪装 saved（08 §8.2）。
  const { confirmedRemoteSha: _sha, ...checkpointWithoutSha } = checkpointFixture;
  assert.equal(cloudCheckpointRecordSchema.safeParse(checkpointWithoutSha).success, false);
  // noChanges 产物必须带持久摘要，不创建空 PR（08 §9）。
  assert.equal(
    cloudTaskArtifactRecordSchema.safeParse({ taskId: taskRecordFixture.taskId, kind: "noChanges" })
      .success,
    false,
  );
});

test("domain input record rejects malformed fingerprint, ack and sequence", () => {
  // runtimeAck 复用既有 V4 commandAckSchema（03 §6 概念契约的括号说明），
  // 该 schema 自身的未知字段策略属 V4 契约，W0 不修改；此处断言取值非法时拒绝。
  assert.equal(
    cloudTaskInputRecordSchema.safeParse({
      ...inputRecordFixture,
      runtimeAck: { status: "not-a-status" },
    }).success,
    false,
  );
  assert.equal(
    cloudTaskInputRecordSchema.safeParse({ ...inputRecordFixture, payloadHash: "not-a-hash" })
      .success,
    false,
  );
  assert.equal(
    cloudTaskInputRecordSchema.safeParse({ ...inputRecordFixture, targetRunId: "not-a-uuid" })
      .success,
    false,
  );
  assert.equal(
    cloudTaskInputRecordSchema.safeParse({ ...inputRecordFixture, acceptanceSeq: 0 }).success,
    false,
  );
});

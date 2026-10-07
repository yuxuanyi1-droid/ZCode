// Cloud bridge 控制帧与投影记录用例（specs/cloud-agent/02 §4/§5/§7.1）：
// round-trip、非法输入拒绝、未知协议版本与未知帧类型拒绝、方向 fail-closed。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_BOOTSTRAP_ENVELOPE_JSON_MAX_CHARS,
  CLOUD_BRIDGE_PROTOCOL_VERSION,
  CLOUD_PROJECTION_BATCH_MAX_RECORDS,
  CLOUD_PROJECTION_PAYLOAD_MAX_JSON_CHARS,
  cloudAttachmentAddressSchema,
  cloudBridgeControlFrameSchema,
  cloudProjectionDedupKey,
  cloudProjectionRecordSchema,
  cloudRunAddressSchema,
  isCloudBridgeFrameInboundAllowed,
} from "../src/index.js";
import {
  OPERATION_ID,
  RUN_ID,
  SHA1_HEX,
  SHA256_HEX,
  TASK_ID,
  WORKSPACE_PATH,
  attachmentAddressFixture,
  projectionRecordFixture,
  runAddressFixture,
} from "./cloudFixtures.js";

const helloFrame = {
  protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
  type: "bridge.hello",
  address: runAddressFixture,
  helloAttemptId: "9a1c3e5f-7b9d-4f1a-8c3e-5f7a9b1d3e5f",
  credentialToken: "test-only-credential",
  candidateNextResumeToken: "test-only-candidate",
  runtimeIncarnation: "incarnation-1",
} as const;

test("bridge address round-trip and epoch takeover shape", () => {
  const address = cloudRunAddressSchema.parse(runAddressFixture);
  assert.deepEqual(address, runAddressFixture);
  const attachment = cloudAttachmentAddressSchema.parse(attachmentAddressFixture);
  assert.equal(attachment.connectionEpoch, 2);
  // address 不接受网络代际字段：connectionEpoch 只属于 attachment 地址（02 §4）。
  assert.equal(cloudRunAddressSchema.safeParse(attachmentAddressFixture).success, false);
  assert.equal(cloudAttachmentAddressSchema.safeParse({ ...runAddressFixture }).success, false);
});

test("control frame round-trip: hello / heartbeat / projection batch+ack", () => {
  const hello = cloudBridgeControlFrameSchema.parse(helloFrame);
  assert.equal(hello.type, "bridge.hello");
  assert.deepEqual(cloudBridgeControlFrameSchema.parse(JSON.parse(JSON.stringify(hello))), hello);

  const heartbeat = cloudBridgeControlFrameSchema.parse({
    protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
    type: "bridge.heartbeat",
    connectionEpoch: 2,
    processAlive: true,
    activitySummary: "idle",
    walHighWatermarks: [{ topic: "conversation", logEpoch: "epoch-1", sourceSeq: 7 }],
    sentAt: 1_760_000_000_000,
  });
  assert.equal(heartbeat.type, "bridge.heartbeat");

  const batch = cloudBridgeControlFrameSchema.parse({
    protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
    type: "projection.batch",
    connectionEpoch: 2,
    records: [projectionRecordFixture],
  });
  assert.equal(batch.type, "projection.batch");

  const ack = cloudBridgeControlFrameSchema.parse({
    protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
    type: "projection.ack",
    connectionEpoch: 2,
    topic: "conversation",
    logEpoch: "epoch-1",
    lastContiguousSourceSeq: 7,
    ingestCursor: "opaque-cursor-1",
  });
  assert.equal(ack.type, "projection.ack");
});

test("checkpoint frames round-trip and keep saved evidence strict", () => {
  // 请求：operationId 与 outbox operation 同键，幂等（02 §4、01 §8）。
  const request = cloudBridgeControlFrameSchema.parse({
    protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
    type: "checkpoint.request",
    operationId: OPERATION_ID,
    runId: RUN_ID,
    runGeneration: 1,
    connectionEpoch: 2,
    purpose: "stop",
  });
  assert.equal(request.type, "checkpoint.request");
  assert.deepEqual(
    cloudBridgeControlFrameSchema.parse(JSON.parse(JSON.stringify(request))),
    request,
  );

  // 结果：saved 必须带 remoteSha 证据，且形状为 git object id（08 §8.1/§8.2）。
  const result = cloudBridgeControlFrameSchema.parse({
    protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
    type: "checkpoint.result",
    operationId: OPERATION_ID,
    status: "saved",
    branch: "cloud/task-1",
    remoteSha: SHA1_HEX,
    hadNewCommits: false,
  });
  assert.equal(result.type, "checkpoint.result");
  assert.deepEqual(cloudBridgeControlFrameSchema.parse(JSON.parse(JSON.stringify(result))), result);

  // hadNewCommits 是 additive 字段：缺席合法，不得据缺席推断「有提交」。
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "checkpoint.result",
      operationId: OPERATION_ID,
      status: "failed",
      errorCode: "checkpoint_failed",
      error: "push rejected",
    }).success,
    true,
  );

  // 无 remoteSha 的 saved 一律拒绝：不伪造保存事实。
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "checkpoint.result",
      operationId: OPERATION_ID,
      status: "saved",
      branch: "cloud/task-1",
    }).success,
    false,
  );
  // 非 git object id 的 remoteSha 拒绝。
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "checkpoint.result",
      operationId: OPERATION_ID,
      status: "saved",
      remoteSha: "not-a-sha",
    }).success,
    false,
  );
  // 未知版本与未知字段整帧拒绝。
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      protocolVersion: 2,
      type: "checkpoint.request",
      operationId: OPERATION_ID,
      runId: RUN_ID,
      runGeneration: 1,
      connectionEpoch: 2,
      purpose: "stop",
    }).success,
    false,
  );
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "checkpoint.request",
      operationId: OPERATION_ID,
      runId: RUN_ID,
      runGeneration: 1,
      connectionEpoch: 2,
      purpose: "reclaim",
    }).success,
    false,
  );
});

test("bootstrap.config carries clone facts and the provisioning envelope on the authenticated channel", () => {
  const frame = cloudBridgeControlFrameSchema.parse({
    protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
    type: "bootstrap.config",
    taskId: TASK_ID,
    workspacePath: WORKSPACE_PATH,
    clone: {
      repositoryId: 42,
      repositoryFullName: "example/repo",
      baseSha: SHA1_HEX,
      taskBranch: "cloud/example",
    },
    provisioningEnvelopeJson: JSON.stringify({ provider: "example", credentials: ["account"] }),
    credentialGeneration: 3,
    policyVersion: "policy-1",
  });
  assert.equal(frame.type, "bootstrap.config");
  assert.deepEqual(cloudBridgeControlFrameSchema.parse(JSON.parse(JSON.stringify(frame))), frame);

  // 未知版本 / 未知字段 / 未知 clone 字段整帧拒绝（02 §4 尾段）。
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({ ...frame, protocolVersion: 2 }).success,
    false,
  );
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({ ...frame, injected: true }).success,
    false,
  );
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      ...frame,
      clone: { ...frame.clone, sshTargetRef: "retired" },
    }).success,
    false,
  );
  // 非绝对 workspacePath、非 git object id 的 baseSha、越界 envelope 一律拒绝。
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({ ...frame, workspacePath: "relative/path" }).success,
    false,
  );
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      ...frame,
      clone: { ...frame.clone, baseSha: "not-a-sha" },
    }).success,
    false,
  );
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      ...frame,
      provisioningEnvelopeJson: "x".repeat(CLOUD_BOOTSTRAP_ENVELOPE_JSON_MAX_CHARS + 1),
    }).success,
    false,
  );
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({ ...frame, provisioningEnvelopeJson: "" }).success,
    false,
  );
  // 代际不得为负：credentialGeneration 供 A-08 核对（12 §6）。
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({ ...frame, credentialGeneration: -1 }).success,
    false,
  );
  // 方向：控制面 → bridge 单向。
  assert.equal(isCloudBridgeFrameInboundAllowed("bootstrap.config", "bridge"), true);
  assert.equal(isCloudBridgeFrameInboundAllowed("bootstrap.config", "control-plane"), false);
});

test("control frames reject unknown protocol version, unknown type and unknown fields", () => {
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({ ...helloFrame, protocolVersion: 2 }).success,
    false,
  );
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({ ...helloFrame, type: "bridge.unknown" }).success,
    false,
  );
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({ ...helloFrame, injected: true }).success,
    false,
  );
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "projection.batch",
      connectionEpoch: 2,
      records: [],
    }).success,
    false,
  );
  const tooManyRecords = Array.from({ length: CLOUD_PROJECTION_BATCH_MAX_RECORDS + 1 }, () => ({
    ...projectionRecordFixture,
  }));
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "projection.batch",
      connectionEpoch: 2,
      records: tooManyRecords,
    }).success,
    false,
  );
});

test("projection records bound the payload and freeze the dedup key", () => {
  const record = cloudProjectionRecordSchema.parse(projectionRecordFixture);
  assert.equal(
    cloudProjectionDedupKey(record),
    [RUN_ID, "incarnation-1", "conversation", "epoch-1", 7].join("\u0000"),
  );
  // payload 必须是合法 JSON：函数/undefined 不属于 wire（不得用 unknown 兜业务字段）。
  assert.equal(
    cloudProjectionRecordSchema.safeParse({ ...projectionRecordFixture, payload: undefined })
      .success,
    false,
  );
  const oversized = "x".repeat(CLOUD_PROJECTION_PAYLOAD_MAX_JSON_CHARS + 1);
  assert.equal(
    cloudProjectionRecordSchema.safeParse({ ...projectionRecordFixture, payload: oversized })
      .success,
    false,
  );
  assert.equal(
    cloudProjectionRecordSchema.safeParse({ ...projectionRecordFixture, contentHash: "short" })
      .success,
    false,
  );
  assert.equal(
    cloudProjectionRecordSchema.safeParse({ ...projectionRecordFixture, schemaVersion: 2 }).success,
    false,
  );
  assert.equal(
    cloudProjectionRecordSchema.safeParse({ ...projectionRecordFixture, taskId: SHA256_HEX })
      .success,
    false,
  );
});

test("frame direction is fail-closed per receiver", () => {
  // welcome 是控制面 → bridge，不能从 bridge 入站（02 §4）。
  assert.equal(isCloudBridgeFrameInboundAllowed("bridge.welcome", "bridge"), true);
  assert.equal(isCloudBridgeFrameInboundAllowed("bridge.welcome", "control-plane"), false);
  assert.equal(isCloudBridgeFrameInboundAllowed("bridge.hello", "control-plane"), true);
  assert.equal(isCloudBridgeFrameInboundAllowed("bridge.hello", "bridge"), false);
  assert.equal(isCloudBridgeFrameInboundAllowed("projection.ack", "bridge"), true);
  assert.equal(isCloudBridgeFrameInboundAllowed("projection.ack", "control-plane"), false);
  // fault/drain 按 02 §4 帧表为双向。
  assert.equal(isCloudBridgeFrameInboundAllowed("bridge.fault", "control-plane"), true);
  assert.equal(isCloudBridgeFrameInboundAllowed("bridge.drain", "bridge"), true);
  // checkpoint 通路各取单向（02 §4）。
  assert.equal(isCloudBridgeFrameInboundAllowed("checkpoint.request", "bridge"), true);
  assert.equal(isCloudBridgeFrameInboundAllowed("checkpoint.request", "control-plane"), false);
  assert.equal(isCloudBridgeFrameInboundAllowed("checkpoint.result", "control-plane"), true);
  assert.equal(isCloudBridgeFrameInboundAllowed("checkpoint.result", "bridge"), false);
});

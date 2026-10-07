// Cloud HTTP 响应信封用例（specs/cloud-agent/03 §6 错误信封与分页信封、02 §7.3）：
// round-trip、未知 code/未知字段拒绝、尺寸上限拒绝。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_ERROR_DETAILS_MAX_JSON_CHARS,
  cloudErrorEnvelopeSchema,
  cloudHistoryPageSchema,
  cloudMetadataEventSchema,
  cloudTaskEventsResponseSchema,
  inputRecordPageSchema,
  inputReceiptSchema,
  taskDetailResponseSchema,
} from "../src/index.js";
import {
  COMMAND_ID,
  RUN_ID,
  TASK_ID,
  checkpointFixture,
  historyItemFixture,
  inputRecordFixture,
  runRecordFixture,
  taskRecordFixture,
} from "./cloudFixtures.js";

test("response envelopes round-trip", () => {
  const error = cloudErrorEnvelopeSchema.parse({
    code: "recovery_required",
    message: "旧 run 未被确认终止，无法自动重开",
    retryable: false,
    traceId: "trace-1",
    details: { runGeneration: 1 },
  });
  assert.deepEqual(cloudErrorEnvelopeSchema.parse(JSON.parse(JSON.stringify(error))), error);

  const detail = taskDetailResponseSchema.parse({
    task: taskRecordFixture,
    activeRun: runRecordFixture,
    execution: { status: "idle", observedAt: 1_760_000_000_000 },
    latestCheckpoint: checkpointFixture,
    // 服务端裁决的能力投影；客户端只用于呈现与门控（04 §3.3）。
    actions: ["send-input", "stop", "complete", "archive"],
  });
  assert.deepEqual(taskDetailResponseSchema.parse(JSON.parse(JSON.stringify(detail))), detail);

  const receipt = inputReceiptSchema.parse({
    taskId: TASK_ID,
    commandId: COMMAND_ID,
    deliveryStatus: "accepted",
  });
  assert.deepEqual(inputReceiptSchema.parse(JSON.parse(JSON.stringify(receipt))), receipt);

  const page = inputRecordPageSchema.parse({ items: [inputRecordFixture] });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, undefined);

  const history = cloudHistoryPageSchema.parse({
    items: [historyItemFixture],
    nextCursor: "epoch-1:7",
  });
  assert.equal(history.nextCursor, "epoch-1:7");

  const events = cloudTaskEventsResponseSchema.parse({ items: [], timedOut: true });
  assert.equal(events.timedOut, true);

  const metadata = cloudMetadataEventSchema.parse({
    kind: "run.changed",
    entityId: RUN_ID,
    revision: 4,
    at: 1_760_000_000_000,
  });
  assert.equal(metadata.kind, "run.changed");
});

test("task detail actions are a closed enum derived by the server", () => {
  // 缺 actions 即拒绝：客户端不得回退到自行推导动作表（04 §3.3）。
  assert.equal(taskDetailResponseSchema.safeParse({ task: taskRecordFixture }).success, false);
  assert.equal(
    taskDetailResponseSchema.safeParse({ task: taskRecordFixture, actions: ["stop", "reopen"] })
      .success,
    true,
  );
  assert.equal(
    taskDetailResponseSchema.safeParse({ task: taskRecordFixture, actions: [] }).success,
    true,
  );
  assert.equal(
    taskDetailResponseSchema.safeParse({ task: taskRecordFixture, actions: ["launch"] }).success,
    false,
  );
});

test("response envelopes reject unknown codes, unknown fields and bad cursors", () => {
  assert.equal(
    cloudErrorEnvelopeSchema.safeParse({
      code: "not_a_code",
      message: "x",
      retryable: false,
      traceId: "t",
    }).success,
    false,
  );
  assert.equal(
    cloudErrorEnvelopeSchema.safeParse({
      code: "not_found",
      message: "x",
      retryable: false,
      traceId: "t",
      leaked: "token",
    }).success,
    false,
  );
  assert.equal(inputRecordPageSchema.safeParse({ items: [], nextCursor: "" }).success, false);
  assert.equal(
    inputRecordPageSchema.safeParse({ items: [], nextCursor: "a".repeat(600) }).success,
    false,
  );
  assert.equal(
    cloudHistoryPageSchema.safeParse({ items: [], nextCursor: "not-a-cursor" }).success,
    false,
  );
  assert.equal(
    taskDetailResponseSchema.safeParse({ task: taskRecordFixture, unexpected: 1 }).success,
    false,
  );
  assert.equal(
    taskDetailResponseSchema.safeParse({ task: { ...taskRecordFixture, status: "unknown" } })
      .success,
    false,
  );
  assert.equal(
    cloudMetadataEventSchema.safeParse({
      kind: "task.changed",
      entityId: TASK_ID,
      revision: 1,
      at: 1,
      payload: {},
    }).success,
    false,
  );
});

test("error details are bounded JSON", () => {
  assert.equal(
    cloudErrorEnvelopeSchema.safeParse({
      code: "validation_failed",
      message: "x",
      retryable: false,
      traceId: "t",
      details: { prompt: "x".repeat(CLOUD_ERROR_DETAILS_MAX_JSON_CHARS + 1) },
    }).success,
    false,
  );
  assert.equal(
    cloudErrorEnvelopeSchema.safeParse({
      code: "validation_failed",
      message: "x",
      retryable: false,
      traceId: "t",
      details: { attempt: 1 },
    }).success,
    true,
  );
});

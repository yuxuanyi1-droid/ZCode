/**
 * 交互决定持久化验收（02 §6.3、03 §4、04 §3.4.1；`InteractionDecisionRepo` 端口）。
 *
 * 断言：决定载荷与 fingerprint 一起持久（dispatcher 崩溃/重启后据此重建投递内容）；
 * 同键返回既有记录且不覆盖载荷（调用方比对 hash 后拒绝不同内容）；投递状态迁移只允许
 * 前进；取消走独立 cancelCommandId，不把原决定伪造成 cancelled。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS } from "../src/cloud/app/ports/inputPort.js";
import {
  newUuid,
  openTestStorage,
  removeTestRoot,
  seedDraftTask,
  type SeededTask,
  type TestStorageHandle,
} from "./cloudStorageHarness.js";
import { isCloudStorageError } from "../src/cloud/adapters/storage/cloudStorageError.js";

function hashOf(payloadJson: string): string {
  return createHash("sha256").update(payloadJson).digest("hex");
}

async function withTask(
  body: (context: { handle: TestStorageHandle; seeded: SeededTask }) => Promise<void>,
): Promise<void> {
  const handle = await openTestStorage();
  try {
    const seeded = await seedDraftTask(handle.storage);
    await body({ handle, seeded });
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
}

test("决定载荷与 fingerprint 一起持久，重开后仍可重建投递内容", async () => {
  const handle = await openTestStorage();
  const seeded = await seedDraftTask(handle.storage);
  const payloadJson = JSON.stringify({ optionId: "allow-once", sessionId: "sess-1" });
  const interactionId = newUuid();
  const runId = newUuid();
  try {
    const recorded = await handle.storage.interactions.recordDecision({
      taskId: seeded.taskId,
      interactionId,
      deliveryCommandId: newUuid(),
      runId,
      runGeneration: 1,
      kind: "permission",
      payloadJson,
      payloadHash: hashOf(payloadJson),
    });
    assert.equal(recorded.payloadJson, payloadJson);
    assert.equal(recorded.deliveryStatus, "accepted");
    assert.ok(recorded.recordedAt > 0);
    await handle.close();

    const reopened = await openTestStorage({ root: handle.root });
    try {
      const rebuilt = await reopened.storage.interactions.getDecision(seeded.taskId, interactionId);
      assert.equal(rebuilt?.payloadJson, payloadJson, "崩溃/重启后必须能重建投递正文");
      assert.equal(rebuilt?.kind, "permission");
      assert.equal(rebuilt?.runId, runId, "run 绑定随记录持久");
      assert.equal(rebuilt?.runGeneration, 1);
    } finally {
      await reopened.close();
    }
  } finally {
    await handle.close().catch(() => undefined);
    await removeTestRoot(handle.root);
  }
});

test("同键返回既有记录且不覆盖载荷：调用方可据 payloadHash 识别冲突", async () => {
  await withTask(async ({ handle, seeded }) => {
    const interactionId = newUuid();
    const payloadJson = JSON.stringify({ optionId: "deny" });
    const first = await handle.storage.interactions.recordDecision({
      taskId: seeded.taskId,
      interactionId,
      deliveryCommandId: newUuid(),
      kind: "elicitation",
      payloadJson,
      payloadHash: hashOf(payloadJson),
    });

    const replay = await handle.storage.interactions.recordDecision({
      taskId: seeded.taskId,
      interactionId,
      deliveryCommandId: newUuid(),
      kind: "elicitation",
      payloadJson,
      payloadHash: hashOf(payloadJson),
    });
    assert.deepEqual(replay, first, "同键同内容幂等返回既有记录");

    const otherPayload = JSON.stringify({ optionId: "allow-always" });
    const mismatched = await handle.storage.interactions.recordDecision({
      taskId: seeded.taskId,
      interactionId,
      deliveryCommandId: newUuid(),
      kind: "elicitation",
      payloadJson: otherPayload,
      payloadHash: hashOf(otherPayload),
    });
    assert.equal(
      mismatched.payloadHash,
      first.payloadHash,
      "仓储不覆盖既有载荷：调用方比对到 hash 不一致即拒绝（端口口径）",
    );
    assert.equal(mismatched.payloadJson, payloadJson);
    const stored = await handle.storage.interactions.getDecision(seeded.taskId, interactionId);
    assert.equal(stored?.payloadHash, hashOf(payloadJson));
  });
});

test("载荷有界且必须是合法 JSON，超限/非 JSON 在写库前拒绝", async () => {
  await withTask(async ({ handle, seeded }) => {
    const oversized = JSON.stringify({
      blob: "x".repeat(CLOUD_INTERACTION_DECISION_PAYLOAD_MAX_CHARS),
    });
    await assert.rejects(
      handle.storage.interactions.recordDecision({
        taskId: seeded.taskId,
        interactionId: newUuid(),
        deliveryCommandId: newUuid(),
        kind: "permission",
        payloadJson: oversized,
        payloadHash: hashOf(oversized),
      }),
      (error: unknown) => isCloudStorageError(error) && error.code === "validation_failed",
    );
    await assert.rejects(
      handle.storage.interactions.recordDecision({
        taskId: seeded.taskId,
        interactionId: newUuid(),
        deliveryCommandId: newUuid(),
        kind: "permission",
        payloadJson: "{not-json",
        payloadHash: hashOf("{not-json"),
      }),
      (error: unknown) => isCloudStorageError(error) && error.code === "validation_failed",
    );
    assert.equal(await handle.storage.interactions.getDecision(seeded.taskId, newUuid()), null);
  });
});

test("投递状态迁移只允许前进，同状态幂等", async () => {
  await withTask(async ({ handle, seeded }) => {
    const interactionId = newUuid();
    const payloadJson = JSON.stringify({ optionId: "allow" });
    await handle.storage.interactions.recordDecision({
      taskId: seeded.taskId,
      interactionId,
      deliveryCommandId: newUuid(),
      kind: "permission",
      payloadJson,
      payloadHash: hashOf(payloadJson),
    });

    const delivering = await handle.storage.interactions.setDecisionDeliveryStatus({
      taskId: seeded.taskId,
      interactionId,
      status: "delivering",
    });
    assert.equal(delivering?.deliveryStatus, "delivering");
    assert.equal(
      (
        await handle.storage.interactions.setDecisionDeliveryStatus({
          taskId: seeded.taskId,
          interactionId,
          status: "delivering",
        })
      )?.deliveryStatus,
      "delivering",
      "同状态重复写入幂等",
    );
    const admitted = await handle.storage.interactions.setDecisionDeliveryStatus({
      taskId: seeded.taskId,
      interactionId,
      status: "admitted",
    });
    assert.equal(admitted?.deliveryStatus, "admitted");
    assert.equal(
      await handle.storage.interactions.setDecisionDeliveryStatus({
        taskId: seeded.taskId,
        interactionId,
        status: "delivering",
      }),
      null,
      "admitted 后不得回退",
    );
    const withError = await handle.storage.interactions.setDecisionDeliveryStatus({
      taskId: seeded.taskId,
      interactionId,
      status: "admitted",
      lastError: "runtime 拒绝",
    });
    assert.equal(withError?.lastError, "runtime 拒绝", "同状态可更新错误事实");
    assert.equal(
      await handle.storage.interactions.setDecisionDeliveryStatus({
        taskId: seeded.taskId,
        interactionId: newUuid(),
        status: "delivering",
      }),
      null,
      "不存在的决定不得伪造状态",
    );
  });
});

test("取消走独立 cancelCommandId，不把原决定伪造成 cancelled", async () => {
  await withTask(async ({ handle, seeded }) => {
    const interactionId = newUuid();
    const commandId = newUuid();
    const cancelCommandId = newUuid();
    const payloadJson = JSON.stringify({ optionId: "allow-once" });
    await handle.storage.interactions.recordDecision({
      taskId: seeded.taskId,
      interactionId,
      deliveryCommandId: newUuid(),
      kind: "permission",
      payloadJson,
      payloadHash: hashOf(payloadJson),
    });

    assert.equal(await handle.storage.interactions.getCancelIntent(seeded.taskId, commandId), null);
    const intent = await handle.storage.interactions.recordCancelIntent({
      taskId: seeded.taskId,
      commandId,
      cancelCommandId,
    });
    assert.equal(intent.cancelCommandId, cancelCommandId);
    assert.ok(intent.recordedAt > 0);

    // 重复记录（含换一个 cancelCommandId 的迟到重试）返回既有意图：一个命令只有一次
    // 取消意向，调用方据返回的 cancelCommandId 对账（端口口径）。
    const retry = await handle.storage.interactions.recordCancelIntent({
      taskId: seeded.taskId,
      commandId,
      cancelCommandId: newUuid(),
    });
    assert.equal(retry.cancelCommandId, cancelCommandId);
    assert.equal(retry.recordedAt, intent.recordedAt);
    const stored = await handle.storage.interactions.getCancelIntent(seeded.taskId, commandId);
    assert.equal(stored?.cancelCommandId, cancelCommandId);

    // 取消是独立事实：原决定仍是 accepted，不被伪造成 cancelled。
    const decision = await handle.storage.interactions.getDecision(seeded.taskId, interactionId);
    assert.equal(decision?.deliveryStatus, "accepted");
  });
});

test("deliveryCommandId 随决定持久，可按它反查；查不到返回 null", async () => {
  await withTask(async ({ handle, seeded }) => {
    const interactionId = newUuid();
    const deliveryCommandId = newUuid();
    const payloadJson = JSON.stringify({ optionId: "allow-once" });
    const recorded = await handle.storage.interactions.recordDecision({
      taskId: seeded.taskId,
      interactionId,
      deliveryCommandId,
      kind: "permission",
      payloadJson,
      payloadHash: hashOf(payloadJson),
    });
    assert.equal(recorded.deliveryCommandId, deliveryCommandId);

    const found = await handle.storage.interactions.findDecisionByDeliveryCommandId(
      seeded.taskId,
      deliveryCommandId,
    );
    assert.equal(found?.interactionId, interactionId, "按投递命令键反查命中同一决定");
    assert.equal(found?.payloadJson, payloadJson);

    // 查不到是正常对账结论，不抛错。
    assert.equal(
      await handle.storage.interactions.findDecisionByDeliveryCommandId(seeded.taskId, newUuid()),
      null,
    );
  });
});

test("(task_id, delivery_command_id) 唯一冲突拒绝，且与 interactionId 唯一互不干扰", async () => {
  await withTask(async ({ handle, seeded }) => {
    const sharedCommandId = newUuid();
    const firstInteraction = newUuid();
    await handle.storage.interactions.recordDecision({
      taskId: seeded.taskId,
      interactionId: firstInteraction,
      deliveryCommandId: sharedCommandId,
      kind: "permission",
      payloadJson: JSON.stringify({ optionId: "allow" }),
      payloadHash: hashOf(JSON.stringify({ optionId: "allow" })),
    });

    // 同一 Task 内复用投递 commandId：结构化拒绝，不静默改绑。
    await assert.rejects(
      handle.storage.interactions.recordDecision({
        taskId: seeded.taskId,
        interactionId: newUuid(),
        deliveryCommandId: sharedCommandId,
        kind: "permission",
        payloadJson: JSON.stringify({ optionId: "deny" }),
        payloadHash: hashOf(JSON.stringify({ optionId: "deny" })),
      }),
      (error: unknown) => isCloudStorageError(error) && error.code === "validation_failed",
    );
    assert.equal(
      (
        await handle.storage.interactions.findDecisionByDeliveryCommandId(
          seeded.taskId,
          sharedCommandId,
        )
      )?.interactionId,
      firstInteraction,
      "冲突不得改绑既有决定",
    );

    // 另一个决定使用不同 commandId：两条唯一约束并存，互不干扰。
    const secondCommandId = newUuid();
    const second = await handle.storage.interactions.recordDecision({
      taskId: seeded.taskId,
      interactionId: newUuid(),
      deliveryCommandId: secondCommandId,
      kind: "elicitation",
      payloadJson: JSON.stringify({ action: "accept" }),
      payloadHash: hashOf(JSON.stringify({ action: "accept" })),
    });
    assert.equal(second.deliveryCommandId, secondCommandId);
    assert.equal(
      (await handle.storage.interactions.getDecision(seeded.taskId, firstInteraction))
        ?.deliveryCommandId,
      sharedCommandId,
      "按 interactionId 的查询不受另一决定影响",
    );
  });
});

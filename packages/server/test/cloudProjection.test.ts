/**
 * W1 投影通路测试（02 §7.1/§7.2/§7.3 的 durable ingest、缺口、快照与恢复）。
 * 只驱动 app 服务与端口 fake；不 sleep、不触网。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudProjectionRecord, ProjectionBatchFrame } from "@zcode/shared";
import { attachReadySession, buildTestPlane } from "./cloudCoreFakes.js";
import {
  CANONICAL_TOPIC,
  decideResume,
  PROJECTION_RETENTION_MS,
} from "../src/cloud/app/projections/history.js";

const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";

function record(overrides: Partial<CloudProjectionRecord> = {}): CloudProjectionRecord {
  return {
    schemaVersion: 1,
    taskId: "00000000-0000-4000-8000-000000000001",
    runId: "00000000-0000-4000-8000-000000000002",
    runGeneration: 1,
    runtimeIncarnation: "incarnation-1",
    topic: CANONICAL_TOPIC,
    logEpoch: "epoch-1",
    sourceSeq: 0,
    kind: "delta",
    payload: { text: "hello" },
    contentHash: "a".repeat(64),
    ...overrides,
  };
}

function batch(records: CloudProjectionRecord[], connectionEpoch = 1): ProjectionBatchFrame {
  return { protocolVersion: 1, type: "projection.batch", connectionEpoch, records };
}

/** 造出「已接纳 + create 完成、run 仍在 provisioning」的现场（真 create 通路，签发 clone grant）。 */
async function seedTaskWithProvisioningRun(context: ReturnType<typeof buildTestPlane>) {
  const project = await context.plane.tasks.createProject({
    principalId: PRINCIPAL,
    repositoryId: 101,
  });
  assert.ok(project.ok);
  const task = await context.plane.tasks.createTask({
    principalId: PRINCIPAL,
    projectId: project.value.projectId,
    title: "Investigate flake",
    creationKey: "ck-projection",
    draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
  });
  assert.ok(task.ok);
  const submit = await context.plane.inputs.submit({
    principalId: PRINCIPAL,
    taskId: task.value.taskId,
    source: "http",
    request: {
      intent: "start",
      commandId: "00000000-0000-4000-8000-000000000201",
      prompt: "go",
      expectedTaskRevision: task.value.revision,
      start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    },
  });
  assert.ok(submit.ok);
  const runId = submit.value.runId ?? "";
  await context.plane.provisioning.create.runCreateOnce();
  const run = await context.storage.runs.get(runId);
  assert.ok(run);
  return {
    taskId: task.value.taskId,
    runId,
    runGeneration: run.runGeneration,
    epoch: run.connectionEpoch,
  };
}

async function seedTaskWithReadyRun(context: ReturnType<typeof buildTestPlane>) {
  const session = await seedTaskWithProvisioningRun(context);
  await attachReadySession(context, {
    taskId: session.taskId,
    runId: session.runId,
    runGeneration: session.runGeneration,
  });
  await context.plane.runs.markReady({
    taskId: session.taskId,
    runId: session.runId,
    runGeneration: session.runGeneration,
    connectionEpoch: session.epoch,
  });
  return session;
}

test("投影 ingest：提交成功才回连续性水位，重复批次幂等（02 §7.1/§7.2）", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  const records = [
    record({ runId: session.runId, taskId: session.taskId, sourceSeq: 0 }),
    record({
      runId: session.runId,
      taskId: session.taskId,
      sourceSeq: 1,
      payload: { text: "world" },
    }),
  ];
  const first = await context.plane.projections.ingest.ingestProjectionBatch(
    batch(records, session.epoch),
  );
  assert.equal(first.accepted, 2);
  assert.deepEqual(first.cursors, [{ topic: CANONICAL_TOPIC, logEpoch: "epoch-1", sourceSeq: 1 }]);
  assert.equal(first.conflicts.length, 0);
  assert.equal(first.expectedSourceSeq, undefined);

  const replay = await context.plane.projections.ingest.ingestProjectionBatch(
    batch(records, session.epoch),
  );
  assert.equal(replay.accepted, 0, "同键同内容幂等");
  assert.equal(replay.cursors[0]?.sourceSeq, 1, "重投返回原水位");
});

test("投影 ingest：同键不同 contentHash 报一致性 fault，不覆盖（02 §7.1）", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  await context.plane.projections.ingest.ingestProjectionBatch(
    batch([record({ runId: session.runId, taskId: session.taskId, sourceSeq: 0 })], session.epoch),
  );
  const conflict = await context.plane.projections.ingest.ingestProjectionBatch(
    batch(
      [
        record({
          runId: session.runId,
          taskId: session.taskId,
          sourceSeq: 0,
          contentHash: "b".repeat(64),
          payload: { text: "tampered" },
        }),
      ],
      session.epoch,
    ),
  );
  assert.equal(conflict.accepted, 0);
  assert.equal(conflict.conflicts.length, 1);
  assert.equal(conflict.conflicts[0]?.sourceSeq, 0);
});

test("投影 ingest：缺口返回期望 sourceSeq，不跳跃确认（02 §7.1）", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  await context.plane.projections.ingest.ingestProjectionBatch(
    batch([record({ runId: session.runId, taskId: session.taskId, sourceSeq: 0 })], session.epoch),
  );
  const gap = await context.plane.projections.ingest.ingestProjectionBatch(
    batch(
      [
        record({
          runId: session.runId,
          taskId: session.taskId,
          sourceSeq: 3,
          payload: { text: "gap" },
        }),
      ],
      session.epoch,
    ),
  );
  assert.deepEqual(gap.expectedSourceSeq, {
    topic: CANONICAL_TOPIC,
    logEpoch: "epoch-1",
    expectedSourceSeq: 1,
  });
  assert.equal(gap.cursors[0]?.sourceSeq, 0, "水位停在缺口之前");
});

test("投影 ingest：旧 attachment epoch 的批次整批拒绝，不落库不回 ACK（02 §2 不变量 3）", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  context.plane.attachments.register({
    ...(context.plane.attachments.current(session.runId) ?? {
      taskId: session.taskId,
      runId: session.runId,
      runGeneration: session.runGeneration,
      connectionEpoch: session.epoch,
      address: {
        taskId: session.taskId,
        runId: session.runId,
        runGeneration: session.runGeneration,
        workspaceIdentity: `cloud-task:${session.taskId}`,
        workspacePath: "/workspace/demo",
        remoteSessionId: `remote-${session.runId}`,
        connectionEpoch: session.epoch,
      },
      ready: true,
      connectedAt: context.clock.now(),
    }),
    connectionEpoch: session.epoch + 1,
  });
  const stale = await context.plane.projections.ingest.ingestProjectionBatch(
    batch([record({ runId: session.runId, taskId: session.taskId, sourceSeq: 0 })], session.epoch),
  );
  assert.equal(stale.accepted, 0);
  assert.equal(context.storage.projectionRecords.length, 0);
});

test("runtime ACK 经 ingest 端口落地（02 §6.2、W1 §4 端口对）", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  await context.plane.projections.ingest.recordRuntimeAck({
    taskId: session.taskId,
    commandId: "00000000-0000-4000-8000-000000000201",
    runId: session.runId,
    runGeneration: session.runGeneration,
    deliveryStatus: "admitted",
    runtimeAck: {
      commandId: "00000000-0000-4000-8000-000000000201",
      status: "duplicate",
      revisionAtDecision: 3,
      result: { type: "createSession", sessionId: "runtime-session-9" },
    },
  });
  const input = await context.storage.inputs.get(
    session.taskId,
    "00000000-0000-4000-8000-000000000201",
  );
  assert.equal(input?.deliveryStatus, "admitted", "duplicate 按原结果落 admission");
  assert.equal(input?.runtimeSessionId, "runtime-session-9");
});

test("run fault 只记录，不回滚已持久事实（02 §8）", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  await context.plane.projections.ingest.ingestProjectionBatch(
    batch([record({ runId: session.runId, taskId: session.taskId, sourceSeq: 0 })], session.epoch),
  );
  await context.plane.projections.ingest.reportRunFault({
    taskId: session.taskId,
    runId: session.runId,
    runGeneration: session.runGeneration,
    errorCode: "bootstrap_failed",
    message: "clone failed",
    retryable: false,
  });
  assert.equal(context.storage.projectionRecords.length, 1, "已持久投影不被 fault 回滚");
  assert.equal(
    (await context.storage.runs.get(session.runId))?.status,
    "ready",
    "fault 不改 run 状态",
  );
});

test("bootstrap_failed 重新武装 clone grant：单次兑换后重试不再必然 403（01 §7.2、02 §8）", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithProvisioningRun(context);
  const cloneGrants = () =>
    context.gitGrantStore.records.filter(
      (item) => item.runId === session.runId && item.purpose === "clone",
    );
  const reportBootstrapFailed = () =>
    context.plane.projections.ingest.reportRunFault({
      taskId: session.taskId,
      runId: session.runId,
      runGeneration: session.runGeneration,
      errorCode: "bootstrap_failed",
      // 现场原文口径（真实链路 15:30）：沙箱侧 400，随后每次重试都在兑换侧 403。
      message: 'clone failed: remote: Duplicate header: "Authorization"',
      retryable: true,
    });

  // ① 首次签发（create 路径）被真兑换消费掉：单次兑换，记录变 redeemed。
  const first = cloneGrants()[0];
  assert.ok(first, "create 路径已签发 clone grant");
  assert.equal(first.status, "issued");
  const redeemed = await context.plane.gitGrants.redeem({
    runId: session.runId,
    purpose: "clone",
    runGeneration: session.runGeneration,
    repositoryId: 101,
  });
  assert.equal(redeemed.ok, true, "首次兑换成功（token 已铸出）");
  assert.equal((await context.gitGrantStore.get(first.grantId))?.status, "redeemed");

  // ② 故障上报后必须补签：否则 supervisor 整轮重试（hello→welcome→config→clone）必然 403。
  //    时间按真实现场推进（首兑 15:30:31 → 故障 15:30:34），保证 issued_at 严格递增。
  context.clock.advance(3_000);
  await reportBootstrapFailed();
  const afterRearm = cloneGrants();
  assert.equal(afterRearm.length, 2, "失败后补出一条新的 clone grant");
  const rearmed = afterRearm[1];
  assert.ok(rearmed && rearmed.grantId !== first.grantId, "补的是新记录，不复用已消费的那条");
  assert.equal(rearmed.status, "issued");
  assert.equal(rearmed.runGeneration, session.runGeneration);
  assert.equal(
    (await context.gitGrantStore.get(first.grantId))?.status,
    "redeemed",
    "旧记录保持已消费，不回滚已持久事实",
  );

  // ③ 幂等：未消费且在有效期内的 grant 只复用，不重复签发（不发散 grant 洪泛）。
  await reportBootstrapFailed();
  assert.equal(cloneGrants().length, 2, "有效未消费的 grant 被复用");
  assert.equal((await context.storage.runs.get(session.runId))?.status, "provisioning");

  // ④ 停止受理后不再补签（08 §8.1 停止屏障）。
  await context.storage.runs.requestStop({
    taskId: session.taskId,
    operationId: "00000000-0000-4000-8000-0000000002ff",
    now: context.clock.now(),
  });
  await reportBootstrapFailed();
  assert.equal(cloneGrants().length, 2, "stopRequested 的 run 不补签");

  // ⑤ 终态 run 不补签（08 §3.2 终态不可复活）。
  await context.storage.runs.transitionStatus({
    runId: session.runId,
    runGeneration: session.runGeneration,
    from: ["provisioning"],
    to: "failed",
    now: context.clock.now(),
  });
  await reportBootstrapFailed();
  assert.equal(cloneGrants().length, 2, "终态 run 不补签");
});

test("历史读取只依赖控制面副本，跨主体 not_found（03 §6/§9）", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  await context.plane.projections.ingest.ingestProjectionBatch(
    batch(
      [
        record({ runId: session.runId, taskId: session.taskId, sourceSeq: 0 }),
        record({ runId: session.runId, taskId: session.taskId, sourceSeq: 1, kind: "lifecycle" }),
      ],
      session.epoch,
    ),
  );
  const history = await context.plane.projections.history.readHistory({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.equal(history.ok, true);
  assert.equal(history.ok && history.value.items.length, 2);
  assert.equal(history.ok && history.value.items[1]?.seq, 1);
  assert.equal(history.ok && history.value.items[1]?.kind, "lifecycle");

  const foreign = await context.plane.projections.history.readHistory({
    principalId: "00000000-0000-4000-8000-0000000000cc",
    taskId: session.taskId,
  });
  assert.equal(foreign.ok === false && foreign.code, "not_found");

  const missingSnapshot = await context.plane.projections.history.readSnapshot({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.equal(missingSnapshot.ok === false && missingSnapshot.reason, "snapshot-not-available");
  await context.storage.projections.writeSnapshot({
    taskId: session.taskId,
    runId: session.runId,
    topic: CANONICAL_TOPIC,
    logEpoch: "epoch-1",
    coveredSourceSeq: 1,
    snapshot: { messages: [] },
    now: context.clock.now(),
  });
  const snapshot = await context.plane.projections.history.readSnapshot({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.equal(snapshot.ok && snapshot.value.coveredSourceSeq, 1);
  assert.equal(snapshot.ok && snapshot.value.logEpoch, "epoch-1");
});

test("恢复判定：epoch+水位匹配才 resume，否则快照，越界 resync（02 §7.3）", () => {
  const cursors = [{ topic: CANONICAL_TOPIC, logEpoch: "epoch-1", sourceSeq: 10 }];
  assert.deepEqual(
    decideResume({
      requestedLogEpoch: "epoch-1",
      requestedSeq: 4,
      cursors,
      snapshotAvailable: true,
    }),
    { kind: "resume", logEpoch: "epoch-1", fromSeq: 4 },
  );
  assert.deepEqual(
    decideResume({
      requestedLogEpoch: "epoch-0",
      requestedSeq: 4,
      cursors,
      snapshotAvailable: true,
    }),
    { kind: "snapshot", reason: "epoch-mismatch" },
  );
  assert.deepEqual(decideResume({ cursors, snapshotAvailable: true }), {
    kind: "snapshot",
    reason: "no-cursor",
  });
  assert.deepEqual(
    decideResume({
      requestedLogEpoch: "epoch-1",
      requestedSeq: 4,
      cursors,
      snapshotAvailable: true,
      elapsedSinceCursorMs: PROJECTION_RETENTION_MS + 1,
    }),
    { kind: "resync", reason: "retention-exceeded" },
  );
});

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

test("投影 ingest：批次内任一条跨 run / 跨 task / 旧 generation 即整批拒绝，无 ACK（R2，15 §3）", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  const good = (sourceSeq: number, overrides: Partial<CloudProjectionRecord> = {}) =>
    record({
      runId: session.runId,
      taskId: session.taskId,
      runGeneration: session.runGeneration,
      sourceSeq,
      ...overrides,
    });
  const reject = async (foreign: CloudProjectionRecord, label: string) => {
    const result = await context.plane.projections.ingest.ingestProjectionBatch(
      batch([good(0), foreign], session.epoch),
    );
    assert.equal(result.accepted, 0, `${label}：整批不落库`);
    assert.deepEqual(result.cursors, [], `${label}：不回 projection.ack`);
    assert.equal(context.storage.projectionRecords.length, 0, `${label}：既有记录也不受影响`);
  };

  // 首条记录合法也不代表整批合法：跨 run / 跨 task / 旧代际的夹带记录必须整批拒绝。
  await reject(good(1, { runId: "00000000-0000-4000-8000-0000000000e1" }), "跨 run 记录");
  await reject(good(1, { taskId: "00000000-0000-4000-8000-0000000000e2" }), "跨 task 记录");

  // 模拟 run 已进入新代际（reopen/接管）后，旧 generation 的批次仍会到达。
  const current = await context.storage.runs.get(session.runId);
  assert.ok(current);
  context.storage.runsById.set(session.runId, {
    ...current,
    runGeneration: current.runGeneration + 1,
  });
  await reject(good(0), "旧 generation 记录");

  // 同 run + 当前 generation 的正常批次不受上述拒绝影响（幂等语义保持）。
  const accepted = await context.plane.projections.ingest.ingestProjectionBatch(
    batch([good(0, { runGeneration: current.runGeneration + 1 })], session.epoch),
  );
  assert.equal(accepted.accepted, 1);
  assert.deepEqual(accepted.cursors, [
    { topic: CANONICAL_TOPIC, logEpoch: "epoch-1", sourceSeq: 0 },
  ]);
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

/**
 * 2026-10-18 复审修复：ingest `kind=snapshot` 时同步落一份权威快照（projection_snapshots），
 * 让 `GET /snapshot` 可用、resync 有快照可回；快照覆盖范围单调，旧快照不覆盖新快照。
 */
test("投影 ingest：kind=snapshot 落权威快照，覆盖范围单调且 GET /snapshot 可用", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  const frame = (fromSeq: number, toSeq: number, text: string) => ({
    topic: CANONICAL_TOPIC,
    fromSeq,
    toSeq,
    sentAt: 0,
    payload: { kind: "snapshot", snapshot: { messages: [{ text }] } },
  });
  const snapshotRecord = (sourceSeq: number, payload: unknown, contentHash: string) =>
    record({
      runId: session.runId,
      taskId: session.taskId,
      sourceSeq,
      kind: "snapshot",
      payload,
      contentHash,
    });

  const ingestedAt = context.clock.now();
  const first = await context.plane.projections.ingest.ingestProjectionBatch(
    batch([snapshotRecord(5, frame(0, 5, "first"), "a".repeat(64))], session.epoch),
  );
  assert.equal(first.accepted, 1);

  const stored = await context.storage.projections.readSnapshot({
    taskId: session.taskId,
    topic: CANONICAL_TOPIC,
  });
  assert.ok(stored, "ingest snapshot 后必须落权威快照（GET /snapshot 不再必然 404）");
  assert.equal(stored.coveredSourceSeq, 5);
  assert.equal(stored.logEpoch, "epoch-1");
  assert.deepEqual(stored.snapshot, frame(0, 5, "first"), "快照载荷即完整 V4 快照帧载荷");
  assert.equal(stored.createdAt, ingestedAt, "快照 createdAt 取持久时间");

  // 更高 sourceSeq 的快照覆盖旧值（coveredSourceSeq 单调）。
  context.clock.advance(1_000);
  await context.plane.projections.ingest.ingestProjectionBatch(
    batch([snapshotRecord(9, frame(6, 9, "second"), "b".repeat(64))], session.epoch),
  );
  const advanced = await context.storage.projections.readSnapshot({
    taskId: session.taskId,
    topic: CANONICAL_TOPIC,
  });
  assert.equal(advanced?.coveredSourceSeq, 9);
  assert.deepEqual(advanced?.snapshot, frame(6, 9, "second"));

  // 服务层（GET /snapshot 的同一入口）：返回持久 createdAt，重复读取不漂移。
  const response = await context.plane.projections.history.readSnapshot({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.equal(response.ok, true);
  assert.equal(response.ok && response.value.coveredSourceSeq, 9);
  assert.equal(response.ok && response.value.createdAt, stored.createdAt);

  // 冲突批次不覆盖既有权威快照（同名 seq 不同 hash 是一致性 fault）。
  const conflict = await context.plane.projections.ingest.ingestProjectionBatch(
    batch([snapshotRecord(9, frame(0, 9, "tampered"), "c".repeat(64))], session.epoch),
  );
  assert.equal(conflict.conflicts.length, 1);
  const afterConflict = await context.storage.projections.readSnapshot({
    taskId: session.taskId,
    topic: CANONICAL_TOPIC,
  });
  assert.deepEqual(afterConflict?.snapshot, frame(6, 9, "second"), "冲突 payload 不写快照");
});

test("投影 ingest：快照写失败不阻断事件 ACK（历史仍可读）", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  const writeSnapshot = context.storage.projections.writeSnapshot.bind(context.storage.projections);
  context.storage.projections.writeSnapshot = async () => {
    throw new Error("disk full");
  };

  const result = await context.plane.projections.ingest.ingestProjectionBatch(
    batch(
      [
        record({
          runId: session.runId,
          taskId: session.taskId,
          sourceSeq: 0,
          kind: "snapshot",
          payload: {
            topic: CANONICAL_TOPIC,
            fromSeq: 0,
            toSeq: 0,
            sentAt: 0,
            payload: { kind: "snapshot", snapshot: { messages: [] } },
          },
        }),
      ],
      session.epoch,
    ),
  );
  assert.equal(result.accepted, 1, "事件已 durable，快照失败不回滚 ACK");
  assert.deepEqual(result.cursors, [{ topic: CANONICAL_TOPIC, logEpoch: "epoch-1", sourceSeq: 0 }]);
  const history = await context.plane.projections.history.readHistory({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.equal(history.ok && history.value.items.length, 1, "历史仍可读（快照只是加速副本）");

  context.storage.projections.writeSnapshot = writeSnapshot;
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

/**
 * 2026-10-18 复审修复：快照实际落在 `conversation/<sessionId>`，HTTP 缺省 topic 是族名
 * `conversation`。族名查询必须命中该前缀下的快照，响应回实际话题（不能回查询族名）。
 */
test("GET /snapshot 缺省族名命中会话话题快照，响应回实际 topic", async () => {
  const context = buildTestPlane();
  const session = await seedTaskWithReadyRun(context);
  const topic = "conversation/sess-snapshot-family";
  await context.storage.projections.writeSnapshot({
    taskId: session.taskId,
    runId: session.runId,
    topic,
    logEpoch: "epoch-family",
    coveredSourceSeq: 12,
    snapshot: { messages: [{ text: "family" }] },
    now: context.clock.now(),
  });
  const family = await context.plane.projections.history.readSnapshot({
    principalId: PRINCIPAL,
    taskId: session.taskId,
  });
  assert.equal(family.ok, true);
  assert.equal(family.ok && family.value.topic, topic, "响应必须回实际快照话题");
  assert.equal(family.ok && family.value.coveredSourceSeq, 12);
  const exact = await context.plane.projections.history.readSnapshot({
    principalId: PRINCIPAL,
    taskId: session.taskId,
    topic,
  });
  assert.equal(exact.ok, true);
  assert.equal(exact.ok && exact.value.topic, topic);
});

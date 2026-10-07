/**
 * bridge 凭据仓储验收（02 §5.1/§5.2、03 §4 run_credentials 行）。
 *
 * 断言：只持久 hash；消费是单条 CAS（hash/时效/代际/非终态都满足才切换）；失败
 * fail closed，不设置旧 token 的通用有效重叠窗口；旋转响应丢失时同 attempt 复用
 * rotationId，内容不一致一律拒绝。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  newUuid,
  openTestStorage,
  removeTestRoot,
  seedActiveRun,
  seedDraftTask,
  type TestStorageHandle,
} from "./cloudStorageHarness.js";

/**
 * 凭据时效用的是绝对过期时间：`recoverByAttempt` 端口签名不带 now（W0 冻结），
 * 只能与本机时钟比较，因此本文件用真实时钟基准而不是固定的测试常量。
 */
const BASE = Date.now();
function at(offsetMs: number): number {
  return BASE + offsetMs;
}

async function withRun(
  body: (context: { handle: TestStorageHandle; runId: string }) => Promise<void>,
): Promise<void> {
  const handle = await openTestStorage();
  try {
    const seeded = await seedDraftTask(handle.storage);
    const run = await seedActiveRun(handle.storage, seeded);
    await body({ handle, runId: run.runId });
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
}

const INITIAL_HASH = "a".repeat(64);
const CANDIDATE_HASH = "b".repeat(64);

test("消费初始凭据切换 hash 并返回 rotationId，旧 proof 立即失效", async () => {
  await withRun(async ({ handle, runId }) => {
    await handle.storage.storage.credentials.saveInitial({
      runId,
      runGeneration: 1,
      credentialHash: INITIAL_HASH,
      expiresAt: at(600_000),
      bootstrapOperationId: newUuid(),
    });

    const consumed = await handle.storage.storage.credentials.consumeForHello({
      runId,
      proofHash: INITIAL_HASH,
      candidateHash: CANDIDATE_HASH,
      helloAttemptId: "attempt-1",
      now: at(1),
    });
    assert.ok(consumed?.rotationId, "首次 hello 应返回 rotationId");

    const replayWithOldProof = await handle.storage.storage.credentials.consumeForHello({
      runId,
      proofHash: INITIAL_HASH,
      candidateHash: "c".repeat(64),
      helloAttemptId: "attempt-2",
      now: at(2),
    });
    assert.equal(replayWithOldProof, null, "旧 token 不得开启新 attempt（02 §5.2）");

    const wrongCandidate = await handle.storage.storage.credentials.consumeForHello({
      runId,
      proofHash: CANDIDATE_HASH,
      candidateHash: "d".repeat(64),
      helloAttemptId: "attempt-3",
      now: at(3),
    });
    assert.ok(wrongCandidate?.rotationId, "当前凭据可以继续轮换");
  });
});

test("旋转响应丢失：同 attempt 同候选复用 rotationId，不同内容拒绝", async () => {
  await withRun(async ({ handle, runId }) => {
    await handle.storage.storage.credentials.saveInitial({
      runId,
      runGeneration: 1,
      credentialHash: INITIAL_HASH,
      expiresAt: at(600_000),
      bootstrapOperationId: newUuid(),
    });
    const commit = await handle.storage.storage.credentials.consumeForHello({
      runId,
      proofHash: INITIAL_HASH,
      candidateHash: CANDIDATE_HASH,
      helloAttemptId: "attempt-1",
      now: at(1),
    });
    const recovered = await handle.storage.storage.credentials.recoverByAttempt({
      runId,
      helloAttemptId: "attempt-1",
      candidateHash: CANDIDATE_HASH,
    });
    assert.equal(recovered?.rotationId, commit?.rotationId);
    assert.equal(recovered?.committed, true);

    assert.equal(
      await handle.storage.storage.credentials.recoverByAttempt({
        runId,
        helloAttemptId: "attempt-1",
        candidateHash: "e".repeat(64),
      }),
      null,
      "同 attempt 不同候选必须拒绝",
    );
    assert.equal(
      await handle.storage.storage.credentials.recoverByAttempt({
        runId,
        helloAttemptId: "attempt-9",
        candidateHash: CANDIDATE_HASH,
      }),
      null,
    );
  });
});

test("过期、撤销、终态 run 的凭据一律 fail closed", async () => {
  await withRun(async ({ handle, runId }) => {
    await handle.storage.storage.credentials.saveInitial({
      runId,
      runGeneration: 1,
      credentialHash: INITIAL_HASH,
      expiresAt: at(10),
      bootstrapOperationId: newUuid(),
    });
    assert.equal(
      await handle.storage.storage.credentials.consumeForHello({
        runId,
        proofHash: INITIAL_HASH,
        candidateHash: CANDIDATE_HASH,
        helloAttemptId: "expired",
        now: at(11),
      }),
      null,
      "过期凭据不得认证",
    );

    assert.equal(
      await handle.storage.storage.credentials.revokeRun({
        runId,
        reason: "run-terminal",
      }),
      1,
    );
    assert.equal(
      await handle.storage.storage.credentials.consumeForHello({
        runId,
        proofHash: INITIAL_HASH,
        candidateHash: CANDIDATE_HASH,
        helloAttemptId: "revoked",
        now: at(13),
      }),
      null,
    );
    assert.equal(
      await handle.storage.storage.credentials.revokeRun({
        runId,
        reason: "again",
      }),
      0,
      "重复撤销幂等",
    );
  });
});

test("run 终态后凭据不再可用", async () => {
  await withRun(async ({ handle, runId }) => {
    await handle.storage.storage.credentials.saveInitial({
      runId,
      runGeneration: 1,
      credentialHash: INITIAL_HASH,
      expiresAt: at(600_000),
      bootstrapOperationId: newUuid(),
    });
    await handle.storage.storage.runs.transitionStatus({
      runId,
      runGeneration: 1,
      from: ["provisioning"],
      to: "stopped",
      endReason: "user-stop",
      now: at(1),
    });
    assert.equal(
      await handle.storage.storage.credentials.consumeForHello({
        runId,
        proofHash: INITIAL_HASH,
        candidateHash: CANDIDATE_HASH,
        helloAttemptId: "after-stop",
        now: at(2),
      }),
      null,
    );
  });
});

test("重复 saveInitial 不覆盖已消费的凭据，代际不符拒绝", async () => {
  await withRun(async ({ handle, runId }) => {
    await handle.storage.storage.credentials.saveInitial({
      runId,
      runGeneration: 1,
      credentialHash: INITIAL_HASH,
      expiresAt: at(600_000),
      bootstrapOperationId: newUuid(),
    });
    await handle.storage.storage.credentials.consumeForHello({
      runId,
      proofHash: INITIAL_HASH,
      candidateHash: CANDIDATE_HASH,
      helloAttemptId: "attempt-1",
      now: at(1),
    });
    // 恢复中的 provisioning worker 用旧初始 hash 重放：不得把已验证的 resume token 覆盖回去。
    await handle.storage.storage.credentials.saveInitial({
      runId,
      runGeneration: 1,
      credentialHash: "f".repeat(64),
      expiresAt: at(700_000),
      bootstrapOperationId: newUuid(),
    });
    assert.equal(
      (await handle.storage.storage.credentials.consumeForHello({
        runId,
        proofHash: CANDIDATE_HASH,
        candidateHash: "1".repeat(64),
        helloAttemptId: "attempt-2",
        now: at(2),
      })) !== null,
      true,
      "重放 saveInitial 不得破坏已轮换的凭据",
    );

    await assert.rejects(
      handle.storage.storage.credentials.saveInitial({
        runId,
        runGeneration: 2,
        credentialHash: "2".repeat(64),
        expiresAt: BASE,
        bootstrapOperationId: newUuid(),
      }),
      (error: unknown) =>
        error instanceof Error &&
        (error as { reason?: string }).reason === "run-generation-mismatch",
    );
  });
});

test("凭据有效期跟随 run 硬期限：长连接断线后不被固定 TTL 锁死（回归 2026-10-07）", async () => {
  // 回归现场：bridge 凭据行原来按固定 10 分钟 TTL 落库且旋转不续期——连接存活超过
  // TTL 的 run 一旦断线，重连 hello 的 expires_at > now 恒假 → credential-rejected，
  // 恢复阶梯走完 exhausted，run 只能等硬期限收口（真实链路 19:41 复现）。
  await withRun(async ({ handle, runId }) => {
    // 把硬期限推到未来（seed 的 TEST_NOW 在过去），模拟一次带余量的 run。
    const deadline = at(3_600_000);
    const leased = await handle.storage.storage.runs.updateLease({
      runId,
      runGeneration: 1,
      hardDeadlineAt: deadline,
      now: at(1),
    });
    assert.equal(leased, true, "测试前置：更新硬期限必须成功");

    await handle.storage.storage.credentials.saveInitial({
      runId,
      runGeneration: 1,
      credentialHash: INITIAL_HASH,
      expiresAt: deadline, // 新语义：mint 直接用 run 硬期限
      bootstrapOperationId: newUuid(),
    });

    // 「连接已存活 20 分钟」之后断线重连：远超旧 10 分钟 TTL，但仍在硬期限内 → 必须可消费。
    const late = at(20 * 60_000);
    assert.ok(late < deadline, "测试前置：20 分钟必须仍在硬期限内");
    const first = await handle.storage.storage.credentials.consumeForHello({
      runId,
      proofHash: INITIAL_HASH,
      candidateHash: CANDIDATE_HASH,
      helloAttemptId: "attempt-late",
      now: late,
    });
    assert.ok(first, "硬期限前的重连必须可消费（旧实现在此已过期拒绝）");

    // 旋转后的有效期跟随 runs.hard_deadline_at：临近期限仍可再次旋转（延期场景同理）。
    const second = await handle.storage.storage.credentials.consumeForHello({
      runId,
      proofHash: CANDIDATE_HASH,
      candidateHash: INITIAL_HASH,
      helloAttemptId: "attempt-near-deadline",
      now: deadline - 1,
    });
    assert.ok(second, "临近期限的旋转必须成功（expires 跟随硬期限，不是 +10min）");

    // 超过硬期限：fail closed（02 §5.2 到期拒绝的语义保留）。
    const beyond = await handle.storage.storage.credentials.consumeForHello({
      runId,
      proofHash: INITIAL_HASH,
      candidateHash: CANDIDATE_HASH,
      helloAttemptId: "attempt-beyond",
      now: deadline + 1,
    });
    assert.equal(beyond, null, "超过硬期限必须拒绝");
  });
});

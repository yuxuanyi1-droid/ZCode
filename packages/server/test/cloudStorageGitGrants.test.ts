/**
 * git grant 持久面验收（01 §7.1/§7.2、03 §4 `git_grants`、09 §4；`GitGrantStore` 端口）。
 *
 * 断言：单次兑换是 CAS（并发只有一个胜出、过期/绑定不符都不可兑换）；撤销后不可再
 * 兑换，且 GitHub 侧的撤销结果单独持久（尽力语义不谎报）；表里只有 hash 与元数据，
 * 没有 raw token 列。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { GitGrantRecord } from "../src/cloud/app/ports/gitGrantPort.js";
import {
  fakeGitSha,
  newUuid,
  nextNow,
  openTestStorage,
  removeTestRoot,
  seedActiveRun,
  seedDraftTask,
  TEST_NOW,
  type TestStorageHandle,
} from "./cloudStorageHarness.js";
import {
  openStorageDatabase,
  closeStorageDatabase,
} from "../src/cloud/adapters/storage/sqlite/database.js";
import path from "node:path";

function grantRecord(
  overrides: Partial<GitGrantRecord> & Pick<GitGrantRecord, "taskId" | "runId">,
): GitGrantRecord {
  return {
    grantId: newUuid(),
    runGeneration: 1,
    repositoryId: 42,
    installationId: 7,
    purpose: "clone",
    status: "issued",
    issuedAt: TEST_NOW,
    expiresAt: nextNow(60_000),
    proofHash: fakeGitSha("proof"),
    ...overrides,
  };
}

async function withRun(
  body: (context: { handle: TestStorageHandle; taskId: string; runId: string }) => Promise<void>,
): Promise<void> {
  const handle = await openTestStorage();
  try {
    const seeded = await seedDraftTask(handle.storage);
    const run = await seedActiveRun(handle.storage, seeded);
    await body({ handle, taskId: seeded.taskId, runId: run.runId });
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
}

test("grant 记录写入/读取 round-trip，重复写入幂等", async () => {
  await withRun(async ({ handle, taskId, runId }) => {
    const record = grantRecord({ taskId, runId, purpose: "push" });
    await handle.storage.grants.insert(record);
    const loaded = await handle.storage.grants.get(record.grantId);
    assert.deepEqual(loaded, record);

    await handle.storage.grants.insert({ ...record, proofHash: undefined });
    const again = await handle.storage.grants.get(record.grantId);
    assert.equal(again?.proofHash, record.proofHash, "重复写入不得清掉既有凭据摘要");

    assert.equal(await handle.storage.grants.get(newUuid()), null);
    await assert.rejects(
      handle.storage.grants.insert(
        grantRecord({ taskId, runId, purpose: "checkpoint-push" as GitGrantRecord["purpose"] }),
      ),
      "未知 purpose 必须拒绝（词表由端口冻结）",
    );
  });
});

test("单次兑换 CAS：并发只有一个胜出，过期与绑定不符都不可兑换", async () => {
  await withRun(async ({ handle, taskId, runId }) => {
    const record = grantRecord({ taskId, runId });
    await handle.storage.grants.insert(record);
    const claim = { grantId: record.grantId, taskId, runId, runGeneration: 1 };

    assert.equal(
      await handle.storage.grants.claimRedemption({ ...claim, runId: newUuid(), now: nextNow(1) }),
      null,
      "runId 不匹配不得兑换",
    );
    const first = await handle.storage.grants.claimRedemption({ ...claim, now: nextNow(2) });
    assert.equal(first?.status, "redeemed");
    assert.equal(first?.redeemedAt, nextNow(2));
    assert.equal(
      await handle.storage.grants.claimRedemption({ ...claim, now: nextNow(3) }),
      null,
      "单次兑换：第二次必须失败",
    );

    const expired = grantRecord({ taskId, runId, expiresAt: nextNow(10) });
    await handle.storage.grants.insert(expired);
    assert.equal(
      await handle.storage.grants.claimRedemption({
        grantId: expired.grantId,
        taskId,
        runId,
        runGeneration: 1,
        now: nextNow(11),
      }),
      null,
      "过期 grant 不可兑换",
    );
  });
});

test("findCurrentForRun 取最新一条，且不把过期伪装成不存在", async () => {
  await withRun(async ({ handle, taskId, runId }) => {
    const older = grantRecord({ taskId, runId, issuedAt: TEST_NOW });
    const newer = grantRecord({ taskId, runId, issuedAt: nextNow(500), expiresAt: nextNow(100) });
    await handle.storage.grants.insert(older);
    await handle.storage.grants.insert(newer);

    const current = await handle.storage.grants.findCurrentForRun({
      runId,
      purpose: "clone",
      now: nextNow(1_000),
    });
    assert.equal(current?.grantId, newer.grantId, "取 issuedAt 最新的一条");
    assert.ok(current && current.expiresAt < nextNow(1_000), "过期事实如实返回，由 broker 判定");
    assert.equal(
      await handle.storage.grants.findCurrentForRun({
        runId,
        purpose: "push",
        now: nextNow(1_000),
      }),
      null,
    );
  });
});

test("token 生命周期与失败原因只写元数据；撤销后不可兑换", async () => {
  await withRun(async ({ handle, taskId, runId }) => {
    const record = grantRecord({ taskId, runId });
    await handle.storage.grants.insert(record);
    await handle.storage.grants.recordIssuedToken({
      grantId: record.grantId,
      tokenIssuedAt: nextNow(1),
      tokenExpiresAt: nextNow(3_600_000),
    });
    await handle.storage.grants.recordFailure({
      grantId: record.grantId,
      code: "network_unknown",
      message: "github 不可达",
      now: nextNow(2),
    });
    const afterFailure = await handle.storage.grants.get(record.grantId);
    assert.equal(afterFailure?.tokenExpiresAt, nextNow(3_600_000));
    assert.equal(afterFailure?.lastErrorCode, "network_unknown");

    await handle.storage.grants.claimRedemption({
      grantId: record.grantId,
      taskId,
      runId,
      runGeneration: 1,
      now: nextNow(3),
    });
    await handle.storage.grants.recordRevokeOutcome({
      grantId: record.grantId,
      revoked: false,
      reason: "token-not-held",
      now: nextNow(4),
    });
    const revoked = await handle.storage.grants.get(record.grantId);
    assert.equal(revoked?.status, "revoked");
    assert.deepEqual(revoked?.revokeOutcome, {
      revoked: false,
      reason: "token-not-held",
      at: nextNow(4),
    });
    assert.equal(
      await handle.storage.grants.claimRedemption({
        grantId: record.grantId,
        taskId,
        runId,
        runGeneration: 1,
        now: nextNow(5),
      }),
      null,
      "已撤销的 grant 不可兑换",
    );
    assert.equal((await handle.storage.grants.listByRun(runId)).length, 1);
  });
});

test("表里只存 hash 与元数据，没有 raw token 列", async () => {
  const handle = await openTestStorage();
  try {
    const seeded = await seedDraftTask(handle.storage);
    const run = await seedActiveRun(handle.storage, seeded);
    await handle.storage.grants.insert(grantRecord({ taskId: seeded.taskId, runId: run.runId }));
    await handle.close();

    const context = openStorageDatabase({
      path: path.join(handle.root, "data", "cloud.db"),
      readOnly: true,
    });
    try {
      const columns = context.db
        .prepare("PRAGMA table_info(git_grants)")
        .all()
        .map((row) => String(row["name"]));
      assert.ok(columns.includes("proof_hash"), "只持久摘要");
      assert.ok(
        !columns.some((name) => name === "token" || name === "raw_token"),
        "不得有 raw token 列",
      );
      const row = context.db.prepare("SELECT * FROM git_grants").get();
      for (const [column, value] of Object.entries(row ?? {})) {
        if (typeof value !== "string") continue;
        assert.ok(!/^ghs_|^ghp_/.test(value), `${column} 不得出现 GitHub token 明文`);
      }
    } finally {
      closeStorageDatabase(context);
    }
  } finally {
    await handle.close().catch(() => undefined);
    await removeTestRoot(handle.root);
  }
});

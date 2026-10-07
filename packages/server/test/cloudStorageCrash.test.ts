/**
 * 崩溃恢复验收（W2 §6「提交前后 crash」、03 §4/§8、CP-03/CP-04 持久侧断言）。
 *
 * 用真实子进程 + 真实 kill 语义（不 ROLLBACK、不 close）验证两件事：
 * 1. 未提交事务不会留下半截事实；
 * 2. 已提交事实在进程非正常退出后仍然存在，且同一 commandId 的重试返回同一 receipt、
 *    只产生一个 create 意图（不重复创建沙箱）。
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  closeStorageDatabase,
  openStorageDatabase,
} from "../src/cloud/adapters/storage/sqlite/database.js";
import {
  openTestStorage,
  removeTestRoot,
  seedDraftTask,
  TEST_NOW,
  newUuid,
  fakeSha256,
  fakeGitSha,
} from "./cloudStorageHarness.js";

const childPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "cloudStorageCrashChild.ts",
);

interface ChildResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runCrashChild(args: string[]): Promise<ChildResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", childPath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

test("未提交事务在控制面崩溃后回滚", async () => {
  const handle = await openTestStorage();
  const databasePath = path.join(handle.dataDir, "crash-before.db");
  try {
    const result = await runCrashChild(["raw-before-commit", databasePath]);
    assert.equal(result.code, 2, `子进程应以崩溃码退出：${result.stderr}`);
    const context = openStorageDatabase({ path: databasePath });
    try {
      const principals = context.db.prepare("SELECT COUNT(*) AS total FROM principals").get();
      assert.equal(Number(principals?.["total"]), 0);
      const integrity = context.db.prepare("PRAGMA integrity_check").get();
      assert.equal(String(Object.values(integrity ?? {})[0]), "ok");
    } finally {
      closeStorageDatabase(context);
    }
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("已提交事务在控制面崩溃后仍然存在", async () => {
  const handle = await openTestStorage();
  const databasePath = path.join(handle.dataDir, "crash-after.db");
  try {
    const result = await runCrashChild(["raw-after-commit", databasePath]);
    assert.equal(result.code, 2, `子进程应以崩溃码退出：${result.stderr}`);
    const context = openStorageDatabase({ path: databasePath });
    try {
      const principals = context.db
        .prepare("SELECT principal_id FROM principals ORDER BY principal_id")
        .all()
        .map((row) => String(row["principal_id"]));
      assert.deepEqual(principals, ["crash-principal", "crash-principal-2"]);
      const integrity = context.db.prepare("PRAGMA integrity_check").get();
      assert.equal(String(Object.values(integrity ?? {})[0]), "ok");
    } finally {
      closeStorageDatabase(context);
    }
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("DB 提交后进程崩溃：同 commandId 重试得到同一 receipt 且只有一个 create 意图", async () => {
  const handle = await openTestStorage();
  const seeded = await seedDraftTask(handle.storage, {
    draftStartConfig: { baseBranch: "main", provider: "daytona" },
  });
  const commandId = newUuid();
  const runId = newUuid();
  const createOperationId = newUuid();
  const payloadHash = fakeSha256("a1");
  const request = {
    taskId: seeded.taskId,
    commandId,
    intent: "start" as const,
    payloadHash,
    prompt: "首次工作内容",
    expectedTaskRevision: 0,
    start: { baseBranch: "main", provider: "daytona" },
    runRecipe: {
      provider: "daytona",
      resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
      firstCommandConfig: {},
      baseSha: fakeGitSha("b2"),
    },
    taskBranch: "cloud/task-branch",
    createOperationId,
    runId,
    quota: { maxConcurrentRuns: 3 },
    now: TEST_NOW + 1000,
  };
  await handle.close();

  try {
    const crash = await runCrashChild([
      "accept-input",
      JSON.stringify({ root: handle.root, request }),
    ]);
    assert.equal(crash.code, 2, `子进程应以崩溃码退出：${crash.stderr}`);
    assert.match(crash.stdout, /"status":"accepted"/);

    const reopened = await openTestStorage({ root: handle.root });
    try {
      // ① 同 commandId 同 payloadHash 的重试：合法重放返回原 receipt（03 §6.1）。
      const retry = await reopened.storage.storage.acceptInput({
        ...request,
        now: TEST_NOW + 2000,
      });
      assert.equal(retry.status, "duplicate");
      if (retry.status !== "duplicate") throw new Error("unreachable");
      assert.equal(retry.receipt.commandId, commandId);
      assert.equal(retry.receipt.runId, runId);
      assert.equal(retry.receipt.runGeneration, 1);

      // ② 同 commandId 不同 payloadHash：拒绝为 idempotency_conflict。
      const mismatched = await reopened.storage.storage.acceptInput({
        ...request,
        payloadHash: fakeSha256("c3"),
        now: TEST_NOW + 3000,
      });
      assert.equal(mismatched.status, "conflict");
      if (mismatched.status !== "conflict") throw new Error("unreachable");
      assert.equal(mismatched.reason, "payload-mismatch");
      assert.equal(mismatched.code, "idempotency_conflict");

      // ③ 持久事实：一个输入、一个 run、一个未结算 create 意图（CP-04 持久侧）。
      const inputs = await reopened.storage.storage.inputs.list(seeded.taskId, { limit: 10 });
      assert.equal(inputs.items.length, 1);
      const runs = await reopened.storage.storage.runs.listNonTerminal();
      assert.equal(runs.length, 1);
      assert.equal(runs[0]?.runId, runId);
      const unsettled = await reopened.storage.operations.listUnsettled();
      assert.equal(unsettled.length, 1);
      assert.equal(unsettled[0]?.kind, "create");
      assert.equal(unsettled[0]?.idempotencyKey, `create:${runId}`);
      assert.equal(unsettled[0]?.state, "pending");
    } finally {
      await reopened.close();
    }
  } finally {
    await removeTestRoot(handle.root);
  }
});

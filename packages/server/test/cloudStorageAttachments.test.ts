/**
 * 受控附件存储验收（03 §4「临时对象→校验→原子发布→引用」、W2 §5）。
 *
 * 断言：内容地址 = sha256；发布是原子的（tmp 不残留、对象文件就位）；超限/非法输入
 * 在落盘前拒绝；未被引用的对象按保留期连同文件一起清扫；跨 owner 不可见；浏览器
 * 临时路径类型的信息（源文件名里的路径）不会成为持久引用的一部分。
 */
import assert from "node:assert/strict";
import { mkdir, readdir, stat, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import {
  newUuid,
  nextNow,
  openTestStorage,
  removeTestRoot,
  seedActiveRun,
  seedDraftTask,
  TEST_NOW,
} from "./cloudStorageHarness.js";
import { isCloudStorageError } from "../src/cloud/adapters/storage/cloudStorageError.js";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

test("上传发布为内容地址对象，tmp 不残留", async () => {
  const handle = await openTestStorage();
  try {
    const bytes = new TextEncoder().encode("附件正文");
    const record = await handle.storage.attachments.upload({
      ownerPrincipalId: newUuid(),
      fileName: "研究笔记.txt",
      mime: "text/plain",
      body: bytes,
      now: nextNow(1),
    });
    assert.equal(record.attachmentId, sha256(bytes));
    assert.equal(record.byteSize, bytes.byteLength);
    assert.equal(record.state, "published");
    assert.equal(record.publishedAt, nextNow(1));

    const objectFile = await stat(handle.storage.attachments.objectPath(record.attachmentId));
    assert.equal(objectFile.size, bytes.byteLength);
    const tmpEntries = await readdir(path.join(handle.attachmentsDir, "tmp"));
    assert.deepEqual(tmpEntries, [], "发布后临时对象必须消失（rename 语义）");
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("相同内容幂等去重，不同 owner 各自持有元数据", async () => {
  const handle = await openTestStorage();
  try {
    const ownerA = newUuid();
    const ownerB = newUuid();
    const bytes = new TextEncoder().encode("同样的字节");
    const first = await handle.storage.attachments.upload({
      ownerPrincipalId: ownerA,
      fileName: "a.txt",
      mime: "text/plain",
      body: bytes,
      now: nextNow(1),
    });
    const again = await handle.storage.attachments.upload({
      ownerPrincipalId: ownerA,
      fileName: "a.txt",
      mime: "text/plain",
      body: bytes,
      now: nextNow(2),
    });
    assert.equal(again.attachmentId, first.attachmentId);
    assert.equal(again.createdAt, first.createdAt, "重复上传保留首次发布元数据");

    const other = await handle.storage.attachments.upload({
      ownerPrincipalId: ownerB,
      fileName: "b.txt",
      mime: "text/plain",
      body: bytes,
      now: nextNow(3),
    });
    assert.equal(other.attachmentId, first.attachmentId, "内容地址与 owner 无关");
    assert.equal(
      await handle.storage.attachments.get(ownerB, first.attachmentId).then((r) => r?.fileName),
      "b.txt",
    );
    assert.equal(await handle.storage.attachments.get(newUuid(), first.attachmentId), null);

    const rows = await readdir(
      path.join(handle.attachmentsDir, "objects", first.attachmentId.slice(0, 2)),
    );
    assert.equal(rows.length, 1, "相同内容只落一份对象文件");
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("超过大小上限在发布前拒绝且不残留对象", async () => {
  const handle = await openTestStorage({ attachmentLimits: { maxBytes: 8 } });
  try {
    await assert.rejects(
      handle.storage.attachments.upload({
        ownerPrincipalId: newUuid(),
        fileName: "big.bin",
        mime: "application/octet-stream",
        body: new Uint8Array(64),
        now: nextNow(1),
      }),
      (error: unknown) => isCloudStorageError(error) && error.reason === "attachment-too-large",
    );
    const objects = await readdir(path.join(handle.attachmentsDir, "objects")).catch(() => []);
    assert.deepEqual(objects, [], "超限对象不得发布");
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("源文件名只作展示，路径成分被剥离", async () => {
  const handle = await openTestStorage();
  try {
    const record = await handle.storage.attachments.upload({
      ownerPrincipalId: newUuid(),
      fileName: "..\\..\\etc\\passwd",
      mime: "text/plain",
      body: new TextEncoder().encode("x"),
      now: nextNow(1),
    });
    assert.equal(record.fileName, "passwd");
    assert.ok(!record.fileName.includes("/"));

    await assert.rejects(
      handle.storage.attachments.upload({
        ownerPrincipalId: newUuid(),
        fileName: "x.txt",
        mime: "",
        body: new TextEncoder().encode("y"),
        now: nextNow(2),
      }),
      (error: unknown) => isCloudStorageError(error) && error.reason === "attachment-type-rejected",
    );
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("清扫按保留期删除未引用对象（含对象文件），已引用对象保留", async () => {
  const handle = await openTestStorage({ attachmentLimits: { unreferencedRetentionMs: 1_000 } });
  try {
    const seeded = await seedDraftTask(handle.storage);
    const referenced = await handle.storage.attachments.upload({
      ownerPrincipalId: seeded.principalId,
      fileName: "referenced.txt",
      mime: "text/plain",
      body: new TextEncoder().encode("被引用"),
      now: nextNow(1),
    });
    const orphan = await handle.storage.attachments.upload({
      ownerPrincipalId: seeded.principalId,
      fileName: "orphan.txt",
      mime: "text/plain",
      body: new TextEncoder().encode("未被引用"),
      now: nextNow(2),
    });

    const seededRun = await seedActiveRun(handle.storage, seeded);
    await handle.storage.storage.runs.transitionStatus({
      runId: seededRun.runId,
      runGeneration: 1,
      from: ["provisioning"],
      to: "ready",
      now: nextNow(3),
    });
    const appended = await handle.storage.storage.acceptInput({
      taskId: seeded.taskId,
      commandId: newUuid(),
      intent: "append",
      payloadHash: "9".repeat(64),
      prompt: "引用附件",
      attachmentIds: [referenced.attachmentId],
      expectedRunGeneration: 1,
      quota: { maxConcurrentRuns: 8 },
      now: nextNow(4),
    });
    assert.equal(appended.status, "accepted", "引用附件必须先进入已发布状态");

    const sweep = await handle.storage.attachments.sweep(nextNow(10_000));
    assert.equal(sweep.removedRows, 1);
    assert.deepEqual(sweep.orphanShas, [orphan.attachmentId]);
    await assert.rejects(stat(handle.storage.attachments.objectPath(orphan.attachmentId)));
    assert.ok(await stat(handle.storage.attachments.objectPath(referenced.attachmentId)));
    assert.equal(
      (await handle.storage.attachments.get(seeded.principalId, referenced.attachmentId))
        ?.lastReferencedTaskId,
      seeded.taskId,
    );
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

test("清扫回收中断上传残留的临时对象", async () => {
  const handle = await openTestStorage({ attachmentLimits: { stagedTtlMs: 1_000 } });
  try {
    // 与 attachmentStore 的落盘约定一致：.part 直接放在 tmp/ 下。
    await mkdir(path.join(handle.attachmentsDir, "tmp"), { recursive: true });
    const staleFile = path.join(handle.attachmentsDir, "tmp", `${newUuid()}.part`);
    await writeFile(staleFile, "半截上传");
    const old = new Date(TEST_NOW - 60_000);
    await utimes(staleFile, old, old);

    const result = await handle.storage.attachments.sweep(TEST_NOW);
    assert.equal(result.removedRows, 0);
    await assert.rejects(stat(staleFile), "陈旧临时对象必须被清理");
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
});

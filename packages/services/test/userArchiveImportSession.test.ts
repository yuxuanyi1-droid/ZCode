/**
 * 分块导入会话状态机用例（specs/cloud-agent 14 §4.4；skill-sync 与 plugin-sync 共用实现）。
 *
 * 覆盖：begin 参数校验（sha 形状/总量上限/chunkCount 一致性）、正常收块水位、乱序/重复/
 * 越界拒绝、canonical base64 与单块上限、逐块与整包 sha256 校验、缺块 complete 拒绝、
 * 乱序并发下的串行化、abort/被新 begin 顶替后的会话不可达、空闲超时释放与临时缓冲清理。
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES } from "@zcode/shared";
import {
  createUserArchiveImportSession,
  isUserArchiveImportError,
  type UserArchiveImportSession,
} from "../src/remote-sync/userArchiveImportSession.js";

// 每次运行用唯一标签：临时缓冲目录计数不受上次运行（或并行文件）的残留影响。
const LABEL = `session-spec-${randomUUID().slice(0, 8)}`;
const MAX_CHUNK_BYTES = 4;
const MAX_ARCHIVE_BYTES = 32;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 每个用例一个独立标签：临时缓冲计数不被同文件其他用例的存活会话干扰。 */
function uniqueLabel(suffix: string): string {
  return `${LABEL}-${suffix}-${randomUUID().slice(0, 8)}`;
}

function createSession(
  label: string,
  options: {
    idleTimeoutMs?: number;
    maxChunkBytes?: number;
    maxArchiveBytes?: number;
    onDiscarded?: (info: { importId: string; reason: string }) => void;
  } = {},
): UserArchiveImportSession {
  return createUserArchiveImportSession({
    label,
    maxArchiveBytes: options.maxArchiveBytes ?? MAX_ARCHIVE_BYTES,
    maxChunkBytes: options.maxChunkBytes ?? MAX_CHUNK_BYTES,
    ...(options.idleTimeoutMs !== undefined ? { idleTimeoutMs: options.idleTimeoutMs } : {}),
    ...(options.onDiscarded ? { onSessionDiscarded: options.onDiscarded } : {}),
  });
}

function chunkOf(
  bytes: Uint8Array,
  index: number,
): {
  chunkIndex: number;
  chunkSha256: string;
  payloadBase64: string;
} {
  const slice = bytes.subarray(index * MAX_CHUNK_BYTES, (index + 1) * MAX_CHUNK_BYTES);
  return {
    chunkIndex: index,
    chunkSha256: sha256Hex(slice),
    payloadBase64: Buffer.from(slice).toString("base64"),
  };
}

function beginParamsFor(bytes: Uint8Array) {
  return {
    archiveSha256: sha256Hex(bytes),
    totalBytes: bytes.byteLength,
    chunkCount: Math.ceil(bytes.byteLength / MAX_CHUNK_BYTES),
  };
}

function assertImportErrorCode(error: unknown, code: string): void {
  assert.ok(isUserArchiveImportError(error), `expected UserArchiveImportError, got ${error}`);
  assert.equal(error.code, code);
  assert.equal(error.name, "UserArchiveImportError");
}

async function countBuffers(label: string): Promise<number> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith(`zcode-${label}-archive-import-`)).length;
}

test("begin validates sha shape, total bytes and chunk count consistency", async () => {
  const session = createSession(uniqueLabel("begin"));
  const payload = new Uint8Array([1, 2, 3, 4, 5]);
  const valid = beginParamsFor(payload);

  for (const [name, params] of [
    ["bad sha", { ...valid, archiveSha256: "NOT-A-SHA" }],
    ["zero bytes", { ...valid, totalBytes: 0, chunkCount: 1 }],
    ["negative bytes", { ...valid, totalBytes: -1, chunkCount: 1 }],
    ["over category limit", { ...valid, totalBytes: MAX_ARCHIVE_BYTES + 1, chunkCount: 9 }],
    ["fractional bytes", { ...valid, totalBytes: 2.5, chunkCount: 1 }],
    ["chunkCount too small", { ...valid, chunkCount: 1 }],
    ["chunkCount too large", { ...valid, chunkCount: payload.byteLength + 1 }],
    ["fractional chunks", { ...valid, chunkCount: 1.5 }],
  ] as const) {
    await assert.rejects(
      () => session.begin(params),
      (error: unknown) => {
        assertImportErrorCode(error, "invalid-begin-params");
        return true;
      },
      `${name} must be rejected`,
    );
  }

  // 合法下界：每块恰好 1 字节（chunkCount == totalBytes）也接受。
  const oneByteChunks = await session.begin({ ...valid, chunkCount: payload.byteLength });
  assert.ok(oneByteChunks.importId);
  await session.dispose();
});

test("chunked round-trip keeps the water level and returns the exact bytes", async () => {
  const session = createSession(uniqueLabel("roundtrip"));
  const payload = new TextEncoder().encode("abcdefghij");
  const { importId } = await session.begin(beginParamsFor(payload));
  const first = await session.append({ importId, ...chunkOf(payload, 0) });
  assert.deepEqual(first, { receivedChunks: 1, receivedBytes: MAX_CHUNK_BYTES });
  const second = await session.append({ importId, ...chunkOf(payload, 1) });
  assert.deepEqual(second, { receivedChunks: 2, receivedBytes: 8 });
  const third = await session.append({ importId, ...chunkOf(payload, 2) });
  assert.deepEqual(third, { receivedChunks: 3, receivedBytes: payload.byteLength });

  const assembled = await session.complete({ importId });
  assert.deepEqual([...assembled], [...payload]);
  // complete 后会话已释放：同一 importId 不可复用。
  await assert.rejects(
    () =>
      session.append({
        importId,
        chunkIndex: 0,
        chunkSha256: sha256Hex(payload),
        payloadBase64: "",
      }),
    (error: unknown) => {
      assertImportErrorCode(error, "import-not-found");
      return true;
    },
  );
});

test("append rejects out-of-order, duplicate, unknown and over-count chunks", async () => {
  const session = createSession(uniqueLabel("order"));
  const payload = new TextEncoder().encode("abcdefgh");
  const { importId } = await session.begin(beginParamsFor(payload));

  // 乱序：先发 index 1。
  await assert.rejects(
    () => session.append({ importId, ...chunkOf(payload, 1) }),
    (error: unknown) => {
      assertImportErrorCode(error, "chunk-out-of-order");
      return true;
    },
  );
  await session.append({ importId, ...chunkOf(payload, 0) });
  // 重复：index 0 已收，再发一次（幂等拒绝，不静默忽略）。
  await assert.rejects(
    () => session.append({ importId, ...chunkOf(payload, 0) }),
    (error: unknown) => {
      assertImportErrorCode(error, "chunk-out-of-order");
      return true;
    },
  );
  // 越界 index（等于 chunkCount）在收齐前也拒绝。
  await assert.rejects(
    () => session.append({ importId, ...chunkOf(payload, 2) }),
    (error: unknown) => {
      assertImportErrorCode(error, "chunk-out-of-order");
      return true;
    },
  );
  // 未知 importId。
  await assert.rejects(
    () =>
      session.append({ importId: "00000000-0000-4000-8000-000000000000", ...chunkOf(payload, 1) }),
    (error: unknown) => {
      assertImportErrorCode(error, "import-not-found");
      return true;
    },
  );
});

test("append validates canonical base64, chunk size and per-chunk sha256", async () => {
  const session = createSession(uniqueLabel("payload"));
  const payload = new TextEncoder().encode("abcdefgh");
  const { importId } = await session.begin(beginParamsFor(payload));
  const chunk = chunkOf(payload, 0);

  for (const [name, patch] of [
    ["non base64", { payloadBase64: "not base64!" }],
    ["misaligned", { payloadBase64: "AAA" }],
    ["empty payload", { payloadBase64: "" }],
    ["non canonical padding", { payloadBase64: "AAAAA" }],
    [
      "over chunk limit",
      { payloadBase64: Buffer.alloc(MAX_CHUNK_BYTES + 1, 1).toString("base64") },
    ],
    ["bad chunk sha", { payloadBase64: Buffer.from("zzzz").toString("base64") }],
    ["non hex sha", { chunkSha256: "zz" }],
  ] as const) {
    await assert.rejects(
      () => session.append({ importId, ...chunk, ...patch }),
      (error: unknown) => {
        assert.ok(isUserArchiveImportError(error));
        assert.ok(
          error.code === "chunk-payload-invalid" || error.code === "chunk-hash-mismatch",
          `${name} must be a payload/hash rejection, got ${error.code}`,
        );
        return true;
      },
      `${name} must be rejected`,
    );
  }

  // 解码字节超单块上限：用共享常量的真实上界验证（默认 maxChunkBytes）。
  const defaultChunkSession = createUserArchiveImportSession({
    label: uniqueLabel("default-chunk"),
    maxArchiveBytes: 64 * 1024 * 1024,
  });
  const hugeChunk = Buffer.alloc(USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES + 1, 3);
  const hugeBegin = await defaultChunkSession.begin({
    archiveSha256: sha256Hex(hugeChunk),
    totalBytes: hugeChunk.byteLength,
    // 每块 ≤2MiB：总量超过单块上限时分块数至少为 2（分块数下界由 begin 校验）。
    chunkCount: 2,
  });
  await assert.rejects(
    () =>
      defaultChunkSession.append({
        importId: hugeBegin.importId,
        chunkIndex: 0,
        chunkSha256: sha256Hex(hugeChunk),
        payloadBase64: hugeChunk.toString("base64"),
      }),
    (error: unknown) => {
      assertImportErrorCode(error, "chunk-payload-invalid");
      return true;
    },
  );
  await defaultChunkSession.dispose();
});

test("complete requires every chunk and the whole-archive sha256 (fail-closed)", async () => {
  const session = createSession(uniqueLabel("complete"));
  const payload = new TextEncoder().encode("abcdefgh");
  const { importId } = await session.begin(beginParamsFor(payload));
  await session.append({ importId, ...chunkOf(payload, 0) });

  // 缺块：complete 拒绝，会话仍在（调用方可以继续补块）。
  await assert.rejects(
    () => session.complete({ importId }),
    (error: unknown) => {
      assertImportErrorCode(error, "archive-incomplete");
      return true;
    },
  );
  await session.append({ importId, ...chunkOf(payload, 1) });

  // 整包 sha 不符：fail-closed 且会话立即释放（不留下可重试的"已收齐但坏"状态）。
  const mismatched = await session.begin({
    archiveSha256: "f".repeat(64),
    totalBytes: payload.byteLength,
    chunkCount: beginParamsFor(payload).chunkCount,
  });
  for (let index = 0; index < beginParamsFor(payload).chunkCount; index += 1) {
    await session.append({ importId: mismatched.importId, ...chunkOf(payload, index) });
  }
  await assert.rejects(
    () => session.complete({ importId: mismatched.importId }),
    (error: unknown) => {
      assertImportErrorCode(error, "archive-hash-mismatch");
      return true;
    },
  );
  await assert.rejects(
    () => session.append({ importId: mismatched.importId, ...chunkOf(payload, 0) }),
    (error: unknown) => {
      assertImportErrorCode(error, "import-not-found");
      return true;
    },
  );
});

test("abort releases the buffer and is idempotent; a new begin replaces the old session", async () => {
  const discarded: Array<{ importId: string; reason: string }> = [];
  const label = uniqueLabel("abort");
  const session = createSession(label, { onDiscarded: (info) => discarded.push(info) });
  const payload = new TextEncoder().encode("abcdefgh");
  const first = await session.begin(beginParamsFor(payload));
  assert.equal(await countBuffers(label), 1);

  // 被新 begin 顶替：旧会话不可达（有界资源，同一时刻最多 1 个会话）。
  const second = await session.begin(beginParamsFor(payload));
  assert.notEqual(second.importId, first.importId);
  await assert.rejects(
    () => session.append({ importId: first.importId, ...chunkOf(payload, 0) }),
    (error: unknown) => {
      assertImportErrorCode(error, "import-not-found");
      return true;
    },
  );
  assert.equal(await countBuffers(label), 1, "同一时刻只保留一个会话的缓冲");

  assert.deepEqual(await session.abort({ importId: second.importId }), { aborted: true });
  assert.deepEqual(
    await session.abort({ importId: second.importId }),
    { aborted: false },
    "重复 abort 幂等返回 false（不再抛）",
  );
  assert.deepEqual(await session.abort({ importId: "unknown" }), { aborted: false });
  assert.equal(await countBuffers(label), 0, "abort 后临时缓冲被清理");
  assert.deepEqual(
    discarded.map((info) => info.reason),
    ["replaced-by-begin", "aborted"],
  );
});

test("completed and timed-out sessions clean their buffers", async () => {
  const discarded: Array<{ importId: string; reason: string }> = [];
  const label = uniqueLabel("completed");
  const session = createSession(label, { onDiscarded: (info) => discarded.push(info) });
  const payload = new TextEncoder().encode("abcdefgh");
  const { importId } = await session.begin(beginParamsFor(payload));
  for (let index = 0; index < beginParamsFor(payload).chunkCount; index += 1) {
    await session.append({ importId, ...chunkOf(payload, index) });
  }
  await session.complete({ importId });
  assert.equal(await countBuffers(label), 0);
  assert.equal(discarded.at(-1)?.reason, "completed");

  // 空闲超时：不完成也不 abort 的会话由定时器释放，调用方需重新 begin。
  const timeoutLabel = uniqueLabel("timeout");
  const timeoutSession = createUserArchiveImportSession({
    label: timeoutLabel,
    maxArchiveBytes: MAX_ARCHIVE_BYTES,
    maxChunkBytes: MAX_CHUNK_BYTES,
    idleTimeoutMs: 20,
  });
  const timedOut = await timeoutSession.begin(beginParamsFor(payload));
  await timeoutSession.append({ importId: timedOut.importId, ...chunkOf(payload, 0) });
  await new Promise((resolve) => setTimeout(resolve, 80));
  await assert.rejects(
    () => timeoutSession.complete({ importId: timedOut.importId }),
    (error: unknown) => {
      assertImportErrorCode(error, "import-not-found");
      return true;
    },
  );
  assert.equal(await countBuffers(timeoutLabel), 0, "超时后临时缓冲被清理");
  await timeoutSession.dispose();
});

test("concurrent appends are serialized: exactly one chunk wins", async () => {
  const session = createSession(uniqueLabel("concurrent"));
  const payload = new TextEncoder().encode("abcdefgh");
  const { importId } = await session.begin(beginParamsFor(payload));
  const chunk = chunkOf(payload, 0);
  const [first, second] = await Promise.allSettled([
    session.append({ importId, ...chunk }),
    session.append({ importId, ...chunk }),
  ]);
  const fulfilled = [first, second].filter((result) => result.status === "fulfilled");
  const rejected = [first, second].filter((result) => result.status === "rejected");
  assert.equal(fulfilled.length, 1, "同一 index 的并发 append 只能有一个成功");
  assert.equal(rejected.length, 1, "另一个必须被严格递增判定拒绝（不能交错破坏水位）");
});

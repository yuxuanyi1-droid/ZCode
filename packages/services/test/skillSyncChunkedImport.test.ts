/**
 * skill-sync 分块导入用例（specs/cloud-agent 14 §4.4；控制面连接期同步通路）。
 *
 * 覆盖：正常收块 → complete 委派既有 importSkillsArchive 且结果与直接导入等价（含落盘内容）、
 * 重复同步的 skip 语义、乱序/坏 chunk sha/未知会话拒绝、abort 释放、类别上限与
 * 「同一时刻最多 1 个会话」（新 begin 顶替旧会话）。
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { createSkillSyncService } from "../src/skill-sync/skillSyncService.js";
import { createSkillSyncArchive } from "../src/skill-sync/skillSyncArchive.js";

const CHUNK_BYTES = 1024;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-skill-chunked-"));
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  process.env.HOME = home;
  delete process.env.USERPROFILE;
  try {
    await run(home);
  } finally {
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousUserProfile !== undefined) {
      process.env.USERPROFILE = previousUserProfile;
    }
    await rm(home, { recursive: true, force: true });
  }
}

/** 用既有打包实现生成真实归档（含 front-matter、正文与大文件，保证多块）。 */
async function buildSkillArchive(): Promise<Uint8Array> {
  const source = await mkdtemp(join(tmpdir(), "zcode-skill-source-"));
  try {
    const skillDir = join(source, "demo-skill");
    await mkdir(join(skillDir, "assets"), { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: demo-skill\ndescription: chunked import demo\n---\n\n# Demo\n",
      "utf-8",
    );
    // 随机内容不可压缩：保证 gzip 归档 > 单块大小（重复字符会被压到几十字节，
    // 分块路径根本不会被覆盖）。
    await writeFile(
      join(skillDir, "assets", "big.txt"),
      randomBytes(40_000).toString("base64"),
      "utf-8",
    );
    return await createSkillSyncArchive([{ sourcePath: skillDir, archivePath: "demo-skill" }]);
  } finally {
    await rm(source, { recursive: true, force: true });
  }
}

function chunksOf(bytes: Uint8Array): Array<{
  chunkIndex: number;
  chunkSha256: string;
  payloadBase64: string;
}> {
  const chunks: Array<{ chunkIndex: number; chunkSha256: string; payloadBase64: string }> = [];
  for (let offset = 0, index = 0; offset < bytes.byteLength; offset += CHUNK_BYTES, index += 1) {
    const slice = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
    chunks.push({
      chunkIndex: index,
      chunkSha256: sha256Hex(slice),
      payloadBase64: Buffer.from(slice).toString("base64"),
    });
  }
  return chunks;
}

async function collectTree(root: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else {
        result[relative(root, path).replaceAll("\\", "/")] = await readFile(path, "utf-8");
      }
    }
  }
  await walk(root);
  return result;
}

async function importChunked(
  homeService: ReturnType<typeof createSkillSyncService>,
  archive: Uint8Array,
) {
  const chunks = chunksOf(archive);
  const { importId } = await homeService.beginUserArchiveImport({
    archiveSha256: sha256Hex(archive),
    totalBytes: archive.byteLength,
    chunkCount: chunks.length,
  });
  for (const chunk of chunks) {
    await homeService.appendUserArchiveImportChunk({ importId, ...chunk });
  }
  return await homeService.completeUserArchiveImport({ importId });
}

test("chunked import equals a direct importSkillsArchive and lands identical files", async () => {
  const archive = await buildSkillArchive();
  assert.ok(chunksOf(archive).length > 1, "用例需要多块归档才能覆盖分块路径");

  let chunkedResult: Awaited<ReturnType<typeof importChunked>> | undefined;
  let chunkedTree: Record<string, string> = {};
  await withHome(async (home) => {
    chunkedResult = await importChunked(createSkillSyncService(), archive);
    chunkedTree = await collectTree(join(home, ".zcode", "skills"));
  });

  let directResult: Awaited<ReturnType<typeof importChunked>> | undefined;
  let directTree: Record<string, string> = {};
  await withHome(async (home) => {
    directResult = await createSkillSyncService().importSkillsArchive({ archive });
    directTree = await collectTree(join(home, ".zcode", "skills"));
  });

  // 委派既有实现：逐条结果（除落点 HOME 前缀）与落盘内容都必须与直接导入一致
  // （不新增第二份解包/校验）。
  const stripHome = (result: Awaited<ReturnType<typeof importChunked>>) => ({
    results: result.results.map((item) => ({
      ...item,
      ...(item.path ? { path: item.path.replace(/^.*\.zcode\/skills\//u, ".zcode/skills/") } : {}),
    })),
  });
  assert.deepEqual(
    chunkedResult && stripHome(chunkedResult),
    directResult && stripHome(directResult),
  );
  assert.deepEqual(chunkedTree, directTree);
  assert.equal(chunkedResult?.results[0]?.status, "synced");
  assert.equal(chunkedResult?.results[0]?.name, "demo-skill");
  assert.ok(
    Object.keys(chunkedTree).includes("demo-skill/SKILL.md"),
    `unexpected tree: ${Object.keys(chunkedTree).join(",")}`,
  );
});

test("chunked import keeps the skip semantics on a repeated sync", async () => {
  const archive = await buildSkillArchive();
  await withHome(async () => {
    const service = createSkillSyncService();
    const first = await importChunked(service, archive);
    assert.deepEqual(
      first.results.map((result) => result.status),
      ["synced"],
    );
    // 第二次同步（连接期自动/手动可任意次）：同名 skip，不覆盖既有落盘。
    const second = await importChunked(service, archive);
    assert.deepEqual(
      second.results.map((result) => result.status),
      ["skipped"],
    );
  });
});

test("chunked import rejects bad order, bad chunk sha and unknown sessions", async () => {
  const archive = await buildSkillArchive();
  const chunks = chunksOf(archive);
  await withHome(async () => {
    const service = createSkillSyncService();
    const { importId } = await service.beginUserArchiveImport({
      archiveSha256: sha256Hex(archive),
      totalBytes: archive.byteLength,
      chunkCount: chunks.length,
    });

    // 乱序：blocks[1] 先到。
    await assert.rejects(
      () => service.appendUserArchiveImportChunk({ importId, ...chunks[1]! }),
      /out of order/u,
    );
    // 坏 chunk sha：先到块的内容与声明摘要不符。
    await assert.rejects(
      () =>
        service.appendUserArchiveImportChunk({
          importId,
          chunkIndex: 0,
          chunkSha256: "f".repeat(64),
          payloadBase64: chunks[0]!.payloadBase64,
        }),
      /chunkSha256/u,
    );
    // 未知会话（未 begin / 已被释放）。
    await assert.rejects(
      () =>
        service.appendUserArchiveImportChunk({
          importId: "00000000-0000-4000-8000-000000000000",
          ...chunks[0]!,
        }),
      /session not found/u,
    );
    // 坏 begin 参数：整包 sha 不是 16 进制 sha256。
    await assert.rejects(
      () =>
        service.beginUserArchiveImport({
          archiveSha256: "not-a-sha",
          totalBytes: archive.byteLength,
          chunkCount: 1,
        }),
      /archiveSha256/u,
    );
  });
});

test("chunked import enforces the category limit and single-flight session", async () => {
  const archive = await buildSkillArchive();
  const chunks = chunksOf(archive);
  await withHome(async () => {
    // 类别上限（与 SSH 同为 20MiB；测试注入更小值验证判定发生在 begin）。
    const limited = createSkillSyncService({ maxArchiveBytes: 1024 });
    await assert.rejects(
      () =>
        limited.beginUserArchiveImport({
          archiveSha256: sha256Hex(archive),
          totalBytes: archive.byteLength,
          chunkCount: chunks.length,
        }),
      /exceeds the category archive limit/u,
    );

    // 同一时刻最多 1 个会话：新 begin 废弃旧会话（旧 importId 不可达）。
    const service = createSkillSyncService();
    const first = await service.beginUserArchiveImport({
      archiveSha256: sha256Hex(archive),
      totalBytes: archive.byteLength,
      chunkCount: chunks.length,
    });
    const second = await service.beginUserArchiveImport({
      archiveSha256: sha256Hex(archive),
      totalBytes: archive.byteLength,
      chunkCount: chunks.length,
    });
    assert.notEqual(second.importId, first.importId);
    await assert.rejects(
      () => service.appendUserArchiveImportChunk({ importId: first.importId, ...chunks[0]! }),
      /session not found/u,
    );
    // abort（控制面断连/放弃）：释放缓冲后重复 abort 幂等。
    assert.deepEqual(await service.abortUserArchiveImport({ importId: second.importId }), {
      aborted: true,
    });
    assert.deepEqual(await service.abortUserArchiveImport({ importId: second.importId }), {
      aborted: false,
    });
  });
});

test("complete fails closed when the assembled bytes do not match archiveSha256", async () => {
  const archive = await buildSkillArchive();
  const chunks = chunksOf(archive);
  await withHome(async () => {
    const service = createSkillSyncService();
    const { importId } = await service.beginUserArchiveImport({
      archiveSha256: "f".repeat(64),
      totalBytes: archive.byteLength,
      chunkCount: chunks.length,
    });
    for (const chunk of chunks) {
      await service.appendUserArchiveImportChunk({ importId, ...chunk });
    }
    await assert.rejects(
      () => service.completeUserArchiveImport({ importId }),
      /do not match archiveSha256/u,
    );
  });
});

/**
 * plugin-sync 分块导入用例（specs/cloud-agent 14 §4.4；控制面连接期同步通路）。
 *
 * 覆盖：正常收块 → complete 委派既有 importPluginsArchive 且结果与直接导入等价（含落盘与
 * `plugins.dirs`/`enabledPlugins` 注册）、重复同步 skip、乱序/坏 chunk sha/未知会话拒绝、
 * abort 与单飞、类别上限（50MiB 口径，测试注入更小值）与整包 sha 不符 fail-closed。
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPluginSyncService } from "../src/plugin-sync/pluginSyncService.js";
import { createPluginSyncArchive } from "../src/plugin-sync/pluginSyncArchive.js";

const CHUNK_BYTES = 1024;
const PLUGIN_NAME = "demo-plugin";

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withHome(run: (home: string) => Promise<void>): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "zcode-plugin-chunked-"));
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

/** 用既有打包实现生成真实归档（manifest + 不可压缩资源，保证多块）。 */
async function buildPluginArchive(): Promise<Uint8Array> {
  return await createPluginSyncArchive({
    entries: [
      {
        archivePath: `${PLUGIN_NAME}/.zcode-plugin/plugin.json`,
        content: `${JSON.stringify({ name: PLUGIN_NAME, version: "1.0.0" }, null, 2)}\n`,
      },
      {
        archivePath: `${PLUGIN_NAME}/assets/blob.txt`,
        content: randomBytes(40_000).toString("base64"),
      },
    ],
    metadata: {
      plugins: [
        {
          name: PLUGIN_NAME,
          pluginId: `${PLUGIN_NAME}@inline`,
          directoryName: PLUGIN_NAME,
          // 归档元数据显式带 enabled 时才有 enabledPlugins 注册（SSH 同款派生口径）。
          enabled: true,
        },
      ],
    },
  });
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

async function importChunked(
  service: ReturnType<typeof createPluginSyncService>,
  archive: Uint8Array,
) {
  const chunks = chunksOf(archive);
  const { importId } = await service.beginUserArchiveImport({
    archiveSha256: sha256Hex(archive),
    totalBytes: archive.byteLength,
    chunkCount: chunks.length,
  });
  for (const chunk of chunks) {
    await service.appendUserArchiveImportChunk({ importId, ...chunk });
  }
  return await service.completeUserArchiveImport({ importId });
}

async function readPluginsConfig(home: string): Promise<Record<string, unknown>> {
  const raw = await readFile(join(home, ".zcode", "cli", "config.json"), "utf-8");
  return JSON.parse(raw) as Record<string, unknown>;
}

test("chunked import equals a direct importPluginsArchive and registers the plugin", async () => {
  const archive = await buildPluginArchive();
  assert.ok(chunksOf(archive).length > 1, "用例需要多块归档才能覆盖分块路径");

  let chunkedResult: Awaited<ReturnType<typeof importChunked>> | undefined;
  let chunkedConfig: Record<string, unknown> | undefined;
  await withHome(async (home) => {
    chunkedResult = await importChunked(createPluginSyncService(), archive);
    chunkedConfig = await readPluginsConfig(home);
  });

  let directResult: Awaited<ReturnType<typeof importChunked>> | undefined;
  let directConfig: Record<string, unknown> | undefined;
  await withHome(async (home) => {
    directResult = await createPluginSyncService().importPluginsArchive({ archive });
    directConfig = await readPluginsConfig(home);
  });

  const stripHome = (result: Awaited<ReturnType<typeof importChunked>>) => ({
    results: result.results.map((item) => ({
      ...item,
      ...(item.path
        ? { path: item.path.replace(/^.*\.zcode\/plugins\//u, ".zcode/plugins/") }
        : {}),
    })),
  });
  assert.deepEqual(
    chunkedResult && stripHome(chunkedResult),
    directResult && stripHome(directResult),
  );
  assert.equal(chunkedResult?.results[0]?.status, "synced");
  assert.equal(chunkedResult?.results[0]?.pluginId, `${PLUGIN_NAME}@inline`);

  // 注册写入与直接导入同构：dirs 追加绝对路径、enabledPlugins 记 inline 键。
  const normalizeConfig = (config: Record<string, unknown> | undefined) => {
    const plugins = (config?.plugins ?? {}) as { dirs?: string[]; enabledPlugins?: unknown };
    return {
      dirs: (plugins.dirs ?? []).map((dir) =>
        dir.replace(/^.*\.zcode\/plugins\//u, ".zcode/plugins/"),
      ),
      enabledPlugins: plugins.enabledPlugins,
    };
  };
  assert.deepEqual(normalizeConfig(chunkedConfig), normalizeConfig(directConfig));
  assert.deepEqual(normalizeConfig(chunkedConfig).enabledPlugins, {
    [`${PLUGIN_NAME}@inline`]: true,
  });
  assert.deepEqual(normalizeConfig(chunkedConfig).dirs, [`.zcode/plugins/${PLUGIN_NAME}`]);
});

test("chunked import keeps the skip semantics on a repeated sync", async () => {
  const archive = await buildPluginArchive();
  await withHome(async () => {
    const service = createPluginSyncService();
    const first = await importChunked(service, archive);
    assert.deepEqual(
      first.results.map((result) => result.status),
      ["synced"],
    );
    const second = await importChunked(service, archive);
    assert.deepEqual(
      second.results.map((result) => result.status),
      ["skipped"],
    );
  });
});

test("chunked import rejects bad order, bad chunk sha, unknown sessions and oversized begin", async () => {
  const archive = await buildPluginArchive();
  const chunks = chunksOf(archive);
  await withHome(async () => {
    const service = createPluginSyncService();
    const { importId } = await service.beginUserArchiveImport({
      archiveSha256: sha256Hex(archive),
      totalBytes: archive.byteLength,
      chunkCount: chunks.length,
    });

    await assert.rejects(
      () => service.appendUserArchiveImportChunk({ importId, ...chunks[1]! }),
      /out of order/u,
    );
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
    await assert.rejects(
      () =>
        service.appendUserArchiveImportChunk({
          importId: "00000000-0000-4000-8000-000000000000",
          ...chunks[0]!,
        }),
      /session not found/u,
    );

    // 类别上限（与 SSH 同为 50MiB；测试注入更小值验证判定发生在 begin）。
    const limited = createPluginSyncService({ maxArchiveBytes: 1024 });
    await assert.rejects(
      () =>
        limited.beginUserArchiveImport({
          archiveSha256: sha256Hex(archive),
          totalBytes: archive.byteLength,
          chunkCount: chunks.length,
        }),
      /exceeds the category archive limit/u,
    );
  });
});

test("single-flight session, abort cleanup and archive sha fail-closed", async () => {
  const archive = await buildPluginArchive();
  const chunks = chunksOf(archive);
  await withHome(async () => {
    const service = createPluginSyncService();
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
    await assert.rejects(
      () => service.appendUserArchiveImportChunk({ importId: first.importId, ...chunks[0]! }),
      /session not found/u,
    );
    assert.deepEqual(await service.abortUserArchiveImport({ importId: second.importId }), {
      aborted: true,
    });
    assert.deepEqual(await service.abortUserArchiveImport({ importId: second.importId }), {
      aborted: false,
    });

    // 整包 sha 不符：fail-closed，不产生半安装（plugins 根为空）。
    const mismatched = await service.beginUserArchiveImport({
      archiveSha256: "f".repeat(64),
      totalBytes: archive.byteLength,
      chunkCount: chunks.length,
    });
    for (const chunk of chunks) {
      await service.appendUserArchiveImportChunk({ importId: mismatched.importId, ...chunk });
    }
    await assert.rejects(
      () => service.completeUserArchiveImport({ importId: mismatched.importId }),
      /do not match archiveSha256/u,
    );
    await assert.rejects(
      () => service.appendUserArchiveImportChunk({ importId: mismatched.importId, ...chunks[0]! }),
      /session not found/u,
    );
  });
});

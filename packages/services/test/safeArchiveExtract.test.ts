/**
 * 通用 tar+gzip 安全解包用例（specs/cloud-agent 14 §4.2/§9.3）。
 *
 * 覆盖：正常目录树/长路径（ustar prefix）、成员权限恢复、gzip magic、路径穿越/绝对路径、
 * symlink/hardlink/未知类型拒绝、单成员与总量上限、成员数上限、截断归档、空归档。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { extractSafeTarGzip } from "@zcode/services/archive";

const TAR_BLOCK = 512;

interface TarEntry {
  path: string;
  content?: string;
  typeFlag?: string;
  mode?: number;
  linkName?: string;
  usePrefix?: boolean;
  sizeOverride?: number;
}

function tarEntry(entry: TarEntry): Buffer {
  const content = Buffer.from(entry.content ?? "", "utf8");
  const size = entry.sizeOverride ?? (entry.typeFlag === "5" ? 0 : content.length);
  const header = Buffer.alloc(TAR_BLOCK);
  const writeString = (value: string, offset: number, length: number): void => {
    header.write(value, offset, Math.min(length, Buffer.byteLength(value, "utf8")), "utf8");
  };
  if (entry.usePrefix) {
    const segments = entry.path.split("/");
    const splitAt = Math.max(1, segments.length - 2);
    writeString(segments.slice(0, splitAt).join("/"), 345, 155);
    writeString(segments.slice(splitAt).join("/"), 0, 100);
  } else {
    writeString(entry.path, 0, 100);
  }
  writeString((entry.mode ?? 0o644).toString(8).padStart(8, "0").slice(-8), 100, 8);
  writeString(size.toString(8).padStart(12, "0").slice(-12), 124, 12);
  header.fill(0x20, 148, 156);
  writeString(entry.typeFlag ?? "0", 156, 1);
  writeString(entry.linkName ?? "", 157, 100);
  writeString("ustar", 257, 6);
  writeString("00", 263, 2);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  writeString(checksum.toString(8).padStart(6, "0").slice(-6), 148, 6);
  header[154] = 0;
  header[155] = 0x20;
  const padding = Buffer.alloc(Math.ceil(content.length / TAR_BLOCK) * TAR_BLOCK - content.length);
  return Buffer.concat([header, content, padding]);
}

function tarGzip(entries: readonly TarEntry[]): Uint8Array {
  const parts = entries.map((entry) => tarEntry(entry));
  parts.push(Buffer.alloc(TAR_BLOCK * 2));
  return gzipSync(Buffer.concat(parts));
}

async function workspace(): Promise<string> {
  return mkdtemp(join(tmpdir(), "safe-extract-"));
}

test("正常解包：目录树落盘、长路径走 ustar prefix、可执行位按归档头恢复", async () => {
  const target = await workspace();
  const longDir = `dir-${"x".repeat(90)}/nested-${"y".repeat(60)}`;
  const archive = tarGzip([
    { path: "skill/", typeFlag: "5" },
    { path: "skill/SKILL.md", content: "# skill" },
    { path: "skill/scripts/run.sh", content: "#!/bin/sh\necho hi\n", mode: 0o755 },
    { path: `${longDir}/file.md`, content: "long path", usePrefix: true },
  ]);
  const result = await extractSafeTarGzip(archive, target, {
    maxExtractedBytes: 1024 * 1024,
    restoreEntryMode: true,
  });
  assert.deepEqual([...result.topLevel], ["skill", "dir-" + "x".repeat(90)]);
  assert.ok(result.extractedBytes > 0);
  assert.equal(await readFile(join(target, "skill", "SKILL.md"), "utf8"), "# skill");
  assert.equal(await readFile(join(target, longDir, "file.md"), "utf8"), "long path");
  if (process.platform !== "win32") {
    assert.equal((await stat(join(target, "skill", "scripts", "run.sh"))).mode & 0o777, 0o755);
  }
});

test("gzip magic 前置校验：非 gzip 直接拒绝（不改扩展名/不猜格式）", async () => {
  const target = await workspace();
  await assert.rejects(
    () => extractSafeTarGzip(Buffer.from("not gzip at all"), target, { maxExtractedBytes: 1024 }),
    /gzip magic/,
  );
  const zipLike = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
  await assert.rejects(
    () => extractSafeTarGzip(zipLike, target, { maxExtractedBytes: 1024 }),
    /gzip magic/,
  );
});

test("路径穿越/绝对路径/反斜杠/盘符一律拒绝", async () => {
  const cases = ["../escape.md", "/etc/escape.md", "dir/../../escape.md", "a\\b.md", "C:/x.md"];
  for (const badPath of cases) {
    const target = await workspace();
    const archive = tarGzip([{ path: badPath, content: "x" }]);
    await assert.rejects(
      () => extractSafeTarGzip(archive, target, { maxExtractedBytes: 1024 }),
      /unsafe archive path/,
      `${badPath} 必须被拒绝`,
    );
    assert.equal(existsSync(join(target, "escape.md")), false);
  }
});

test("symlink/hardlink/未知成员类型拒绝（不落到目标树再判越界）", async () => {
  for (const typeFlag of ["1", "2", "3", "6", "7"]) {
    const target = await workspace();
    const archive = tarGzip([{ path: "link", typeFlag, linkName: "/etc/passwd" }]);
    await assert.rejects(
      () => extractSafeTarGzip(archive, target, { maxExtractedBytes: 1024 }),
      /unsupported archive entry type/,
      `typeflag ${typeFlag} 必须被拒绝`,
    );
  }
});

test("上限：单成员、解包总量、成员数三重上限都拒绝", async () => {
  const target = await workspace();
  const big = "a".repeat(2048);
  await assert.rejects(
    () =>
      extractSafeTarGzip(tarGzip([{ path: "big.bin", content: big }]), target, {
        maxExtractedBytes: 4096,
        maxEntryBytes: 1024,
      }),
    /entry exceeds limit/,
  );
  await assert.rejects(
    () =>
      extractSafeTarGzip(
        tarGzip([
          { path: "a.bin", content: "a".repeat(1024) },
          { path: "b.bin", content: "b".repeat(1024) },
        ]),
        target,
        { maxExtractedBytes: 1536 },
      ),
    /extracted content exceeds limit/,
  );
  await assert.rejects(
    () =>
      extractSafeTarGzip(tarGzip([{ path: "a.md", content: "x" }]), target, {
        maxExtractedBytes: 1024,
        maxEntries: 0,
      }),
    /entry count exceeds limit/,
  );
});

test("截断归档、损坏成员大小、空归档：明确失败", async () => {
  const target = await workspace();
  const full = tarGzip([{ path: "a.md", content: "hello" }]);
  await assert.rejects(
    () =>
      extractSafeTarGzip(full.subarray(0, Math.floor(full.length / 2)), target, {
        maxExtractedBytes: 1024,
      }),
    /truncated|invalid|unexpected/i,
  );

  // 声明大小 4096 但没有数据（截断成员）。
  const lyingSize = tarGzip([{ path: "a.bin", content: "short", sizeOverride: 4096 }]);
  await assert.rejects(
    () => extractSafeTarGzip(lyingSize, target, { maxExtractedBytes: 1024 * 1024 }),
    /truncated|exceeds limit/,
  );

  // 空归档（只有结束块）：解包成功但没有任何顶层条目（调用方据此 fail-closed）。
  const empty = tarGzip([]);
  const result = await extractSafeTarGzip(empty, target, { maxExtractedBytes: 1024 });
  assert.deepEqual([...result.topLevel], []);
  assert.equal(result.entries, 0);
});

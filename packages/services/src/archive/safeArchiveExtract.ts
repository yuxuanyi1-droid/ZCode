/**
 * 通用 tar+gzip 安全解包（specs/cloud-agent 14 §4.2/§9.3）：云沙箱资源安装器的
 * **权威解包校验**实现，也是 services 包对这类归档的唯一通用入口
 * （`@zcode/services/archive`）。
 *
 * 为什么与 SSH 同步的 `skillSyncArchive`/`pluginSyncArchive` 并存而不是直接复用：
 * 那两个 extract 与各自的 UI 错误码契约（`createSkillSyncSizeLimitError` 的结构化
 * `data.phase`）、plugin 元数据（`.zcode-plugin-sync.json`）与模式恢复语义耦合，
 * 且缺 gzip magic 前置校验。本文件按 14 §9.3 的冻结语义提供**更严**的通用版本：
 * - gzip magic（`0x1f 0x8b`）前置校验，非 gzip 直接拒绝；
 * - 流式解包（增量校验），先于内存膨胀被截断，不做整体 gunzip 缓冲；
 * - 成员路径穿越/绝对路径/驱动器盘符/反斜杠一律拒绝，目标根越界拒绝；
 * - symlink/hardlink/长名扩展等非常规成员类型一律拒绝（不落到目标树里再判越界）；
 * - 成员数、单成员字节、解包总字节（调用方按类别上限 ×4 传入）三重上限；
 * - 目录成员只建目录，文件成员按 `fileMode` 落盘（可执行位由调用方决定）。
 *
 * 三处归档解包（SSH skill/plugin sync、云安装器）收敛为同一实现列为悬项
 * （14 §9.3），收敛前任何一侧都不得复制本文件的校验逻辑。
 */
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createGunzip } from "node:zlib";

const TAR_BLOCK_SIZE = 512;
const DEFAULT_MAX_ENTRIES = 8192;
const DEFAULT_FILE_MODE = 0o644;
const GZIP_MAGIC_FIRST = 0x1f;
const GZIP_MAGIC_SECOND = 0x8b;

export interface SafeArchiveExtractOptions {
  /** 解包后**成员数据**总字节上限（目录头不计）；必须显式给出（调用方按类别上限 ×4）。 */
  maxExtractedBytes: number;
  /** 单成员数据字节上限（缺省 = 总上限）。 */
  maxEntryBytes?: number;
  /** 成员数上限（目录 + 文件；缺省 8192）。 */
  maxEntries?: number;
  /** 新建文件的权限（缺省 0o644；`restoreEntryMode` 为 true 时被归档头覆盖）。 */
  fileMode?: number;
  /** 按归档头的 mode 恢复文件权限（plugin 脚本的可执行位需要，SSH 同步同款）。 */
  restoreEntryMode?: boolean;
  /** 路径越界错误的标签（默认 "unsafe archive path"）。 */
  unsafePathLabel?: string;
}

export interface SafeArchiveExtractResult {
  /** 成员总数（含目录）。 */
  entries: number;
  /** 成员数据总字节。 */
  extractedBytes: number;
  /** 解包树的顶层条目名（去重、按首次出现顺序）——调用方据此决定安装/rename 的单元。 */
  topLevel: readonly string[];
}

/**
 * 解包 `archive`（tar+gzip）到 `targetDir`；任何校验失败抛错且**不留半解包状态**
 * （调用方负责清理解包目录——解包目录由调用方创建在目标根下的临时位置）。
 */
export async function extractSafeTarGzip(
  archive: Uint8Array,
  targetDir: string,
  options: SafeArchiveExtractOptions,
): Promise<SafeArchiveExtractResult> {
  if (archive.length < 2 || archive[0] !== GZIP_MAGIC_FIRST || archive[1] !== GZIP_MAGIC_SECOND) {
    throw new Error("archive is not gzip (gzip magic missing)");
  }
  const maxEntryBytes = options.maxEntryBytes ?? options.maxExtractedBytes;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const unsafePathLabel = options.unsafePathLabel ?? "unsafe archive path";
  const fileMode = options.fileMode ?? DEFAULT_FILE_MODE;
  const targetRoot = resolve(targetDir);
  await mkdir(targetRoot, { recursive: true });

  const input = Readable.from([Buffer.from(archive)]);
  const gunzip = createGunzip();
  const reader = new TarStreamReader(input.pipe(gunzip));
  const topLevel: string[] = [];
  const seenTopLevel = new Set<string>();
  let entries = 0;
  let extractedBytes = 0;

  try {
    while (true) {
      const header = await reader.readExactly(TAR_BLOCK_SIZE);
      if (header === null) break;
      if (header.every((byte) => byte === 0)) {
        await reader.drain();
        break;
      }
      entries += 1;
      if (entries > maxEntries) {
        throw new Error(`archive entry count exceeds limit: ${entries}/${maxEntries}`);
      }

      const size = readTarOctal(header, 124, 12);
      if (!Number.isSafeInteger(size) || size < 0) {
        throw new Error("invalid archive entry size");
      }
      const typeFlag = readTarString(header, 156, 1) || "0";
      const archivePath = normalizeArchivePath(readTarEntryPath(header), unsafePathLabel);
      const segments = archivePath.split("/");
      const first = segments[0]!;
      if (!seenTopLevel.has(first)) {
        seenTopLevel.add(first);
        topLevel.push(first);
      }
      const targetPath = resolveWithin(targetRoot, archivePath, unsafePathLabel);

      if (typeFlag === "5") {
        await reader.skipExactly(tarPaddedBytes(size));
        await mkdir(targetPath, { recursive: true });
        continue;
      }
      if (typeFlag !== "0" && typeFlag !== "\0") {
        // symlink（2）/hardlink（1）/pax 与 GNU 长名扩展（x/g/L）等一律拒绝：不把可指向
        // 目标根之外的成员类型落到文件系统上（14 §9.3「symlink 越界拒绝」的最严口径）。
        throw new Error(`unsupported archive entry type: ${typeFlag}`);
      }
      if (size > maxEntryBytes) {
        throw new Error(`archive entry exceeds limit: ${size}/${maxEntryBytes}`);
      }
      const nextExtractedBytes = extractedBytes + size;
      if (
        !Number.isSafeInteger(nextExtractedBytes) ||
        nextExtractedBytes > options.maxExtractedBytes
      ) {
        throw new Error(
          `archive extracted content exceeds limit: ${nextExtractedBytes}/${options.maxExtractedBytes}`,
        );
      }

      const data = await reader.readExactly(size);
      if (data === null) {
        throw new Error("truncated archive entry");
      }
      await reader.skipExactly(tarPaddedBytes(size) - size);
      await mkdir(dirname(targetPath), { recursive: true });
      const mode = options.restoreEntryMode ? readTarMode(header) : fileMode;
      await writeFile(targetPath, data, { mode });
      if (options.restoreEntryMode && process.platform !== "win32") {
        // writeFile 新建文件受进程 umask 影响；可执行位必须按归档头恢复（plugin 脚本同款）。
        await chmod(targetPath, mode);
      }
      extractedBytes = nextExtractedBytes;
    }
  } finally {
    // 超限或损坏时主动销毁流：不让 gunzip 在后台继续膨胀或触发未处理错误。
    input.destroy();
    gunzip.destroy();
  }

  return { entries, extractedBytes, topLevel };
}

function tarPaddedBytes(size: number): number {
  return Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
}

/** 归一化 + 穿越防护：只接受相对、无 `..`/空段/盘符/反斜杠的 posix 路径。 */
export function normalizeArchivePath(path: string, unsafePathLabel: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/u, "").replace(/\/+$/u, "");
  if (
    !normalized ||
    isAbsolute(path) ||
    posix.isAbsolute(path) ||
    path.includes("\\") ||
    /^[a-zA-Z]:/u.test(path) ||
    normalized.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(`${unsafePathLabel}: ${path}`);
  }
  return normalized;
}

/** 解析到目标根内：`resolve` 后必须仍是目标根的严格子路径（越界即拒绝）。 */
export function resolveWithin(
  targetRoot: string,
  archivePath: string,
  unsafePathLabel: string,
): string {
  const normalizedRoot = resolve(targetRoot);
  const normalizedPath = normalizeArchivePath(archivePath, unsafePathLabel);
  const targetPath = resolve(normalizedRoot, ...normalizedPath.split("/"));
  const relativePath = relative(normalizedRoot, targetPath);
  if (
    relativePath === "" ||
    relativePath.startsWith(`..${sep}`) ||
    relativePath === ".." ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`${unsafePathLabel}: ${archivePath}`);
  }
  return targetPath;
}

/** tar 流的定长读取器（跨 chunk 拼接；EOF 与截断区分对待）。 */
class TarStreamReader {
  private readonly iterator: AsyncIterator<Buffer>;
  private readonly chunks: Buffer[] = [];
  private bufferedBytes = 0;
  private done = false;

  constructor(stream: AsyncIterable<Buffer>) {
    this.iterator = stream[Symbol.asyncIterator]();
  }

  async readExactly(byteCount: number): Promise<Buffer | null> {
    if (byteCount === 0) return Buffer.alloc(0);
    await this.fill(byteCount);
    if (this.bufferedBytes === 0) return null;
    if (this.bufferedBytes < byteCount) throw new Error("truncated archive");
    const output = Buffer.allocUnsafe(byteCount);
    this.consume(byteCount, output);
    return output;
  }

  async skipExactly(byteCount: number): Promise<void> {
    if (byteCount === 0) return;
    await this.fill(byteCount);
    if (this.bufferedBytes < byteCount) throw new Error("truncated archive");
    this.consume(byteCount);
  }

  async drain(): Promise<void> {
    while (!this.done) {
      const next = await this.iterator.next();
      if (next.done) this.done = true;
    }
  }

  private async fill(byteCount: number): Promise<void> {
    while (!this.done && this.bufferedBytes < byteCount) {
      const next = await this.iterator.next();
      if (next.done) {
        this.done = true;
        break;
      }
      if (next.value.length === 0) continue;
      this.chunks.push(next.value);
      this.bufferedBytes += next.value.length;
    }
  }

  private consume(byteCount: number, output?: Buffer): void {
    let remaining = byteCount;
    let outputOffset = 0;
    while (remaining > 0) {
      const chunk = this.chunks[0];
      if (!chunk) throw new Error("truncated archive");
      const consumed = Math.min(remaining, chunk.length);
      if (output) {
        chunk.copy(output, outputOffset, 0, consumed);
        outputOffset += consumed;
      }
      if (consumed === chunk.length) this.chunks.shift();
      else this.chunks[0] = chunk.subarray(consumed);
      this.bufferedBytes -= consumed;
      remaining -= consumed;
    }
  }
}

function readTarEntryPath(header: Buffer): string {
  const name = readTarString(header, 0, 100);
  const prefix = readTarString(header, 345, 155);
  return prefix ? `${prefix}/${name}` : name;
}

function readTarString(buffer: Buffer, offset: number, length: number): string {
  const slice = buffer.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function readTarOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = readTarString(buffer, offset, length).trim();
  return raw ? Number.parseInt(raw, 8) : 0;
}

/** 归档头的 mode（仅取 0o777 位；非法/为 0 时回落 0o644）。 */
function readTarMode(header: Buffer): number {
  const mode = readTarOctal(header, 100, 8);
  if (!Number.isFinite(mode) || mode <= 0) return DEFAULT_FILE_MODE;
  return mode & 0o777;
}

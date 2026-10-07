/**
 * 受控附件存储（03 §4「先写临时对象、校验、原子发布，之后在输入事务中引用」、
 * W2 §5「附件不得引用浏览器临时路径」）。
 *
 * 落盘顺序保证「已发布行 ⇒ 对象文件存在」：
 *   临时对象（tmp/<uuid>.part，边写边算 sha256/字节数）
 *   → 校验（大小/类型/哈希）
 *   → 原子发布（rename 到 objects/<ab>/<sha256>，同文件系统内 rename 是原子的）
 *   → 元数据经 worker 持久（随后才能在接纳事务里被引用）。
 * 崩溃最多留下未被引用的 tmp/对象文件，由清扫按保留期回收；反之不会出现
 * 「数据库有引用、磁盘没有字节」。
 *
 * 文件级操作在同一进程内用串行锁互斥：发布与清扫不会交错，避免清扫删掉正在发布
 * 的对象（单控制面进程模型，03 §4）。
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AttachmentObjectRecord, AttachmentLimits } from "./attachmentTypes.js";
import {
  DEFAULT_ATTACHMENT_LIMITS,
  isAttachmentId,
  sanitizeAttachmentFileName,
} from "./attachmentTypes.js";
import { CloudStorageError } from "../cloudStorageError.js";
import type { StorageTransport } from "../storageTransport.js";

export interface AttachmentUploadRequest {
  ownerPrincipalId: string;
  fileName: string;
  mime: string;
  /** HTTP 流或内存缓冲；两者都按块写入临时对象。 */
  body: AsyncIterable<Uint8Array> | Uint8Array;
  taskId?: string;
  now: number;
}

export interface CloudAttachmentStore {
  /** 上传并发布，返回 owner 级持久引用（03 §6 附件端点）。 */
  upload(request: AttachmentUploadRequest): Promise<AttachmentObjectRecord>;
  get(ownerPrincipalId: string, attachmentId: string): Promise<AttachmentObjectRecord | null>;
  /** 对象文件绝对路径；attachmentId 形状非法时抛错，不接受任意路径。 */
  objectPath(attachmentId: string): string;
  /** 清扫未引用对象；返回删除行数与真正孤立的内容地址。 */
  sweep(now: number): Promise<{ removedRows: number; orphanShas: string[] }>;
}

export interface CloudAttachmentStoreOptions {
  dir: string;
  transport: StorageTransport;
  limits?: Partial<AttachmentLimits>;
}

export function createCloudAttachmentStore(
  options: CloudAttachmentStoreOptions,
): CloudAttachmentStore {
  const limits = { ...DEFAULT_ATTACHMENT_LIMITS, ...options.limits };
  const tmpDir = path.join(options.dir, "tmp");
  const objectsDir = path.join(options.dir, "objects");
  let queue: Promise<unknown> = Promise.resolve();

  /** 串行锁：发布/重命名/清扫互斥，失败不阻断后续操作。 */
  function withLock<T>(run: () => Promise<T>): Promise<T> {
    const result = queue.then(run, run);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  function objectPath(attachmentId: string): string {
    if (!isAttachmentId(attachmentId)) {
      throw new CloudStorageError({
        code: "validation_failed",
        reason: "invalid-record",
        message: "附件引用形状非法",
      });
    }
    return path.join(objectsDir, attachmentId.slice(0, 2), attachmentId);
  }

  async function stageToTmp(
    request: AttachmentUploadRequest,
  ): Promise<{ tmpPath: string; sha256: string; byteSize: number }> {
    await mkdir(tmpDir, { recursive: true });
    const tmpPath = path.join(tmpDir, `${randomUUID()}.part`);
    const hash = createHash("sha256");
    let byteSize = 0;
    const handle = await open(tmpPath, "wx");
    try {
      const chunks: AsyncIterable<Uint8Array> =
        request.body instanceof Uint8Array ? singleChunk(request.body) : request.body;
      for await (const chunk of chunks) {
        byteSize += chunk.byteLength;
        if (byteSize > limits.maxBytes) {
          throw new CloudStorageError({
            code: "validation_failed",
            reason: "attachment-too-large",
            message: `附件超过上限 ${limits.maxBytes} 字节`,
          });
        }
        hash.update(chunk);
        await handle.write(chunk);
      }
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { tmpPath, sha256: hash.digest("hex"), byteSize };
  }

  return {
    // async：参数校验失败也必须表现为 rejected promise，不能同步抛出绕过异步端口语义。
    async upload(request) {
      const fileName = sanitizeAttachmentFileName(request.fileName, limits.maxFileNameChars);
      const mime = normalizeMime(request.mime);
      return withLock(async () => {
        // 失败时残留的 tmp 文件没有数据库行，由 sweep 按 stagedTtlMs 回收。
        const staged = await stageToTmp(request);
        try {
          const target = objectPath(staged.sha256);
          await mkdir(path.dirname(target), { recursive: true });
          // 原子发布：同文件系统内 rename 不会留下半写文件。
          await rename(staged.tmpPath, target);
        } catch (error) {
          await rm(staged.tmpPath, { force: true }).catch(() => undefined);
          throw new CloudStorageError({
            code: "recovery_required",
            reason: "database-error",
            message: "附件对象发布失败",
            cause: error,
          });
        }
        return (await options.transport.request("attachments.publish", {
          ownerPrincipalId: request.ownerPrincipalId,
          sha256: staged.sha256,
          fileName,
          mime,
          byteSize: staged.byteSize,
          taskId: request.taskId,
          now: request.now,
        })) as AttachmentObjectRecord;
      });
    },

    get: async (ownerPrincipalId, attachmentId) =>
      (await options.transport.request("attachments.get", {
        ownerPrincipalId,
        attachmentId,
      })) as AttachmentObjectRecord | null,

    objectPath,

    sweep: (now) =>
      withLock(async () => {
        const result = (await options.transport.request("attachments.sweep", {
          now,
          stagedTtlMs: limits.stagedTtlMs,
          unreferencedRetentionMs: limits.unreferencedRetentionMs,
          limit: 512,
        })) as { removedRows: number; orphanShas: string[] };
        for (const sha256 of result.orphanShas) {
          await rm(path.join(objectsDir, sha256.slice(0, 2), sha256), { force: true }).catch(
            () => undefined,
          );
        }
        await sweepStagedFiles(tmpDir, now - limits.stagedTtlMs);
        return result;
      }),
  };
}

async function* singleChunk(chunk: Uint8Array): AsyncIterable<Uint8Array> {
  yield chunk;
}

/** 回收中断上传留下的临时对象（没有数据库行，只能按 mtime 判定）。 */
async function sweepStagedFiles(tmpDir: string, before: number): Promise<void> {
  let entries;
  try {
    entries = await readdir(tmpDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".part")) continue;
    const filePath = path.join(tmpDir, entry.name);
    try {
      const stats = await stat(filePath);
      if (stats.mtimeMs <= before) await rm(filePath, { force: true });
    } catch {
      // 已被其他清理路径删除：忽略。
    }
  }
}

function normalizeMime(mime: string): string {
  const trimmed = mime.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 128 || trimmed.includes("\n")) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "attachment-type-rejected",
      message: "附件 MIME 形状非法",
    });
  }
  return trimmed;
}

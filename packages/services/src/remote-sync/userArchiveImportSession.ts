/**
 * 用户级归档分块导入会话（specs/cloud-agent 14 §4.4；skill-sync 与 plugin-sync 共用）。
 *
 * 归档 ≤50MiB 而单帧 RPC ≤4MiB，因此大归档按「收块缓冲 → 复用既有导入实现」传输：
 * `begin` 建立会话（同一实例同一时刻最多 1 个，新 `begin` 废弃旧会话），`append` 逐块
 * 入缓冲（`chunkIndex` 严格从 0 递增；先核对 `chunkSha256` 再落盘，缺块/乱序/重复一律
 * 拒绝），`complete` 收齐后核对整包 `archiveSha256` 并返回字节（调用方交给既有导入实现，
 * 本文件不做解包——解包/校验仍是既有导入链路的职责），`abort`/空闲超时释放缓冲。
 *
 * 缓冲落在临时文件而不是内存（14 §4.4：避免大归档常驻内存），因此单会话内存峰值只有
 * 单块大小；`complete` 组装完整字节（既有导入入口接受 `Uint8Array`）。
 *
 * 串行化：Node 单线程但各操作含 `await`，两个并发 `append` 会交错破坏"严格递增"判定，
 * 故所有操作经内部单飞队列串行执行（同一服务同一时刻至多一个导入会话的语义由此保证）。
 */
import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES,
  type UserArchiveImportAbortParams,
  type UserArchiveImportAbortResult,
  type UserArchiveImportAppendChunkParams,
  type UserArchiveImportAppendChunkResult,
  type UserArchiveImportBeginParams,
  type UserArchiveImportBeginResult,
  type UserArchiveImportCompleteParams,
} from "@zcode/shared";

const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/** 空闲超时默认值：60s 无新块即释放缓冲（14 §4.4 的"超时释放"；调用方需重新 begin）。 */
const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

const ARCHIVE_FILE_NAME = "archive.bin";

export type UserArchiveImportErrorCode =
  | "invalid-begin-params"
  | "import-not-found"
  | "chunk-out-of-order"
  | "chunk-payload-invalid"
  | "chunk-hash-mismatch"
  | "archive-incomplete"
  | "archive-hash-mismatch";

/**
 * 分块导入错误：`code` 为稳定原因（跨 RPC 后仍可区分），`data` 只带数值/字节水位，
 * **不带归档正文**（14 §5 凭据边界：诊断只记 category/entryId/sha256/bytes）。
 */
export interface UserArchiveImportError extends Error {
  code: UserArchiveImportErrorCode;
  data?: Readonly<Record<string, number | string>>;
}

export function isUserArchiveImportError(error: unknown): error is UserArchiveImportError {
  return error instanceof Error && "code" in error;
}

function createImportError(
  code: UserArchiveImportErrorCode,
  message: string,
  data?: Record<string, number | string>,
): UserArchiveImportError {
  const error = new Error(message) as UserArchiveImportError;
  error.name = "UserArchiveImportError";
  error.code = code;
  if (data) {
    error.data = Object.freeze({ ...data });
  }
  return error;
}

export interface UserArchiveImportSessionOptions {
  /** 诊断标签（"skill-sync" / "plugin-sync"）：只进错误消息与日志，不进协议。 */
  label: string;
  /** 类别归档上限（原始字节）：skills 20MiB / plugins 50MiB（14 §4.3/§4.4）。 */
  maxArchiveBytes: number;
  /** 单块原始字节上限（默认 `USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES`；测试可调小）。 */
  maxChunkBytes?: number;
  /** 空闲超时（默认 60s）。 */
  idleTimeoutMs?: number;
  /** 注入时钟（测试用；默认 `Date.now`）。 */
  now?: () => number;
  /** 会话被释放时的回调（超时/被新 begin 顶替/abort/complete 后清理），供服务记日志。 */
  onSessionDiscarded?: (info: { importId: string; reason: string }) => void;
}

export interface UserArchiveImportSession {
  begin(params: UserArchiveImportBeginParams): Promise<UserArchiveImportBeginResult>;
  append(params: UserArchiveImportAppendChunkParams): Promise<UserArchiveImportAppendChunkResult>;
  /** 收齐并核对整包 sha256 后返回归档字节；会话已被释放（无论成功或失败）。 */
  complete(params: UserArchiveImportCompleteParams): Promise<Uint8Array>;
  abort(params: UserArchiveImportAbortParams): Promise<UserArchiveImportAbortResult>;
  /** 释放当前会话与定时器（服务卸载/测试收尾）。 */
  dispose(): Promise<void>;
}

interface ActiveSession {
  importId: string;
  archiveSha256: string;
  totalBytes: number;
  chunkCount: number;
  receivedChunks: number;
  receivedBytes: number;
  tempDir: string;
  archivePath: string;
  expiresAtMs: number;
  timer?: NodeJS.Timeout;
}

export function createUserArchiveImportSession(
  options: UserArchiveImportSessionOptions,
): UserArchiveImportSession {
  const maxChunkBytes = options.maxChunkBytes ?? USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES;
  const maxChunkBase64Chars = Math.ceil(maxChunkBytes / 3) * 4;
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const now = options.now ?? Date.now;

  let session: ActiveSession | null = null;
  let queue: Promise<unknown> = Promise.resolve();

  /** 所有入口经此串行执行：并发 append 不得交错（否则严格递增判定会被破坏）。 */
  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async function discardSession(current: ActiveSession, reason: string): Promise<void> {
    clearSessionTimer(current);
    if (session?.importId === current.importId) {
      session = null;
    }
    await rm(current.tempDir, { recursive: true, force: true }).catch(() => {
      // 释放缓冲是 best-effort：临时目录残留不改变导入结论（下次 begin 用新目录）。
    });
    options.onSessionDiscarded?.({ importId: current.importId, reason });
  }

  function clearSessionTimer(current: ActiveSession): void {
    if (current.timer !== undefined) {
      clearTimeout(current.timer);
      current.timer = undefined;
    }
  }

  function armIdleTimer(current: ActiveSession): void {
    current.timer = setTimeout(() => {
      void enqueue(async () => {
        if (session?.importId !== current.importId) return;
        await discardSession(current, "idle-timeout");
      });
    }, idleTimeoutMs);
    // 不因导入会话挂起进程生命周期（服务常驻，但测试/CLI 语境下必须可自然退出）。
    current.timer.unref?.();
  }

  function requireSession(importId: string): ActiveSession {
    const current = session;
    if (!current || current.importId !== importId) {
      throw createImportError(
        "import-not-found",
        `${options.label} archive import session not found (expired, aborted or replaced)`,
      );
    }
    if (now() >= current.expiresAtMs) {
      throw createImportError(
        "import-not-found",
        `${options.label} archive import session expired after ${idleTimeoutMs}ms idle`,
      );
    }
    return current;
  }

  function touch(current: ActiveSession): void {
    current.expiresAtMs = now() + idleTimeoutMs;
    clearSessionTimer(current);
    armIdleTimer(current);
  }

  function validateBeginParams(params: UserArchiveImportBeginParams): void {
    const reject = (reason: string, data?: Record<string, number | string>) => {
      throw createImportError(
        "invalid-begin-params",
        `${options.label} archive import begin rejected: ${reason}`,
        data,
      );
    };
    if (!SHA256_HEX_PATTERN.test(params.archiveSha256)) {
      reject("archiveSha256 must be lowercase hex sha256");
    }
    if (!Number.isSafeInteger(params.totalBytes) || params.totalBytes < 1) {
      reject("totalBytes must be a positive integer");
    }
    if (params.totalBytes > options.maxArchiveBytes) {
      reject("totalBytes exceeds the category archive limit", {
        totalBytes: params.totalBytes,
        maxArchiveBytes: options.maxArchiveBytes,
      });
    }
    // 每块 ≥1 字节且 ≤maxChunkBytes：分块数必须能覆盖总字节，且不能超过总字节数
    // （发送方可以选更小的块，因此只约束上下界，不要求恰好等于按满块算出的值）。
    const minimumChunkCount = Math.ceil(params.totalBytes / maxChunkBytes);
    if (
      !Number.isSafeInteger(params.chunkCount) ||
      params.chunkCount < minimumChunkCount ||
      params.chunkCount > params.totalBytes
    ) {
      reject("chunkCount is inconsistent with totalBytes and the chunk size limit", {
        chunkCount: params.chunkCount,
        minimumChunkCount,
        totalBytes: params.totalBytes,
      });
    }
  }

  function decodeChunkPayload(payloadBase64: string): Buffer {
    const reject = (reason: string) => {
      throw createImportError(
        "chunk-payload-invalid",
        `${options.label} archive import chunk rejected: ${reason}`,
      );
    };
    if (payloadBase64.length === 0 || payloadBase64.length % 4 !== 0) {
      reject("payloadBase64 must be non-empty base64 with 4-char alignment");
    }
    if (payloadBase64.length > maxChunkBase64Chars) {
      reject(`payloadBase64 exceeds ${maxChunkBase64Chars} chars`);
    }
    // Buffer.from 会静默跳过非 base64 字符，重编码比对才是无歧义的 canonical 判定
    // （与 shared 的线性扫描同语义：非 canonical 一律拒绝，不做宽松解码）。
    const decoded = Buffer.from(payloadBase64, "base64");
    if (decoded.length === 0 || decoded.length > maxChunkBytes) {
      reject(`payload decodes beyond ${maxChunkBytes} bytes or is empty`);
    }
    if (decoded.toString("base64") !== payloadBase64) {
      reject("payloadBase64 must be canonical base64");
    }
    return decoded;
  }

  function sha256Hex(bytes: Uint8Array): string {
    return createHash("sha256").update(bytes).digest("hex");
  }

  return {
    begin(params) {
      return enqueue(async () => {
        validateBeginParams(params);
        const previous = session;
        if (previous) {
          await discardSession(previous, "replaced-by-begin");
        }
        const tempDir = await mkdtemp(join(tmpdir(), `zcode-${options.label}-archive-import-`));
        const importId = randomUUID();
        const created: ActiveSession = {
          importId,
          archiveSha256: params.archiveSha256,
          totalBytes: params.totalBytes,
          chunkCount: params.chunkCount,
          receivedChunks: 0,
          receivedBytes: 0,
          tempDir,
          archivePath: join(tempDir, ARCHIVE_FILE_NAME),
          expiresAtMs: now() + idleTimeoutMs,
        };
        session = created;
        armIdleTimer(created);
        return { importId };
      });
    },

    append(params) {
      return enqueue(async () => {
        const current = requireSession(params.importId);
        if (params.chunkIndex !== current.receivedChunks) {
          // 缺块/乱序/重复同一条拒绝路径：严格递增，不做乱序缓冲（14 §4.4）。
          throw createImportError(
            "chunk-out-of-order",
            `${options.label} archive import chunk out of order: expected ${current.receivedChunks}, received ${params.chunkIndex}`,
            { expectedChunkIndex: current.receivedChunks, receivedChunkIndex: params.chunkIndex },
          );
        }
        if (params.chunkIndex >= current.chunkCount) {
          throw createImportError(
            "chunk-out-of-order",
            `${options.label} archive import chunk index exceeds chunkCount`,
            { chunkIndex: params.chunkIndex, chunkCount: current.chunkCount },
          );
        }
        if (!SHA256_HEX_PATTERN.test(params.chunkSha256)) {
          throw createImportError(
            "chunk-payload-invalid",
            `${options.label} archive import chunk rejected: chunkSha256 must be lowercase hex sha256`,
          );
        }
        const decoded = decodeChunkPayload(params.payloadBase64);
        if (sha256Hex(decoded) !== params.chunkSha256) {
          throw createImportError(
            "chunk-hash-mismatch",
            `${options.label} archive import chunk rejected: chunkSha256 does not match the payload`,
            { chunkIndex: params.chunkIndex, chunkBytes: decoded.length },
          );
        }
        if (current.receivedBytes + decoded.length > current.totalBytes) {
          throw createImportError(
            "chunk-payload-invalid",
            `${options.label} archive import chunk rejected: received bytes exceed totalBytes`,
            {
              receivedBytes: current.receivedBytes + decoded.length,
              totalBytes: current.totalBytes,
            },
          );
        }
        await appendFile(current.archivePath, decoded);
        current.receivedChunks += 1;
        current.receivedBytes += decoded.length;
        touch(current);
        return {
          receivedChunks: current.receivedChunks,
          receivedBytes: current.receivedBytes,
        };
      });
    },

    complete(params) {
      return enqueue(async () => {
        const current = requireSession(params.importId);
        if (
          current.receivedChunks !== current.chunkCount ||
          current.receivedBytes !== current.totalBytes
        ) {
          throw createImportError(
            "archive-incomplete",
            `${options.label} archive import incomplete: received ${current.receivedChunks}/${current.chunkCount} chunks, ${current.receivedBytes}/${current.totalBytes} bytes`,
            {
              receivedChunks: current.receivedChunks,
              chunkCount: current.chunkCount,
              receivedBytes: current.receivedBytes,
              totalBytes: current.totalBytes,
            },
          );
        }
        const archive = await readFile(current.archivePath);
        const archiveSha256 = sha256Hex(archive);
        if (archiveSha256 !== current.archiveSha256) {
          await discardSession(current, "archive-hash-mismatch");
          // 不符 fail-closed：直接释放会话，不把半安装风险留给调用方重试同一批块。
          throw createImportError(
            "archive-hash-mismatch",
            `${options.label} archive import rejected: assembled bytes do not match archiveSha256`,
            { archiveBytes: archive.length, archiveSha256 },
          );
        }
        await discardSession(current, "completed");
        return new Uint8Array(archive);
      });
    },

    abort(params) {
      return enqueue(async () => {
        const current = session;
        if (!current || current.importId !== params.importId) {
          return { aborted: false };
        }
        await discardSession(current, "aborted");
        return { aborted: true };
      });
    },

    async dispose() {
      await enqueue(async () => {
        if (session) {
          await discardSession(session, "disposed");
        }
      });
    },
  };
}

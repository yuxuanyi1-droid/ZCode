/**
 * 连接期用户资源同步的控制面纯规则（specs/cloud-agent 14 §4.3–§4.5；W11 §13B）。
 *
 * 只放「需要单测或被多处复用的纯判定」：条目 → 既有服务调用参数的映射（mcp 分批、
 * 归档分块、commands 的 markdown → 既有写方法入参）、逐条错误文本的有界化。
 * IO（sha256、base64 解码、RPC 帧、store 读取）在 app/adapters 层。
 *
 * 边界（14 §4.1）：安装逻辑的唯一来源 = 既有 sync/资源服务的导入实现；本文件只做
 * 「把 profile 条目翻译成既有服务入参」的适配，不复制任何校验（名称合法性、front-matter
 * 结构校验、tar 解包/膨胀/穿越全部由被调服务完成）。subagents 自 2026-10-17 起走
 * `writeUserAgentMarkdownFile` 原样写入（14 §4.5），不再有 front-matter → `SubAgentConfig`
 * 的映射；commands 仍整份正文交给既有写方法，由服务侧读回 front-matter。
 */
import { USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES } from "@zcode/shared";

/** mcp 批的「序列化后 ≤2MiB/批」上限（14 §4.2：mcp 与单文件条目按批调用，批内/批间串行）。 */
export const CLOUD_PROFILE_SYNC_MCP_BATCH_MAX_JSON_CHARS = 2 * 1024 * 1024;

/** 逐条错误的文本上限（shared `cloudUserProfileSyncResultItemSchema` 的 `error` 上限一致）。 */
export const CLOUD_PROFILE_SYNC_ERROR_MAX_CHARS = 512;

// ── 逐条错误文本（有界、单行、不含正文）──

/**
 * 把服务/RPC 错误收敛成有界的单行诊断：只保留首行、截断到上限。
 * 绝不拼接条目正文（凭据边界 14 §5：结果里的诊断只允许定位到 `category/entryId`）。
 */
export function userProfileSyncErrorText(error: unknown): string {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : "sync call failed";
  const firstLine = message.split("\n", 1)[0] ?? "sync call failed";
  const normalized = firstLine.replace(/\s+/gu, " ").trim();
  const text = normalized.length > 0 ? normalized : "sync call failed";
  return text.length > CLOUD_PROFILE_SYNC_ERROR_MAX_CHARS
    ? text.slice(0, CLOUD_PROFILE_SYNC_ERROR_MAX_CHARS)
    : text;
}

// ── mcp：按序列化大小分批（14 §4.2）──

export interface McpSyncBatchItem {
  entryId: string;
  /** 条目正文解析出的 `config`（写事务保证是 JSON 对象）。 */
  config: Record<string, unknown>;
}

/**
 * 分批：批内条目按 `entryId` 升序（确定性），累计「序列化后 JSON 字符数」不超上限；
 * 单条超上限时独自成批（由被调服务的既有上限拒绝，控制面不截断、不丢条目）。
 */
export function planMcpSyncBatches(
  entries: readonly McpSyncBatchItem[],
  maxJsonChars: number = CLOUD_PROFILE_SYNC_MCP_BATCH_MAX_JSON_CHARS,
): McpSyncBatchItem[][] {
  const sorted = [...entries].sort((left, right) =>
    left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0,
  );
  const batches: McpSyncBatchItem[][] = [];
  let current: McpSyncBatchItem[] = [];
  let currentChars = 0;
  for (const entry of sorted) {
    const chars = JSON.stringify({ name: entry.entryId, config: entry.config }).length;
    if (current.length > 0 && currentChars + chars > maxJsonChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(entry);
    currentChars += chars;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

// ── 归档类：分块（14 §4.4；块上限 = shared 的既有常量）──

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const BASE64_VALUES: Readonly<Record<string, number>> = Object.freeze(
  [...BASE64_ALPHABET].reduce<Record<string, number>>((values, character, index) => {
    values[character] = index;
    return values;
  }, {}),
);

/**
 * canonical base64 → 字节（**纯计算**：domain 不 import `node:*`、不依赖 `Buffer`/`btoa`）。
 *
 * 仅供上传侧最小前置（canonical 形状/字节上限）已通过的正文使用；实现仍逐字符校验，
 * 非法字符/长度即抛错（fail-closed，不产出半份归档）。
 */
export function decodeCanonicalBase64(value: string): Uint8Array {
  if (value.length % 4 !== 0) throw new Error("base64 length must be a multiple of 4");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bodyEnd = value.length - padding;
  const bytes = new Uint8Array((value.length / 4) * 3 - padding);
  let byteIndex = 0;
  for (let index = 0; index < value.length; index += 4) {
    const isLastGroup = index + 4 === value.length;
    const codes = [0, 1, 2, 3].map((offset) => {
      const position = index + offset;
      const character = value[position] as string;
      if (position >= bodyEnd) {
        // padding 只允许出现在末组尾部（canonical 形状）。
        if (!isLastGroup || character !== "=") {
          throw new Error("base64 payload contains a non-canonical character");
        }
        return 0;
      }
      const code = BASE64_VALUES[character];
      if (code === undefined) throw new Error("base64 payload contains a non-canonical character");
      return code;
    });
    bytes[byteIndex] = (codes[0]! << 2) | (codes[1]! >> 4);
    byteIndex += 1;
    if (isLastGroup && padding === 2) continue;
    bytes[byteIndex] = ((codes[1]! & 0x0f) << 4) | (codes[2]! >> 2);
    byteIndex += 1;
    if (isLastGroup && padding === 1) continue;
    bytes[byteIndex] = ((codes[2]! & 0x03) << 6) | codes[3]!;
    byteIndex += 1;
  }
  if (byteIndex !== bytes.byteLength)
    throw new Error("base64 padding does not match payload length");
  return bytes;
}

/** 字节 → canonical base64（纯计算，分块导入的 `payloadBase64` 唯一编码点）。 */
export function encodeCanonicalBase64(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.byteLength; index += 3) {
    const first = bytes[index] as number;
    const hasSecond = index + 1 < bytes.byteLength;
    const hasThird = index + 2 < bytes.byteLength;
    const second = hasSecond ? (bytes[index + 1] as number) : 0;
    const third = hasThird ? (bytes[index + 2] as number) : 0;
    output += BASE64_ALPHABET[first >> 2];
    output += BASE64_ALPHABET[((first & 0x03) << 4) | (second >> 4)];
    output += hasSecond ? BASE64_ALPHABET[((second & 0x0f) << 2) | (third >> 6)] : "=";
    output += hasThird ? BASE64_ALPHABET[third & 0x3f] : "=";
  }
  return output;
}

/** 切块：块大小 ≤ `USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES`（14 §4.4 冻结值），顺序即 `chunkIndex`。 */
export function planArchiveChunks(
  bytes: Uint8Array,
  chunkBytes: number = USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES,
): Uint8Array[] {
  const size = Math.max(1, Math.floor(chunkBytes));
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.byteLength; offset += size) {
    chunks.push(bytes.subarray(offset, Math.min(offset + size, bytes.byteLength)));
  }
  // 空归档不该出现（类别 schema 已拒空字节）；不制造零块会话，交给调用方 fail-closed。
  return chunks;
}

// ── commands：markdown 正文逐条交给既有写方法（14 §4.5）──

/** `entryId` = 落盘文件名 `<name>.md`（14 §4.5）：既有写方法的 `config.name` = 去后缀的裸名。 */
export function commandNameFromMarkdownEntryId(entryId: string): string {
  return entryId.endsWith(".md") ? entryId.slice(0, -".md".length) : entryId;
}

/**
 * commands 的既有写方法入参（14 §4.5）：`config.prompt` = **整份 markdown 正文**。
 *
 * 为什么不拆 front-matter：既有 `writeCommandFile`/`updateCommandFile` 的生成器在没有
 * `description`/`argument-hint` 时**原样写出 `config.prompt`**（`generateMarkdownCommandFileContent`），
 * 因此整份正文（含 front-matter）会逐字节落盘；而服务侧的 `parseCommandFile` 再从写出的
 * 文件里读回 front-matter（description/argument-hint）——即"front-matter 解析由既有服务
 * 保留"（14 §4.5），控制面不复制解析、正文不失真。
 */
export function planCommandFileWrite(input: { entryId: string; content: string }): {
  name: string;
  prompt: string;
} {
  return { name: commandNameFromMarkdownEntryId(input.entryId), prompt: input.content };
}

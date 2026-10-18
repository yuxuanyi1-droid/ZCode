/**
 * 用户资源 profile 的控制面纯规则（specs/cloud-agent/14 §9.2；W11 §10/§13B）。
 *
 * 只放「需要单测或被多处复用的纯判定」：类别 ↔ 正文形态映射、`bytes` 口径的精算、
 * 归档上传的最小前置（gzip magic 前缀）、条目顺序（组装/展示的确定性来源）、上传超限的
 * 便宜前置。IO（sha256、SQLite、HTTP、tar 解包）一律在 app/adapters 层：上传侧只做最小
 * 前置，tar 权威校验在既有 sync 导入实现（14 §4.4/§9.2②）。
 */
import {
  CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES,
  CLOUD_USER_PROFILE_ARCHIVE_BASE64_MAX_CHARS,
  CLOUD_USER_PROFILE_CATEGORIES,
  CLOUD_USER_PROFILE_ENTRY_MAX_BYTES,
  CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES,
  CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS,
  CLOUD_USER_PROFILE_ARCHIVE_CATEGORIES,
  cloudUserProfileEntryPayloadSchema,
  isCloudUserProfileMarkdownCategory,
  type CloudUserProfileArchiveCategory,
  type CloudUserProfileCategory,
  type CloudUserProfileEntryPayload,
} from "@zcode/shared";

/**
 * 条目正文的存储形态（与 shared 的负载 union 一一对应，14 §9.2①；2026-10-11 简化定调后
 * commands/subagents 是单文件 markdown 文本，不再是归档，14 §4.5）。
 */
export type UserProfileEntryContentKind =
  | "archive-base64"
  | "mcp-config"
  | "markdown"
  | "agents-md";

const CONTENT_KIND_BY_CATEGORY: Readonly<
  Record<CloudUserProfileCategory, UserProfileEntryContentKind>
> = {
  mcp: "mcp-config",
  skills: "archive-base64",
  commands: "markdown",
  plugins: "archive-base64",
  subagents: "markdown",
  "agents-md": "agents-md",
};

export function userProfileContentKindOf(
  category: CloudUserProfileCategory,
): UserProfileEntryContentKind {
  return CONTENT_KIND_BY_CATEGORY[category];
}

/** agents-md 单例条目的固定 `entryId`（14 §4.5；唯一落点 `~/.zcode/AGENTS.md`）。 */
const CLOUD_USER_PROFILE_AGENTS_MD_ENTRY_ID = "user-agents";

/**
 * agents-md 单例约束（2026-10-17 收口，14 §4.3/§4.5；原 §9.4⑥ 悬项）。
 *
 * 第二条 agents-md 条目与第一条争夺同一落点 `~/.zcode/AGENTS.md`，同步时会互相覆盖；
 * 约束必须在写入入口 fail-closed（HTTP 400 `invalid_entry`），不能推迟到同步期——
 * 否则用户先看到"上传成功"，随后在沙箱里得到不可预测的覆盖结果。
 * 返回 null = 通过；否则是拒绝 reason（复用既有错误码目录，不新增 wire 错误码）。
 */
export function userProfileAgentsMdEntryIdReason(
  category: CloudUserProfileCategory,
  entryId: string,
): string | null {
  if (category !== "agents-md") return null;
  return entryId === CLOUD_USER_PROFILE_AGENTS_MD_ENTRY_ID
    ? null
    : "agents-md-entry-id-must-be-user-agents";
}

/**
 * 正文（存储形态）→ 条目负载（14 §9.2③ 的 `payload`；shared schema 是唯一形状来源）。
 *
 * 单点实现的原因：连接期同步（`app/userProfile/profileSyncService.ts`）与条目回显
 * （`app/userProfile` 的 GET 用例，14 §9.4①）必须给出**逐字节一致**的负载——两处各写一份
 * 会立刻分叉。候选形状由 `contentKind` 决定、再整体过 shared 负载 schema：类别与形态
 * 不一致（例如行是 archive 但类别是 mcp）会被 `.strict()` 分支拒绝。
 * 返回 null = 正文不可解析或类别/形态不一致：调用方各自 fail-closed（同步侧按条目记
 * `failed`、回显侧 `invalid_entry`），错误码不在本函数里决定。
 */
export function userProfileEntryPayloadFromContent(
  contentKind: UserProfileEntryContentKind,
  category: CloudUserProfileCategory,
  content: string,
): CloudUserProfileEntryPayload | null {
  let candidate: unknown;
  if (contentKind === "mcp-config") {
    try {
      candidate = { category, config: JSON.parse(content) };
    } catch {
      return null;
    }
  } else if (contentKind === "archive-base64") {
    candidate = { category, archiveBase64: content };
  } else {
    candidate = { category, content };
  }
  const parsed = cloudUserProfileEntryPayloadSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function isUserProfileArchiveCategory(
  category: CloudUserProfileCategory,
): category is CloudUserProfileArchiveCategory {
  return (CLOUD_USER_PROFILE_ARCHIVE_CATEGORIES as readonly string[]).includes(category);
}

/** 单文件 markdown 条目类别（commands/subagents，14 §4.5）：负载 = UTF-8 正文。 */
export function isUserProfileMarkdownCategory(category: string): boolean {
  return isCloudUserProfileMarkdownCategory(category);
}

// ── `bytes` 口径精算（14 §9.1④）──

/**
 * UTF-8 字节数（纯函数，不依赖 TextEncoder/Buffer）：代理对算 4 字节。
 * 只在字符数已过 `.max()` 前置闸后调用，避免对超大串做全量扫描。
 */
export function userProfileUtf8ByteLength(value: string): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
        continue;
      }
      bytes += 3;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** `mcp` 的 `bytes` 口径 = `config` JSON 文本字符数（对齐 `CLOUD_PROJECTION_PAYLOAD_MAX_JSON_CHARS`）。 */
export function userProfileMcpConfigByteLength(configJsonText: string): number {
  return configJsonText.length;
}

// ── 条目顺序（组装与展示的唯一确定性来源：同集合重复排序结果相同）──

const CATEGORY_ORDER: Readonly<Record<CloudUserProfileCategory, number>> =
  CLOUD_USER_PROFILE_CATEGORIES.reduce(
    (order, category, index) => {
      order[category] = index;
      return order;
    },
    {} as Record<CloudUserProfileCategory, number>,
  );

/** 排序键：类别按 shared 冻结枚举次序，同类别按 entryId 码位升序（稳定、可重复）。 */
export function compareUserProfileEntries(
  left: { category: CloudUserProfileCategory; entryId: string },
  right: { category: CloudUserProfileCategory; entryId: string },
): number {
  const byCategory = CATEGORY_ORDER[left.category] - CATEGORY_ORDER[right.category];
  if (byCategory !== 0) return byCategory;
  return left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0;
}

export function sortUserProfileEntries<
  Entry extends { category: CloudUserProfileCategory; entryId: string },
>(entries: readonly Entry[]): Entry[] {
  return [...entries].sort(compareUserProfileEntries);
}

// ── 归档上传的最小前置（14 §9.2②：完整 tar 校验在既有 sync 导入实现，此处只验 gzip magic）──

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function base64CharValue(character: string): number {
  return BASE64_ALPHABET.indexOf(character);
}

/**
 * 归档正文前缀是否是 gzip magic（`0x1f 0x8b`）。
 *
 * 只解码前 3 个 base64 字符（2 字节），**不做完整解码**：80MiB 上传体在请求路径上
 * 整体解码会拖垮事件循环，而完整校验（tar 解包/膨胀/穿越/manifest）本就属于既有
 * sync 导入实现（14 §4.4/§9.2②，禁止第二套权威校验）。调用前必须已通过 shared 的
 * canonical base64 校验。
 */
export function userProfileArchiveGzipPrefixOk(archiveBase64: string): boolean {
  if (archiveBase64.length < 4) return false;
  const first = base64CharValue(archiveBase64[0] as string);
  const second = base64CharValue(archiveBase64[1] as string);
  const third = base64CharValue(archiveBase64[2] as string);
  if (first < 0 || second < 0 || third < 0) return false;
  const byte0 = (first << 2) | (second >> 4);
  const byte1 = ((second & 0x0f) << 4) | (third >> 2);
  return byte0 === 0x1f && byte1 === 0x8b;
}

// ── 上传超限的便宜前置（真实聚合上限在写事务内判定，14 §9.2①）──
/**
 * 单条正文「明显超限」的前置判定：命中即 413 `payload_too_large`（不截断、不落盘）。
 * 只做字符级比较（不做 JSON 解析与 base64 解码）；返回 null 表示交给严格 schema 判定
 * （形状错误走 `invalid_entry`）。口径与 shared schema 的 `.max()` 同源：
 * 归档 = base64 字符上限、文本类（agents-md 与 markdown 单文件）= 字符数上限（UTF-8 字节
 * 上限由 schema 精算）、mcp = JSON 字符上限。
 */
export function userProfileUploadOversizeReason(category: unknown, body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  if (typeof category !== "string") return null;
  if (isUserProfileArchiveCategory(category as CloudUserProfileCategory)) {
    const archive = record["archiveBase64"];
    if (
      typeof archive === "string" &&
      archive.length >
        CLOUD_USER_PROFILE_ARCHIVE_BASE64_MAX_CHARS[category as CloudUserProfileArchiveCategory]
    ) {
      return `${category}-archive-too-large`;
    }
    return null;
  }
  if (category === "agents-md") {
    const content = record["content"];
    if (typeof content === "string" && content.length > CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES) {
      return "agents-md-too-large";
    }
    return null;
  }
  if (isUserProfileMarkdownCategory(category)) {
    // commands/subagents 单文件 markdown（14 §4.5）：与 agents-md 同口径、独立具名 reason。
    const content = record["content"];
    if (typeof content === "string" && content.length > CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES) {
      return `${category}-content-too-large`;
    }
    return null;
  }
  if (category === "mcp") {
    const config = record["config"];
    if (config === undefined) return null;
    let serialized: string;
    try {
      serialized = JSON.stringify(config) ?? "";
    } catch {
      return null;
    }
    if (serialized.length > CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS) {
      return "mcp-config-too-large";
    }
    return null;
  }
  return null;
}

/** 单条 `bytes` 是否超该类别上限（写事务内的兜底判定，与 shared schema 同口径）。 */
export function userProfileEntryBytesExceedLimit(
  category: CloudUserProfileCategory,
  bytes: number,
): boolean {
  return bytes > CLOUD_USER_PROFILE_ENTRY_MAX_BYTES[category];
}

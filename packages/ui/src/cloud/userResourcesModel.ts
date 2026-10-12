/**
 * 云用户资源管理页的纯逻辑（specs/cloud-agent/14 §3.2/§4.5/§9.4；W11 §12/§13D、W8 §5）。
 *
 * 只放「与 React 无关、可单测」的部分：
 * - 类别 → 录入方式（归档上传 / JSON 表单 / markdown 单文件文本编辑器）的唯一映射
 *   （14 §4.5：commands/subagents 由归档放宽为单文件 markdown 文本，消除 tar 解包环节）；
 * - entryId 与上限的**客户端前置**校验（真值判定仍在服务端写事务内，14 §9.2①）；
 * - 文件 → canonical base64（分块转换，见 `encodeUserResourceArchiveBase64` 的内存说明）；
 * - 错误（结构化 code + reason）→ i18n key 的映射（UI 不解析服务端文案，04 §6）。
 *
 * 上限常量与形状一律取自 `@zcode/shared`（不复制数值，14 §9.1④）。
 */
import {
  CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES,
  CLOUD_USER_PROFILE_ARCHIVE_CATEGORIES,
  CLOUD_USER_PROFILE_CATEGORIES,
  CLOUD_USER_PROFILE_ENTRY_MAX_BYTES,
  CLOUD_USER_PROFILE_ENTRY_ID_MAX_CHARS,
  CLOUD_USER_PROFILE_MARKDOWN_CATEGORIES,
  CLOUD_USER_PROFILE_MARKDOWN_ENTRY_ID_SUFFIX,
  CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES,
  CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS,
  cloudUserProfileEntryIdSchema,
  cloudUserProfileMarkdownEntryIdSchema,
  cloudUserProfileMcpConfigSchema,
  type CloudErrorCode,
  type CloudUserProfileArchiveCategory,
  type CloudUserProfileCategory,
  type CloudUserProfileEntry,
  type CloudUserProfileEntryUploadRequest,
  type CloudUserProfileMarkdownCategory,
} from "@zcode/shared";

/** 条目录入方式（由类别决定，UI 不为同一类别提供第二条录入路径）。 */
export type CloudUserResourceInputKind =
  | "archive"
  | "mcp-json"
  | "markdown-text"
  | "agents-md-text";

const ARCHIVE_CATEGORY_SET = new Set<string>(CLOUD_USER_PROFILE_ARCHIVE_CATEGORIES);
const MARKDOWN_CATEGORY_SET = new Set<string>(CLOUD_USER_PROFILE_MARKDOWN_CATEGORIES);

/** 归档类类别：文件上传（tar+gzip；14 §4.3 简化修订后只有 skills/plugins）。 */
export function isUserResourceArchiveCategory(
  category: CloudUserProfileCategory,
): category is (typeof CLOUD_USER_PROFILE_ARCHIVE_CATEGORIES)[number] {
  return ARCHIVE_CATEGORY_SET.has(category);
}

/** 单文件 markdown 文本类类别（commands/subagents；14 §4.5，entryId = 文件名 `*.md`）。 */
export function isUserResourceMarkdownCategory(
  category: CloudUserProfileCategory,
): category is CloudUserProfileMarkdownCategory {
  return MARKDOWN_CATEGORY_SET.has(category);
}

export function userResourceInputKindOf(
  category: CloudUserProfileCategory,
): CloudUserResourceInputKind {
  if (isUserResourceArchiveCategory(category)) return "archive";
  if (isUserResourceMarkdownCategory(category)) return "markdown-text";
  return category === "mcp" ? "mcp-json" : "agents-md-text";
}

/** markdown 条目的 entryId 后缀（唯一来源 shared；UI 只在提示文案里引用它）。 */
export const CLOUD_USER_RESOURCES_MARKDOWN_ENTRY_ID_SUFFIX =
  CLOUD_USER_PROFILE_MARKDOWN_ENTRY_ID_SUFFIX;

/**
 * 用户全局 AGENTS.md 的固定 entryId（单例条目）。
 *
 * 依据：落点是**单文件** `~/.zcode/AGENTS.md`（14 §4.5），同一 profile 内出现第二个
 * agents-md 条目会让同步"谁写最后谁生效"变得不确定（同一目标文件、无版本仲裁）。
 * UI 因此把 agents-md 约束成单例（固定键 + 覆盖保存），不提供"再建一条"的入口；
 * schema 层不限制条目数（服务端侧的条目数约束沿既有上限，本批不动）。
 */
export const CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID = "user-agents";

/** 条目身份键（store 的分组、pending、optimistic overlay 共用同一键）。 */
export function userResourceEntryKey(category: CloudUserProfileCategory, entryId: string): string {
  return `${category}\u0000${entryId}`;
}

export function parseUserResourceEntryKey(
  key: string,
): { category: CloudUserProfileCategory; entryId: string } | null {
  const [category, entryId] = key.split("\u0000");
  if (category === undefined || entryId === undefined) return null;
  if (!(CLOUD_USER_PROFILE_CATEGORIES as readonly string[]).includes(category)) return null;
  return { category: category as CloudUserProfileCategory, entryId };
}

// ── 客户端前置校验（便宜、fail-closed；真值判定在服务端写事务内）──

export type UserResourceValidationFailure =
  | { readonly reason: "empty" }
  | { readonly reason: "shape"; readonly pattern: string }
  | { readonly reason: "empty-file" }
  | { readonly reason: "file-too-large"; readonly maxBytes: number }
  | { readonly reason: "body-too-large"; readonly maxBytes: number }
  /** markdown 类 entryId 缺少 `.md` 后缀（14 §4.5：entryId = 落盘文件名）。 */
  | { readonly reason: "markdown-suffix"; readonly suffix: string }
  /** markdown 正文超过单条上限（UTF-8 字节）。 */
  | { readonly reason: "markdown-too-large"; readonly maxBytes: number };

export type UserResourceValidationResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: UserResourceValidationFailure };

/** entryId 形状校验：与 shared 冻结正则同源（不手写第二份规则）。 */
export function validateUserResourceEntryId(entryId: string): UserResourceValidationResult<string> {
  const parsed = cloudUserProfileEntryIdSchema.safeParse(entryId);
  if (parsed.success) return { ok: true, value: parsed.data };
  if (entryId.trim().length === 0) return { ok: false, failure: { reason: "empty" } };
  return {
    ok: false,
    failure: {
      reason: "shape",
      pattern: `^[a-z0-9][a-z0-9-_.]{0,${CLOUD_USER_PROFILE_ENTRY_ID_MAX_CHARS - 1}}$`,
    },
  };
}

/**
 * markdown 类 entryId 的形状校验（14 §4.5）：在通用条目键形状之上要求 `.md` 后缀。
 *
 * 形状判定复用 shared 的 `cloudUserProfileMarkdownEntryIdSchema`（同一 refine，
 * 不手写第二份后缀规则）；只有"为什么失败"的区分是 UI 事实：空输入 / 形状不符 /
 * 缺后缀（后缀缺失单独成档，用户正在敲文件名时该提示最可行动）。
 */
export function validateUserResourceMarkdownEntryId(
  entryId: string,
): UserResourceValidationResult<string> {
  const parsed = cloudUserProfileMarkdownEntryIdSchema.safeParse(entryId);
  if (parsed.success) return { ok: true, value: parsed.data };
  if (entryId.trim().length === 0) return { ok: false, failure: { reason: "empty" } };
  const shape = validateUserResourceEntryId(entryId);
  if (!shape.ok) return shape;
  return {
    ok: false,
    failure: {
      reason: "markdown-suffix",
      suffix: CLOUD_USER_PROFILE_MARKDOWN_ENTRY_ID_SUFFIX,
    },
  };
}

/**
 * markdown 正文的客户端预检（14 §4.5：UTF-8 字节 ≤256KiB/条）。
 *
 * 字符数先行闸（字符数 ≥ 字节数，超字符数必然超字节数）挡住"读了也发不出去"的正文，
 * 再按真实 UTF-8 字节精算；真值判定仍在服务端写事务内（14 §9.2①）。
 */
export function validateUserResourceMarkdownContent(
  content: string,
): UserResourceValidationResult<string> {
  if (content.length > CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES) {
    return {
      ok: false,
      failure: { reason: "markdown-too-large", maxBytes: CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES },
    };
  }
  const bytes = new TextEncoder().encode(content).byteLength;
  if (bytes > CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES) {
    return {
      ok: false,
      failure: { reason: "markdown-too-large", maxBytes: CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES },
    };
  }
  return { ok: true, value: content };
}

/** markdown 条目的表单前置（entryId + 正文）：两处都过才允许发出 PUT。 */
export function validateUserResourceMarkdownEntry(input: {
  entryId: string;
  content: string;
}): UserResourceValidationResult<{ entryId: string; content: string }> {
  const entryId = validateUserResourceMarkdownEntryId(input.entryId);
  if (!entryId.ok) return entryId;
  const content = validateUserResourceMarkdownContent(input.content);
  if (!content.ok) return content;
  return { ok: true, value: { entryId: entryId.value, content: content.value } };
}

// ── 上传体构造（PUT 负载的客户端部分；服务端仍按同一 schema 独立校验）──

/** 条目 PUT 的公共可选字段：displayName 显式缺省、enabled 必须由调用方给出现值。 */
interface UserResourceUploadBodyCommon {
  readonly displayName: string | undefined;
  readonly enabled: boolean;
}

function uploadBodyCommon(input: UserResourceUploadBodyCommon) {
  return {
    ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
    enabled: input.enabled,
  };
}

/**
 * 归档类条目的上传体（skills/plugins，14 §4.3）：类别 → 负载 union 分支由类型判别收口，
 * 运行时不做二次形状判断（把分支收敛在纯模块里，hook 只负责编码与调用）。
 */
export function buildUserResourceArchiveUploadBody(
  input: UserResourceUploadBodyCommon & {
    readonly category: CloudUserProfileArchiveCategory;
    readonly archiveBase64: string;
  },
): CloudUserProfileEntryUploadRequest {
  const common = uploadBodyCommon(input);
  switch (input.category) {
    case "skills":
      return { category: "skills", archiveBase64: input.archiveBase64, ...common };
    case "plugins":
      return { category: "plugins", archiveBase64: input.archiveBase64, ...common };
  }
}

/**
 * markdown 单文件条目的上传体（commands/subagents，14 §4.5）：`entryId` 由调用方
 * 用 shared 校验过（`.md` 文件名，见 `validateUserResourceMarkdownEntryId`）。
 */
export function buildUserResourceMarkdownUploadBody(
  input: UserResourceUploadBodyCommon & {
    readonly category: CloudUserProfileMarkdownCategory;
    readonly content: string;
  },
): CloudUserProfileEntryUploadRequest {
  const common = uploadBodyCommon(input);
  switch (input.category) {
    case "commands":
      return { category: "commands", content: input.content, ...common };
    case "subagents":
      return { category: "subagents", content: input.content, ...common };
  }
}

/**
 * 归档文件的客户端预检：空文件、按类别的归档上限（shared 常量）、以及上传体上限。
 *
 * 只对归档类（skills/plugins）适用——commands/subagents 是单文件 markdown 文本，
 * 走 `validateUserResourceMarkdownEntry`，不会经过这里（14 §4.5）。
 *
 * 上传体上限（80MiB）先于类别上限检查的原因：base64 会放大 4/3，先拒掉"读了也发不出去"
 * 的文件，避免为一个必然 413 的请求把几十 MiB 读进内存。
 */
export function validateUserResourceArchiveFile(input: {
  category: CloudUserProfileArchiveCategory;
  bytes: number;
}): UserResourceValidationResult<number> {
  if (input.bytes <= 0) return { ok: false, failure: { reason: "empty-file" } };
  if (input.bytes > CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES) {
    return {
      ok: false,
      failure: { reason: "body-too-large", maxBytes: CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES },
    };
  }
  const maxBytes = CLOUD_USER_PROFILE_ENTRY_MAX_BYTES[input.category];
  if (input.bytes > maxBytes) {
    return { ok: false, failure: { reason: "file-too-large", maxBytes } };
  }
  return { ok: true, value: input.bytes };
}

/** 单块转换的字节数：`String.fromCharCode` 的参数个数上限远大于此，取值只为控制峰值内存。 */
const BASE64_CONVERSION_CHUNK_BYTES = 0x8000;

/**
 * 字节 → canonical base64。
 *
 * 为什么不用一次性 `String.fromCharCode(...bytes)`：50MiB 归档的展开参数会直接触发
 * 「Maximum call stack size exceeded」（参数个数上限约 65k）。这里按 32KiB 分块拼接
 * 二进制串，最后只调一次 `btoa`。峰值内存 ≈ 文件 + 二进制串 + base64（约 2.4x 文件），
 * 这是浏览器端把 50MiB 归档编码成上传体的既定代价（分块 multipart 不属本批，见 spec §9.4 悬项）。
 */
export function encodeUserResourceArchiveBase64Bytes(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CONVERSION_CHUNK_BYTES) {
    const chunk = bytes.subarray(offset, offset + BASE64_CONVERSION_CHUNK_BYTES);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export async function encodeUserResourceArchiveBase64(file: Blob): Promise<string> {
  return encodeUserResourceArchiveBase64Bytes(new Uint8Array(await file.arrayBuffer()));
}

/**
 * MCP 配置 JSON 的客户端预校验（提交前给出行内错误，避免把明显非法的 JSON 发出去）。
 *
 * 只保证「是 JSON 对象且 JSON 文本 ≤256KiB」；字段语义属 MCP 契约（`packages/shared/src/mcp.ts`），
 * UI 不复刻 schema（14 §3.2 的同一口径）。服务端仍会按同一上限独立判定。
 */
export type UserResourceMcpJsonFailure =
  | { readonly reason: "empty" }
  | { readonly reason: "invalid-json" }
  | { readonly reason: "not-object" }
  | { readonly reason: "too-large"; readonly maxJsonChars: number };

/** mcp 条目的 `config` 类型直接取自上传请求 union（不自行声明索引签名类型）。 */
export type UserResourceMcpConfig = Extract<
  CloudUserProfileEntryUploadRequest,
  { category: "mcp" }
>["config"];

export type UserResourceMcpJsonResult =
  | { readonly ok: true; readonly config: UserResourceMcpConfig; readonly jsonText: string }
  | { readonly ok: false; readonly failure: UserResourceMcpJsonFailure };

export function parseUserResourceMcpConfigJson(text: string): UserResourceMcpJsonResult {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { ok: false, failure: { reason: "empty" } };
  if (trimmed.length > CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS) {
    return {
      ok: false,
      failure: { reason: "too-large", maxJsonChars: CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, failure: { reason: "invalid-json" } };
  }
  // 形状判定复用 shared 的 mcp config schema（唯一来源）：对象且 JSON 文本 ≤256KiB。
  const config = cloudUserProfileMcpConfigSchema.safeParse(parsed);
  if (!config.success) return { ok: false, failure: { reason: "not-object" } };
  return { ok: true, config: config.data, jsonText: trimmed };
}

// ── 展示格式化 ──

/** 人性化字节数（二进制单位；只用于展示，不参与判定）。 */
export function formatUserResourceBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib < 10 ? kib.toFixed(1) : Math.round(kib)} KiB`;
  const mib = kib / 1024;
  return `${mib < 10 ? mib.toFixed(1) : Math.round(mib)} MiB`;
}

/** sha256 前 12 位（U-11 口径的定位信息，UI 只展示前缀）。 */
export function userResourceShortSha256(sha256: string): string {
  return sha256.slice(0, 12);
}

// ── 结构化错误（store 与视图共用的形状）──

/**
 * 用户资源操作的结构化错误：`code` 取 shared 错误码目录（可能为 null = 结果未知），
 * `reason` 是服务端稳定标签（可选），`message` 只作兜底展示。
 * 文案由 `userResourcesErrorKey` 按 code/reason 映射到 i18n key —— 不解析服务端文案。
 */
export interface CloudUserResourcesError {
  readonly code: CloudErrorCode | null;
  readonly reason: string | null;
  readonly message: string;
  /** 出错的条目键（`userResourceEntryKey`）；整体加载失败时为 null。 */
  readonly entryKey: string | null;
}

export function userResourcesErrorKey(error: CloudUserResourcesError): string {
  if (error.reason === "profile-entry-not-found" || error.code === "not_found") {
    return "settings.cloudUserResources.error.notFound";
  }
  switch (error.code) {
    case "payload_too_large":
      return "settings.cloudUserResources.error.payloadTooLarge";
    case "profile_total_exceeded":
      return "settings.cloudUserResources.error.profileTotalExceeded";
    case "profile_entries_exceeded":
      return "settings.cloudUserResources.error.profileEntriesExceeded";
    case "invalid_entry":
      return "settings.cloudUserResources.error.invalidEntry";
    case "not_configured":
      return "settings.cloudUserResources.error.notConfigured";
    case "unauthenticated":
    case "unauthorized":
      return "settings.cloudUserResources.error.unauthorized";
    case "network_unknown":
    case "provider_unreachable":
    case "bridge_disconnected":
      return "settings.cloudUserResources.error.network";
    default:
      return "settings.cloudUserResources.error.unknown";
  }
}

/**
 * 按类别分组条目（分组顺序 = shared 冻结的类别枚举次序；同类别按 entryId 次序）。
 * 空类别保留在结果里：UI 需要为每个类别渲染"还没有条目"的入口（上传/新建）。
 */
export function groupUserResourcesByCategory(entries: readonly CloudUserProfileEntry[]): readonly {
  readonly category: CloudUserProfileCategory;
  readonly entries: readonly CloudUserProfileEntry[];
}[] {
  return CLOUD_USER_PROFILE_CATEGORIES.map((category) => ({
    category,
    entries: entries
      .filter((entry) => entry.category === category)
      .slice()
      .sort((left, right) =>
        left.entryId < right.entryId ? -1 : left.entryId > right.entryId ? 1 : 0,
      ),
  }));
}

/** 当前条目元数据（PUT 时保留 `enabled`/`displayName` 的依据，14 §9.4①）。 */
export function findUserResourceEntry(
  entries: readonly CloudUserProfileEntry[],
  category: CloudUserProfileCategory,
  entryId: string,
): CloudUserProfileEntry | null {
  return entries.find((entry) => entry.category === category && entry.entryId === entryId) ?? null;
}

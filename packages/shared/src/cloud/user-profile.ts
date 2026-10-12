/**
 * 云用户资源 profile 契约（specs/cloud-agent 14 §3/§4/§5 与 §9.1/§9.4/§9.5 冻结值；W11 §3/§4/§13A）。
 *
 * 单一来源：类别枚举、条目元数据、条目负载、版本快照、上传/查询请求响应与**全部上限
 * 常量**。控制面 profile store（P19）、W8 上传 UI（P20）与连接期同步编排只引用这里，
 * 不各自定义类别字符串或数值上限（14 §9.1④ 于 2026-10-11 冻结）。
 *
 * P20 追加冻结（14 §9.4，2026-10-11）：条目级开关 `PATCH …/entries/:category/:entryId`
 * （`{enabled}`，toggle 亦递增版本）与条目正文回显 `GET …/entries/:category/:entryId`
 * （`{entry, payload}`，UI 编辑回显唯一通路）。
 *
 * 2026-10-11 简化定调（14 §4.3/§4.5/§9.5，A 批契约）：
 * - **归档类别收敛为 `skills`/`plugins`**（`CLOUD_USER_PROFILE_ARCHIVE_CATEGORIES`）；
 * - **`commands`/`subagents` 改单文件 markdown 文本负载**（`{category, content}`，UTF-8
 *   ≤256KiB/条；`entryId` = 落盘文件名 `<name>.md`，见 `cloudUserProfileMarkdownEntryIdSchema`），
 *   消除 tar 解包环节；
 * - 帧用分块常量（`CLOUD_USER_PROFILE_CHUNK_*`/`…MAX_CHUNKS`）随 `bootstrap.resources` 帧
 *   退役；连接期分块导入的块上限在 `../user-archive-import.ts`（≤2MiB 原始字节，14 §4.4）。
 *
 * 边界（14 §4.2/§5）：
 * - 本文件只冻结「有界的 wire 形状 + 严格校验」，不做打包/解包（tar+gzip 校验复用 SSH
 *   同步既有实现；禁止第二套校验代码）。
 * - `mcp` 条目正文（token/headers/env）是凭据载体：只经 bridge 认证通道下发，禁止写入
 *   日志、`bridge.phase` 诊断、任务投影与 attachment 面；诊断只记 category/entryId/sha256/bytes。
 *   14 §9.4① 的唯一例外是条目回显 GET（已鉴权主体的按需读取，见该 schema 的 JSDoc）。
 * - 快照响应（`GET /api/cloud/user-profile`）永远只是条目元数据（本文件的 snapshot 结构不含任何正文）。
 *
 * `bytes` 口径（14 §9.1④ 与 2026-10-11 简化修订）：归档类（skills/plugins）= 归档字节数；
 * `mcp` = `config` JSON 字符数（对齐 `CLOUD_PROJECTION_PAYLOAD_MAX_JSON_CHARS` 的 JSON 口径）；
 * `commands`/`subagents`/`agents-md` = 正文 UTF-8 字节数。
 * 条目元数据与条目负载是两份 schema（元数据由控制面在服务端派生，客户端不能自报
 * `sha256`/`bytes`），故二者的逐条一致性由控制面写入事务保证，不在 schema 层交叉校验。
 */
import { z } from "zod";
import { SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES } from "../settings-sync.js";
import { cloudUuidSchema } from "./identity.js";

const nonEmptyString = z.string().trim().min(1);
const positiveGeneration = z.number().int().positive();
const epochMs = z.number().int().nonnegative();

// ── 类别（14 §1.1，7 项中的 6 个内容类；行为偏好走 bootstrap.config.preferences，不走条目）──

export const CLOUD_USER_PROFILE_CATEGORIES = [
  "mcp",
  "skills",
  "commands",
  "plugins",
  "subagents",
  "agents-md",
] as const;

export const cloudUserProfileCategorySchema = z.enum(CLOUD_USER_PROFILE_CATEGORIES);
export type CloudUserProfileCategory = z.infer<typeof cloudUserProfileCategorySchema>;

/** 归档类类别：负载是 tar+gzip 归档字节（14 §4.3 简化修订后只有 skills/plugins）。 */
export const CLOUD_USER_PROFILE_ARCHIVE_CATEGORIES = ["skills", "plugins"] as const;

export const cloudUserProfileArchiveCategorySchema = z.enum(CLOUD_USER_PROFILE_ARCHIVE_CATEGORIES);
export type CloudUserProfileArchiveCategory = z.infer<typeof cloudUserProfileArchiveCategorySchema>;

/** 单文件 markdown 文本类类别：负载 = UTF-8 正文（14 §4.5，`entryId` = 文件名 `*.md`）。 */
export const CLOUD_USER_PROFILE_MARKDOWN_CATEGORIES = ["commands", "subagents"] as const;

export const cloudUserProfileMarkdownCategorySchema = z.enum(
  CLOUD_USER_PROFILE_MARKDOWN_CATEGORIES,
);
export type CloudUserProfileMarkdownCategory = z.infer<
  typeof cloudUserProfileMarkdownCategorySchema
>;

export function isCloudUserProfileMarkdownCategory(category: string): boolean {
  return (CLOUD_USER_PROFILE_MARKDOWN_CATEGORIES as readonly string[]).includes(category);
}

// ── 上限常量（14 §9.1④，2026-10-11 冻结；超限上传即拒绝，不截断）──

/** 条目键：小写字母/数字开头，允许 `-_.`，最长 128 字符（稳定、可入路径、可读）。 */
export const CLOUD_USER_PROFILE_ENTRY_ID_MAX_CHARS = 128;

/** markdown 单文件条目的文件名后缀（14 §4.5：`entryId` = 落盘文件名 `<name>.md`）。 */
export const CLOUD_USER_PROFILE_MARKDOWN_ENTRY_ID_SUFFIX = ".md";

export const CLOUD_USER_PROFILE_DISPLAY_NAME_MAX_CHARS = 200;

/** `mcp` 单条 config JSON 字符上限（JSON 文本口径，非 UTF-8 字节）。 */
export const CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS = 256 * 1024;

/**
 * 单文件 markdown 文本条目上限（UTF-8 字节；`commands`/`subagents` 与 `agents-md` 同口径，
 * 14 §4.5/§9.1④ 简化修订）。与 settings-sync 的 `~/.zcode/AGENTS.md` 写入上限是同一个
 * 用户级文本条目口径，取同一常量（唯一来源 `SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES`）。
 */
export const CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES = SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES;

/** `agents-md` 单条 UTF-8 字节上限（与 markdown 文本条目同口径）。 */
export const CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES = SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES;

/** 归档类单条上限（tar+gzip 归档后字节；skills 20MiB 与 SSH 同步既有上限同款，14 §2）。 */
export const CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES = 20 * 1024 * 1024;
export const CLOUD_USER_PROFILE_PLUGINS_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;

/** 条目 `bytes` 的按类别上限（单位见文件头 `bytes` 口径）。 */
export const CLOUD_USER_PROFILE_ENTRY_MAX_BYTES: Readonly<
  Record<CloudUserProfileCategory, number>
> = {
  mcp: CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS,
  skills: CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES,
  commands: CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES,
  plugins: CLOUD_USER_PROFILE_PLUGINS_ARCHIVE_MAX_BYTES,
  subagents: CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES,
  "agents-md": CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES,
};

/** profile 总量上限：全部条目 `bytes` 之和。 */
export const CLOUD_USER_PROFILE_TOTAL_MAX_BYTES = 128 * 1024 * 1024;

/** 单账号 profile 条目数上限。 */
export const CLOUD_USER_PROFILE_MAX_ENTRIES = 256;

/** 版本快照保留窗口：最近 8 个版本；条目按 sha256 去重存储，修剪无引用旧条目（14 §9.1④）。 */
export const CLOUD_USER_PROFILE_RETAINED_VERSIONS = 8;

/** 上传 HTTP 请求体上限（整包字节，含 base64 膨胀后的长度）。 */
export const CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES = 80 * 1024 * 1024;

/** 归档类 base64 字符上限（按类别，由字节上限推导的 4/3 展开；解码字节数仍逐条精算）。 */
export const CLOUD_USER_PROFILE_ARCHIVE_BASE64_MAX_CHARS: Readonly<
  Record<CloudUserProfileArchiveCategory, number>
> = {
  skills: Math.ceil(CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES / 3) * 4,
  plugins: Math.ceil(CLOUD_USER_PROFILE_PLUGINS_ARCHIVE_MAX_BYTES / 3) * 4,
};

// ── base64 线性校验与解码字节数（RPC 帧的同类校验同款：不用整体正则，避免栈溢出）──

export function isCloudProfileCanonicalBase64(value: string): boolean {
  if (value.length < 4 || value.length % 4 !== 0) return false;
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const bodyEnd = value.length - padding;
  for (let index = 0; index < bodyEnd; index += 1) {
    const code = value.charCodeAt(index);
    const allowed =
      (code >= 65 && code <= 90) ||
      (code >= 97 && code <= 122) ||
      (code >= 48 && code <= 57) ||
      code === 43 ||
      code === 47;
    if (!allowed) return false;
  }
  for (let index = bodyEnd; index < value.length; index += 1) {
    if (value.charCodeAt(index) !== 61) return false;
  }
  return true;
}

/** 已通过 canonical 校验的 base64 的解码字节数（padding 精算，避免 4/3 展开误差）。 */
export function cloudProfileBase64DecodedBytes(value: string): number {
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  return (value.length / 4) * 3 - padding;
}

/** UTF-8 字节数；仅在字符数已过 `.max()` 前置闸后调用（避免对超大串做全量编码）。 */
function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

// ── 条目元数据（14 §3.2；sha256 与 bytes 由控制面派生，客户端只读）──

export const cloudUserProfileEntryIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-_.]{0,127}$/, "entryId must be ^[a-z0-9][a-z0-9-_.]{0,127}$");

/**
 * markdown 单文件类（commands/subagents）的 `entryId`（14 §4.5）：落盘文件名 `<name>.md`。
 * 在既有条目键形状（小写/数字开头、允许 `-_.`、≤128 字符 → 天然排除路径分隔符与 `..`）
 * 之上追加"必须以 `.md` 结尾"；首字符规则同时排除了 `.md` 自身（空 name）。
 */
export const cloudUserProfileMarkdownEntryIdSchema = cloudUserProfileEntryIdSchema.refine(
  (entryId) => entryId.endsWith(CLOUD_USER_PROFILE_MARKDOWN_ENTRY_ID_SUFFIX),
  `entryId must end with ${CLOUD_USER_PROFILE_MARKDOWN_ENTRY_ID_SUFFIX}`,
);

/**
 * 条目 sha256 的 16 进制形状。与 `bridge-protocol.ts` 的 `cloudSha256HexSchema` 同形态，
 * 就地声明的理由是两份契约各自独立（避免互相 import 成环），与 `domain.ts` 内联同一形状的
 * 既有先例一致。
 */
export const cloudUserProfileSha256Schema = z.string().regex(/^[0-9a-f]{64}$/);

/** 条目 `enabled` 的默认值：默认全开，条目级开关承担"逐条关闭"（14 §9.1②）。 */
const entryEnabledSchema = z.boolean().default(true);

/** markdown 类别（commands/subagents）的 `entryId` 必须是 `*.md` 文件名（14 §4.5）。 */
const markdownEntryIdInvariantMessage = `entryId of a markdown category must end with ${CLOUD_USER_PROFILE_MARKDOWN_ENTRY_ID_SUFFIX}`;

export const cloudUserProfileEntrySchema = z
  .object({
    category: cloudUserProfileCategorySchema,
    entryId: cloudUserProfileEntryIdSchema,
    displayName: nonEmptyString.max(CLOUD_USER_PROFILE_DISPLAY_NAME_MAX_CHARS).optional(),
    enabled: entryEnabledSchema,
    sha256: cloudUserProfileSha256Schema,
    bytes: positiveGeneration,
  })
  .strict()
  .superRefine((entry, context) => {
    const maxBytes = CLOUD_USER_PROFILE_ENTRY_MAX_BYTES[entry.category];
    if (entry.bytes > maxBytes) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${entry.category} entry bytes exceed ${maxBytes}`,
        path: ["bytes"],
      });
    }
    // 单文件 markdown 类别的条目键必须可作落盘文件名（`<name>.md`）；否则控制面
    // 同步时会把一个不可能落盘的名字交给既有服务，失败面推迟到同步期（14 §4.5/U-09）。
    if (
      isCloudUserProfileMarkdownCategory(entry.category) &&
      !cloudUserProfileMarkdownEntryIdSchema.safeParse(entry.entryId).success
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: markdownEntryIdInvariantMessage,
        path: ["entryId"],
      });
    }
  });
export type CloudUserProfileEntry = z.infer<typeof cloudUserProfileEntrySchema>;

/** 条目 `bytes` 之和（总量上限与版本快照一致性共用的唯一算法）。 */
export function cloudUserProfileEntriesTotalBytes(
  entries: readonly CloudUserProfileEntry[],
): number {
  return entries.reduce((sum, entry) => sum + entry.bytes, 0);
}

/**
 * 条目清单（版本快照与 `bootstrap.resources` 帧共用）：条目数 ≤256、`bytes` 之和 ≤128MiB、
 * (category, entryId) 不得重复——重复键会让安装核对与幂等判定歧义，直接 fail-closed。
 */
export const cloudUserProfileEntryListSchema = z
  .array(cloudUserProfileEntrySchema)
  .max(CLOUD_USER_PROFILE_MAX_ENTRIES)
  .superRefine((entries, context) => {
    const totalBytes = cloudUserProfileEntriesTotalBytes(entries);
    if (totalBytes > CLOUD_USER_PROFILE_TOTAL_MAX_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `profile total bytes exceed ${CLOUD_USER_PROFILE_TOTAL_MAX_BYTES}`,
      });
    }
    const seen = new Set<string>();
    for (const entry of entries) {
      const key = `${entry.category}\u0000${entry.entryId}`;
      if (seen.has(key)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate profile entry ${entry.category}/${entry.entryId}`,
        });
        return;
      }
      seen.add(key);
    }
  });

// ── 条目负载（14 §3.2；按 category 判别）──

/**
 * `mcp` 配置：结构归 MCP 契约（`packages/shared/src/mcp.ts` 的 `McpServerConfig`）所有，
 * 该类型带索引签名与 provider 私有字段，shared 不复刻其内部 schema（同 `provisioningEnvelopeJson`
 * 的处理口径）：只冻结「必须是 JSON 对象且有界」。凭据字段（token/headers/env）随本条目只走
 * bridge 认证通道，禁止落日志与 HTTP 响应。
 */
export const cloudUserProfileMcpConfigSchema = z
  .record(z.string(), z.json())
  .refine(
    (config) => JSON.stringify(config).length <= CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS,
    `mcp config exceeds ${CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS} JSON chars`,
  );

/**
 * 单文件 markdown 文本负载（`commands`/`subagents`，14 §4.5）：UTF-8 字节数 ≤256KiB
 * （字符数先行闸，再精算字节）；`entryId` = 落盘文件名 `*.md`（见 markdown entryId schema）。
 * 与 `agents-md` 同口径但**具名 schema 单列**——两者的落点与服务方法不同
 * （`writeCommandFile`/`createAgent` vs `writeUserAgentsFile`），不得共用同一个分支对象。
 */
export const cloudUserProfileMarkdownContentSchema = z
  .string()
  .max(CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES)
  .refine(
    (content) => utf8ByteLength(content) <= CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES,
    `markdown content exceeds ${CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES} bytes`,
  );

/** `agents-md` 正文：UTF-8 字节数 ≤256KiB（字符数先行闸，再精算字节）。 */
export const cloudUserProfileAgentsMdContentSchema = z
  .string()
  .max(CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES)
  .refine(
    (content) => utf8ByteLength(content) <= CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES,
    `agents-md content exceeds ${CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES} bytes`,
  );

/** 归档类 base64：字符上限（4/3 展开）→ canonical 校验 → 解码字节数精算 ≤ 类别上限。 */
function cloudUserProfileArchiveBase64Schema(category: CloudUserProfileArchiveCategory) {
  return z
    .string()
    .max(CLOUD_USER_PROFILE_ARCHIVE_BASE64_MAX_CHARS[category])
    .refine(isCloudProfileCanonicalBase64, "archiveBase64 must be canonical base64")
    .refine(
      (value) =>
        cloudProfileBase64DecodedBytes(value) <= CLOUD_USER_PROFILE_ENTRY_MAX_BYTES[category],
      `archive decodes beyond ${CLOUD_USER_PROFILE_ENTRY_MAX_BYTES[category]} bytes`,
    );
}

function archivePayloadBranch(category: CloudUserProfileArchiveCategory) {
  return z
    .object({
      category: z.literal(category),
      archiveBase64: cloudUserProfileArchiveBase64Schema(category),
    })
    .strict();
}

/** markdown 文本负载分支（commands/subagents）：同一组分支对象派生 payload 与上传请求。 */
function markdownPayloadBranch(category: CloudUserProfileMarkdownCategory) {
  return z
    .object({
      category: z.literal(category),
      content: cloudUserProfileMarkdownContentSchema,
    })
    .strict();
}

/** 条目负载分支的唯一来源：payload union 与上传请求 union 都由同一组分支对象派生。 */
const mcpPayloadBranch = z
  .object({
    category: z.literal("mcp"),
    config: cloudUserProfileMcpConfigSchema,
  })
  .strict();
const skillsPayloadBranch = archivePayloadBranch("skills");
const commandsPayloadBranch = markdownPayloadBranch("commands");
const pluginsPayloadBranch = archivePayloadBranch("plugins");
const subagentsPayloadBranch = markdownPayloadBranch("subagents");
const agentsMdPayloadBranch = z
  .object({
    category: z.literal("agents-md"),
    content: cloudUserProfileAgentsMdContentSchema,
  })
  .strict();

export const cloudUserProfileEntryPayloadSchema = z.discriminatedUnion("category", [
  mcpPayloadBranch,
  skillsPayloadBranch,
  commandsPayloadBranch,
  pluginsPayloadBranch,
  subagentsPayloadBranch,
  agentsMdPayloadBranch,
]);
export type CloudUserProfileEntryPayload = z.infer<typeof cloudUserProfileEntryPayloadSchema>;

// ── 版本快照（14 §3.2：profileVersion 单调递增、每类条目独立 sha256、总量有界）──

export const cloudUserProfileSnapshotSchema = z
  .object({
    profileVersion: positiveGeneration,
    /** 全量条目元数据（不含正文）；总量/条目数/去重上限由 entryList 承担。 */
    entries: cloudUserProfileEntryListSchema,
    totalBytes: z.number().int().nonnegative(),
    createdAtMs: epochMs,
  })
  .strict()
  .superRefine((snapshot, context) => {
    const expected = cloudUserProfileEntriesTotalBytes(snapshot.entries);
    if (snapshot.totalBytes !== expected) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `snapshot totalBytes must equal the sum of entry bytes (${expected})`,
        path: ["totalBytes"],
      });
    }
  });
export type CloudUserProfileSnapshot = z.infer<typeof cloudUserProfileSnapshotSchema>;

// ── HTTP 契约（14 §9.1 追加冻结；03 §6 端点矩阵登记见 endpoints.ts）──
//
// 路径参数与请求体都携带 category：路径是路由事实，body 是自描述事实，服务端必须核验两者
// 一致（不一致按 invalid_entry 拒绝），不隐式取其一。

export const cloudUserProfileEntryPathParamsSchema = z
  .object({
    category: cloudUserProfileCategorySchema,
    entryId: cloudUserProfileEntryIdSchema,
  })
  .strict()
  .superRefine((params, context) => {
    // 路径参数与条目元数据同一条 markdown 类别约束（14 §4.5）：PUT/PATCH/DELETE/GET 四类
    // 端点共用本 schema，路径里的 entryId 也必须可作落盘文件名，否则同一约束会在入口两处漂移。
    if (
      isCloudUserProfileMarkdownCategory(params.category) &&
      !cloudUserProfileMarkdownEntryIdSchema.safeParse(params.entryId).success
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: markdownEntryIdInvariantMessage,
        path: ["entryId"],
      });
    }
  });
export type CloudUserProfileEntryPathParams = z.infer<typeof cloudUserProfileEntryPathParamsSchema>;

/**
 * `PUT /api/cloud/user-profile/entries/:category/:entryId` 请求体：
 * 条目负载 + 可选 `displayName` + 可选 `enabled`。语义 = 幂等整条替换（同 key 重复提交
 * 不产生第二个版本语义）；`sha256`/`bytes` 由服务端派生，schema 层直接不收这些字段。
 * `enabled` 缺席按条目默认值 true 归一（沿用条目 schema 的同一默认值）。
 * 分支与 payload union 同源（同一组分支对象 extend），负载规则不会两处漂移。
 */
const uploadEntryFields = {
  displayName: nonEmptyString.max(CLOUD_USER_PROFILE_DISPLAY_NAME_MAX_CHARS).optional(),
  enabled: entryEnabledSchema,
};

export const cloudUserProfileEntryUploadRequestSchema = z.discriminatedUnion("category", [
  mcpPayloadBranch.extend(uploadEntryFields),
  skillsPayloadBranch.extend(uploadEntryFields),
  commandsPayloadBranch.extend(uploadEntryFields),
  pluginsPayloadBranch.extend(uploadEntryFields),
  subagentsPayloadBranch.extend(uploadEntryFields),
  agentsMdPayloadBranch.extend(uploadEntryFields),
]);
export type CloudUserProfileEntryUploadRequest = z.infer<
  typeof cloudUserProfileEntryUploadRequestSchema
>;

export const cloudUserProfileEntryUploadResponseSchema = z
  .object({
    entry: cloudUserProfileEntrySchema,
    profileVersion: positiveGeneration,
  })
  .strict();
export type CloudUserProfileEntryUploadResponse = z.infer<
  typeof cloudUserProfileEntryUploadResponseSchema
>;

export const cloudUserProfileEntryDeleteResponseSchema = z
  .object({ profileVersion: positiveGeneration })
  .strict();
export type CloudUserProfileEntryDeleteResponse = z.infer<
  typeof cloudUserProfileEntryDeleteResponseSchema
>;

/**
 * `PATCH /api/cloud/user-profile/entries/:category/:entryId` 请求体（14 §9.4 追加冻结）：
 * **只** `{enabled}`，语义 = 条目级授权开关（14 §9.1②「默认全开 + 逐条关闭」的落地通路）。
 *
 * 与 PUT 的区别：PUT 是整条替换（负载 + 可选 displayName/enabled），PATCH 不携带负载、
 * 只翻开关，因此**没有 `.default(true)`**——toggle 意图必须显式，缺席或 `null` 一律拒绝
 * （把"漏传"当成"关闭"会静默改变交付集合）。开关变化同样递增 `profileVersion`：交付集合
 * （enabled 子集）属于版本 manifest，Run 冻结的是"某个版本的交付集合"，不递增会让
 * "运行中 Run 不变、新 Run 生效"失去锚点。
 */
export const cloudUserProfileEntryEnabledPatchRequestSchema = z
  .object({ enabled: z.boolean() })
  .strict();
export type CloudUserProfileEntryEnabledPatchRequest = z.infer<
  typeof cloudUserProfileEntryEnabledPatchRequestSchema
>;

/**
 * `GET /api/cloud/user-profile/entries/:category/:entryId` 响应（14 §9.4 追加冻结）：
 * 条目元数据 + 该条目**正文负载**（形状复用 `cloudUserProfileEntryPayloadSchema`）。
 *
 * 用途 = UI 编辑回显（AGENTS.md 文本编辑器、MCP 表单），服务端有界输出：负载按类别天然
 * 有界（mcp ≤256KiB JSON / agents-md ≤256KiB UTF-8 / 归档 ≤20MiB、plugins ≤50MiB）。
 * **本端点是唯一从 HTTP 面回吐条目正文的通路**（14 §9.4① 的凭据边界修订：只有本端点例外，
 * 且仅限已鉴权的主体；日志、`bridge.phase` 诊断、任务投影、历史回放与 attachment 面
 * 一律不含正文，`CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` 不新增通道）。
 */
export const cloudUserProfileEntryReadResponseSchema = z
  .object({
    entry: cloudUserProfileEntrySchema,
    payload: cloudUserProfileEntryPayloadSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.payload.category !== value.entry.category) {
      // 元数据与正文的类别不一致会让 UI 用错编辑器（fail-closed，不隐式取其一）。
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "entry payload category must match the entry metadata category",
        path: ["payload", "category"],
      });
    }
  });
export type CloudUserProfileEntryReadResponse = z.infer<
  typeof cloudUserProfileEntryReadResponseSchema
>;

/**
 * `PATCH` 响应 = 与 PUT 同一形状 `{entry, profileVersion}`：别名而不是新 schema，
 * 保证"浏览器读回一份条目结果"只有一份定义（矩阵行的响应名登记为
 * `cloudUserProfileEntryUploadResponseSchema`，本别名仅供调用方按语义引用）。
 */
export const cloudUserProfileEntryPatchResponseSchema = cloudUserProfileEntryUploadResponseSchema;
export type CloudUserProfileEntryPatchResponse = CloudUserProfileEntryUploadResponse;

export const cloudUserProfileVersionResponseSchema = z
  .object({ profileVersion: positiveGeneration })
  .strict();
export type CloudUserProfileVersionResponse = z.infer<typeof cloudUserProfileVersionResponseSchema>;

// ── 连接期同步结果（14 §4.6/§9.5，A 批契约；手动同步端点由 B 批实现）──
//
// 同步 = 控制面经 bridge relay 逐类别调沙箱既有 sync 服务（14 §4），逐条结论按
// `(category, entryId)` 定位；自动触发（bridge.ready 后一次）的结论只记日志，
// 手动触发（`POST /api/cloud/tasks/:taskId/user-profile-sync`）在响应里返回同一形状。

/** 同步触发方式：`automatic` = bridge ready 后自动一次；`manual` = 连接态手动端点。 */
export const CLOUD_USER_PROFILE_SYNC_TRIGGERS = ["automatic", "manual"] as const;

export const cloudUserProfileSyncTriggerSchema = z.enum(CLOUD_USER_PROFILE_SYNC_TRIGGERS);
export type CloudUserProfileSyncTrigger = z.infer<typeof cloudUserProfileSyncTriggerSchema>;

/** 逐条同步结果状态：沿用既有导入服务的 `synced`/`skipped`/`failed` 三种（14 §4.4）。 */
export const CLOUD_USER_PROFILE_SYNC_STATUSES = ["synced", "skipped", "failed"] as const;

export const cloudUserProfileSyncStatusSchema = z.enum(CLOUD_USER_PROFILE_SYNC_STATUSES);
export type CloudUserProfileSyncStatus = z.infer<typeof cloudUserProfileSyncStatusSchema>;

/**
 * 逐条同步结果：`error` 是失败诊断（有界、脱敏），**不得携带条目正文**
 * （凭据边界 14 §5：诊断只记 category/entryId/sha256/bytes）。
 */
export const cloudUserProfileSyncResultItemSchema = z
  .object({
    category: cloudUserProfileCategorySchema,
    entryId: cloudUserProfileEntryIdSchema,
    status: cloudUserProfileSyncStatusSchema,
    error: nonEmptyString.max(512).optional(),
  })
  .strict()
  .superRefine((item, context) => {
    // 与条目/路径参数同一条 markdown 类别约束（14 §4.5），保证结果能按 entryId 定位到落点。
    if (
      isCloudUserProfileMarkdownCategory(item.category) &&
      !cloudUserProfileMarkdownEntryIdSchema.safeParse(item.entryId).success
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: markdownEntryIdInvariantMessage,
        path: ["entryId"],
      });
    }
  });
export type CloudUserProfileSyncResultItem = z.infer<typeof cloudUserProfileSyncResultItemSchema>;

/**
 * `POST /api/cloud/tasks/:taskId/user-profile-sync` 响应（14 §4.6）：
 * `{runId, profileVersion, trigger:"manual", results[]}`——`runId` = 实际承载同步的 Run，
 * `profileVersion` = 本次同步读取的最新版本（同步不追踪 Run 冻结版本，14 §4.7⑤），
 * `results` 逐条定位到 `(category, entryId)`；上限即条目数上限（每条目 ≤1 条结论）。
 */
export const cloudUserProfileSyncResponseSchema = z
  .object({
    runId: cloudUuidSchema,
    profileVersion: positiveGeneration,
    trigger: cloudUserProfileSyncTriggerSchema,
    results: z.array(cloudUserProfileSyncResultItemSchema).max(CLOUD_USER_PROFILE_MAX_ENTRIES),
  })
  .strict();
export type CloudUserProfileSyncResponse = z.infer<typeof cloudUserProfileSyncResponseSchema>;

// ── 端点路径常量（14 §9.2⑦；P18 冻结时在 endpoints.ts，P19a 随端点行表落到本文件）──
//
// 路径参数与请求体都携带 category：路径是路由事实、body 是自描述事实，服务端必须核验两者
// 一致（不一致按 invalid_entry 拒绝）。导出名与公共入口不变（`@zcode/shared`）。
// **本组端点不进入 attachment 面**：MCP/skills 类内容与凭据不经
// `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` 暴露（14 §5、02 §0）。

export const CLOUD_USER_PROFILE_ENDPOINT_PATHS = {
  /** profile 快照摘要：条目元数据 + profileVersion + totalBytes + createdAtMs，不含归档正文。 */
  snapshot: "/api/cloud/user-profile",
  version: "/api/cloud/user-profile/version",
  /** 幂等整条替换（PUT）与删除（DELETE）共用路径；路径与 body 的 category 必须一致。 */
  entry: "/api/cloud/user-profile/entries/:category/:entryId",
  /**
   * 手动同步一次最新 profile 到该 Task 当前 Run 的沙箱（14 §4.6）：连接态（bridge ready）
   * 且非终态前置，未连接/终态 409 `not_ready`；响应 = `cloudUserProfileSyncResponseSchema`。
   */
  syncTask: "/api/cloud/tasks/:taskId/user-profile-sync",
} as const;

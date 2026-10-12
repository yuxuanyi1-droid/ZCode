// 云用户资源 profile 契约用例（specs/cloud-agent/14 §3–§5 与 §9.1/§9.5 冻结值；W11 §3/§4/§13A）：
// 类别上限边界、entryId 形状（含 markdown 单文件类别的 `.md` 约束）、markdown 文本负载、
// 快照一致性、自举资源帧退役断言、base64 上限、端点登记与连接期同步结果。
import assert from "node:assert/strict";
import test from "node:test";
import * as shared from "../src/index.js";
import {
  CLOUD_BRIDGE_FRAME_DIRECTIONS,
  CLOUD_ERROR_HTTP_STATUS,
  CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES,
  CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES,
  CLOUD_USER_PROFILE_ARCHIVE_BASE64_MAX_CHARS,
  CLOUD_USER_PROFILE_CATEGORIES,
  CLOUD_USER_PROFILE_ENTRY_ID_MAX_CHARS,
  CLOUD_USER_PROFILE_ENTRY_MAX_BYTES,
  CLOUD_USER_PROFILE_ENDPOINT_PATHS,
  CLOUD_USER_PROFILE_MARKDOWN_CATEGORIES,
  CLOUD_USER_PROFILE_MARKDOWN_ENTRY_ID_SUFFIX,
  CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES,
  CLOUD_USER_PROFILE_MAX_ENTRIES,
  CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS,
  CLOUD_USER_PROFILE_PLUGINS_ARCHIVE_MAX_BYTES,
  CLOUD_USER_PROFILE_RETAINED_VERSIONS,
  CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES,
  CLOUD_USER_PROFILE_SYNC_STATUSES,
  CLOUD_USER_PROFILE_SYNC_TRIGGERS,
  CLOUD_USER_PROFILE_TOTAL_MAX_BYTES,
  CLOUD_HTTP_ENDPOINTS,
  SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES,
  bootstrapConfigFrameSchema,
  cloudBridgeControlFrameSchema,
  cloudProfileBase64DecodedBytes,
  cloudUserProfileArchiveCategorySchema,
  cloudUserProfileCategorySchema,
  cloudUserProfileEntriesTotalBytes,
  cloudUserProfileEntryIdSchema,
  cloudUserProfileEntryListSchema,
  cloudUserProfileEntryEnabledPatchRequestSchema,
  cloudUserProfileEntryPatchResponseSchema,
  cloudUserProfileEntryPathParamsSchema,
  cloudUserProfileEntryPayloadSchema,
  cloudUserProfileEntryReadResponseSchema,
  cloudUserProfileEntrySchema,
  cloudUserProfileEntryUploadRequestSchema,
  cloudUserProfileEntryUploadResponseSchema,
  cloudUserProfileMarkdownCategorySchema,
  cloudUserProfileMarkdownContentSchema,
  cloudUserProfileMarkdownEntryIdSchema,
  cloudUserProfileSnapshotSchema,
  cloudUserProfileSyncResponseSchema,
  cloudUserProfileSyncResultItemSchema,
  cloudUserProfileVersionResponseSchema,
  findCloudHttpEndpoint,
  isCloudBridgeFrameInboundAllowed,
  isCloudProfileCanonicalBase64,
  isCloudUserProfileMarkdownCategory,
} from "../src/index.js";
import { OPERATION_ID, RUN_ID, SHA256_HEX, TASK_ID, WORKSPACE_PATH } from "./cloudFixtures.js";

const OTHER_SHA256_HEX = "f".repeat(64);

/** 构造 decodedBytes 字节的规范 base64（自动选 padding，保证长度合法且恰好落点）。 */
function base64ForDecodedBytes(decodedBytes: number): string {
  const padding = ([0, 1, 2] as const).find((candidate) => (decodedBytes + candidate) % 3 === 0);
  assert.ok(padding !== undefined, `cannot encode ${decodedBytes} bytes as base64`);
  const chars = ((decodedBytes + padding) / 3) * 4;
  return "A".repeat(chars - padding) + "=".repeat(padding);
}

function entryFixture(overrides: Record<string, unknown> = {}) {
  return {
    category: "skills",
    entryId: "sample-skill",
    sha256: SHA256_HEX,
    bytes: 1024,
    ...overrides,
  };
}

test("profile categories and limits are the frozen single source", () => {
  assert.deepEqual(
    [...CLOUD_USER_PROFILE_CATEGORIES],
    ["mcp", "skills", "commands", "plugins", "subagents", "agents-md"],
  );
  // hooks 不纳入 M8（14 §9.1①）：类别枚举不得出现 hooks。
  assert.equal(cloudUserProfileCategorySchema.safeParse("hooks").success, false);
  assert.equal(
    CLOUD_USER_PROFILE_ENTRY_MAX_BYTES.skills,
    CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES,
  );
  assert.equal(
    CLOUD_USER_PROFILE_ENTRY_MAX_BYTES.plugins,
    CLOUD_USER_PROFILE_PLUGINS_ARCHIVE_MAX_BYTES,
  );
  // 简化修订（14 §9.5）：commands/subagents 从归档（20MiB）改为单文件 markdown 文本（256KiB）。
  assert.equal(CLOUD_USER_PROFILE_ENTRY_MAX_BYTES.commands, CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES);
  assert.equal(CLOUD_USER_PROFILE_ENTRY_MAX_BYTES.subagents, CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES);
  assert.equal(CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES, 256 * 1024);
  assert.equal(
    CLOUD_USER_PROFILE_ENTRY_MAX_BYTES.mcp,
    CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS,
  );
  assert.equal(
    CLOUD_USER_PROFILE_ENTRY_MAX_BYTES["agents-md"],
    CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES,
  );
  // 用户级文本条目同一个 256KiB 口径：settings-sync 写入上限与 profile 文本上限同源。
  assert.equal(CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES, SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES);
  assert.equal(CLOUD_USER_PROFILE_TOTAL_MAX_BYTES, 128 * 1024 * 1024);
  assert.equal(CLOUD_USER_PROFILE_MAX_ENTRIES, 256);
  assert.equal(CLOUD_USER_PROFILE_RETAINED_VERSIONS, 8);
  assert.equal(CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES, 80 * 1024 * 1024);
  // 归档类别收敛为 skills/plugins（14 §4.3）；commands/subagents 是 markdown 文本类别（14 §4.5）。
  assert.deepEqual([...cloudUserProfileArchiveCategorySchema.options], ["skills", "plugins"]);
  assert.deepEqual([...CLOUD_USER_PROFILE_MARKDOWN_CATEGORIES], ["commands", "subagents"]);
  assert.deepEqual([...cloudUserProfileMarkdownCategorySchema.options], ["commands", "subagents"]);
  assert.equal(isCloudUserProfileMarkdownCategory("commands"), true);
  assert.equal(isCloudUserProfileMarkdownCategory("skills"), false);
  assert.equal(
    CLOUD_USER_PROFILE_ARCHIVE_BASE64_MAX_CHARS.skills,
    Math.ceil(CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES / 3) * 4,
  );
});

test("entry metadata: entryId shape, bytes per-category limit, enabled default", () => {
  const parsed = cloudUserProfileEntrySchema.parse(entryFixture());
  assert.equal(parsed.enabled, true);
  assert.equal(parsed.displayName, undefined);

  // entryId：合法样例；拒绝大写/越界字符/空串/超长/非 ASCII。
  assert.equal(cloudUserProfileEntryIdSchema.safeParse("a").success, true);
  assert.equal(cloudUserProfileEntryIdSchema.safeParse("my-skill_1.2").success, true);
  for (const invalid of [
    "Upper-Case",
    "-leading",
    "a/b",
    "a b",
    "",
    "中文",
    "a".repeat(CLOUD_USER_PROFILE_ENTRY_ID_MAX_CHARS + 1),
  ]) {
    assert.equal(
      cloudUserProfileEntryIdSchema.safeParse(invalid).success,
      false,
      `entryId ${JSON.stringify(invalid)} must be rejected`,
    );
  }

  // bytes 按类别上限：恰好等于上限合法，上限+1 拒绝；未知字段与非法 sha256 拒绝。
  for (const [category, maxBytes] of Object.entries(CLOUD_USER_PROFILE_ENTRY_MAX_BYTES)) {
    const entryId = isCloudUserProfileMarkdownCategory(category) ? "sample.md" : "sample-skill";
    assert.equal(
      cloudUserProfileEntrySchema.safeParse(entryFixture({ category, entryId, bytes: maxBytes }))
        .success,
      true,
      `${category} at limit must pass`,
    );
    assert.equal(
      cloudUserProfileEntrySchema.safeParse(
        entryFixture({ category, entryId, bytes: maxBytes + 1 }),
      ).success,
      false,
      `${category} over limit must fail`,
    );
  }
  assert.equal(cloudUserProfileEntrySchema.safeParse(entryFixture({ bytes: 0 })).success, false);
  assert.equal(cloudUserProfileEntrySchema.safeParse(entryFixture({ bytes: 1.5 })).success, false);
  assert.equal(
    cloudUserProfileEntrySchema.safeParse(entryFixture({ sha256: "not-a-sha" })).success,
    false,
  );
  assert.equal(
    cloudUserProfileEntrySchema.safeParse(entryFixture({ content: "leaked field" })).success,
    false,
  );
});

test("markdown categories require a *.md entryId (14 §4.5/U-09)", () => {
  // markdown 单文件类别的 entryId = 落盘文件名：既有条目键形状 + `.md` 后缀。
  assert.equal(cloudUserProfileMarkdownEntryIdSchema.safeParse("my-command.md").success, true);
  assert.equal(cloudUserProfileMarkdownEntryIdSchema.safeParse("a.md").success, true);
  assert.equal(
    cloudUserProfileMarkdownEntryIdSchema.safeParse("nested.name.md").success,
    true,
    "`.` 在既有键形状内合法（仍是单段文件名，不含路径分隔符）",
  );
  for (const invalid of [
    "my-command",
    "my-command.markdown",
    ".md",
    "UPPER.md",
    "-leading.md",
    "a b.md",
    "dir/sub.md",
    "..md",
    `${"a".repeat(CLOUD_USER_PROFILE_ENTRY_ID_MAX_CHARS - 2)}.md`,
  ]) {
    assert.equal(
      cloudUserProfileMarkdownEntryIdSchema.safeParse(invalid).success,
      false,
      `markdown entryId ${JSON.stringify(invalid)} must be rejected`,
    );
  }

  // 元数据层（快照/清单）同一条约束：markdown 类别非 `.md` 拒绝，归档类与 mcp 不受影响。
  for (const category of CLOUD_USER_PROFILE_MARKDOWN_CATEGORIES) {
    assert.equal(
      cloudUserProfileEntrySchema.safeParse(entryFixture({ category, entryId: "no-suffix" }))
        .success,
      false,
      `${category} without .md must be rejected`,
    );
    assert.equal(
      cloudUserProfileEntrySchema.safeParse(entryFixture({ category, entryId: "sample.md" }))
        .success,
      true,
      `${category} with .md must pass`,
    );
  }
  assert.equal(
    cloudUserProfileEntrySchema.safeParse(entryFixture({ category: "skills", entryId: "no-md" }))
      .success,
    true,
    "归档类 entryId 不受 .md 约束（条目键仍是目录名）",
  );

  // 路径参数（PUT/PATCH/DELETE/GET 四类端点共用的 schema）同源约束，错误定位到 entryId。
  const rejected = cloudUserProfileEntryPathParamsSchema.safeParse({
    category: "commands",
    entryId: "no-suffix",
  });
  assert.equal(rejected.success, false);
  assert.equal(
    cloudUserProfileEntryPathParamsSchema
      .safeParse({
        category: "commands",
        entryId: "no-suffix",
      })
      .error?.issues.some((issue) => issue.path.join(".") === "entryId"),
    true,
  );
  assert.equal(
    cloudUserProfileEntryPathParamsSchema.safeParse({
      category: "commands",
      entryId: "my-command.md",
    }).success,
    true,
  );
  assert.equal(CLOUD_USER_PROFILE_MARKDOWN_ENTRY_ID_SUFFIX, ".md");
});

test("markdown payload is a bounded UTF-8 text branch (14 §4.3/§4.5)", () => {
  // 正常样例：front-matter / 正文都按纯文本承载，不做解析。
  const content = "---\ndescription: demo\n---\n\n# Command\n";
  assert.deepEqual(cloudUserProfileEntryPayloadSchema.parse({ category: "commands", content }), {
    category: "commands",
    content,
  });
  assert.deepEqual(cloudUserProfileEntryPayloadSchema.parse({ category: "subagents", content }), {
    category: "subagents",
    content,
  });

  // 上限按 UTF-8 字节：三字节字符在字符数未过闸时也可能超限（同 agents-md 口径）。
  assert.equal(
    cloudUserProfileMarkdownContentSchema.safeParse(
      "中".repeat(CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES / 3),
    ).success,
    true,
  );
  assert.equal(
    cloudUserProfileMarkdownContentSchema.safeParse(
      "中".repeat(CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES / 3 + 1),
    ).success,
    false,
  );
  assert.equal(
    cloudUserProfileMarkdownContentSchema.safeParse(
      "a".repeat(CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES),
    ).success,
    true,
  );
  assert.equal(
    cloudUserProfileMarkdownContentSchema.safeParse(
      "a".repeat(CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES + 1),
    ).success,
    false,
  );

  // 类别与负载必须匹配：markdown 类别不收 archiveBase64；归档类别不收 content。
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({ category: "commands", archiveBase64: "AAAA" })
      .success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({ category: "skills", content: "# skill" })
      .success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({ category: "commands", content: 1 }).success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "commands",
      content: "x",
      injected: true,
    }).success,
    false,
  );
});

test("mcp payload is bounded JSON and rejects non-objects", () => {
  const config = { command: "npx", args: ["-y", "example"], env: { TOKEN: "test-only" } };
  assert.deepEqual(cloudUserProfileEntryPayloadSchema.parse({ category: "mcp", config }), {
    category: "mcp",
    config,
  });
  // JSON 字符数边界：恰好上限合法，上限+1 拒绝（口径与投影 payload 的 JSON 上限同源）。
  const mcpJsonOverhead = JSON.stringify({ pad: "" }).length;
  const exact = { pad: "x".repeat(CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS - mcpJsonOverhead) };
  assert.equal(JSON.stringify(exact).length, CLOUD_USER_PROFILE_MCP_CONFIG_MAX_JSON_CHARS);
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({ category: "mcp", config: exact }).success,
    true,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "mcp",
      config: { pad: `${exact.pad}x` },
    }).success,
    false,
  );
  for (const invalid of ["str", 7, true, null, [1]]) {
    assert.equal(
      cloudUserProfileEntryPayloadSchema.safeParse({ category: "mcp", config: invalid }).success,
      false,
      `mcp config ${JSON.stringify(invalid)} must be rejected`,
    );
  }
});

test("agents-md payload counts UTF-8 bytes, not UTF-16 code units", () => {
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "agents-md",
      content: "中".repeat(CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES / 3),
    }).success,
    true,
  );
  // 87382 个三字节字符 = 262146 字节：字符数未过闸但字节超限，必须拒绝。
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "agents-md",
      content: "中".repeat(CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES / 3 + 1),
    }).success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "agents-md",
      content: "a".repeat(CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES + 1),
    }).success,
    false,
  );
});

test("archive payload enforces base64 shape and per-category decoded byte limits", () => {
  // canonical base64 形状：非 4 倍数、非法字符、非 canonical padding 一律拒绝。
  for (const invalid of ["", "AAA", "AAAAA", "AA=A", "****", "AAAA\n"]) {
    assert.equal(isCloudProfileCanonicalBase64(invalid), false);
  }
  assert.equal(isCloudProfileCanonicalBase64("AAAA"), true);
  assert.equal(isCloudProfileCanonicalBase64("AAA="), true);
  assert.equal(cloudProfileBase64DecodedBytes("AAAA"), 3);
  assert.equal(cloudProfileBase64DecodedBytes("AAA="), 2);
  assert.equal(cloudProfileBase64DecodedBytes("AA=="), 1);

  // skills：20MiB 恰好合法，20MiB+1 字节拒绝（两串长度相同，解码字节精算落地）。
  assert.equal(CLOUD_USER_PROFILE_ARCHIVE_BASE64_MAX_CHARS.skills, 27_962_028);
  const skillsAtLimit = base64ForDecodedBytes(CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES);
  const skillsOverLimit = base64ForDecodedBytes(CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES + 1);
  assert.equal(skillsAtLimit.length, skillsOverLimit.length);
  assert.equal(
    cloudProfileBase64DecodedBytes(skillsAtLimit),
    CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES,
  );
  assert.equal(
    cloudProfileBase64DecodedBytes(skillsOverLimit),
    CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES + 1,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "skills",
      archiveBase64: skillsAtLimit,
    }).success,
    true,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "skills",
      archiveBase64: skillsOverLimit,
    }).success,
    false,
  );

  // plugins：20MiB+1 字节仍合法（证明 plugins 分支用的是 50MiB 上限而非 skills 的）；
  // 50MiB 恰好合法，50MiB+1 拒绝。
  const pluginsOverSkillsLimit = base64ForDecodedBytes(
    CLOUD_USER_PROFILE_SKILLS_ARCHIVE_MAX_BYTES + 1,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "plugins",
      archiveBase64: pluginsOverSkillsLimit,
    }).success,
    true,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "skills",
      archiveBase64: pluginsOverSkillsLimit,
    }).success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "plugins",
      archiveBase64: base64ForDecodedBytes(CLOUD_USER_PROFILE_PLUGINS_ARCHIVE_MAX_BYTES),
    }).success,
    true,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "plugins",
      archiveBase64: base64ForDecodedBytes(CLOUD_USER_PROFILE_PLUGINS_ARCHIVE_MAX_BYTES + 1),
    }).success,
    false,
  );

  // 归档类别只有 skills/plugins（14 §4.3 简化修订）：commands/subagents 不再接受归档负载，
  // 归档上限表也不再为它们维护 4/3 展开。
  assert.equal("commands" in CLOUD_USER_PROFILE_ARCHIVE_BASE64_MAX_CHARS, false);
  assert.equal("subagents" in CLOUD_USER_PROFILE_ARCHIVE_BASE64_MAX_CHARS, false);
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({ category: "commands", archiveBase64: "AAAA" })
      .success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({
      category: "subagents",
      archiveBase64: base64ForDecodedBytes(1024),
    }).success,
    false,
  );

  // 类别与负载必须匹配：skills 分支不接受 agents-md 字段，反之亦然。
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({ category: "skills", content: "x" }).success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryPayloadSchema.safeParse({ category: "agents-md", archiveBase64: "AAAA" })
      .success,
    false,
  );
});

test("entry list enforces count, total bytes and unique (category, entryId)", () => {
  const manyEntries = Array.from({ length: CLOUD_USER_PROFILE_MAX_ENTRIES }, (_unused, index) =>
    entryFixture({ entryId: `entry-${index}`, bytes: 1 }),
  );
  assert.equal(cloudUserProfileEntryListSchema.safeParse(manyEntries).success, true);
  assert.equal(
    cloudUserProfileEntryListSchema.safeParse([
      ...manyEntries,
      entryFixture({ entryId: "entry-overflow", bytes: 1 }),
    ]).success,
    false,
  );
  // 3 × 50MiB = 150MiB > 128MiB：条目本身合法但总量越界。
  const oversized = ["a", "b", "c"].map((id) =>
    entryFixture({
      category: "plugins",
      entryId: id,
      bytes: CLOUD_USER_PROFILE_PLUGINS_ARCHIVE_MAX_BYTES,
    }),
  );
  assert.equal(
    cloudUserProfileEntriesTotalBytes(oversized) > CLOUD_USER_PROFILE_TOTAL_MAX_BYTES,
    true,
  );
  assert.equal(cloudUserProfileEntryListSchema.safeParse(oversized).success, false);
  // 重复 (category, entryId) 拒绝；不同 category 同 entryId 合法。
  assert.equal(
    cloudUserProfileEntryListSchema.safeParse([
      entryFixture({ entryId: "dup" }),
      entryFixture({ entryId: "dup" }),
    ]).success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryListSchema.safeParse([
      entryFixture({ category: "skills", entryId: "same" }),
      entryFixture({ category: "commands", entryId: "same.md" }),
    ]).success,
    true,
  );
});

test("snapshot keeps totalBytes consistent with the entry list", () => {
  const entries = [
    entryFixture({ entryId: "one", bytes: 10 }),
    entryFixture({ entryId: "two", bytes: 5 }),
  ];
  const snapshot = {
    profileVersion: 4,
    entries,
    totalBytes: 15,
    createdAtMs: 1_760_000_000_000,
  };
  const parsed = cloudUserProfileSnapshotSchema.parse(snapshot);
  // enabled 缺席按条目默认值 true 归一（14 §9.1②）。
  assert.equal(
    parsed.entries.every((entry) => entry.enabled),
    true,
  );
  assert.deepEqual(
    cloudUserProfileSnapshotSchema.parse(JSON.parse(JSON.stringify(parsed))),
    parsed,
  );
  assert.equal(parsed.totalBytes, 15);
  // totalBytes 必须等于条目之和（多算/少算都拒绝）；profileVersion 必须是正整数。
  assert.equal(
    cloudUserProfileSnapshotSchema.safeParse({ ...snapshot, totalBytes: 16 }).success,
    false,
  );
  assert.equal(
    cloudUserProfileSnapshotSchema.safeParse({ ...snapshot, totalBytes: 14 }).success,
    false,
  );
  assert.equal(
    cloudUserProfileSnapshotSchema.safeParse({ ...snapshot, profileVersion: 0 }).success,
    false,
  );
  // 空 profile 快照合法（totalBytes=0），未知字段拒绝。
  assert.equal(
    cloudUserProfileSnapshotSchema.safeParse({
      profileVersion: 1,
      entries: [],
      totalBytes: 0,
      createdAtMs: 0,
    }).success,
    true,
  );
  assert.equal(
    cloudUserProfileSnapshotSchema.safeParse({ ...snapshot, archiveBase64: "AAAA" }).success,
    false,
  );
});

test("bootstrap.resources retirement: no frame, no chunk constants, no phase (14 §4.8/U-13)", () => {
  // 帧类型整体退役：union 不含 `bootstrap.resources`，未知类型整帧拒绝。
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({
      protocolVersion: 1,
      type: "bootstrap.resources",
      profileVersion: 3,
      transferId: OPERATION_ID,
      chunkIndex: 0,
      chunkCount: 1,
      chunkSha256: SHA256_HEX,
      archiveSha256: OTHER_SHA256_HEX,
      entries: [entryFixture()],
      payload: "AAAA",
    }).success,
    false,
  );
  assert.equal("bootstrap.resources" in CLOUD_BRIDGE_FRAME_DIRECTIONS, false);
  assert.equal(isCloudBridgeFrameInboundAllowed("bootstrap.resources" as never, "bridge"), false);

  // 相位 `installing-resources` 一并移除（不留废弃态）。
  const phaseFrame = {
    protocolVersion: 1,
    type: "bridge.phase",
    phase: "installing-resources",
  };
  assert.equal(cloudBridgeControlFrameSchema.safeParse(phaseFrame).success, false);
  assert.equal(
    cloudBridgeControlFrameSchema.safeParse({ ...phaseFrame, phase: "installing-config" }).success,
    true,
  );

  // 退役的 shared 导出不得残留（帧 schema、分块常量、旧归档上限）。
  for (const removedExport of [
    "bootstrapResourcesFrameSchema",
    "CLOUD_USER_PROFILE_CHUNK_PAYLOAD_MAX_BYTES",
    "CLOUD_USER_PROFILE_CHUNK_PAYLOAD_MAX_BASE64_CHARS",
    "CLOUD_USER_PROFILE_MAX_CHUNKS",
    "CLOUD_USER_PROFILE_COMMANDS_ARCHIVE_MAX_BYTES",
    "CLOUD_USER_PROFILE_SUBAGENTS_ARCHIVE_MAX_BYTES",
  ]) {
    assert.equal(
      removedExport in shared,
      false,
      `${removedExport} must not be exported after the 2026-10-11 simplification`,
    );
  }
  // 替代件必须存在：连接期分块导入的块上限（≤2MiB 原始字节，14 §4.4）。
  assert.equal(shared.USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(
    shared.USER_ARCHIVE_IMPORT_CHUNK_MAX_BASE64_CHARS,
    Math.ceil(shared.USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES / 3) * 4,
  );
});

test("chunked import contract shapes are frozen for both sync services (14 §4.4)", () => {
  // 类型形状由 interface 冻结；此处断言运行时可见的常量与（经服务实现断言的）方法名口径。
  assert.deepEqual(
    Object.keys(shared)
      .filter((key) => key.startsWith("USER_ARCHIVE_IMPORT_"))
      .sort(),
    ["USER_ARCHIVE_IMPORT_CHUNK_MAX_BASE64_CHARS", "USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES"],
  );
  // 单块上限必须保证双层 base64 后仍小于单帧 RPC 上限（4MiB，14 §4.2）。
  const doubleEncoded =
    Math.ceil((Math.ceil(shared.USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES / 3) * 4) / 3) * 4;
  assert.ok(
    doubleEncoded < shared.CLOUD_RPC_PAYLOAD_MAX_BYTES,
    "double base64 must fit the RPC frame",
  );
});

test("bootstrap.config preferences block: optional, typed by the source schemas", () => {
  const baseFrame = {
    protocolVersion: 1,
    type: "bootstrap.config",
    taskId: TASK_ID,
    workspacePath: WORKSPACE_PATH,
    clone: {
      repositoryId: 42,
      repositoryFullName: "example/repo",
      baseSha: "0123456789abcdef0123456789abcdef01234567",
      taskBranch: "cloud/example",
    },
    provisioningEnvelopeJson: JSON.stringify({ provider: "example" }),
    credentialGeneration: 3,
    policyVersion: "policy-1",
  };
  // 附加块是可选字段：旧形状（无 preferences）继续合法。
  assert.equal(bootstrapConfigFrameSchema.safeParse(baseFrame).success, true);

  const withPreferences = {
    ...baseFrame,
    preferences: {
      configVersion: "cloud-config-2",
      values: {
        askUserQuestionAutoResolutionEnabled: false,
        nativeSearchEnhancementsEnabled: true,
        memoryEnabled: true,
        modelContextBudgetStrategy: "preflight-v1",
        integratedTerminalShell: { mode: "auto" },
      },
    },
  };
  const parsed = bootstrapConfigFrameSchema.parse(withPreferences);
  assert.deepEqual(parsed.preferences, withPreferences.preferences);
  assert.deepEqual(bootstrapConfigFrameSchema.parse(JSON.parse(JSON.stringify(parsed))), parsed);
  // 空 values 合法（缺席键由 responder 的既有默认值收敛）。
  assert.equal(
    bootstrapConfigFrameSchema.safeParse({
      ...baseFrame,
      preferences: { configVersion: "cloud-config-2", values: {} },
    }).success,
    true,
  );
  // shell 枚举分支：完整字段合法。
  assert.equal(
    bootstrapConfigFrameSchema.safeParse({
      ...baseFrame,
      preferences: {
        configVersion: "cloud-config-2",
        values: {
          integratedTerminalShell: {
            mode: "shell",
            dialect: "git-bash",
            id: "git-bash",
            label: "Git Bash",
            path: "/usr/bin/bash",
          },
        },
      },
    }).success,
    true,
  );

  for (const [name, preferences] of [
    // configVersion 必须非空。
    ["missing configVersion", { values: {} }],
    ["blank configVersion", { configVersion: "   ", values: {} }],
    // modelContextBudgetStrategy 枚举非法值拒绝（源 schema 只有 legacy | preflight-v1）。
    ["bad strategy", { configVersion: "v", values: { modelContextBudgetStrategy: "v3" } }],
    // integratedTerminalShell 判别联合缺字段拒绝。
    ["bad shell", { configVersion: "v", values: { integratedTerminalShell: { mode: "shell" } } }],
    [
      "bad shell mode",
      { configVersion: "v", values: { integratedTerminalShell: { mode: "tmux" } } },
    ],
    // 类型错误与未知键拒绝。
    ["bad boolean", { configVersion: "v", values: { memoryEnabled: "yes" } }],
    ["unknown value key", { configVersion: "v", values: { unknownPreference: 1 } }],
    ["unknown block key", { configVersion: "v", values: {}, injected: true }],
  ] as const) {
    assert.equal(
      bootstrapConfigFrameSchema.safeParse({ ...baseFrame, preferences }).success,
      false,
      `${name} must be rejected`,
    );
  }
});

test("upload request/response and path params follow the frozen endpoint shape", () => {
  const request = {
    category: "mcp",
    config: { url: "https://example.invalid/mcp", headers: { Authorization: "test-only" } },
    displayName: "Example MCP",
    enabled: false,
  };
  const parsed = cloudUserProfileEntryUploadRequestSchema.parse(request);
  assert.deepEqual(parsed, request);
  // enabled 缺席按条目默认值 true 归一；payload 分支的类别匹配约束同样生效。
  assert.equal(
    cloudUserProfileEntryUploadRequestSchema.parse({ category: "agents-md", content: "# hi" })
      .enabled,
    true,
  );
  assert.equal(
    cloudUserProfileEntryUploadRequestSchema.safeParse({ category: "skills", config: {} }).success,
    false,
  );
  // 服务端派生字段不得由客户端自报（strict 拒绝）。
  assert.equal(
    cloudUserProfileEntryUploadRequestSchema.safeParse({ ...request, sha256: SHA256_HEX }).success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryUploadRequestSchema.safeParse({ ...request, bytes: 10 }).success,
    false,
  );

  const uploadResponse = {
    entry: entryFixture({ entryId: "example-mcp", category: "mcp", bytes: 120 }),
    profileVersion: 5,
  };
  const parsedResponse = cloudUserProfileEntryUploadResponseSchema.parse(uploadResponse);
  assert.equal(parsedResponse.entry.enabled, true);
  assert.deepEqual(
    cloudUserProfileEntryUploadResponseSchema.parse(JSON.parse(JSON.stringify(parsedResponse))),
    parsedResponse,
  );
  assert.equal(
    cloudUserProfileEntryUploadResponseSchema.safeParse({ ...uploadResponse, profileVersion: 0 })
      .success,
    false,
  );
  assert.equal(
    cloudUserProfileVersionResponseSchema.parse({ profileVersion: 5 }).profileVersion,
    5,
  );
  assert.equal(
    cloudUserProfileEntryPathParamsSchema.safeParse({ category: "plugins", entryId: "my-plugin" })
      .success,
    true,
  );
  assert.equal(
    cloudUserProfileEntryPathParamsSchema.safeParse({ category: "hooks", entryId: "my-hook" })
      .success,
    false,
  );
});

test("endpoint paths and error statuses register the frozen profile contracts", () => {
  // 路径常量是端点形状的单一来源；矩阵行与 SDK 索引随 P19 实现一并登记
  // （矩阵里的写端点必须同时在 SDK 索引，既有覆盖不变量）。
  assert.deepEqual(CLOUD_USER_PROFILE_ENDPOINT_PATHS, {
    snapshot: "/api/cloud/user-profile",
    version: "/api/cloud/user-profile/version",
    entry: "/api/cloud/user-profile/entries/:category/:entryId",
    // B 批（14 §4.6）：连接期手动同步是 task-scoped 动作端点。
    syncTask: "/api/cloud/tasks/:taskId/user-profile-sync",
  });
  assert.equal(findCloudHttpEndpoint("upsertUserProfileEntry"), undefined);
  // 上传类错误码的 HTTP 落点（14 §9.1）。
  assert.equal(CLOUD_ERROR_HTTP_STATUS.payload_too_large, 413);
  assert.equal(CLOUD_ERROR_HTTP_STATUS.invalid_entry, 400);
  assert.equal(CLOUD_ERROR_HTTP_STATUS.profile_total_exceeded, 409);
  assert.equal(CLOUD_ERROR_HTTP_STATUS.profile_entries_exceeded, 409);
});

test("PATCH 开关请求：只收 {enabled}，缺席/额外字段/hash 一律拒绝（14 §9.4①）", () => {
  // 开关意图必须显式：没有 `.default(true)` 兜底，漏传就是 400，不是"关掉"。
  assert.equal(cloudUserProfileEntryEnabledPatchRequestSchema.safeParse({}).success, false);
  assert.equal(
    cloudUserProfileEntryEnabledPatchRequestSchema.safeParse({ enabled: "true" }).success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryEnabledPatchRequestSchema.safeParse({ enabled: null }).success,
    false,
  );
  // strict：PATCH 不接受负载/元数据字段（整条替换才是 PUT 的语义）。
  for (const extra of [
    { category: "mcp", config: {} },
    { content: "x" },
    { displayName: "改名" },
    { sha256: SHA256_HEX },
    { bytes: 1 },
  ] as const) {
    assert.equal(
      cloudUserProfileEntryEnabledPatchRequestSchema.safeParse({ enabled: false, ...extra })
        .success,
      false,
      `patch body must reject ${Object.keys(extra).join(",")}`,
    );
  }
  assert.deepEqual(cloudUserProfileEntryEnabledPatchRequestSchema.parse({ enabled: false }), {
    enabled: false,
  });
  assert.equal(
    cloudUserProfileEntryEnabledPatchRequestSchema.parse({ enabled: true }).enabled,
    true,
  );
  // PATCH 响应与 PUT 同形状（同一 schema 对象：别名不是第二份定义）。
  assert.equal(cloudUserProfileEntryPatchResponseSchema, cloudUserProfileEntryUploadResponseSchema);
  const patched = cloudUserProfileEntryPatchResponseSchema.parse({
    entry: entryFixture({ entryId: "primary", category: "mcp", bytes: 120, enabled: false }),
    profileVersion: 6,
  });
  assert.equal(patched.entry.enabled, false);
  assert.equal(patched.profileVersion, 6);
});

test("条目回显响应 {entry, payload}：类别必须一致、正文按类别有界（14 §9.4①）", () => {
  const read = cloudUserProfileEntryReadResponseSchema.parse({
    entry: entryFixture({ category: "agents-md", entryId: "user-agents", bytes: 12 }),
    payload: { category: "agents-md", content: "# 用户指令" },
  });
  assert.equal(read.payload.category, "agents-md");

  // mcp：正文是配置对象（凭据字段随条目正文，只经本端点回吐）。
  const mcp = cloudUserProfileEntryReadResponseSchema.parse({
    entry: entryFixture({ category: "mcp", entryId: "primary", bytes: 42 }),
    payload: { category: "mcp", config: { command: "npx", env: { TOKEN: "x" } } },
  });
  assert.equal(mcp.payload.category, "mcp");

  // 归档：正文是 canonical base64；非 canonical / 超类别上限由负载 schema 拒绝。
  const skills = cloudUserProfileEntryReadResponseSchema.parse({
    entry: entryFixture({ category: "skills", entryId: "demo" }),
    payload: { category: "skills", archiveBase64: "AAAA" },
  });
  assert.equal(skills.payload.category, "skills");

  // markdown 单文件类：正文是文本（entryId 与元数据同受 `.md` 约束）。
  const commands = cloudUserProfileEntryReadResponseSchema.parse({
    entry: entryFixture({ category: "commands", entryId: "deploy.md", bytes: 20 }),
    payload: { category: "commands", content: "# deploy\n" },
  });
  assert.equal(commands.payload.category, "commands");
  assert.equal(
    cloudUserProfileEntryReadResponseSchema.safeParse({
      entry: entryFixture({ category: "commands", entryId: "deploy", bytes: 20 }),
      payload: { category: "commands", content: "# deploy\n" },
    }).success,
    false,
    "markdown 条目的 entryId 约束在回显响应里同样生效",
  );

  // 元数据类别与正文类别不一致 → 拒绝（否则 UI 会用错编辑器）。
  assert.equal(
    cloudUserProfileEntryReadResponseSchema.safeParse({
      entry: entryFixture({ category: "skills", entryId: "demo" }),
      payload: { category: "agents-md", content: "# 错位" },
    }).success,
    false,
  );
  // 未知字段/缺字段拒绝（strict）。
  assert.equal(
    cloudUserProfileEntryReadResponseSchema.safeParse({
      entry: entryFixture({ category: "skills", entryId: "demo" }),
      payload: { category: "skills", archiveBase64: "AAAA" },
      content: "多余字段",
    }).success,
    false,
  );
  assert.equal(
    cloudUserProfileEntryReadResponseSchema.safeParse({
      entry: entryFixture({ category: "skills", entryId: "demo" }),
    }).success,
    false,
  );
  // 非 gzip 归档正文：形状合法即通过（gzip magic 是服务端准入与安装器的校验，不在 schema）。
  assert.equal(
    cloudUserProfileEntryReadResponseSchema.safeParse({
      entry: entryFixture({ category: "skills", entryId: "demo" }),
      payload: { category: "skills", archiveBase64: "not base64!" },
    }).success,
    false,
  );
});

test("P20 端点登记：矩阵两行 + SDK 索引成对（14 §9.4）", () => {
  const readEntry = findCloudHttpEndpoint("readUserProfileEntry");
  assert.ok(readEntry);
  assert.equal(readEntry.method, "GET");
  assert.equal(readEntry.path, CLOUD_USER_PROFILE_ENDPOINT_PATHS.entry);
  assert.equal(readEntry.request, null);
  assert.equal(readEntry.response, "cloudUserProfileEntryReadResponseSchema");

  const patchEntry = findCloudHttpEndpoint("patchUserProfileEntryEnabled");
  assert.ok(patchEntry);
  assert.equal(patchEntry.method, "PATCH");
  assert.equal(patchEntry.path, CLOUD_USER_PROFILE_ENDPOINT_PATHS.entry);
  assert.equal(
    patchEntry.request,
    "cloudUserProfileEntryEnabledPatchRequestSchema",
    "PATCH 请求 schema 名必须能在 shared 公共入口解析到（SDK 索引同款断言）",
  );
  // PATCH 与 PUT/DELETE 共用路径模板：矩阵里同路径多方法，靠方法区分（fixture 反查同规则）。
  const samePath = CLOUD_HTTP_ENDPOINTS.filter(
    (endpoint) => endpoint.path === CLOUD_USER_PROFILE_ENDPOINT_PATHS.entry,
  );
  assert.deepEqual(samePath.map((endpoint) => `${endpoint.method} ${endpoint.id}`).sort(), [
    "DELETE deleteUserProfileEntry",
    "GET readUserProfileEntry",
    "PATCH patchUserProfileEntryEnabled",
    "PUT putUserProfileEntry",
  ]);
});

test("B 批端点登记：手动同步一行（矩阵 + 路径常量同源，14 §4.6/§9.5）", () => {
  const sync = findCloudHttpEndpoint("syncTaskUserProfile");
  assert.ok(sync, "手动同步端点必须登记在冻结矩阵里");
  assert.equal(sync.method, "POST");
  assert.equal(sync.path, CLOUD_USER_PROFILE_ENDPOINT_PATHS.syncTask);
  assert.equal(sync.path, "/api/cloud/tasks/:taskId/user-profile-sync");
  assert.equal(sync.request, "cloudEmptyBodySchema", "无请求体的动作端点（空体 schema）");
  assert.equal(sync.response, "cloudUserProfileSyncResponseSchema");
  assert.equal(sync.availability, "available");
  // 手动同步是 task-scoped 的动作端点：与 taskDetail 同形（路径参数只有 taskId）。
  assert.equal(sync.path.includes(":category"), false);
  assert.equal(sync.path.includes(":entryId"), false);
});

test("connection-time sync result contract shapes (14 §4.6/§9.5，A 批)", () => {
  assert.deepEqual([...CLOUD_USER_PROFILE_SYNC_TRIGGERS], ["automatic", "manual"]);
  assert.deepEqual([...CLOUD_USER_PROFILE_SYNC_STATUSES], ["synced", "skipped", "failed"]);

  // 逐条结果定位到 (category, entryId)；error 有界且不含正文（凭据/内容边界 14 §5）。
  const item = cloudUserProfileSyncResultItemSchema.parse({
    category: "mcp",
    entryId: "primary",
    status: "failed",
    error: "relay unavailable",
  });
  assert.equal(item.status, "failed");
  assert.equal(
    cloudUserProfileSyncResultItemSchema.safeParse({
      category: "skills",
      entryId: "demo",
      status: "cancelled",
    }).success,
    false,
  );
  assert.equal(
    cloudUserProfileSyncResultItemSchema.safeParse({
      category: "skills",
      entryId: "demo",
      status: "synced",
      error: "x".repeat(513),
    }).success,
    false,
  );
  assert.equal(
    cloudUserProfileSyncResultItemSchema.safeParse({
      category: "commands",
      entryId: "deploy",
      status: "synced",
    }).success,
    false,
    "markdown 类别结果同样要求 *.md 定位",
  );

  const response = {
    runId: RUN_ID,
    profileVersion: 7,
    trigger: "manual",
    results: [
      { category: "commands", entryId: "deploy.md", status: "synced" },
      { category: "skills", entryId: "demo", status: "skipped" },
      { category: "agents-md", entryId: "user-agents", status: "failed", error: "write denied" },
    ],
  };
  const parsed = cloudUserProfileSyncResponseSchema.parse(response);
  assert.equal(parsed.trigger, "manual");
  assert.equal(parsed.results.length, 3);
  assert.deepEqual(
    cloudUserProfileSyncResponseSchema.parse(JSON.parse(JSON.stringify(parsed))),
    parsed,
  );
  // 自动同步（bridge ready 后一次）复用同一形状（结论只记日志，不进 HTTP 响应）。
  assert.equal(
    cloudUserProfileSyncResponseSchema.parse({ ...response, trigger: "automatic" }).trigger,
    "automatic",
  );
  assert.equal(
    cloudUserProfileSyncResponseSchema.parse({ ...response, results: [] }).results.length,
    0,
    "空 profile 的同步结论是空数组（不是缺字段）",
  );
  // runId / profileVersion / trigger / results 全部必填，越界结果数与未知字段拒绝。
  for (const invalid of [
    { ...response, runId: "not-a-uuid" },
    { ...response, profileVersion: 0 },
    { ...response, trigger: "startup" },
    { ...response, injected: true },
    { ...response, results: undefined },
    {
      ...response,
      results: Array.from({ length: CLOUD_USER_PROFILE_MAX_ENTRIES + 1 }, (_unused, index) => ({
        category: "skills",
        entryId: `entry-${index}`,
        status: "synced",
      })),
    },
  ]) {
    assert.equal(
      cloudUserProfileSyncResponseSchema.safeParse(invalid).success,
      false,
      `sync response ${JSON.stringify(invalid).slice(0, 60)} must be rejected`,
    );
  }
});

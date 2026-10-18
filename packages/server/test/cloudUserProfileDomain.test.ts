/**
 * M8 profile 领域纯规则单测（specs/cloud-agent 14 §9.2②③/§4.4/§4.5；W11 §13B）。
 *
 * 覆盖：`bytes` 口径精算、条目标定序、归档最小前置（gzip 前缀）、上传超限前置（含
 * commands/subagents 的 markdown 文本类）、agents-md 单例约束、连接期同步的纯规则
 * （markdown 分类、base64 编解码、分块、mcp 分批、错误文本有界）。
 * 原 bundle／分片用例随 `bootstrap.resources` 退役整体删除（14 §4.8/§9.5）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES, isCloudProfileCanonicalBase64 } from "@zcode/shared";
import {
  compareUserProfileEntries,
  isUserProfileMarkdownCategory,
  sortUserProfileEntries,
  userProfileAgentsMdEntryIdReason,
  userProfileArchiveGzipPrefixOk,
  userProfileContentKindOf,
  userProfileUploadOversizeReason,
  userProfileUtf8ByteLength,
} from "../src/cloud/domain/userProfile.js";
import {
  commandNameFromMarkdownEntryId,
  decodeCanonicalBase64,
  encodeCanonicalBase64,
  planArchiveChunks,
  planCommandFileWrite,
  planMcpSyncBatches,
  userProfileSyncErrorText,
} from "../src/cloud/domain/userProfileSync.js";

test("UTF-8 字节精算与 Buffer 权威一致（含代理对）", () => {
  for (const value of ["ascii", "中文", "emoji-😀-mix", "a\u0000b", "é"]) {
    assert.equal(userProfileUtf8ByteLength(value), Buffer.byteLength(value, "utf8"), value);
  }
});

test("条目顺序：类别按枚举次序，同类别按 entryId 字典序（确定性来源）", () => {
  const entries = [
    { category: "agents-md" as const, entryId: "z" },
    { category: "mcp" as const, entryId: "b" },
    { category: "skills" as const, entryId: "a" },
    { category: "mcp" as const, entryId: "a" },
  ];
  assert.deepEqual(
    sortUserProfileEntries(entries).map((entry) => `${entry.category}/${entry.entryId}`),
    ["mcp/a", "mcp/b", "skills/a", "agents-md/z"],
  );
  assert.equal(
    compareUserProfileEntries(
      { category: "plugins", entryId: "a" },
      { category: "subagents", entryId: "a" },
    ),
    -1,
  );
});

test("归档最小前置只认 gzip magic（0x1f 0x8b）", () => {
  const gzip = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from("payload")]);
  assert.equal(userProfileArchiveGzipPrefixOk(gzip.toString("base64")), true);
  // 0x1f 0x8c（非 gzip）与普通文本都拒绝。
  assert.equal(
    userProfileArchiveGzipPrefixOk(Buffer.from([0x1f, 0x8c, 0x08, 0x00]).toString("base64")),
    false,
  );
  assert.equal(userProfileArchiveGzipPrefixOk(Buffer.from("plain").toString("base64")), false);
  // 过短/非法字符：不猜，直接 false（严格 schema 已先行拒绝）。
  assert.equal(userProfileArchiveGzipPrefixOk("abc"), false);
});

test("上传超限前置：命中类别阈值即返回原因，形状错误交给 schema", () => {
  assert.equal(userProfileUploadOversizeReason("mcp", { config: { a: 1 } }), null);
  assert.equal(
    userProfileUploadOversizeReason("mcp", { config: { big: "x".repeat(256 * 1024) } }),
    "mcp-config-too-large",
  );
  assert.equal(
    userProfileUploadOversizeReason("agents-md", { content: "x".repeat(256 * 1024 + 1) }),
    "agents-md-too-large",
  );
  // 归档：base64 字符上限（未解码即拒绝），用小类别的 20MiB 上限推导值验证。
  const overArchive = "A".repeat(Math.ceil((20 * 1024 * 1024) / 3) * 4 + 4);
  assert.equal(
    userProfileUploadOversizeReason("skills", { archiveBase64: overArchive }),
    "skills-archive-too-large",
  );
  assert.equal(userProfileUploadOversizeReason("unknown", { content: "x".repeat(1e6) }), null);
});

test("markdown 类别：commands/subagents 是文本类（content_kind=markdown），归档类收敛为 skills/plugins", () => {
  assert.equal(isUserProfileMarkdownCategory("commands"), true);
  assert.equal(isUserProfileMarkdownCategory("subagents"), true);
  assert.equal(isUserProfileMarkdownCategory("skills"), false);
  assert.equal(userProfileContentKindOf("commands"), "markdown");
  assert.equal(userProfileContentKindOf("subagents"), "markdown");
  assert.equal(userProfileContentKindOf("skills"), "archive-base64");
  assert.equal(userProfileContentKindOf("plugins"), "archive-base64");
  assert.equal(userProfileContentKindOf("agents-md"), "agents-md");
  assert.equal(userProfileContentKindOf("mcp"), "mcp-config");

  // markdown 单文件条目的超限前置与 agents-md 同口径但具名 reason（14 §4.5）。
  assert.equal(
    userProfileUploadOversizeReason("commands", { content: "x".repeat(256 * 1024 + 1) }),
    "commands-content-too-large",
  );
  assert.equal(
    userProfileUploadOversizeReason("subagents", { content: "x".repeat(256 * 1024 + 1) }),
    "subagents-content-too-large",
  );
  assert.equal(userProfileUploadOversizeReason("commands", { content: "小" }), null);
});

test("base64 纯编解码：canonical 形状往返与 Buffer 权威交叉验证（分块导入的块负载）", () => {
  for (const text of ["A", "AB", "ABC", "ABCD", "hello world", '{"a":1}']) {
    const decoded = decodeCanonicalBase64(Buffer.from(text, "utf8").toString("base64"));
    assert.equal(Buffer.from(decoded).toString("utf8"), text);
    const encoded = encodeCanonicalBase64(decoded);
    assert.ok(isCloudProfileCanonicalBase64(encoded), encoded);
    assert.equal(encoded, Buffer.from(text, "utf8").toString("base64"));
  }
  // 任意字节（含 0x00/0xff 与各长度余数）往返一致。
  for (let length = 1; length < 200; length += 7) {
    const bytes = Buffer.alloc(length);
    for (let index = 0; index < length; index += 1) bytes[index] = (index * 37 + length * 11) % 256;
    const encoded = encodeCanonicalBase64(bytes);
    assert.equal(encoded, Buffer.from(bytes).toString("base64"), `长度 ${length} 与 Buffer 一致`);
    assert.deepEqual(Buffer.from(decodeCanonicalBase64(encoded)), bytes);
  }
  // 非 canonical 形状拒绝（fail-closed，不产出半份归档）。
  assert.throws(() => decodeCanonicalBase64("abc"));
  assert.throws(() => decodeCanonicalBase64("QQ=A"));
  assert.throws(() => decodeCanonicalBase64("Q==="));
  assert.throws(() => decodeCanonicalBase64("!!!!"));
});

test("分块：块大小 ≤2MiB（14 §4.4）、顺序即 chunkIndex、切片拼接还原原文", () => {
  const bytes = Buffer.alloc(USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES * 2 + 5, 9);
  const chunks = planArchiveChunks(bytes);
  assert.equal(chunks.length, 3);
  for (const chunk of chunks) assert.ok(chunk.byteLength <= USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES);
  assert.deepEqual(Buffer.concat(chunks), bytes);
  assert.equal(planArchiveChunks(Buffer.alloc(0)).length, 0, "空字节不制造零块会话");
  // 小归档单块（顺序与内容原样）。
  assert.equal(planArchiveChunks(Buffer.from("tiny")).length, 1);
});

test("mcp 分批：≤2MiB/批、批内 entryId 升序；单条超限独自成批（14 §4.2）", () => {
  const entry = (entryId: string, size: number) => ({
    entryId,
    config: { args: ["x".repeat(size)], command: "npx" },
  });
  const batches = planMcpSyncBatches([
    entry("b", 800_000),
    entry("a", 800_000),
    entry("c", 800_000),
  ]);
  assert.deepEqual(
    batches.map((batch) => batch.map((item) => item.entryId)),
    [["a", "b"], ["c"]],
    "前两条同批（1.6MB ≤ 2MiB），第三条推新批；批内按 entryId 升序",
  );
  // 单条 >2MiB：独自成批（不截断、不丢条目，交给被调服务的既有上限拒绝）。
  const oversized = planMcpSyncBatches([entry("big", 2 * 1024 * 1024 + 1024)]);
  assert.equal(oversized.length, 1);
  assert.equal(oversized[0]?.length, 1);
  assert.deepEqual(planMcpSyncBatches([]), []);
});

test("commands：entryId 去 .md 得到既有写方法的名字；正文整份透传（front-matter 由既有服务读回）", () => {
  assert.equal(commandNameFromMarkdownEntryId("review.md"), "review");
  assert.equal(commandNameFromMarkdownEntryId("nested-name.md"), "nested-name");
  const content = "---\ndescription: 审查\n---\n请审查";
  assert.deepEqual(planCommandFileWrite({ entryId: "review.md", content }), {
    name: "review",
    prompt: content,
  });
});

test("agents-md 单例：entryId 必须为 user-agents，其余类别不受影响（2026-10-17 收口）", () => {
  assert.equal(userProfileAgentsMdEntryIdReason("agents-md", "user-agents"), null);
  assert.equal(
    userProfileAgentsMdEntryIdReason("agents-md", "other"),
    "agents-md-entry-id-must-be-user-agents",
  );
  assert.equal(
    userProfileAgentsMdEntryIdReason("agents-md", "other.md"),
    "agents-md-entry-id-must-be-user-agents",
  );
  // 单例只约束 agents-md；commands/subagents 的文件名仍按 `.md` 形状各自提交。
  assert.equal(userProfileAgentsMdEntryIdReason("commands", "review.md"), null);
  assert.equal(userProfileAgentsMdEntryIdReason("subagents", "helper.md"), null);
});

test("逐条错误文本：单行、有界、不回传正文（14 §5）", () => {
  assert.equal(userProfileSyncErrorText(new Error("first line\nsecond line")), "first line");
  assert.equal(userProfileSyncErrorText("  spaced   out  "), "spaced out");
  assert.equal(userProfileSyncErrorText(undefined), "sync call failed");
  const long = userProfileSyncErrorText(new Error("x".repeat(2000)));
  assert.equal(long.length, 512, "错误文本按 shared schema 上限截断");
});

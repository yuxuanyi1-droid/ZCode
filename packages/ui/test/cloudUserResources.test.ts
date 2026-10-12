/**
 * 云用户资源管理（P20；specs/cloud-agent 14 §4.5/§9.4①；W11 §12/§13D）用例。
 *
 * 覆盖范围与理由：
 * - store 投影/optimistic overlay/回填/回滚/结构化错误——这是"不建第二权威"的落点；
 * - 纯逻辑层（entryId 与上限前置、markdown 条目形态、分块 base64、MCP JSON 预校验、
 *   错误码 → i18n key、分组与格式化）——hook 的动作就是"校验 + 组 body + 调端口 + 回填 store"；
 * - i18n 键覆盖：源码引用的 `settings.cloudUserResources.*` 必须在两个 locale 都存在
 *   （漏键在运行时只会显示 id，靠人眼发现）；
 * - **未覆盖**：hook 与组件的渲染级行为（act/effect 时序、开关点击）。本包测试布局是
 *   `node --test` 纯逻辑（无 React renderer / jsdom），E2E 场景不在本批（如实记录，
 *   见 spec §9.4 与验收记录的"未执行"栏）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { CloudUserProfileEntry } from "@zcode/shared";
import {
  CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID,
  CLOUD_USER_RESOURCES_MARKDOWN_ENTRY_ID_SUFFIX,
  encodeUserResourceArchiveBase64Bytes,
  findUserResourceEntry,
  formatUserResourceBytes,
  groupUserResourcesByCategory,
  isUserResourceArchiveCategory,
  isUserResourceMarkdownCategory,
  parseUserResourceEntryKey,
  parseUserResourceMcpConfigJson,
  userResourceEntryKey,
  userResourceInputKindOf,
  userResourcesErrorKey,
  validateUserResourceArchiveFile,
  validateUserResourceEntryId,
  validateUserResourceMarkdownContent,
  validateUserResourceMarkdownEntry,
  validateUserResourceMarkdownEntryId,
  type CloudUserResourcesError,
} from "../src/cloud/userResourcesModel.js";
import {
  selectVisibleUserResourceEntries,
  useCloudUserResourcesStore,
} from "../src/store/cloud/cloudUserResourcesStore.js";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function entryFixture(overrides: Partial<CloudUserProfileEntry> = {}): CloudUserProfileEntry {
  return {
    category: "mcp",
    entryId: "primary",
    enabled: true,
    sha256: SHA_A,
    bytes: 42,
    ...overrides,
  };
}

function resetStore() {
  useCloudUserResourcesStore.getState().reset();
}

// ── store：投影 / overlay / 回填 / 回滚 ──

test("快照写入投影，optimistic overlay 只影响展示不改权威", () => {
  resetStore();
  const store = useCloudUserResourcesStore.getState();
  store.applySnapshot({
    profileVersion: 3,
    entries: [entryFixture()],
    totalBytes: 42,
    createdAtMs: 1_760_000_000_000,
  });
  assert.equal(useCloudUserResourcesStore.getState().profileVersion, 3);
  assert.equal(
    selectVisibleUserResourceEntries(useCloudUserResourcesStore.getState())[0]?.enabled,
    true,
  );

  // 开关先动（optimistic），版本与条目本体不动。
  store.setEnabledOverlay(userResourceEntryKey("mcp", "primary"), false);
  const visible = selectVisibleUserResourceEntries(useCloudUserResourcesStore.getState());
  assert.equal(visible[0]?.enabled, false, "overlay 立即生效");
  assert.equal(useCloudUserResourcesStore.getState().entries[0]?.enabled, true, "权威投影不被改写");
  assert.equal(useCloudUserResourcesStore.getState().profileVersion, 3, "本地不发明版本推进");
});

test("写成功以响应回填：条目元数据与 profileVersion 都以服务端为准", () => {
  resetStore();
  const store = useCloudUserResourcesStore.getState();
  store.applySnapshot({
    profileVersion: 3,
    entries: [entryFixture()],
    totalBytes: 42,
    createdAtMs: 1,
  });
  const key = userResourceEntryKey("mcp", "primary");
  store.setEnabledOverlay(key, false);
  store.beginWrite(key, "toggle");
  // 服务端响应：enabled=false、版本 4（toggle 递增）。
  store.applyEntryResult(entryFixture({ enabled: false }), 4);

  const state = useCloudUserResourcesStore.getState();
  assert.equal(state.profileVersion, 4);
  assert.equal(state.entries[0]?.enabled, false);
  assert.equal(state.enabledOverlay[key], undefined, "回填后 overlay 必须清掉");
  assert.equal(state.pendingByKey[key], undefined);
  assert.equal(state.totalBytes, 42, "同 bytes 的替换不改变总量");
});

test("写失败回滚 overlay、保留权威投影，并记录结构化错误（版本不动）", () => {
  resetStore();
  const store = useCloudUserResourcesStore.getState();
  store.applySnapshot({
    profileVersion: 3,
    entries: [entryFixture()],
    totalBytes: 42,
    createdAtMs: 1,
  });
  const key = userResourceEntryKey("mcp", "primary");
  const error: CloudUserResourcesError = {
    code: "invalid_entry",
    reason: "invalid-enabled-body",
    message: "raw server text",
    entryKey: key,
  };
  store.setEnabledOverlay(key, false);
  store.beginWrite(key, "toggle");
  store.failWrite(key, error);

  const state = useCloudUserResourcesStore.getState();
  assert.equal(state.enabledOverlay[key], undefined, "失败必须回滚 optimistic 显示");
  assert.equal(state.pendingByKey[key], undefined);
  assert.deepEqual(state.errorByKey[key], error, "错误按 code/reason 结构化保留（不解析文案）");
  assert.equal(state.profileVersion, 3, "失败不推进版本");
  assert.equal(selectVisibleUserResourceEntries(state)[0]?.enabled, true, "回滚后回到服务端事实");
});

test("删除：optimistic 先隐藏，成功移除并扣减总量；失败恢复显示", () => {
  resetStore();
  const store = useCloudUserResourcesStore.getState();
  store.applySnapshot({
    profileVersion: 5,
    entries: [entryFixture({ bytes: 100 }), entryFixture({ entryId: "secondary", bytes: 7 })],
    totalBytes: 107,
    createdAtMs: 1,
  });
  const key = userResourceEntryKey("mcp", "primary");

  store.markRemovedOverlay(key);
  store.beginWrite(key, "delete");
  assert.equal(selectVisibleUserResourceEntries(useCloudUserResourcesStore.getState()).length, 1);

  store.applyDeleteResult(key, 6);
  let state = useCloudUserResourcesStore.getState();
  assert.equal(state.entries.length, 1);
  assert.equal(state.profileVersion, 6);
  assert.equal(state.totalBytes, 7, "总量按被删条目扣减");

  // 第二次：删除失败 → 条目必须回到列表（回滚 removedOverlay）。
  const secondKey = userResourceEntryKey("mcp", "secondary");
  store.markRemovedOverlay(secondKey);
  store.beginWrite(secondKey, "delete");
  store.failWrite(secondKey, {
    code: "network_unknown",
    reason: null,
    message: "socket hang up",
    entryKey: secondKey,
  });
  state = useCloudUserResourcesStore.getState();
  assert.equal(selectVisibleUserResourceEntries(state).length, 1, "失败后条目恢复显示");
  assert.equal(state.errorByKey[secondKey]?.code, "network_unknown");
});

test("正文缓存与版本事实对齐：sha256 不符即作废（不显示上一版正文）", () => {
  resetStore();
  const store = useCloudUserResourcesStore.getState();
  store.applySnapshot({
    profileVersion: 2,
    entries: [entryFixture()],
    totalBytes: 42,
    createdAtMs: 1,
  });
  const key = userResourceEntryKey("mcp", "primary");
  store.applyContent(key, {
    payload: { category: "mcp", config: { command: "npx" } },
    sha256: SHA_A,
  });
  assert.equal(useCloudUserResourcesStore.getState().contentByKey[key]?.sha256, SHA_A);

  // 同 sha 刷新：缓存保留（编辑表单不闪空）。
  store.applySnapshot({
    profileVersion: 2,
    entries: [entryFixture()],
    totalBytes: 42,
    createdAtMs: 1,
  });
  assert.equal(useCloudUserResourcesStore.getState().contentByKey[key]?.sha256, SHA_A);

  // 条目被替换（新 sha）：旧正文缓存必须丢弃。
  store.applySnapshot({
    profileVersion: 3,
    entries: [entryFixture({ sha256: SHA_B })],
    totalBytes: 42,
    createdAtMs: 1,
  });
  assert.equal(useCloudUserResourcesStore.getState().contentByKey[key], undefined);

  // 条目被删除：正文缓存一并清除。
  store.applyContent(key, { payload: { category: "mcp", config: {} }, sha256: SHA_B });
  store.applyDeleteResult(key, 4);
  assert.equal(useCloudUserResourcesStore.getState().contentByKey[key], undefined);
});

test("加载失败保留 last-known 投影，主体切换清空投影（不跨主体复用）", () => {
  resetStore();
  const store = useCloudUserResourcesStore.getState();
  store.setPrincipal("principal-a");
  store.applySnapshot({
    profileVersion: 7,
    entries: [entryFixture()],
    totalBytes: 42,
    createdAtMs: 1,
  });
  store.failLoad({ code: "network_unknown", reason: null, message: "offline", entryKey: null });

  let state = useCloudUserResourcesStore.getState();
  assert.equal(state.status, "error");
  assert.equal(state.entries.length, 1, "加载失败不改写既有投影（保留 last-known）");
  assert.equal(state.profileVersion, 7);

  store.setPrincipal("principal-b");
  state = useCloudUserResourcesStore.getState();
  assert.equal(state.entries.length, 0);
  assert.equal(state.profileVersion, null);
  assert.equal(state.error, null);
});

// ── 纯逻辑：校验 / 编码 / 映射 ──

test("entryId 形状：复用 shared 正则，空值与非法形状分别给出可读原因", () => {
  assert.deepEqual(validateUserResourceEntryId("user-agents"), { ok: true, value: "user-agents" });
  assert.deepEqual(validateUserResourceEntryId("a"), { ok: true, value: "a" });
  assert.equal(validateUserResourceEntryId("  ").ok, false);
  assert.equal(validateUserResourceEntryId("Upper").ok, false, "大写开头非法");
  assert.equal(validateUserResourceEntryId("-leading").ok, false);
  assert.equal(validateUserResourceEntryId("a".repeat(129)).ok, false, "超过 128 字符");
  assert.equal(validateUserResourceEntryId("a".repeat(128)).ok, true);
  const empty = validateUserResourceEntryId("");
  assert.equal(empty.ok === false && empty.failure.reason, "empty");
  const shape = validateUserResourceEntryId("Bad Id");
  assert.equal(shape.ok === false && shape.failure.reason, "shape");
});

test("归档文件前置：空文件 / 类别上限（20MiB、50MiB）/ 80MiB 上传体上限", () => {
  const skill = validateUserResourceArchiveFile({ category: "skills", bytes: 20 * 1024 * 1024 });
  assert.equal(skill.ok, true);
  const skillOver = validateUserResourceArchiveFile({
    category: "skills",
    bytes: 20 * 1024 * 1024 + 1,
  });
  assert.equal(skillOver.ok === false && skillOver.failure.reason, "file-too-large");
  assert.equal(
    skillOver.ok === false && skillOver.failure.reason === "file-too-large"
      ? skillOver.failure.maxBytes
      : 0,
    20 * 1024 * 1024,
  );
  // plugins 50MiB 合法（证明按类别取值，不是统一上限）。
  assert.equal(
    validateUserResourceArchiveFile({ category: "plugins", bytes: 50 * 1024 * 1024 }).ok,
    true,
  );
  // 上传体上限（80MiB）优先于类别上限：plugins 的 81MiB 先触发 body 上限。
  const body = validateUserResourceArchiveFile({ category: "plugins", bytes: 81 * 1024 * 1024 });
  assert.equal(body.ok === false && body.failure.reason, "body-too-large");
  assert.equal(validateUserResourceArchiveFile({ category: "skills", bytes: 0 }).ok, false);
});

test("markdown 条目形态（14 §4.5）：entryId 须为 *.md 文件名，正文按 UTF-8 字节限 256KiB", () => {
  // 后缀是唯一来源 shared 的常量（UI 不手写第二份规则）。
  assert.equal(CLOUD_USER_RESOURCES_MARKDOWN_ENTRY_ID_SUFFIX, ".md");

  // entryId：合法（含 .md 后缀）；空 / 形状 / 缺后缀三档分别可读。
  assert.deepEqual(validateUserResourceMarkdownEntryId("review.md"), {
    ok: true,
    value: "review.md",
  });
  assert.deepEqual(validateUserResourceMarkdownEntryId("a.md"), { ok: true, value: "a.md" });
  const empty = validateUserResourceMarkdownEntryId("   ");
  assert.equal(empty.ok === false && empty.failure.reason, "empty");
  const shape = validateUserResourceMarkdownEntryId("Bad Name.md");
  assert.equal(shape.ok === false && shape.failure.reason, "shape");
  const missingSuffix = validateUserResourceMarkdownEntryId("review");
  assert.equal(missingSuffix.ok === false && missingSuffix.failure.reason, "markdown-suffix");
  assert.equal(
    missingSuffix.ok === false && missingSuffix.failure.reason === "markdown-suffix"
      ? missingSuffix.failure.suffix
      : "",
    ".md",
  );
  // 首字符规则排除 `.md` 自身（空 name）与路径分隔符（天然排除穿越）。
  assert.equal(validateUserResourceMarkdownEntryId(".md").ok, false);
  assert.equal(validateUserResourceMarkdownEntryId("sub/agent.md").ok, false);
  // 总长上限 128（含后缀）：125 + ".md" = 128 合法，126 + ".md" = 129 超限。
  assert.equal(validateUserResourceMarkdownEntryId("a".repeat(125) + ".md").ok, true);
  assert.equal(validateUserResourceMarkdownEntryId("a".repeat(126) + ".md").ok, false);

  // 正文：256KiB ASCII 合法；超 1 字节拒绝；多字节字符按 UTF-8 字节精算。
  const maxBytes = 256 * 1024;
  assert.equal(validateUserResourceMarkdownContent("x".repeat(maxBytes)).ok, true);
  const tooLarge = validateUserResourceMarkdownContent("x".repeat(maxBytes + 1));
  assert.equal(tooLarge.ok === false && tooLarge.failure.reason, "markdown-too-large");
  assert.equal(
    tooLarge.ok === false && tooLarge.failure.reason === "markdown-too-large"
      ? tooLarge.failure.maxBytes
      : 0,
    maxBytes,
  );
  // 中文字符 3 字节：字符数不超上限但字节数超上限的边界（1024*86 = 258KiB > 256KiB）。
  const cjk = "中".repeat(Math.ceil(maxBytes / 3) + 1);
  assert.ok(cjk.length < maxBytes, "字符数闸放行");
  const cjkResult = validateUserResourceMarkdownContent(cjk);
  assert.equal(cjkResult.ok === false && cjkResult.failure.reason, "markdown-too-large");

  // 组合前置：先 entryId 后正文（两条规则都要过）。
  assert.equal(validateUserResourceMarkdownEntry({ entryId: "review", content: "x" }).ok, false);
  assert.equal(
    validateUserResourceMarkdownEntry({ entryId: "review.md", content: "" }).ok,
    true,
    "空正文合法（条目正文可以为空）",
  );
  assert.equal(
    validateUserResourceMarkdownEntry({
      entryId: "review.md",
      content: "x".repeat(maxBytes + 1),
    }).ok,
    false,
  );
});

test("分块 base64 与参考实现逐字节一致（100KB 跨多块，防 fromCharCode 分块错位）", () => {
  // 确定性伪随机：任意字节值（含 0x00 / 0xff / 非 ASCII），覆盖 padding 边界。
  const bytes = new Uint8Array(100_003);
  let seed = 123456789;
  for (let index = 0; index < bytes.length; index += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    bytes[index] = seed % 256;
  }
  const encoded = encodeUserResourceArchiveBase64Bytes(bytes);
  assert.equal(encoded, Buffer.from(bytes).toString("base64"));
  // 小尺寸（<1 块）与 4/3 展开也对齐参考实现。
  for (const size of [1, 2, 3, 4, 31, 0x8000, 0x8001]) {
    const slice = bytes.subarray(0, size);
    assert.equal(
      encodeUserResourceArchiveBase64Bytes(slice),
      Buffer.from(slice).toString("base64"),
    );
  }
  assert.equal(
    encodeUserResourceArchiveBase64Bytes(new Uint8Array([0x1f, 0x8b, 0x08, 0x00])),
    "H4sIAA==",
    "gzip magic 前缀的编码形态（与 server 上传用例的 `0x1f 0x8b` 前缀同一字节序列）",
  );
});

test("MCP 配置 JSON 预校验：空/非法/非对象/超限分别拒绝，合法对象通过", () => {
  assert.equal(parseUserResourceMcpConfigJson("   ").ok, false);
  assert.equal(parseUserResourceMcpConfigJson("{").ok, false);
  assert.equal(parseUserResourceMcpConfigJson("[1,2]").ok, false);
  assert.equal(parseUserResourceMcpConfigJson('"text"').ok, false);
  const tooLarge = parseUserResourceMcpConfigJson(`{"pad":"${"x".repeat(256 * 1024)}"}`);
  assert.equal(tooLarge.ok === false && tooLarge.failure.reason, "too-large");

  const ok = parseUserResourceMcpConfigJson('{"command":"npx","env":{"TOKEN":"t"}}');
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.config["command"], "npx");
    assert.equal(ok.jsonText, '{"command":"npx","env":{"TOKEN":"t"}}');
  }
  const invalid = parseUserResourceMcpConfigJson("{nope}");
  assert.equal(invalid.ok === false && invalid.failure.reason, "invalid-json");
});

test("错误码/reason → i18n key：404、413、409、鉴权与网络分别落到不同文案", () => {
  const key = (error: Partial<CloudUserResourcesError>) =>
    userResourcesErrorKey({
      code: null,
      reason: null,
      message: "",
      entryKey: null,
      ...error,
    });
  assert.equal(
    key({ reason: "profile-entry-not-found" }),
    "settings.cloudUserResources.error.notFound",
  );
  assert.equal(key({ code: "not_found" }), "settings.cloudUserResources.error.notFound");
  assert.equal(
    key({ code: "payload_too_large" }),
    "settings.cloudUserResources.error.payloadTooLarge",
  );
  assert.equal(
    key({ code: "profile_total_exceeded" }),
    "settings.cloudUserResources.error.profileTotalExceeded",
  );
  assert.equal(
    key({ code: "profile_entries_exceeded" }),
    "settings.cloudUserResources.error.profileEntriesExceeded",
  );
  assert.equal(key({ code: "unauthorized" }), "settings.cloudUserResources.error.unauthorized");
  assert.equal(key({ code: "network_unknown" }), "settings.cloudUserResources.error.network");
  // 结果未知（无 code）不猜语义，落 unknown。
  assert.equal(key({}), "settings.cloudUserResources.error.unknown");
});

test("类别分组与展示格式化：顺序沿 shared 枚举、空类别保留", () => {
  const entries: CloudUserProfileEntry[] = [
    entryFixture({ category: "skills", entryId: "zeta" }),
    entryFixture({ category: "mcp", entryId: "primary" }),
    entryFixture({ category: "skills", entryId: "alpha" }),
  ];
  const groups = groupUserResourcesByCategory(entries);
  assert.deepEqual(
    groups.map((group) => group.category),
    ["mcp", "skills", "commands", "plugins", "subagents", "agents-md"],
  );
  assert.deepEqual(
    groups.find((group) => group.category === "skills")?.entries.map((entry) => entry.entryId),
    ["alpha", "zeta"],
  );
  assert.equal(
    groups.find((group) => group.category === "plugins")?.entries.length,
    0,
    "空类别保留入口",
  );

  assert.equal(formatUserResourceBytes(0), "0 B");
  assert.equal(formatUserResourceBytes(1023), "1023 B");
  assert.equal(formatUserResourceBytes(1024), "1.0 KiB");
  assert.equal(formatUserResourceBytes(20 * 1024 * 1024), "20 MiB");
  assert.equal(formatUserResourceBytes(50 * 1024 * 1024), "50 MiB");
  assert.equal(formatUserResourceBytes(1536), "1.5 KiB");
});

test("类别 → 录入方式与键工具：归档收敛 skills/plugins，commands/subagents 为 markdown 文本", () => {
  assert.equal(userResourceInputKindOf("skills"), "archive");
  assert.equal(userResourceInputKindOf("plugins"), "archive");
  assert.equal(isUserResourceArchiveCategory("skills"), true);
  assert.equal(isUserResourceArchiveCategory("commands"), false, "简化修订：不再走归档上传");
  assert.equal(isUserResourceArchiveCategory("subagents"), false);
  assert.equal(isUserResourceArchiveCategory("mcp"), false);
  assert.equal(userResourceInputKindOf("commands"), "markdown-text");
  assert.equal(userResourceInputKindOf("subagents"), "markdown-text");
  assert.equal(isUserResourceMarkdownCategory("commands"), true);
  assert.equal(isUserResourceMarkdownCategory("subagents"), true);
  assert.equal(isUserResourceMarkdownCategory("skills"), false);
  assert.equal(isUserResourceMarkdownCategory("agents-md"), false);
  assert.equal(userResourceInputKindOf("mcp"), "mcp-json");
  assert.equal(userResourceInputKindOf("agents-md"), "agents-md-text");
  assert.equal(CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID, "user-agents");

  const key = userResourceEntryKey("agents-md", CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID);
  assert.deepEqual(parseUserResourceEntryKey(key), {
    category: "agents-md",
    entryId: CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID,
  });
  assert.equal(parseUserResourceEntryKey("hooks\u0000x"), null, "非法类别不解析");
  assert.equal(findUserResourceEntry([entryFixture()], "mcp", "primary")?.entryId, "primary");
  assert.equal(findUserResourceEntry([entryFixture()], "mcp", "ghost"), null);
});

// ── i18n 键覆盖（漏键在运行时只显示 id）──

test("源码引用的 settings.cloudUserResources.* 键在两个 locale 都存在", () => {
  const sources = [
    "src/settings/CloudUserResourcesSection.tsx",
    "src/settings/cloudUserResourcesSectionParts.tsx",
    "src/settings/cloudUserResourcesArchivePanel.tsx",
    "src/settings/cloudUserResourcesMarkdownPanel.tsx",
    "src/settings/cloudUserResourcesMcpPanel.tsx",
    "src/settings/cloudUserResourcesAgentsMdPanel.tsx",
    "src/cloud/userResourcesModel.ts",
  ];
  const referenced = new Set<string>();
  for (const source of sources) {
    const text = readFileSync(new URL(`../${source}`, import.meta.url), "utf8");
    for (const match of text.matchAll(/"(settings\.cloudUserResources\.[A-Za-z0-9.-]+)"/g)) {
      referenced.add(match[1] as string);
    }
    for (const match of text.matchAll(/id: `(settings\.cloudUserResources\.[A-Za-z0-9.-]+)`/g)) {
      referenced.add(match[1] as string);
    }
    if (/settings\.cloudUserResources\.category\.\$\{/.test(text)) {
      for (const category of ["mcp", "skills", "commands", "plugins", "subagents", "agents-md"]) {
        referenced.add(`settings.cloudUserResources.category.${category}`);
      }
    }
  }
  assert.ok(referenced.size > 40, `referenced keys look too few: ${referenced.size}`);

  for (const locale of ["zh-CN", "en-US"]) {
    const text = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8");
    const defined = new Set(
      [...text.matchAll(/"(settings\.cloudUserResources\.[A-Za-z0-9.-]+)":/g)].map(
        (match) => match[1] as string,
      ),
    );
    const missing = [...referenced].filter((key) => !defined.has(key));
    assert.deepEqual(missing, [], `${locale} is missing ${missing.join(", ")}`);
  }
});

test("源码引用的 cloud.userProfileSync.* 键在两个 locale 都存在（任务面板同步入口）", () => {
  const sources = [
    "src/cloud/CloudTaskUserProfileSyncRow.tsx",
    "src/cloud/cloudTaskUserProfileSync.ts",
  ];
  const referenced = new Set<string>();
  for (const source of sources) {
    const text = readFileSync(new URL(`../${source}`, import.meta.url), "utf8");
    for (const match of text.matchAll(/"(cloud\.userProfileSync\.[A-Za-z0-9.-]+)"/g)) {
      referenced.add(match[1] as string);
    }
  }
  assert.ok(referenced.size >= 8, `referenced keys look too few: ${referenced.size}`);

  for (const locale of ["zh-CN", "en-US"]) {
    const text = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8");
    const defined = new Set(
      [...text.matchAll(/"(cloud\.userProfileSync\.[A-Za-z0-9.-]+)":/g)].map(
        (match) => match[1] as string,
      ),
    );
    const missing = [...referenced].filter((key) => !defined.has(key));
    assert.deepEqual(missing, [], `${locale} is missing ${missing.join(", ")}`);
  }
});

test("设置页顶部说明为连接期语义（旧「新任务安装 / 运行中冻结」文案已删除）", () => {
  for (const locale of ["zh-CN", "en-US"]) {
    const text = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8");
    assert.equal(
      /savedNextRun|new tasks install|新任务会自动|保持创建时的版本/.test(text),
      false,
      `${locale} 仍有退役的"新任务安装/运行中冻结版本"文案`,
    );
  }
  const zh = readFileSync(new URL("../src/i18n/locales/zh-CN.ts", import.meta.url), "utf8");
  assert.match(zh, /沙箱连接建立后会自动同步一次/, "zh-CN 顶部说明为连接期语义");
  assert.match(zh, /未连接时不提供同步/);
  const en = readFileSync(new URL("../src/i18n/locales/en-US.ts", import.meta.url), "utf8");
  assert.match(en, /sync automatically once a sandbox connection is established/);
  assert.match(en, /no sync is offered while disconnected/);
});

/**
 * 结构冒烟：分区在云模式上下文中挂载（标题/分类 tab/面板）不抛错；非云模式渲染为空。
 *
 * 为什么只断言"结构"而不驱动数据：zustand v5 的 `useSyncExternalStore` 在 SSR 下取的是
 * `getInitialState()`（`getServerSnapshot`），`renderToStaticMarkup` 因此看不到测试预先
 * 写入的投影——数据驱动断言必须用真实 DOM renderer（本包无），列悬项。此用例仍有价值：
 * 它验证 Provider/context/intl 组合、hook 调用顺序与面板装配在渲染期不炸。
 */
test("分区渲染冒烟：云模式渲染出标题与分类 tab，非云模式渲染为空", async (t) => {
  let renderToStaticMarkup: (element: unknown) => string;
  let createElement: typeof import("react").createElement;
  try {
    ({ renderToStaticMarkup } = await import("react-dom/server"));
    ({ createElement } = await import("react"));
  } catch {
    t.skip("react-dom/server 不可用");
    return;
  }
  const [{ ZCodeIntlProvider }, { CloudWorkspaceContextProvider }, { CloudUserResourcesSection }] =
    await Promise.all([
      import("../src/i18n/IntlProvider.js"),
      import("../src/cloud/cloudWorkspaceContext.js"),
      import("../src/settings/CloudUserResourcesSection.js"),
    ]);

  const cloudValue = {
    selection: {
      principalId: "principal-1",
      controlPlaneOrigin: "https://cloud.example.test",
      projectId: null,
      taskId: null,
      draftScope: null,
    },
    controlPlane: null,
    hostAccessor: null,
    attachment: null,
    capabilities: null,
    capabilitiesStatus: "idle" as const,
    capabilitiesError: null,
    taskDetail: null,
    taskDetailStatus: "idle" as const,
    taskDetailError: null,
    taskDetailErrorCode: null,
    selectProject() {},
    selectTask() {},
    async reloadCapabilities() {},
    async reloadTask() {},
    beginTaskRunWatch() {},
  };

  const render = (withContext: boolean) =>
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        withContext
          ? createElement(
              CloudWorkspaceContextProvider,
              { value: cloudValue as never },
              createElement(CloudUserResourcesSection),
            )
          : createElement(CloudUserResourcesSection),
      ),
    );

  assert.equal(render(false), "", "非云模式不渲染任何内容（不落在别处显示半截分区）");
  const html = render(true);
  assert.ok(html.includes("用户资源"), "标题来自 i18n（zh-CN）");
  for (const label of ["MCP server", "Skills", "命令", "Plugins", "Subagents", "AGENTS.md"]) {
    assert.ok(html.includes(label), `分类 tab 缺少 ${label}`);
  }
  // 面板装配（默认选中 mcp）：新建表单与凭据说明都在同一层渲染里。
  assert.ok(html.includes("新建 MCP server"));
  assert.ok(html.includes("只经认证通道下发到云沙箱"));
});

/**
 * 结构冒烟（W11 §13D 验收③的静态可核对部分）：commands/subagents 是 markdown 文本编辑面板
 * （无归档上传入口），skills/plugins 仍是归档上传面板。
 *
 * 直接渲染两个面板（分区 tab 的切换需要 DOM 交互，本包无 renderer）：resources 用最小假件，
 * 只覆盖渲染路径读取的字段；不驱动数据、不断言交互（E2E 属 W11 §13D 的无头浏览器验收）。
 */
test("面板装配冒烟：commands/subagents 为 markdown 文本面板，skills/plugins 为归档上传面板", async (t) => {
  let renderToStaticMarkup: (element: unknown) => string;
  let createElement: typeof import("react").createElement;
  try {
    ({ renderToStaticMarkup } = await import("react-dom/server"));
    ({ createElement } = await import("react"));
  } catch {
    t.skip("react-dom/server 不可用");
    return;
  }
  const [
    { ZCodeIntlProvider },
    { CloudUserResourceMarkdownPanel },
    { CloudUserResourceArchivePanel },
  ] = await Promise.all([
    import("../src/i18n/IntlProvider.js"),
    import("../src/settings/cloudUserResourcesMarkdownPanel.js"),
    import("../src/settings/cloudUserResourcesArchivePanel.js"),
  ]);

  const resources = {
    status: "ready",
    error: null,
    profileVersion: 1,
    totalBytes: 0,
    entries: [],
    pendingByKey: {},
    errorByKey: {},
    contentByKey: {},
    contentStatusByKey: {},
    async load() {},
    async uploadArchive() {
      return { ok: false as const, error: { kind: "server" as const, error: null } };
    },
    async saveMarkdownEntry() {
      return { ok: false as const, error: { kind: "server" as const, error: null } };
    },
    async saveMcpEntry() {
      return { ok: false as const, error: { kind: "server" as const, error: null } };
    },
    async saveAgentsMd() {
      return { ok: false as const, error: { kind: "server" as const, error: null } };
    },
    async remove() {
      return { ok: false as const, error: { kind: "server" as const, error: null } };
    },
    async setEnabled() {
      return { ok: false as const, error: { kind: "server" as const, error: null } };
    },
    async loadContent() {
      return { ok: false as const, error: { kind: "server" as const, error: null } };
    },
  };

  const render = (element: unknown) =>
    renderToStaticMarkup(createElement(ZCodeIntlProvider, { initialLocale: "zh-CN" }, element));

  const markdown = render(
    createElement(CloudUserResourceMarkdownPanel, {
      category: "commands",
      resources: resources as never,
    }),
  );
  assert.ok(markdown.includes("新建条目"), "markdown 面板渲染新建入口");
  assert.ok(markdown.includes("Markdown 正文"), "markdown 面板渲染正文编辑器");
  assert.ok(markdown.includes("从文件读取…"), "markdown 面板提供文件读文本入口");
  assert.ok(markdown.includes(".md"), "提示条目 ID 的 .md 后缀规则");
  assert.equal(markdown.includes("选择归档"), false, "markdown 面板不得出现归档上传入口");

  const archive = render(
    createElement(CloudUserResourceArchivePanel, {
      category: "skills",
      resources: resources as never,
    }),
  );
  assert.ok(archive.includes("选择归档…"), "skills/plugins 仍是归档上传面板");
  assert.ok(archive.includes("上传/替换"));
  assert.equal(archive.includes("Markdown 正文"), false, "归档面板不得出现 markdown 编辑器");
});

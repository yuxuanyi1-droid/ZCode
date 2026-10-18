/**
 * M8 用户资源 profile store 集成验收（specs/cloud-agent 14 §9.2①；W2 §6 同款：临时 SQLite）。
 *
 * 覆盖：版本单调与幂等整条替换、DELETE 语义、sha256/bytes 服务端派生口径、内容寻址行的
 * 旧版本可解析性、8 版本保留窗口的 manifest 与条目引用计数修剪、上限错误码（单条/总量/条目数）
 * 与 Run 冻结列（预约事务内写当前版本）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createCredentialCipherProvider } from "@zcode/services/node";
import {
  CLOUD_USER_PROFILE_MAX_ENTRIES,
  CLOUD_USER_PROFILE_RETAINED_VERSIONS,
  CLOUD_USER_PROFILE_TOTAL_MAX_BYTES,
} from "@zcode/shared";
import {
  fakeGitSha,
  newUuid,
  openTestStorage,
  removeTestRoot,
  seedDraftTask,
  TEST_NOW,
} from "./cloudStorageHarness.js";
import type { TestStorageHandle } from "./cloudStorageHarness.js";
import type { UserProfileStorePort } from "../src/cloud/app/ports/userProfileStorePort.js";

const MCP_CONTENT = JSON.stringify({ command: "npx", args: ["-y", "server"], env: { A: "1" } });
const AGENTS_CONTENT = "# 用户级指令\n中文正文（UTF-8 口径）。\n";

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

/** 合法 gzip magic 的 base64（真实 tar 校验在安装器，store 只存正文）。 */
function gzipBase64(payload: string): string {
  return Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from(payload)]).toString(
    "base64",
  );
}

async function withStorage(run: (handle: TestStorageHandle) => Promise<void>): Promise<void> {
  const handle = await openTestStorage();
  try {
    await run(handle);
  } finally {
    await handle.close();
    await removeTestRoot(handle.root);
  }
}

function profileOf(handle: TestStorageHandle): UserProfileStorePort {
  return handle.storage.userProfile;
}

async function upsertMcp(
  store: UserProfileStorePort,
  entryId: string,
  content: string = MCP_CONTENT,
  overrides: { enabled?: boolean; displayName?: string; now?: number } = {},
) {
  return store.upsertEntry({
    category: "mcp",
    entryId,
    ...(overrides.displayName === undefined ? {} : { displayName: overrides.displayName }),
    enabled: overrides.enabled ?? true,
    contentKind: "mcp-config",
    content,
    now: overrides.now ?? TEST_NOW,
  });
}

test("迁移种下空版本 1：新库快照可用且不含正文（14 §9.2①）", async () => {
  await withStorage(async (handle) => {
    const snapshot = await profileOf(handle).snapshot();
    assert.equal(snapshot.profileVersion, 1);
    assert.deepEqual(snapshot.entries, []);
    assert.equal(snapshot.totalBytes, 0);
    assert.equal((await profileOf(handle).readVersion(1))?.profileVersion, 1);
  });
});

test("sha256/bytes 由服务端从正文派生（客户端不传；三类口径各验一次）", async () => {
  await withStorage(async (handle) => {
    const store = profileOf(handle);
    const mcp = await upsertMcp(store, "primary");
    assert.equal(mcp.status, "ok");
    if (mcp.status !== "ok") return;
    // mcp：bytes = JSON 字符数；sha256 = JSON 文本 UTF-8 字节。
    assert.equal(mcp.entry.bytes, MCP_CONTENT.length);
    assert.equal(mcp.entry.sha256, sha256Hex(MCP_CONTENT));

    const agents = await store.upsertEntry({
      category: "agents-md",
      entryId: "global",
      enabled: true,
      contentKind: "agents-md",
      content: AGENTS_CONTENT,
      now: TEST_NOW,
    });
    assert.equal(agents.status, "ok");
    if (agents.status !== "ok") return;
    assert.equal(agents.entry.bytes, Buffer.byteLength(AGENTS_CONTENT, "utf8"));
    assert.equal(agents.entry.sha256, sha256Hex(Buffer.from(AGENTS_CONTENT, "utf8")));

    const archive = gzipBase64("skills-archive-bytes");
    const skills = await store.upsertEntry({
      category: "skills",
      entryId: "demo",
      enabled: true,
      contentKind: "archive-base64",
      content: archive,
      now: TEST_NOW,
    });
    assert.equal(skills.status, "ok");
    if (skills.status !== "ok") return;
    // 归档：bytes/sha256 = **解码后**归档字节。
    assert.equal(skills.entry.bytes, Buffer.from(archive, "base64").byteLength);
    assert.equal(skills.entry.sha256, sha256Hex(Buffer.from(archive, "base64")));
  });
});

test("R4 contentFacts：mcp 密文按明文事实落库；非 mcp 覆盖派生值被拒绝（14 §5）", async () => {
  await withStorage(async (handle) => {
    const store = profileOf(handle);
    const cipher = createCredentialCipherProvider({
      env: { ZCODE_CREDENTIAL_SECRET: "profile-store-r4" },
    });
    const ciphertext = cipher.encrypt(MCP_CONTENT);
    const inserted = await store.upsertEntry({
      category: "mcp",
      entryId: "primary",
      enabled: true,
      contentKind: "mcp-config",
      content: ciphertext,
      contentFacts: { sha256: sha256Hex(MCP_CONTENT), bytes: MCP_CONTENT.length },
      now: TEST_NOW,
    });
    assert.equal(inserted.status, "ok");
    if (inserted.status === "ok") {
      assert.equal(inserted.entry.sha256, sha256Hex(MCP_CONTENT), "sha256 按明文派生");
      assert.equal(inserted.entry.bytes, MCP_CONTENT.length, "bytes 按明文口径");
    }
    // store 对正文透明：密文原样保存，解密只在 app 读路径（单一职责）。
    assert.equal((await store.readVersionEntries(2))?.[0]?.content, ciphertext);

    // 其他类别继续由 store 从正文派生，不允许调用方覆盖（客户端不能自报 sha256/bytes）。
    const denied = await store.upsertEntry({
      category: "agents-md",
      entryId: "user-agents",
      enabled: true,
      contentKind: "agents-md",
      content: AGENTS_CONTENT,
      contentFacts: { sha256: "a".repeat(64), bytes: 1 },
      now: TEST_NOW,
    });
    assert.equal(denied.status, "rejected");
    if (denied.status === "rejected") {
      assert.equal(denied.code, "invalid_entry");
      assert.equal(denied.reason, "content-facts-not-allowed");
    }

    // 形状非法的明文事实同样拒绝（不把坏值写进 manifest）。
    const invalid = await store.upsertEntry({
      category: "mcp",
      entryId: "bad",
      enabled: true,
      contentKind: "mcp-config",
      content: ciphertext,
      contentFacts: { sha256: "not-a-sha", bytes: -1 },
      now: TEST_NOW,
    });
    assert.equal(invalid.status, "rejected");
    if (invalid.status === "rejected") assert.equal(invalid.reason, "invalid-content-facts");
  });
});

test("PUT 语义 = 幂等整条替换：同 key 同内容不递增版本（14 §9.2①）", async () => {
  await withStorage(async (handle) => {
    const store = profileOf(handle);
    const first = await upsertMcp(store, "primary");
    assert.equal(first.status === "ok" && first.profileVersion, 2);
    const repeated = await upsertMcp(store, "primary");
    assert.equal(
      repeated.status === "ok" && repeated.profileVersion,
      2,
      "重复提交不产生第二个版本",
    );

    // 内容变化 → 递增；旧版本快照仍可解析（内容寻址行在窗口内保留）。
    const changed = await upsertMcp(store, "primary", JSON.stringify({ command: "other" }));
    assert.equal(changed.status === "ok" && changed.profileVersion, 3);
    const oldEntries = await store.readVersionEntries(2);
    assert.ok(oldEntries, "被替换条目的旧版本仍可解析（在途 Run 冻结锚点）");
    assert.equal(oldEntries?.length, 1);
    assert.equal(oldEntries?.[0]?.sha256, first.status === "ok" ? first.entry.sha256 : "");

    // 元数据变化（enabled）也算变更 → 递增。
    const disabled = await upsertMcp(store, "primary", JSON.stringify({ command: "other" }), {
      enabled: false,
    });
    assert.equal(disabled.status === "ok" && disabled.profileVersion, 4);
    if (disabled.status === "ok") assert.equal(disabled.entry.enabled, false);
  });
});

test("DELETE：从当前版本移除并递增；键不存在时幂等无操作（14 §9.2①）", async () => {
  await withStorage(async (handle) => {
    const store = profileOf(handle);
    await upsertMcp(store, "primary");
    const deleted = await store.deleteEntry({ category: "mcp", entryId: "primary", now: TEST_NOW });
    assert.deepEqual(deleted, { status: "ok", profileVersion: 3, deleted: true });
    assert.deepEqual((await store.snapshot()).entries, []);

    const again = await store.deleteEntry({ category: "mcp", entryId: "primary", now: TEST_NOW });
    assert.deepEqual(again, { status: "ok", profileVersion: 3, deleted: false });

    // 旧版本（含该条目）在窗口内仍可解析。
    const version2 = await store.readVersionEntries(2);
    assert.equal(version2?.length, 1);
  });
});

test("修剪：超出 8 版本窗口后最旧 manifest 与无引用条目行被清（14 §9.2①）", async () => {
  await withStorage(async (handle) => {
    const store = profileOf(handle);
    // 每个版本写入不同内容 → 每个版本各有一行 sha（内容寻址行）。
    for (let index = 0; index < CLOUD_USER_PROFILE_RETAINED_VERSIONS + 1; index += 1) {
      const result = await upsertMcp(store, "primary", JSON.stringify({ command: `c-${index}` }));
      assert.equal(result.status, "ok");
    }
    const current = await store.snapshot();
    // 版本 1（空种子）+ 9 次写 = 10；窗口 8 → 保留 3..10。
    assert.equal(current.profileVersion, CLOUD_USER_PROFILE_RETAINED_VERSIONS + 2);
    assert.equal(await store.readVersion(2), null, "窗口外的最旧 manifest 被修剪");
    assert.ok(await store.readVersion(current.profileVersion), "窗口内版本可解析");
    assert.ok(await store.readVersion(current.profileVersion - 7), "窗口边界（第 8 个）仍保留");

    // 条目行：保留窗口内每个版本各引用一个 sha（内容寻址行共存），窗口外的 sha 被删。
    const { openStorageDatabase, closeStorageDatabase } =
      await import("../src/cloud/adapters/storage/sqlite/database.js");
    const context = openStorageDatabase({ path: handle.databasePath });
    try {
      const count = context.db
        .prepare("SELECT COUNT(*) AS n FROM profile_entries WHERE category = 'mcp'")
        .get();
      assert.equal(
        Number(count?.["n"]),
        CLOUD_USER_PROFILE_RETAINED_VERSIONS,
        "保留窗口内 8 个版本的条目行共存",
      );
      const prunedSha = sha256Hex(JSON.stringify({ command: "c-0" }));
      const prunedRow = context.db
        .prepare("SELECT COUNT(*) AS n FROM profile_entries WHERE category = 'mcp' AND sha256 = ?")
        .get(prunedSha);
      assert.equal(Number(prunedRow?.["n"]), 0, "窗口外版本引用的条目行被修剪");
    } finally {
      closeStorageDatabase(context);
    }
  });
});

test("上限：单条超类别上限 → payload_too_large；条目数与总量 → 对应错误码（14 §9.2①）", async () => {
  await withStorage(async (handle) => {
    const store = profileOf(handle);
    // 单条：agents-md 用真实字符数命中（bytes 超 256KiB 上限）。
    const oversized = await store.upsertEntry({
      category: "agents-md",
      entryId: "too-big",
      enabled: true,
      contentKind: "agents-md",
      content: "x".repeat(256 * 1024 + 1),
      now: TEST_NOW,
    });
    assert.equal(oversized.status, "rejected");
    if (oversized.status === "rejected") {
      assert.equal(oversized.code, "payload_too_large");
      assert.equal(oversized.reason, "agents-md-entry-too-large");
    }

    // 条目数：写满 256 条后第 257 条拒绝（键各不相同，逐条小内容）。
    for (let index = 0; index < CLOUD_USER_PROFILE_MAX_ENTRIES; index += 1) {
      const result = await upsertMcp(store, `s${String(index).padStart(3, "0")}`);
      assert.equal(result.status, "ok", `第 ${index + 1} 条应写入成功`);
    }
    const overflow = await upsertMcp(store, "over-limit");
    assert.equal(overflow.status, "rejected");
    if (overflow.status === "rejected") {
      assert.equal(overflow.code, "profile_entries_exceeded");
    }
  });
});

test("上限：总量超 128MiB → profile_total_exceeded（伪造 manifest 聚合值，不落几百 MiB 正文）", async () => {
  await withStorage(async (handle) => {
    const store = profileOf(handle);
    // 直接摆放三行 plugins 条目（45MiB each ≤50MiB 单条上限；聚合 135MiB > 128MiB）与对应
    // manifest：真实正文不可能在测试里廉价造出 128MiB 总量，这里只验证**聚合判定**分支
    // （14 §9.2①：上限以 manifest 的真实 `bytes` 求和判定，与本次写入的正文大小无关）。
    const { openStorageDatabase, closeStorageDatabase } =
      await import("../src/cloud/adapters/storage/sqlite/database.js");
    const context = openStorageDatabase({ path: handle.databasePath });
    try {
      const perEntry = 45 * 1024 * 1024;
      const manifest = [1, 2, 3].map((index) => ({
        category: "plugins",
        entryId: `p${index}`,
        enabled: true,
        sha256: String(index).repeat(64),
        bytes: perEntry,
      }));
      context.db
        .prepare(
          "INSERT INTO profile_versions (profile_version, manifest_json, created_at) VALUES (2, ?, ?)",
        )
        .run(JSON.stringify(manifest), TEST_NOW);
    } finally {
      closeStorageDatabase(context);
    }
    const result = await upsertMcp(store, "small", JSON.stringify({ command: "tiny" }));
    assert.equal(result.status, "rejected");
    if (result.status === "rejected") {
      assert.equal(result.code, "profile_total_exceeded");
      assert.equal(result.reason, "profile-total-exceeded");
    }
    assert.ok(CLOUD_USER_PROFILE_TOTAL_MAX_BYTES < 3 * 45 * 1024 * 1024);
  });
});

test("Run 冻结列退役：预约不再写 resources_profile_version，读侧入口一并移除（14 §4.8/§9.5）", async () => {
  await withStorage(async (handle) => {
    const store = profileOf(handle);
    await upsertMcp(store, "primary"); // 当前版本 = 2
    const seeded = await seedDraftTask(handle.storage);
    const reservation = await handle.storage.storage.runs.reserveRun({
      taskId: seeded.taskId,
      runId: newUuid(),
      executionRecipe: {
        provider: "daytona",
        resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
        firstCommandConfig: {},
        baseSha: fakeGitSha("base"),
      },
      quota: { maxConcurrentRuns: 3 },
      now: TEST_NOW + 1,
    });
    // 列保留（迁移不回滚）但永不写入：预约事务后仍为 NULL，后续上传也不改写它。
    const { openStorageDatabase, closeStorageDatabase } =
      await import("../src/cloud/adapters/storage/sqlite/database.js");
    const context = openStorageDatabase({ path: handle.databasePath });
    try {
      const readColumn = () =>
        context.db
          .prepare("SELECT resources_profile_version AS v FROM runs WHERE run_id = ?")
          .get(reservation.run.runId) as { v: number | null };
      assert.equal(readColumn().v, null, "预约事务不写冻结列（Run 不追踪 profile 版本）");
      await upsertMcp(store, "second");
      assert.equal(readColumn().v, null, "上传同样不改写该列（保留不写）");
    } finally {
      closeStorageDatabase(context);
    }
    // 读侧 handler 一并移除：方法表里不存在该键（"不读"是编译期与运行期双重事实）。
    const { runRepoHandlers } =
      await import("../src/cloud/adapters/storage/repositories/runRepo.js");
    assert.equal(
      Object.prototype.hasOwnProperty.call(runRepoHandlers, "runs.resourcesProfileVersion"),
      false,
      "runs.resourcesProfileVersion 读 handler 必须随退役删除",
    );
  });
});

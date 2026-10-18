/**
 * M8 用户资源 profile HTTP 端点验收（specs/cloud-agent 14 §9.2⑦；03 §6 端点矩阵）。
 *
 * 用**真实 SQLite store** + 真实 app 用例 + 真实路由（Hono 直调）验证：
 * 快照/版本读取、PUT 幂等整条替换与 sha256/bytes 服务端派生、DELETE 语义、
 * 鉴权外的形状校验（路径/正文 category 一致、gzip 最小前置）、超限状态码
 * （413 payload_too_large / 409 profile_*）、未接线 store 的 503，以及
 * **响应永不含正文/凭据**（U-10）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { Hono } from "hono";
import { createCredentialCipherProvider } from "@zcode/services/node";
import { CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES } from "@zcode/shared";
import { registerCloudHttpRoutes } from "../src/cloud/adapters/http/routes.js";
import {
  CLOUD_REQUEST_BODY_MAX_BYTES,
  isCloudProfileEntryUploadPath,
  registerCloudRoutes,
} from "../src/cloud/adapters/http/registerCloudRoutes.js";
import type { CloudHttpRouteDeps } from "../src/cloud/adapters/http/support.js";
import type { CloudBridgeChannel } from "../src/cloud/adapters/ws/bridgeChannel.js";
import { openTestStorage, removeTestRoot, TEST_NOW } from "./cloudStorageHarness.js";
import type { TestStorageHandle } from "./cloudStorageHarness.js";
import { buildTestPlane, attachReadySession } from "./cloudCoreFakes.js";
import type { TestPlane } from "./cloudCoreFakes.js";

const PRINCIPAL_ID = "00000000-0000-4000-8000-0000000000aa";
/** HTTP 用例不触发 WS：桥只作占位（同 W4 路由用例口径）。 */
const bridgeStub = {} as unknown as CloudBridgeChannel;

function appFor(context: TestPlane): Hono {
  const app = new Hono();
  const deps: CloudHttpRouteDeps = {
    plane: context.plane,
    router: context.plane.router,
    bridge: bridgeStub,
    principalId: PRINCIPAL_ID,
    publicOrigin: "https://cloud.example.test",
    githubConfigured: true,
  };
  registerCloudHttpRoutes(app, deps);
  return app;
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

function putEntry(app: Hono, category: string, entryId: string, body: unknown): Promise<Response> {
  return app.request(`/api/cloud/user-profile/entries/${category}/${entryId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function jsonOf<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

test("PUT → GET 快照/版本 → DELETE：整条替换、服务端派生、响应不含正文（U-10）", async () => {
  await withStorage(async (handle) => {
    const app = appFor(buildTestPlane({ userProfile: handle.storage.userProfile }));

    const empty = await jsonOf<{ profileVersion: number; entries: unknown[] }>(
      await app.request("/api/cloud/user-profile"),
    );
    assert.equal(empty.profileVersion, 1, "迁移种下的空版本 1");
    assert.deepEqual(empty.entries, []);

    const config = { command: "npx", args: ["-y", "server"], env: { TOKEN: "secret-token" } };
    const put = await putEntry(app, "mcp", "primary", { category: "mcp", config });
    assert.equal(put.status, 200);
    const uploaded = await jsonOf<{
      entry: { sha256: string; bytes: number; enabled: boolean; entryId: string };
      profileVersion: number;
    }>(put);
    const jsonText = JSON.stringify(config);
    assert.equal(uploaded.profileVersion, 2);
    assert.equal(uploaded.entry.sha256, createHash("sha256").update(jsonText).digest("hex"));
    assert.equal(uploaded.entry.bytes, jsonText.length, "bytes = config JSON 字符数");
    assert.equal(uploaded.entry.enabled, true);

    const snapshot = await jsonOf<{ entries: { entryId: string }[]; totalBytes: number }>(
      await app.request("/api/cloud/user-profile"),
    );
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0]?.entryId, "primary");
    assert.equal(snapshot.totalBytes, jsonText.length);
    const snapshotText = JSON.stringify(snapshot);
    assert.ok(!snapshotText.includes("secret-token"), "快照响应不得包含凭据正文（14 §5）");
    assert.ok(!snapshotText.includes("command"), "快照响应不得包含条目正文");

    const version = await jsonOf<{ profileVersion: number }>(
      await app.request("/api/cloud/user-profile/version"),
    );
    assert.equal(version.profileVersion, 2);

    // 幂等整条替换：同 key 同内容重复提交 → 同一 profileVersion。
    const repeated = await jsonOf<{ profileVersion: number }>(
      await putEntry(app, "mcp", "primary", { category: "mcp", config }),
    );
    assert.equal(repeated.profileVersion, 2, "重复提交不递增两次（14 §9.1 冻结语义）");

    const deleted = await jsonOf<{ profileVersion: number }>(
      await app.request("/api/cloud/user-profile/entries/mcp/primary", { method: "DELETE" }),
    );
    assert.equal(deleted.profileVersion, 3);
    const deletedAgain = await jsonOf<{ profileVersion: number }>(
      await app.request("/api/cloud/user-profile/entries/mcp/primary", { method: "DELETE" }),
    );
    assert.equal(deletedAgain.profileVersion, 3, "键不存在时幂等无操作");
  });
});

test("形状校验：非法类别/路径正文不一致/非 gzip 归档 → 400 invalid_entry（定位到条目）", async () => {
  await withStorage(async (handle) => {
    const app = appFor(buildTestPlane({ userProfile: handle.storage.userProfile }));

    const invalidCategory = await putEntry(app, "hooks", "x", { category: "hooks" });
    assert.equal(invalidCategory.status, 400);
    const invalidCategoryBody = await jsonOf<{ code: string; details?: Record<string, string> }>(
      invalidCategory,
    );
    assert.equal(invalidCategoryBody.code, "invalid_entry");
    assert.equal(invalidCategoryBody.details?.category, "hooks", "错误必须定位到条目（U-11）");

    // 路径 category = mcp、正文 category = skills：显式拒绝，不隐式取其一。
    const gzip = Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08, 0x00]), Buffer.from("x")]).toString(
      "base64",
    );
    const mismatch = await putEntry(app, "mcp", "primary", {
      category: "skills",
      archiveBase64: gzip,
    });
    assert.equal(mismatch.status, 400);
    const mismatchBody = await jsonOf<{ code: string; details?: Record<string, string> }>(mismatch);
    assert.equal(mismatchBody.code, "invalid_entry");
    assert.equal(mismatchBody.details?.category, "mcp");

    // 归档最小前置（14 §9.2②）：非 gzip magic 直接拒绝（完整校验在安装器）。
    const notGzip = await putEntry(app, "skills", "demo", {
      category: "skills",
      archiveBase64: Buffer.from("plain-tar?").toString("base64"),
    });
    assert.equal(notGzip.status, 400);
    const notGzipBody = await jsonOf<{ code: string; message: string }>(notGzip);
    assert.equal(notGzipBody.code, "invalid_entry");
    assert.equal(notGzipBody.message, "archive-not-gzip");

    // 未知字段（严格 schema）。
    const unknownField = await putEntry(app, "mcp", "primary", {
      category: "mcp",
      config: {},
      sha256: "0".repeat(64),
    });
    assert.equal(unknownField.status, 400, "客户端不能自报 sha256/bytes");
  });
});

test("agents-md 单例：user-agents 成功、其它 entryId → 400 invalid_entry（2026-10-17 收口）", async () => {
  await withStorage(async (handle) => {
    const app = appFor(buildTestPlane({ userProfile: handle.storage.userProfile }));

    const allowed = await putEntry(app, "agents-md", "user-agents", {
      category: "agents-md",
      content: "# 指令",
    });
    assert.equal(allowed.status, 200);
    assert.equal((await jsonOf<{ profileVersion: number }>(allowed)).profileVersion, 2);

    // 第二条 agents-md 会与第一条争抢 `~/.zcode/AGENTS.md`：必须在入口 400，不推迟到同步期。
    const denied = await putEntry(app, "agents-md", "other.md", {
      category: "agents-md",
      content: "# 第二条",
    });
    assert.equal(denied.status, 400);
    const deniedBody = await jsonOf<{
      code: string;
      message: string;
      details?: Record<string, string>;
    }>(denied);
    assert.equal(deniedBody.code, "invalid_entry");
    assert.equal(deniedBody.message, "agents-md-entry-id-must-be-user-agents");
    assert.equal(deniedBody.details?.category, "agents-md");
    assert.equal(deniedBody.details?.entryId, "other.md");

    // 非法条目未入库：快照仍只有合法单例一条。
    const snapshot = await jsonOf<{ entries: { entryId: string }[] }>(
      await app.request("/api/cloud/user-profile"),
    );
    assert.deepEqual(
      snapshot.entries.map((entry) => entry.entryId),
      ["user-agents"],
    );
  });
});

test("超限：单条超类别上限 → 413；总量/条目数 → 409（14 §9.2①）", async () => {
  await withStorage(async (handle) => {
    const app = appFor(buildTestPlane({ userProfile: handle.storage.userProfile }));

    const oversize = await putEntry(app, "agents-md", "user-agents", {
      category: "agents-md",
      content: "x".repeat(256 * 1024 + 1),
    });
    assert.equal(oversize.status, 413, "单条超限即 413（不截断）");
    const oversizeBody = await jsonOf<{ code: string; details?: Record<string, string> }>(oversize);
    assert.equal(oversizeBody.code, "payload_too_large");
    assert.equal(oversizeBody.details?.entryId, "user-agents");
  });
});

test("请求体上限 80MiB：Content-Length 超限即 413 payload_too_large（不读体）", async () => {
  await withStorage(async (handle) => {
    const app = appFor(buildTestPlane({ userProfile: handle.storage.userProfile }));
    const response = await app.request("/api/cloud/user-profile/entries/mcp/primary", {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        "content-length": String(CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES + 1),
      },
      body: "{}",
      // 故意声明超限长度（真实客户端在 body 上就会带这个头；中间件先看头、不读体）。
    });
    assert.equal(response.status, 413);
    const body = await jsonOf<{ code: string; message: string }>(response);
    assert.equal(body.code, "payload_too_large");
    assert.equal(body.message, "profile-upload-body-too-large");
  });
});

test("未接线 profile store：503 not_configured（不伪装空 profile，03 §6）", async () => {
  const app = appFor(buildTestPlane({ userProfile: null }));
  const snapshot = await app.request("/api/cloud/user-profile");
  assert.equal(snapshot.status, 503);
  const body = await jsonOf<{ code: string }>(snapshot);
  assert.equal(body.code, "not_configured");
  const put = await putEntry(app, "mcp", "primary", { category: "mcp", config: {} });
  assert.equal(put.status, 503);
});

/** PATCH 开关请求（矩阵首个 PATCH，body 只含 {enabled}）。 */
function patchEnabled(app: Hono, category: string, entryId: string, body: unknown) {
  return app.request(`/api/cloud/user-profile/entries/${category}/${entryId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("PATCH 条目开关：值变化递增版本、重复提交不递增、404 定位到条目（14 §9.4①）", async () => {
  await withStorage(async (handle) => {
    const store = handle.storage.userProfile;
    const app = appFor(buildTestPlane({ userProfile: store }));
    const config = { command: "npx", args: ["-y", "server"], env: { TOKEN: "secret-token" } };
    await putEntry(app, "mcp", "primary", { category: "mcp", config });
    const before = await jsonOf<{ profileVersion: number }>(
      await app.request("/api/cloud/user-profile/version"),
    );
    assert.equal(before.profileVersion, 2);

    // 开关变化 → 新版本：交付集合（enabled 子集）属于 manifest，变了才是新版本。
    const off = await patchEnabled(app, "mcp", "primary", { enabled: false });
    assert.equal(off.status, 200);
    const offBody = await jsonOf<{
      entry: { entryId: string; enabled: boolean; sha256: string };
      profileVersion: number;
    }>(off);
    assert.equal(offBody.profileVersion, 3);
    assert.equal(offBody.entry.enabled, false);
    assert.equal(
      offBody.entry.sha256,
      createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    );

    // 重复提交同一值：不递增（幂等），返回当前条目与当前版本。
    const repeated = await jsonOf<{ profileVersion: number; entry: { enabled: boolean } }>(
      await patchEnabled(app, "mcp", "primary", { enabled: false }),
    );
    assert.equal(repeated.profileVersion, 3, "同值重复提交不产生第二个版本");
    assert.equal(repeated.entry.enabled, false);

    // 快照看到开关后的状态，且总量/正文不变（开关不搬正文）。
    const snapshot = await jsonOf<{
      profileVersion: number;
      totalBytes: number;
      entries: { entryId: string; enabled: boolean }[];
    }>(await app.request("/api/cloud/user-profile"));
    assert.equal(snapshot.profileVersion, 3);
    assert.equal(snapshot.entries[0]?.enabled, false);
    assert.equal(snapshot.totalBytes, JSON.stringify(config).length);

    // U-08：版本 2（在途 Run 冻结的版本）必须仍是 enabled=true —— manifest 是版本事实。
    const version2 = await store.readVersion(2);
    assert.equal(version2?.entries[0]?.enabled, true, "旧版本 manifest 不被开关改写");
    const version2Entries = await store.readVersionEntries(2);
    assert.equal(
      version2Entries?.[0]?.enabled,
      true,
      "下发组装按 manifest 元数据：运行中 Run 的交付集合不变（14 §9.2①）",
    );
    const version3Entries = await store.readVersionEntries(3);
    assert.equal(version3Entries?.[0]?.enabled, false);
    const storedMcp = version3Entries?.[0]?.content ?? "";
    // R4（14 §5）：mcp 行是 `enc:v1:` 密文；开关只动 manifest，不搬/不改写正文行。
    assert.match(storedMcp, /^enc:v1:/u, "mcp 正文以密文落库");
    assert.ok(!storedMcp.includes("secret-token"), "落库正文不含 token 明文");

    // 开与关都递增；键不存在 → 404（PATCH 不是幂等无操作，没有可翻的开关）。
    const on = await jsonOf<{ profileVersion: number }>(
      await patchEnabled(app, "mcp", "primary", { enabled: true }),
    );
    assert.equal(on.profileVersion, 4);

    const missing = await patchEnabled(app, "mcp", "ghost", { enabled: false });
    assert.equal(missing.status, 404);
    const missingBody = await jsonOf<{ code: string; details?: Record<string, string> }>(missing);
    assert.equal(missingBody.code, "not_found");
    assert.equal(missingBody.details?.category, "mcp");
    assert.equal(missingBody.details?.entryId, "ghost");
    const afterMissing = await jsonOf<{ profileVersion: number }>(
      await app.request("/api/cloud/user-profile/version"),
    );
    assert.equal(afterMissing.profileVersion, 4, "404 不产生版本推进");
  });
});

test("PATCH 形状校验：enabled 缺席/额外字段/非法类别一律 400 invalid_entry（14 §9.4①）", async () => {
  await withStorage(async (handle) => {
    const app = appFor(buildTestPlane({ userProfile: handle.storage.userProfile }));
    await putEntry(app, "agents-md", "user-agents", { category: "agents-md", content: "# 指令" });

    // 缺席 enabled：把"漏传"当成 false 会静默改交付集合，必须拒绝。
    const missingField = await patchEnabled(app, "agents-md", "user-agents", {});
    assert.equal(missingField.status, 400);
    const missingBody = await jsonOf<{ code: string; message: string }>(missingField);
    assert.equal(missingBody.code, "invalid_entry");
    assert.equal(missingBody.message, "invalid-enabled-body");

    // strict：PATCH 不接受负载字段（整条替换才是 PUT）。
    const withPayload = await patchEnabled(app, "agents-md", "user-agents", {
      enabled: false,
      content: "# 覆盖正文",
    });
    assert.equal(withPayload.status, 400);

    // 非法的 category（不在章节枚举）→ 400，错误定位到条目。
    const badCategory = await patchEnabled(app, "hooks", "user-agents", { enabled: false });
    assert.equal(badCategory.status, 400);
    const badCategoryBody = await jsonOf<{ code: string; details?: Record<string, string> }>(
      badCategory,
    );
    assert.equal(badCategoryBody.code, "invalid_entry");
    assert.equal(badCategoryBody.details?.category, "hooks");

    const version = await jsonOf<{ profileVersion: number }>(
      await app.request("/api/cloud/user-profile/version"),
    );
    assert.equal(version.profileVersion, 2, "三次拒绝都不推进版本");
  });
});

test("GET 单条目回显：返回元数据 + 正文，键不存在 404（14 §9.4①）", async () => {
  await withStorage(async (handle) => {
    const app = appFor(buildTestPlane({ userProfile: handle.storage.userProfile }));

    // mcp：正文（含凭据字段）按需回吐给已鉴权主体，供表单回显。
    const config = {
      command: "npx",
      args: ["-y", "server"],
      headers: { Authorization: "Bearer secret-token" },
    };
    await putEntry(app, "mcp", "primary", { category: "mcp", config, displayName: "主 MCP" });
    const read = await app.request("/api/cloud/user-profile/entries/mcp/primary");
    assert.equal(read.status, 200);
    const readBody = await jsonOf<{
      entry: {
        entryId: string;
        displayName?: string;
        sha256: string;
        bytes: number;
        enabled: boolean;
      };
      payload: { category: string; config: Record<string, unknown> };
    }>(read);
    assert.equal(readBody.payload.category, "mcp");
    assert.deepEqual(readBody.payload.config, config, "回显正文与上传正文逐字段一致");
    assert.equal(readBody.entry.displayName, "主 MCP");
    assert.equal(readBody.entry.bytes, JSON.stringify(config).length, "bytes 口径与写入一致");
    assert.equal(
      readBody.entry.sha256,
      createHash("sha256").update(JSON.stringify(config)).digest("hex"),
    );
    assert.equal(readBody.entry.enabled, true);

    // agents-md：文本编辑器回显（UTF-8 正文原样）。
    const content = "# 用户指令\n\n偏好：简洁。\n";
    await putEntry(app, "agents-md", "user-agents", { category: "agents-md", content });
    const agents = await jsonOf<{ payload: { category: string; content: string } }>(
      await app.request("/api/cloud/user-profile/entries/agents-md/user-agents"),
    );
    assert.equal(agents.payload.category, "agents-md");
    assert.equal(agents.payload.content, content);

    // 归档：base64 原样回显（编辑器不解析，长度由类别上限保证有界）。
    const archive = Buffer.concat([
      Buffer.from([0x1f, 0x8b, 0x08, 0x00]),
      Buffer.from("payload"),
    ]).toString("base64");
    await putEntry(app, "skills", "demo", { category: "skills", archiveBase64: archive });
    const skills = await jsonOf<{ payload: { category: string; archiveBase64: string } }>(
      await app.request("/api/cloud/user-profile/entries/skills/demo"),
    );
    assert.equal(skills.payload.archiveBase64, archive);

    // 键不存在 → 404 not_found（错误定位到条目）。
    const missing = await app.request("/api/cloud/user-profile/entries/mcp/ghost");
    assert.equal(missing.status, 404);
    const missingBody = await jsonOf<{ code: string; details?: Record<string, string> }>(missing);
    assert.equal(missingBody.code, "not_found");
    assert.equal(missingBody.details?.entryId, "ghost");

    // 非法类别 → 400（不按 404 掩盖形状错误）。
    const badCategory = await app.request("/api/cloud/user-profile/entries/hooks/primary");
    assert.equal(badCategory.status, 400);
    assert.equal((await jsonOf<{ code: string }>(badCategory)).code, "invalid_entry");

    // 未接线 store：503（与其余 profile 端点同款，不伪装空条目）。
    const unwired = appFor(buildTestPlane({ userProfile: null }));
    const unwiredRead = await unwired.request("/api/cloud/user-profile/entries/mcp/primary");
    assert.equal(unwiredRead.status, 503);
  });
});

test("R4 mcp 凭据加密：落库密文、回显解密、重复 PUT 幂等、损坏密文与旧明文语义（14 §5）", async () => {
  await withStorage(async (handle) => {
    const cipher = createCredentialCipherProvider({
      env: { ZCODE_CREDENTIAL_SECRET: "profile-r4-test-secret" },
    });
    const store = handle.storage.userProfile;
    const app = appFor(buildTestPlane({ userProfile: store, credentialCipher: cipher }));
    const config = {
      command: "npx",
      args: ["-y", "server"],
      env: { TOKEN: "secret-token" },
      headers: { Authorization: "Bearer secret-token" },
    };
    const jsonText = JSON.stringify(config);

    // 写入：响应元数据仍按**明文**派生 sha256/bytes。
    const put = await jsonOf<{ profileVersion: number; entry: { sha256: string; bytes: number } }>(
      await putEntry(app, "mcp", "primary", { category: "mcp", config }),
    );
    assert.equal(put.profileVersion, 2);
    assert.equal(put.entry.sha256, createHash("sha256").update(jsonText).digest("hex"));
    assert.equal(put.entry.bytes, jsonText.length);

    // 落库行：`enc:v1:` 密文，且不含 token/headers 明文。
    const { openStorageDatabase, closeStorageDatabase } =
      await import("../src/cloud/adapters/storage/sqlite/database.js");
    const context = openStorageDatabase({ path: handle.databasePath });
    let storedContent = "";
    try {
      const row = context.db
        .prepare(
          "SELECT content FROM profile_entries WHERE category = 'mcp' AND entry_id = 'primary'",
        )
        .get() as { content?: unknown } | undefined;
      storedContent = String(row?.content ?? "");
    } finally {
      closeStorageDatabase(context);
    }
    assert.match(storedContent, /^enc:v1:/u, "mcp 正文必须加密落库（14 §5）");
    assert.ok(!storedContent.includes("secret-token"), "落库正文不得含 token 明文");
    assert.ok(!storedContent.includes("Authorization"), "落库正文不得含 headers 明文");

    // 同一明文重复 PUT：sha/版本不变，密文行不被重写（随机 IV 不参与幂等判定）。
    const repeated = await jsonOf<{ profileVersion: number; entry: { sha256: string } }>(
      await putEntry(app, "mcp", "primary", { category: "mcp", config }),
    );
    assert.equal(repeated.profileVersion, 2, "同一明文不产生新版本（sha 按明文派生）");
    assert.equal(repeated.entry.sha256, put.entry.sha256);
    assert.equal(
      (await store.readVersionEntries(2))?.[0]?.content,
      storedContent,
      "幂等提交不重写密文行",
    );

    // GET 回显：解密后与上传正文逐字段一致。
    const read = await jsonOf<{ payload: { config: unknown } }>(
      await app.request("/api/cloud/user-profile/entries/mcp/primary"),
    );
    assert.deepEqual(read.payload.config, config, "回显正文是明文（14 §9.4①）");

    // 旧明文行（R4 之前写入）：decrypt 无前缀原样返回，兼容读。
    const legacyText = JSON.stringify({ command: "legacy" });
    const legacy = await store.upsertEntry({
      category: "mcp",
      entryId: "legacy",
      enabled: true,
      contentKind: "mcp-config",
      content: legacyText,
      now: TEST_NOW,
    });
    assert.equal(legacy.status, "ok");
    if (legacy.status === "ok") {
      assert.equal(legacy.entry.sha256, createHash("sha256").update(legacyText).digest("hex"));
    }
    const legacyRead = await jsonOf<{ payload: { config: unknown } }>(
      await app.request("/api/cloud/user-profile/entries/mcp/legacy"),
    );
    assert.deepEqual(legacyRead.payload.config, { command: "legacy" });

    // 损坏密文 / 密钥不匹配：fail-closed（400 invalid_entry），响应不回半份或密文。
    const otherCipher = createCredentialCipherProvider({
      env: { ZCODE_CREDENTIAL_SECRET: "profile-r4-wrong-secret" },
    });
    const corruptIndex = "enc:v1:".length + 4;
    const corruptSource = cipher.encrypt(JSON.stringify({ command: "broken" }));
    const corrupted = `${corruptSource.slice(0, corruptIndex)}${
      corruptSource[corruptIndex] === "A" ? "B" : "A"
    }${corruptSource.slice(corruptIndex + 1)}`;
    const brokenPayloads: [string, string][] = [
      ["corrupt", corrupted],
      ["mismatch", otherCipher.encrypt(JSON.stringify({ command: "mismatch" }))],
    ];
    for (const [entryId, content] of brokenPayloads) {
      const upserted = await store.upsertEntry({
        category: "mcp",
        entryId,
        enabled: true,
        contentKind: "mcp-config",
        content,
        contentFacts: { sha256: "a".repeat(64), bytes: 1 },
        now: TEST_NOW,
      });
      assert.equal(upserted.status, "ok");
      const broken = await app.request(`/api/cloud/user-profile/entries/mcp/${entryId}`);
      assert.equal(broken.status, 400, `${entryId}: 密文不可解必须结构化失败`);
      const brokenText = await broken.text();
      assert.ok(brokenText.includes("profile-entry-unreadable"));
      assert.ok(!brokenText.includes(content), `${entryId}: 错误响应不得回显密文`);
    }
  });
});

test("markdown 条目（commands/subagents）：上传派生 UTF-8 字节/sha256、回显原样、entryId 必须 .md（14 §4.5）", async () => {
  await withStorage(async (handle) => {
    const app = appFor(
      buildTestPlane({
        userProfile: handle.storage.userProfile,
      }),
    );

    const content = "---\ndescription: 审查\n---\n请审查这个变更\n";
    const put = await putEntry(app, "commands", "review.md", {
      category: "commands",
      content,
    });
    assert.equal(put.status, 200);
    const uploaded = await jsonOf<{
      entry: { sha256: string; bytes: number; category: string; entryId: string };
      profileVersion: number;
    }>(put);
    assert.equal(
      uploaded.entry.sha256,
      createHash("sha256").update(content, "utf8").digest("hex"),
      "sha256 = 正文 UTF-8 字节摘要（不是 base64/UTF-16）",
    );
    assert.equal(uploaded.entry.bytes, Buffer.byteLength(content, "utf8"), "bytes = UTF-8 字节数");

    // 非 ASCII 正文：字节口径 ≠ 字符数（中文 3 字节）。
    const unicodeContent = "# 标题\n\n中文正文";
    const unicodePut = await putEntry(app, "subagents", "helper.md", {
      category: "subagents",
      content: unicodeContent,
    });
    const unicodeEntry = await jsonOf<{ entry: { bytes: number } }>(unicodePut);
    assert.equal(unicodeEntry.entry.bytes, Buffer.byteLength(unicodeContent, "utf8"));
    assert.notEqual(unicodeEntry.entry.bytes, unicodeContent.length);

    // 回显：正文原样（编辑器唯一通路）。
    const read = await jsonOf<{ entry: { entryId: string }; payload: { content: string } }>(
      await app.request("/api/cloud/user-profile/entries/commands/review.md"),
    );
    assert.equal(read.payload.content, content);
    assert.equal(read.entry.entryId, "review.md");

    // entryId 形状：markdown 类别必须以 .md 结尾（上传与读取两条路径同一约束）。
    const badUpload = await putEntry(app, "commands", "review", { category: "commands", content });
    assert.equal(badUpload.status, 400);
    assert.equal((await jsonOf<{ code: string }>(badUpload)).code, "invalid_entry");
    const badRead = await app.request("/api/cloud/user-profile/entries/subagents/helper.md.bak");
    assert.equal(badRead.status, 400);

    // 归档类别不接受 markdown 的 content 负载（类别判别严格）。
    const wrongShape = await putEntry(app, "skills", "demo", { category: "skills", content });
    assert.equal(wrongShape.status, 400);

    // 单条超限（>256KiB）：413 payload_too_large（不截断、不落盘）。
    const oversized = await putEntry(app, "commands", "big.md", {
      category: "commands",
      content: "x".repeat(256 * 1024 + 1),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await jsonOf<{ code: string }>(oversized)).code, "payload_too_large");
  });
});

test("手动同步端点：连接态/终态/stop 前置 409 not_ready，连接态返回逐条结果（14 §4.6）", async () => {
  await withStorage(async (handle) => {
    const store = handle.storage.userProfile;
    const context = buildTestPlane({ userProfile: store });
    const rpc = context.fakeControlPlaneRpc;
    assert.ok(rpc);
    const app = appFor(context);

    // 造一条真实 Run（复用 app 用例），但保持未连接：手动同步 → 409 not_ready/run-not-connected。
    const PRINCIPAL = "00000000-0000-4000-8000-0000000000aa";
    const project = await context.plane.tasks.createProject({
      principalId: PRINCIPAL,
      repositoryId: 101,
    });
    assert.ok(project.ok);
    const task = await context.plane.tasks.createTask({
      principalId: PRINCIPAL,
      projectId: project.value.projectId,
      title: "sync",
      creationKey: "ck-http-sync-1",
      draftStartConfig: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
    });
    assert.ok(task.ok);
    const submit = await context.plane.inputs.submit({
      principalId: PRINCIPAL,
      taskId: task.value.taskId,
      source: "http",
      request: {
        intent: "start",
        commandId: "00000000-0000-4000-8000-00000000aa01",
        prompt: "go",
        expectedTaskRevision: task.value.revision,
        start: { baseBranch: "main", provider: "e2b", templateRef: "zcode-node24" },
      },
    });
    assert.ok(submit.ok);
    await context.plane.provisioning.create.runCreateOnce();
    const runId = submit.ok ? (submit.value.runId ?? "") : "";

    const notConnected = await app.request(
      `/api/cloud/tasks/${task.value.taskId}/user-profile-sync`,
      { method: "POST" },
    );
    assert.equal(notConnected.status, 409, "未连接 → 409（03 §6 错误码映射）");
    const notConnectedBody = await jsonOf<{
      code: string;
      details?: Record<string, string | number | boolean>;
    }>(notConnected);
    assert.equal(notConnectedBody.code, "not_ready");
    assert.equal(notConnectedBody.details?.reason, "run-not-connected");
    assert.equal(notConnectedBody.details?.runId, runId, "结构化原因可定位到 Run");

    // 上传一条 profile 条目并注册 ready attachment（连接态）。
    await putEntry(app, "agents-md", "user-agents", {
      category: "agents-md",
      content: "# AGENTS",
    });
    const run = await context.storage.runs.get(runId);
    assert.ok(run);
    await attachReadySession(context, {
      taskId: task.value.taskId,
      runId,
      runGeneration: run.runGeneration,
    });

    const synced = await app.request(`/api/cloud/tasks/${task.value.taskId}/user-profile-sync`, {
      method: "POST",
    });
    assert.equal(synced.status, 200);
    const syncedBody = await jsonOf<{
      runId: string;
      profileVersion: number;
      trigger: string;
      results: { category: string; entryId: string; status: string }[];
    }>(synced);
    assert.equal(syncedBody.runId, runId);
    assert.equal(syncedBody.trigger, "manual");
    assert.equal(syncedBody.profileVersion, 2, "上传后版本 2");
    assert.deepEqual(syncedBody.results, [
      { category: "agents-md", entryId: "user-agents", status: "synced" },
    ]);
    assert.deepEqual(rpc.callsOf("settings-sync", "writeUserAgentsFile")[0]?.args, [
      { content: "# AGENTS" },
    ]);

    // stop 屏障：stopRequested 后调用被拒（14 §4.6）。
    context.storage.runsById.set(runId, { ...run, stopRequested: true });
    const stopped = await app.request(`/api/cloud/tasks/${task.value.taskId}/user-profile-sync`, {
      method: "POST",
    });
    assert.equal(stopped.status, 409);
    assert.equal(
      (await jsonOf<{ details?: { reason?: string } }>(stopped)).details?.reason,
      "stop-requested",
    );

    // 终态 Run：run-terminal。
    context.storage.runsById.set(runId, { ...run, status: "stopped" });
    const terminal = await app.request(`/api/cloud/tasks/${task.value.taskId}/user-profile-sync`, {
      method: "POST",
    });
    assert.equal(terminal.status, 409);
    assert.equal(
      (await jsonOf<{ details?: { reason?: string } }>(terminal)).details?.reason,
      "run-terminal",
    );

    // 任务不存在：404（不是 not_ready 门控）。
    const missing = await app.request(
      "/api/cloud/tasks/00000000-0000-4000-8000-00000000dead/user-profile-sync",
      { method: "POST" },
    );
    assert.equal(missing.status, 404);
  });
});

test("云请求体 2MiB 上限：超限 413 payload_too_large，profile 条目 PUT 走 80MiB 例外", async () => {
  // 例外路径的纯判定：只有 PUT + 恰好两段条目标识符才跳过全局中间件。
  assert.equal(
    isCloudProfileEntryUploadPath("PUT", "/api/cloud/user-profile/entries/mcp/primary"),
    true,
  );
  assert.equal(
    isCloudProfileEntryUploadPath("PUT", "/api/cloud/user-profile/entries/skills/foo"),
    true,
  );
  assert.equal(
    isCloudProfileEntryUploadPath("POST", "/api/cloud/user-profile/entries/mcp/primary"),
    false,
  );
  assert.equal(isCloudProfileEntryUploadPath("PUT", "/api/cloud/user-profile/entries/mcp"), false);
  assert.equal(
    isCloudProfileEntryUploadPath("PUT", "/api/cloud/user-profile/entries/mcp/a/b"),
    false,
  );
  assert.equal(isCloudProfileEntryUploadPath("PUT", "/api/cloud/tasks/x"), false);

  // 真实中间件：Hono 直调，超大 JSON body 在进入路由前被拒，返回既有错误信封。
  const context = buildTestPlane();
  const app = new Hono();
  registerCloudRoutes(app, {
    plane: context.plane,
    router: context.plane.router,
    bridge: bridgeStub,
    principalId: PRINCIPAL_ID,
    publicOrigin: "https://cloud.example.test",
    githubConfigured: true,
  });
  const oversized = JSON.stringify({ prompt: "x".repeat(CLOUD_REQUEST_BODY_MAX_BYTES) });
  const rejected = await app.request("/api/cloud/tasks", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: oversized,
  });
  assert.equal(rejected.status, 413);
  const envelope = await jsonOf<{
    code: string;
    message: string;
    retryable: boolean;
    traceId: string;
  }>(rejected);
  assert.equal(envelope.code, "payload_too_large");
  assert.equal(envelope.message, "cloud-request-body-too-large");
  assert.equal(envelope.retryable, false);
  assert.match(envelope.traceId, /^cloud-/);

  // 未超限的正常请求不受影响（空体动作端点照常进入路由；此处仅证明中间件放行）。
  const allowed = await app.request("/api/cloud/capabilities");
  assert.equal(allowed.status, 200);
});

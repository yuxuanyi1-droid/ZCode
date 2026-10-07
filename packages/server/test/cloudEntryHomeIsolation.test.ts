import assert from "node:assert/strict";
import test from "node:test";
import {
  CloudEntryStartupError,
  readCloudDataDirFromEnv,
} from "../src/cloud/adapters/entry-cloud-config.js";
import { applyCloudHomeIsolation } from "../src/cloud/adapters/entry-cloud-home.js";

/**
 * HOME 隔离（03 §8）：云服务端必须把宿主 home 指向云数据目录，否则 settings/credential/
 * skills 等按 HOME 解析的路径会读写运维者真实 `~/.zcode`（实测曾污染真实 setting.json）。
 * 这里只断言隔离函数本身——它必须在服务图加载前调用，时序由 entry-cloud-main 保证。
 */
test("claude-cloud: HOME 隔离把三个 home 变量指向数据目录", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/real/home", USERPROFILE: "C:\\Users\\real" };
  const applied = applyCloudHomeIsolation("/data/cloud", env);

  assert.equal(applied, "/data/cloud");
  assert.equal(env.HOME, "/data/cloud");
  assert.equal(env.USERPROFILE, "/data/cloud");
  assert.equal(env.ZCODE_DESKTOP_HOME_DIR, "/data/cloud");
});

test("claude-cloud: 无 USERPROFILE 时不凭空创建（避免影响非 Windows 分支）", () => {
  const env: NodeJS.ProcessEnv = { HOME: "/real/home" };
  applyCloudHomeIsolation("/data/cloud", env);

  assert.equal(env.HOME, "/data/cloud");
  assert.equal(env.ZCODE_DESKTOP_HOME_DIR, "/data/cloud");
  assert.equal("USERPROFILE" in env, false);
});

test("claude-cloud: 隔离只作用于传入的 env 对象，不碰 process.env", () => {
  const realHome = process.env.HOME;
  const env: NodeJS.ProcessEnv = { HOME: "/real/home" };
  applyCloudHomeIsolation("/data/cloud", env);

  assert.equal(process.env.HOME, realHome);
});

test("claude-cloud: readCloudDataDirFromEnv 去空白，空值返回 undefined", () => {
  assert.equal(readCloudDataDirFromEnv({ ZCODE_CLOUD_DATA_DIR: "  /data/cloud  " }), "/data/cloud");
  assert.equal(readCloudDataDirFromEnv({ ZCODE_CLOUD_DATA_DIR: "   " }), undefined);
  assert.equal(readCloudDataDirFromEnv({}), undefined);
});

test("claude-cloud: 缺 dataDir 时配置读取 fail-closed（隔离与否都不静默启动）", async () => {
  const { readCloudEntryConfig } = await import("../src/cloud/adapters/entry-cloud-config.js");
  const result = await readCloudEntryConfig({
    ZCODE_SERVER_MODE: "cloud",
    ZCODE_CLOUD_PUBLIC_ORIGIN: "http://localhost:1",
    ZCODE_CLOUD_PRINCIPAL_ID: "00000000-0000-4000-8000-000000000000",
    ZCODE_SERVER_AUTH_TOKEN_FILE: "/tmp/does-not-matter.token",
    ZCODE_CLOUD_PROVIDERS: "e2b",
  } as NodeJS.ProcessEnv);

  assert.equal(result.config, undefined);
  const error = result.issues.some((issue) => issue.field === "ZCODE_CLOUD_DATA_DIR");
  assert.ok(error, "缺少 ZCODE_CLOUD_DATA_DIR 必须报出该字段");
  assert.ok(new CloudEntryStartupError("not_configured", "x") instanceof Error);
});

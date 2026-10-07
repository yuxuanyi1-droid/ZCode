/**
 * 沙箱资产与模板契约测试（specs/cloud-agent/01 §6.1、10 §7；W3 §3/§4）。
 *
 * 断言：
 * - 版本/摘要清单的严格解析与分发校验（未知资产 → not_found；摘要/长度不符 → 拒绝，
 *   **不回退未校验旧包**）；
 * - 构建入口真实可用（esbuild bundle → sha256 → manifest.json），并给出真实字节数；
 * - 模板资产满足就绪条件：`start-supervisor.sh` 0755 + flock 单例 + SSH 同构布局，
 *   且其 wrapper 文本与 `remote/zcodeAgentBundleWrapper.ts` 完全一致。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CloudAdapterError } from "../src/cloud/adapters/sandbox/adapterError.js";
import {
  createSandboxAssetCatalog,
  loadSandboxAssetCatalog,
} from "../src/cloud/adapters/sandbox/assets/catalog.js";
import {
  assetKey,
  computeAssetDigest,
  parseAssetManifest,
  resolveAssetEntry,
  SANDBOX_ASSET_MANIFEST_VERSION,
  type SandboxAssetManifest,
} from "../src/cloud/adapters/sandbox/assets/manifest.js";
import {
  buildAssets,
  DEFAULT_BUNDLE_ENTRIES,
} from "../src/cloud/adapters/sandbox/assets/buildAssets.mjs";
import { buildRemoteAgentBundleWrapper } from "../src/remote/zcodeAgentBundleWrapper.js";

const sandboxDir = fileURLToPath(new URL("../src/cloud/adapters/sandbox/", import.meta.url));
const templatesDir = join(sandboxDir, "templates");
const buildScript = join(sandboxDir, "assets", "buildAssets.mjs");

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

function manifestWith(content: Buffer): SandboxAssetManifest {
  return {
    manifestVersion: SANDBOX_ASSET_MANIFEST_VERSION,
    buildId: "1.0.0+abc123abc123",
    generatedAt: new Date(0).toISOString(),
    assets: [
      {
        name: "supervisor.bundle.mjs",
        version: "1.0.0",
        sha256: computeAssetDigest(content),
        bytes: content.byteLength,
        kind: "bootstrap",
        contentType: "text/javascript; charset=utf-8",
      },
    ],
  };
}

test("清单严格解析：版本/摘要/重复键/路径穿越都拒绝", () => {
  const valid = {
    manifestVersion: SANDBOX_ASSET_MANIFEST_VERSION,
    buildId: "b",
    generatedAt: "2026-10-06T00:00:00.000Z",
    assets: [
      {
        name: "supervisor.bundle.mjs",
        version: "1.0.0",
        sha256: "a".repeat(64),
        bytes: 10,
        kind: "bootstrap",
        contentType: "text/javascript; charset=utf-8",
      },
    ],
  };
  assert.equal(parseAssetManifest(valid).assets.length, 1);

  const broken: Array<[unknown, RegExp]> = [
    [{ ...valid, manifestVersion: 99 }, /unsupported asset manifest version/],
    [{ ...valid, buildId: "" }, /buildId must be a non-empty string/],
    [{ ...valid, assets: [] }, /at least one asset/],
    [{ ...valid, assets: [{ ...valid.assets[0]!, sha256: "not-hex" }] }, /invalid sha256/],
    [{ ...valid, assets: [{ ...valid.assets[0]!, name: "../escape.mjs" }] }, /plain file name/],
    [{ ...valid, assets: [{ ...valid.assets[0]!, kind: "unknown" }] }, /unsupported kind/],
    [{ ...valid, assets: [valid.assets[0]!, { ...valid.assets[0]! }] }, /duplicate asset entry/],
  ];
  for (const [value, pattern] of broken) {
    assert.throws(() => parseAssetManifest(value), pattern);
  }
});

test("assetId 解析：name@version 精确匹配，同名多版本必须点名", () => {
  const manifest = manifestWith(Buffer.from("x"));
  manifest.assets.push({
    ...manifest.assets[0]!,
    version: "1.0.1",
    sha256: "b".repeat(64),
  });
  assert.equal(resolveAssetEntry(manifest, "supervisor.bundle.mjs@1.0.1")?.version, "1.0.1");
  // 同名两版本：不带版本号无法判定「最新」，必须显式点名（禁止隐式追最新）。
  assert.equal(resolveAssetEntry(manifest, "supervisor.bundle.mjs"), undefined);
  assert.equal(resolveAssetEntry(manifest, "missing.bundle.mjs"), undefined);
  const single = manifestWith(Buffer.from("x"));
  assert.equal(resolveAssetEntry(single, "supervisor.bundle.mjs")?.version, "1.0.0");
  assert.equal(assetKey(single.assets[0]!), "supervisor.bundle.mjs@1.0.0");
});

test("目录分发：读取校验通过；内容被篡改或文件缺失一律拒绝，不回退旧包", async () => {
  const directory = await tempDir("zcode-asset-");
  const content = Buffer.from("export const a = 1;\n");
  await writeFile(join(directory, "supervisor.bundle.mjs"), content);
  const catalog = createSandboxAssetCatalog({ directory, manifest: manifestWith(content) });

  const payload = await catalog.readAsset("supervisor.bundle.mjs@1.0.0");
  assert.equal(payload.sha256, computeAssetDigest(content));
  assert.equal(payload.bytes.byteLength, content.byteLength);
  assert.equal(payload.buildId, "1.0.0+abc123abc123");
  assert.equal(payload.contentType, "text/javascript; charset=utf-8");

  await assert.rejects(
    () => catalog.readAsset("other.bundle.mjs"),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "not_found");
      return true;
    },
  );

  // 篡改内容 → validation_failed（fail-closed，不返回未校验内容）。
  await writeFile(join(directory, "supervisor.bundle.mjs"), Buffer.from("tampered"));
  await assert.rejects(
    () => catalog.readAsset("supervisor.bundle.mjs@1.0.0"),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "validation_failed");
      return true;
    },
  );

  // 清单声明但文件缺失 → 明确失败。
  const missingDir = await tempDir("zcode-asset-missing-");
  const missingCatalog = createSandboxAssetCatalog({
    directory: missingDir,
    manifest: manifestWith(content),
  });
  await assert.rejects(
    () => missingCatalog.readAsset("supervisor.bundle.mjs@1.0.0"),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "validation_failed");
      return true;
    },
  );

  // 清单缺失 → 加载即失败（不猜默认资产）。
  await assert.rejects(
    () => loadSandboxAssetCatalog({ directory: missingDir }),
    (error: unknown) => {
      assert.ok(error instanceof CloudAdapterError);
      assert.equal(error.code, "validation_failed");
      return true;
    },
  );
});

test("构建入口：bundle 产物 + 版本/摘要清单（真实 esbuild + sha256）", async () => {
  const workspace = await tempDir("zcode-assets-build-");
  const entryPath = join(workspace, "fixtureEntry.ts");
  await writeFile(
    entryPath,
    'export const hello = (name: string): string => `zcode ${name}`;\nconsole.log(hello("sandbox"));\n',
  );
  const outDir = join(workspace, "dist");

  const manifest = await buildAssets({
    outDir,
    version: "9.9.9",
    bundles: [{ name: "fixture.bundle.mjs", entry: entryPath, kind: "bootstrap" }],
    copies: [{ name: "zcode-cli.cjs", path: entryPath, kind: "runtime" }],
  });

  assert.equal(manifest.manifestVersion, SANDBOX_ASSET_MANIFEST_VERSION);
  assert.match(manifest.buildId, /^9\.9\.9\+[0-9a-f]{12}$/);
  assert.deepEqual(
    manifest.assets.map((asset) => asset.name),
    ["fixture.bundle.mjs", "zcode-cli.cjs"],
  );
  const bundleEntry = manifest.assets[0]!;
  assert.equal(bundleEntry.version, "9.9.9");
  assert.equal(bundleEntry.kind, "bootstrap");
  assert.equal(manifest.assets[1]!.kind, "runtime");

  // bundle 真实包含打包后的源码，且清单摘要与落盘内容一致。
  const bundled = await readFile(join(outDir, "fixture.bundle.mjs"));
  assert.ok(bundled.byteLength > 0);
  assert.equal(bundleEntry.bytes, bundled.byteLength);
  assert.equal(bundleEntry.sha256, computeAssetDigest(bundled));

  // 清单可被目录读取器直接消费（分发端点路径）。
  const catalog = await loadSandboxAssetCatalog({ directory: outDir });
  const payload = await catalog.readAsset(`fixture.bundle.mjs@9.9.9`);
  assert.equal(payload.sha256, bundleEntry.sha256);
});

test("构建入口：入口缺失时明确失败，不产出空清单", async () => {
  const workspace = await tempDir("zcode-assets-missing-");
  await assert.rejects(
    () =>
      buildAssets({
        outDir: join(workspace, "dist"),
        version: "1.0.0",
        bundles: [{ name: "x.bundle.mjs", entry: join(workspace, "nope.ts"), kind: "bootstrap" }],
        copies: [],
      }),
    /is missing/,
  );
});

test("构建入口 CLI：默认入口指向 W6 的 supervisor/stub，--help 可用", () => {
  assert.deepEqual(
    DEFAULT_BUNDLE_ENTRIES.map((entry) => entry.name),
    ["supervisor.bundle.mjs", "runtimeStub.bundle.mjs"],
  );
  // 默认入口必须精确落在 W6 的源文件上（路径由仓库根推导，避免相对层级写错）。
  const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
  assert.deepEqual(
    DEFAULT_BUNDLE_ENTRIES.map((entry) => entry.entry),
    ["supervisorMain.ts", "runtimeStub.ts"].map((name) =>
      join(repoRoot, "packages/server/src/cloud/execution/sandbox", name),
    ),
  );

  const help = spawnSync(process.execPath, [buildScript, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /supervisorMain\.ts/);

  const badArg = spawnSync(process.execPath, [buildScript, "--nope"], { encoding: "utf8" });
  assert.notEqual(badArg.status, 0);
  assert.match(badArg.stderr, /unknown argument/);
});

test("模板：start-supervisor.sh 可执行、flock 单例、布局与 SSH 同构", async () => {
  const scriptPath = join(templatesDir, "start-supervisor.sh");
  const info = await stat(scriptPath);
  assert.ok((info.mode & 0o111) !== 0, "start-supervisor.sh 必须可执行（0755）");
  assert.equal((info.mode & 0o777).toString(8), "755");

  const script = await readFile(scriptPath, "utf8");
  assert.match(script, /flock -n 9 \|\|/);
  assert.match(script, /exec 9>\/tmp\/zcode-supervisor\.lock/);
  // 单例判定必须在自举 env 校验之前：重试不得把健康沙箱判成失败。
  assert.ok(
    script.indexOf("flock -n 9") < script.indexOf("ZCODE_CLOUD_RUN_ID:?"),
    "flock 单例必须先于 env 校验",
  );
  // SSH 同构布局（remote/deployShared.ts 的 REMOTE_BASE = ~/.zcode/server）。
  assert.match(script, /layout_root="\$\{HOME:\?HOME is not set\}\/\.zcode\/server"/);
  assert.match(script, /\$layout_root\/zcode-server\.cjs/);
  assert.match(script, /\$layout_root\/agents\/glm\/zcode\.cjs/);
  // 自举要素只从 env 读取（脚本内不出现任何内嵌凭据）。
  for (const name of [
    "ZCODE_CLOUD_PUBLIC_ORIGIN",
    "ZCODE_CLOUD_RUN_ID",
    "ZCODE_CLOUD_RUN_GENERATION",
    "ZCODE_CLOUD_BOOTSTRAP_TICKET",
  ]) {
    assert.ok(script.includes(name), `脚本必须校验 ${name}`);
  }
  // wrapper 文本与 SSH 部署的实现同文（否则交互同构失效）。
  const wrapper = buildRemoteAgentBundleWrapper("glm").trimEnd();
  assert.ok(
    script.includes(wrapper),
    "zcode-agent wrapper 必须与 buildRemoteAgentBundleWrapper 一致",
  );
});

test("模板：镜像 CMD 常驻占位，Daytona 快照定义与 driver 的 create 载荷一致", async () => {
  const startSh = await readFile(join(templatesDir, "start.sh"), "utf8");
  assert.match(startSh, /exec sleep infinity/);

  for (const dockerfile of ["e2b.Dockerfile", "modal.Dockerfile"]) {
    const content = await readFile(join(templatesDir, dockerfile), "utf8");
    assert.match(content, /CMD \["\/opt\/zcode\/start\.sh"\]/);
    assert.match(content, /COPY start-supervisor\.sh \/opt\/zcode\/start-supervisor\.sh/);
    // 指令级检查（注释里出现「非 ENTRYPOINT」是说明，不算指令）。
    assert.ok(!/^ENTRYPOINT/m.test(content), `${dockerfile} 不得覆盖 provider init（用 CMD）`);
  }

  const e2bToml = await readFile(join(templatesDir, "e2b.toml"), "utf8");
  assert.match(e2bToml, /template_id = "zcode-sandbox-template"/);
  assert.match(e2bToml, /dockerfile = "e2b\.Dockerfile"/);
  assert.match(e2bToml, /start_cmd = "\/opt\/zcode\/start\.sh"/);

  const snapshot = JSON.parse(
    await readFile(join(templatesDir, "daytona.snapshot.json"), "utf8"),
  ) as {
    name: string;
    resources: { cpu: number; memoryGiB: number };
    createPayloadReference: Record<string, unknown>;
  };
  assert.equal(snapshot.name, "zcode-sandbox-template");
  assert.equal(snapshot.resources.cpu, 2);
  // idle 回收显式关闭、不自动删除（与 daytonaDriver 的 create 载荷一致）。
  assert.equal(snapshot.createPayloadReference["autoStopInterval"], 0);
  assert.equal(snapshot.createPayloadReference["autoPauseInterval"], 0);
  assert.equal(snapshot.createPayloadReference["autoArchiveInterval"], 0);
  assert.equal(snapshot.createPayloadReference["autoDeleteInterval"], -1);
});

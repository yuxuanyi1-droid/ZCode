/**
 * 沙箱资产构建入口（specs/cloud-agent/01 §6.1、10 §7；W3 §3「构建入口：新增 package
 * scripts（bundle 构建 + 版本摘要）」）。
 *
 * 做两件事：
 * 1. 用 esbuild（server devDeps 已有，不新增依赖）把 supervisor / runtime stub 打成
 *    自包含单文件 bundle（沙箱镜像内没有 node_modules，产物必须自包含）；
 * 2. 为全部产物算出 sha256 与字节数，写 `manifest.json`（版本/摘要清单，
 *    由 assets/catalog.ts 在分发端点校验）。
 *
 * 用法（仓库根执行）：
 *   pnpm --filter @zcode/server build:sandbox-assets
 *   node packages/server/src/cloud/adapters/sandbox/assets/buildAssets.mjs \
 *     --entry supervisor.bundle.mjs=<path/to/supervisorMain.ts> \
 *     --copy  zcode-server.cjs=<path/to/zcode-server.cjs>
 *
 * 默认入口是 `cloud/execution/sandbox/supervisorMain.ts` 与 `runtimeStub.ts`（W6 提供）。
 * 入口文件不存在时**明确失败**（打印期望路径），不做静默跳过或产出空清单——
 * 资产缺口必须在构建期暴露，而不是让沙箱在启动时才发现。
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ASSETS_DIR = dirname(fileURLToPath(import.meta.url));
const SANDBOX_DIR = resolve(ASSETS_DIR, "..");
// assets → sandbox → adapters → cloud → src → server → packages → 仓库根。
const REPO_ROOT = resolve(SANDBOX_DIR, "../../../../../..");
const DEFAULT_OUT_DIR = join(ASSETS_DIR, "dist");
const EXECUTION_SANDBOX_DIR = join(REPO_ROOT, "packages/server/src/cloud/execution/sandbox");

/** 清单格式版本（与 assets/manifest.ts 的 SANDBOX_ASSET_MANIFEST_VERSION 对齐）。 */
export const MANIFEST_VERSION = 1;

/**
 * 默认 bundle 入口（W6 的 supervisor 与 runtime stub）。两者都必须存在，
 * 否则构建失败——缺一不可。
 */
export const DEFAULT_BUNDLE_ENTRIES = [
  {
    name: "supervisor.bundle.mjs",
    entry: join(EXECUTION_SANDBOX_DIR, "supervisorMain.ts"),
    kind: "bootstrap",
  },
  {
    name: "runtimeStub.bundle.mjs",
    entry: join(EXECUTION_SANDBOX_DIR, "runtimeStub.ts"),
    kind: "bootstrap",
  },
];

/** 扩展名 → 分发媒体类型（分发端点直接复用，不各端自猜）。 */
export function contentTypeFor(name) {
  switch (extname(name).toLowerCase()) {
    case ".mjs":
    case ".js":
    case ".cjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json";
    case ".sh":
      return "text/x-shellscript";
    case ".toml":
      return "application/toml";
    default:
      return "application/octet-stream";
  }
}

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 解析 `name=path` 形式的参数（可重复）。 */
export function parseNamedArg(value, flag) {
  const at = value.indexOf("=");
  if (at <= 0) {
    throw new Error(`${flag} expects name=path, got: ${value}`);
  }
  return { name: value.slice(0, at), path: resolve(value.slice(at + 1)) };
}

export function parseArgs(argv) {
  const options = {
    outDir: DEFAULT_OUT_DIR,
    bundles: [],
    copies: [],
    version: null,
    noDefaults: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      options.outDir = resolve(argv[(index += 1)]);
    } else if (arg === "--version") {
      options.version = argv[(index += 1)];
    } else if (arg === "--entry") {
      options.bundles.push({ ...parseNamedArg(argv[(index += 1)], "--entry"), kind: "bootstrap" });
    } else if (arg === "--copy") {
      options.copies.push({ ...parseNamedArg(argv[(index += 1)], "--copy"), kind: "runtime" });
    } else if (arg === "--no-defaults") {
      options.noDefaults = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  // 默认入口（除非显式 --no-defaults）：缺一即构建失败，不静默跳过。
  const bundles = options.noDefaults
    ? [...options.bundles]
    : [...DEFAULT_BUNDLE_ENTRIES, ...options.bundles];
  if (bundles.length === 0 && options.copies.length === 0) {
    throw new Error("nothing to build: pass --entry/--copy or drop --no-defaults");
  }
  return { ...options, bundles };
}

async function assertReadable(path, label) {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    throw new Error(`${label} is missing: ${path}`);
  }
}

/** esbuild 单文件 bundle（与沙箱镜像的 node24 对齐；产物自包含）。 */
export async function bundleEntry({ entry, outfile }) {
  await assertReadable(entry, "bundle entry");
  await build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    // packages: "bundle"（默认）：ws/@zcode/rpc/@zcode/shared 等全部进产物，
    // 因为沙箱镜像里没有 node_modules。
    banner: {
      js: "import { createRequire as __zcodeCreateRequire } from 'node:module';\nconst require = __zcodeCreateRequire(import.meta.url);",
    },
    legalComments: "inline",
    logLevel: "warning",
  });
}

/**
 * 构建并写清单。返回 manifest 对象（测试可直接断言）。
 * 幂等：先清空输出目录，避免残留上一版本的资产被误当成当前构建的一部分。
 */
export async function buildAssets(options) {
  const version = options.version ?? (await readRepoVersion());
  await rm(options.outDir, { recursive: true, force: true });
  await mkdir(options.outDir, { recursive: true });
  const entries = [];

  for (const bundle of options.bundles) {
    const outfile = join(options.outDir, bundle.name);
    await bundleEntry({ entry: bundle.entry, outfile });
    entries.push(await describeFile(outfile, bundle.name, version, bundle.kind));
  }
  for (const copy of options.copies) {
    await assertReadable(copy.path, "copy source");
    const outfile = join(options.outDir, copy.name);
    await writeFile(outfile, await readFile(copy.path));
    entries.push(await describeFile(outfile, copy.name, version, copy.kind));
  }

  const sortedDigests = entries
    .map((entry) => entry.sha256)
    .sort()
    .join("");
  const manifest = {
    manifestVersion: MANIFEST_VERSION,
    // 构建标识 = 版本 + 内容摘要前缀：内容变化即换 id（禁止无限追最新，10 §7）。
    buildId: `${version}+${sha256Hex(Buffer.from(sortedDigests, "utf8")).slice(0, 12)}`,
    generatedAt: new Date().toISOString(),
    assets: entries.sort((a, b) => a.name.localeCompare(b.name)),
  };
  await writeFile(
    join(options.outDir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

async function describeFile(path, name, version, kind) {
  const bytes = await readFile(path);
  return {
    name,
    version,
    sha256: sha256Hex(bytes),
    bytes: bytes.byteLength,
    kind,
    contentType: contentTypeFor(name),
  };
}

async function readRepoVersion() {
  const raw = await readFile(join(REPO_ROOT, "package.json"), "utf8");
  const version = JSON.parse(raw)?.version;
  if (typeof version !== "string" || version.trim() === "") {
    throw new Error("repository package.json has no version; pass --version explicitly");
  }
  return version;
}

const HELP = `usage: buildAssets.mjs [--out DIR] [--version V] [--entry name=path]... [--copy name=path]... [--no-defaults]

默认入口（缺一即构建失败）：
  supervisor.bundle.mjs  <- packages/server/src/cloud/execution/sandbox/supervisorMain.ts
  runtimeStub.bundle.mjs <- packages/server/src/cloud/execution/sandbox/runtimeStub.ts
`;

async function main(argv) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(HELP);
    return 0;
  }
  const manifest = await buildAssets(options);
  for (const asset of manifest.assets) {
    process.stdout.write(
      `built ${asset.name} (${(asset.bytes / 1024).toFixed(1)} KiB, sha256:${asset.sha256.slice(0, 12)})\n`,
    );
  }
  process.stdout.write(
    `manifest buildId=${manifest.buildId} assets=${manifest.assets.length} -> ${join(options.outDir, "manifest.json")}\n`,
  );
  return 0;
}

const invokedDirectly =
  process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`sandbox asset build failed: ${error?.message ?? error}\n`);
    if (String(error?.message ?? "").includes("is missing:")) {
      process.stderr.write(
        "提示：bundle 入口由 cloud-execution（W6）提供；入口尚未落地时不产出资产，构建应失败而不是留空清单。\n",
      );
    }
    process.exitCode = 1;
  }
}

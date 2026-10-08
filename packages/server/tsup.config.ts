import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defineConfig } from "tsup";
// tsup 配置自身会被打包，构建工具需保留原始文件位置，不能被内联后重定位。
const { loadBuiltinProviderConfig } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/builtin-provider-config.mjs")).href
);
const { stageThirdPartyNotices } = await import(
  pathToFileURL(resolve(import.meta.dirname, "../../scripts/third-party-notices.mjs")).href
);

// tsup config 可能从不同 cwd 加载，基于配置文件自身目录解析仓库根 package.json。
const rootPackageJsonPath = resolve(import.meta.dirname, "../../package.json");
const { version } = JSON.parse(readFileSync(rootPackageJsonPath, "utf-8"));

const { environment: zcodeEnv, content: zcodeBuiltinProviderConfigJson } =
  await loadBuiltinProviderConfig();

export const SERVER_HTTP_DEFINES = {
  __ZCODE_VERSION__: JSON.stringify(version),
  __ZCODE_ENV__: JSON.stringify(zcodeEnv),
  __ZCODE_BUILTIN_PROVIDER_CONFIG_JSON__: JSON.stringify(zcodeBuiltinProviderConfigJson),
};

function createSharedDefines() {
  return SERVER_HTTP_DEFINES;
}

export const SERVER_HTTP_EXTERNAL_DEPENDENCIES = [
  "ssh2",
  "node-pty",
  "undici",
  "axios",
  "form-data",
  "combined-stream",
  "proxy-from-env",
  "follow-redirects",
  // node-forge 内部用动态 require("crypto")，内联进 server ESM bundle 后 Node 会报
  // Dynamic require of "crypto" is not supported；这里和 desktop main/host 构建保持同一外置策略。
  "node-forge",
  "yaml",
  // services 的反馈日志压缩链路引入 CJS 包 yazl，被内联进 ESM bundle 后
  // 运行时命中 require("fs") 动态 require，entry-http 启动即崩；保留外部依赖交给 Node 原生加载。
  "yazl",
  // 云内容 ZIP 解包链路引入 yauzl，其 CommonJS require("fs") 在 ESM
  // bundle 加载时崩溃；与 desktop 相同，外置后交给 Node 原生加载。
  "yauzl",
];

export default defineConfig({
  onSuccess: async () => {
    await stageThirdPartyNotices(resolve(import.meta.dirname, "dist"));
  },
  // 三个独立产物：
  // - entry-http：本地/standalone web 唯一入口，也是模式分派点（2026-10-07，04 §2.1/W5 §3.1）：
  //   `ZCODE_SERVER_MODE=cloud` 时它动态 import entry-cloud 产物，因此 dev 脚本的
  //   `--onSuccess 'node dist/entry-http.js'` 带 cloud env 也能起云入口；
  // - entry-cloud：云入口（host 本体 + cloud 叠加，specs/cloud-agent W5）。**产物名不要改**：
  //   entry-http 的动态 import 会被 esbuild 重写成这个产物名（实测 `await import("./entry-cloud.js")`），
  //   改名等于切断单一入口的云分派；
  // - storageWorkerMain：云控制面的 storage 子进程入口，必须独立成文件——W2 的
  //   `storageTransport` 默认按「与自身同目录、同扩展名的 storageWorkerMain」解析，
  //   入口名保持一致才能让打包产物开箱可用（否则需 workerEntryPath 覆盖）。
  entry: {
    "entry-http": "src/entry-http.ts",
    "entry-cloud": "src/cloud/adapters/entry-cloud-main.ts",
    storageWorkerMain: "src/cloud/adapters/storage/storageWorkerMain.ts",
  },
  outDir: "dist",
  format: "esm",
  platform: "node",
  target: "node22",
  // workspace 包的 exports 指向 .ts 源码，node 运行时无法直接加载，需要 bundle 进来
  noExternal: [
    "@zcode/shared",
    "@zcode/rpc",
    "@zcode/services",
    "@zcode/services/node",
    "@zcode/client",
  ],
  // ssh2 / node-pty 含 .node native addon，不能被 esbuild 处理。
  // undici / axios 这类 CJS 依赖被内联进 ESM bundle 后，运行时会走到
  // require("assert") / require("util") / require("url") 等动态 require，Node 的 ESM wrapper 下会直接报 Dynamic require not supported。
  // HTTP server 场景保留为外部依赖，交给 Node 原生加载；remote 单文件 bundle 仍由 build-remote.ts 负责内联。
  external: SERVER_HTTP_EXTERNAL_DEPENDENCIES,
  define: createSharedDefines(),
  // esbuild 不认识 tsconfig.json 里的 es2025，用专门的 tsconfig.build.json 消除 warning
  tsconfig: "tsconfig.build.json",
  // tsup 默认把 `node:xxx` 前缀剥成裸模块名（`removeNodeProtocol: true`）。这会让
  // 只以 `node:` 形式存在的内置模块在 ESM 产物里解析失败——云控制面的 storage worker
  // 子进程入口正是这种（`node:sqlite`，Node 22.5+），剥前缀后 `node dist/storageWorkerMain.js`
  // 直接 ERR_MODULE_NOT_FOUND。运行时要求 Node ≥22，保留前缀是安全的。
  removeNodeProtocol: false,
});

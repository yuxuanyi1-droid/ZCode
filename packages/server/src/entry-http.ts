/**
 * 进程唯一入口与模式分派（specs/cloud-agent/04 §2.1、W5 §3.1、07 §12 修订记录）。
 *
 * 模式由**服务端**决定：读 `ZCODE_SERVER_MODE`，`=cloud` 复用云入口启动事务
 * （`entry-cloud-main.ts`，与 `dist/entry-cloud.js` 是同一份实现），其余走既有本地行为。
 * 客户端不再有 `?mode=` / 构建期 `VITE_*`，启动时用同源探测问服务端（04 §2.1）。
 *
 * 顺序硬约束（03 §8、`entry-cloud-home.ts`）：模式读取与 HOME 隔离必须发生在**加载服务图
 * 之前**——`services/paths.ts` 在模块加载期就固化 `HOME`，隔离晚了云入口会写进运维者真实
 * home。因此本文件只保留轻量静态 import（模式读取），`@zcode/services/node`、`./http.js`
 * 与云入口一律动态 import；否则 tsup 产物会在入口模块求值时就把服务图拉起来，隔离失效。
 *
 * 非法模式值 fail-closed 退出，不隐式回落本机（W5 §5「不隐式切 local」）。
 */
import { formatLogPrefix } from "@zcode/shared";
import { readZCodeServerModeFromEnv } from "./cloud/adapters/entry-cloud-config.js";

/** 本地模式：既有行为原样保留（服务图与 HTTP 装配的 import 全部推迟到这一步之后）。 */
async function runLocalEntry(): Promise<void> {
  const [
    { createLocalServices, getAppConfigDir },
    { materializeBundledZCodeBuiltinProviderConfig, readBundledZCodeBuiltinProviderConfig },
    { createHttpServer },
  ] = await Promise.all([
    import("@zcode/services/node"),
    import("./bundledZCodeBuiltinProviderConfig.js"),
    import("./http.js"),
  ]);

  const zcodeBuiltinProviderConfigFilePath = await materializeBundledZCodeBuiltinProviderConfig({
    environmentConfigRoot: getAppConfigDir(),
    content: readBundledZCodeBuiltinProviderConfig(),
  });
  const port = Number(process.env["PORT"]) || 3030;
  const host = process.env["ZCODE_SERVER_HOST"]?.trim() || process.env["HOST"]?.trim() || undefined;
  const staticRoot = process.env["ZCODE_WEB_STATIC_ROOT"]?.trim() || undefined;
  const authToken = process.env["ZCODE_SERVER_AUTH_TOKEN"]?.trim() || undefined;
  const services = createLocalServices({
    zcodeBuiltinProviderConfigFilePath,
    providerProvisioningTargetEnabled: Boolean(authToken),
  });

  createHttpServer(services, port, {
    ...(host ? { host } : {}),
    ...(staticRoot ? { staticRoot, spaFallback: true } : {}),
    ...(authToken ? { authToken, authRequired: true } : {}),
  });
}

/**
 * 云模式：复用云入口启动事务（HOME 隔离 → 动态 import 服务图 → 启动 → 信号收尾）。
 *
 * 不在这里复制启动顺序：`entry-cloud-main.ts` 已把「隔离先于服务图 import」写成模块级
 * 约定，复制第二份就等于留下两条可能漂移的启动路径（W5 §3.1）。它的失败处理自带
 * `process.exit(1)`（03 §8：不留半个云入口进程）。
 */
async function runCloudEntry(): Promise<void> {
  await import("./cloud/adapters/entry-cloud-main.js");
}

async function main(): Promise<void> {
  const declared = readZCodeServerModeFromEnv();
  if ("invalid" in declared) {
    console.error(
      formatLogPrefix("zcode-server:http", process.pid),
      `startup failed (mode_invalid): ZCODE_SERVER_MODE=${declared.invalid} 不是合法模式（只接受 local|cloud），不隐式回落本机`,
    );
    process.exitCode = 1;
    return;
  }

  if (declared.mode === "cloud") {
    await runCloudEntry();
    return;
  }

  await runLocalEntry();
}

void main().catch((error: unknown) => {
  console.error("[zcode-server:http] startup failed", error);
  process.exitCode = 1;
});

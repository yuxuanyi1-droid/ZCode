/**
 * 云入口可执行引导（specs/cloud-agent/modules/W5-cloud-entry.md §3/§3.1/§4）。
 *
 * 只做进程级事务：**隔离 HOME** → 读配置 → 启动 → 装信号处理 → 按关闭顺序收尾。业务与技术
 * 细节都在 `entry-cloud-server.ts`（组装）与其下各适配器里，本文件不承载任何规则。
 *
 * 两个消费者共用这一份事务（2026-10-07 单一入口，W5 §3.1）：
 * 1) 构建产物 `dist/entry-cloud.js`（运维方直接运行）；
 * 2) `src/entry-http.ts` 在 `ZCODE_SERVER_MODE=cloud` 时动态 import 本模块——
 *    分派与隔离放在这里，入口层不复制第二套启动顺序。
 *
 * 顺序约束（03 §8、`entry-cloud-home.ts`）：HOME 隔离必须发生在**服务图被 import 之前**——
 * `services/paths.ts` 在模块加载时就固化 `HOME`。所以本文件只用轻量静态 import（配置解析 +
 * 隔离助手），`@zcode/services/node` 与 `entry-cloud-server.js` 一律走动态 import；调用方
 * 也必须动态 import 本模块（静态引入会把整条服务图提前到入口模块求值）。
 *
 * 失败语义（03 §8）：启动失败必须显式退出，不留"半个云入口"进程——没有任何路由或
 * 只跑了一半后台循环的进程比直接退出更危险。
 */
import { formatLogPrefix } from "@zcode/shared";
import { CloudEntryStartupError, readCloudDataDirFromEnv } from "./entry-cloud-config.js";
import { applyCloudHomeIsolation } from "./entry-cloud-home.js";

async function main(): Promise<void> {
  // 1) 先隔离 HOME（缺 dataDir 时不隔离，交给完整配置读取 fail-closed：data_dir_required）。
  const isolatedHome = readCloudDataDirFromEnv();
  if (isolatedHome) {
    applyCloudHomeIsolation(isolatedHome);
  }

  // 2) 再加载重图：logger 与云入口装配都依赖 services 图，必须在隔离之后。
  const [{ createServiceLogger }, { startCloudServer }] = await Promise.all([
    import("@zcode/services/node"),
    import("./entry-cloud-server.js"),
  ]);

  const logger = createServiceLogger("cloud-entry");
  if (isolatedHome) {
    logger.info(undefined, "[cloud-entry] host home isolated", { home: isolatedHome });
  }
  const handle = await startCloudServer({ logger });
  logger.info(undefined, "[cloud-entry] started", {
    port: handle.port,
    principalId: handle.principalId,
    publicOrigin: handle.config.publicOrigin,
  });

  let shuttingDown = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      // 第二次信号不打断正在进行的收尾（关闭顺序不可被跳过）。
      return;
    }
    shuttingDown = true;
    logger.info(undefined, `[cloud-entry] ${signal} received, shutting down`);
    void handle.close().then(
      () => process.exit(0),
      (error: unknown) => {
        logger.error(undefined, "[cloud-entry] shutdown failed", error);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

void main().catch((error: unknown) => {
  const code = error instanceof CloudEntryStartupError ? error.code : "startup_failed";
  const details = error instanceof CloudEntryStartupError ? error.details : undefined;
  console.error(
    formatLogPrefix("zcode-server:cloud", process.pid),
    `startup failed (${code})`,
    error instanceof Error ? error.message : error,
    details ?? "",
  );
  process.exit(1);
});

/**
 * 云入口服务组装（specs/cloud-agent/03 §2/§8、07 §2/§5/§12；W5 §3/§4）。
 *
 * 同一个 Hono app 上叠加三件事（12 §4「最小侵入」）：host 本体服务图 → host `/ws`
 * 服务通道；cloud 模块的路由与后台循环（W1 装配后经 `controlPlane` 注入）；Web 静态
 * 产物 + SPA fallback（只回 index.html，绝不吞 `/api/*` 与 `/ws/*`）。
 *
 * 启动顺序（03 §8）：配置校验 → driver 门控 → 数据目录与 host 本体 → 部署秘密 →
 * 存储就绪（迁移门槛）→ 控制面装配/恢复 → 监听。任一步失败都回落清理已启动资源。
 * 关闭顺序（W5 §6）：delivery → lifecycle → server（含连接回收）→ cloud → host dispose。
 */
import { readFile } from "node:fs/promises";
import { createServiceLogger, type ProviderProvisioningSource } from "@zcode/services/node";
import type { ServiceCollection } from "@zcode/services";
import { Hono } from "hono";
import type { ServerType } from "@hono/node-server";
import { createNodeWebSocket } from "@hono/node-ws";
import type { CloudUpgradeWebSocket } from "../contract.js";
import {
  resolveStaticFile,
  staticContentType,
  isChannelOrApiPath,
  createLiteTokenGuard,
} from "../../rpcChannelServer.js";
import type { SandboxDriverRegistryPort } from "../app/ports/sandboxDriverRegistryPort.js";
import type { SandboxTemplateResolverPort } from "../app/ports/sandboxDriverPort.js";
import {
  createCloudGitGrantRoute,
  createCloudGitHubTokenService,
  type CloudGitGrantStorage,
} from "./entry-cloud-git-grant.js";
import type { GitHubTokenService } from "./github/tokens.js";
import type { LoopSchedulerPort } from "../app/ports/loopSchedulerPort.js";
import type { CloudEntryConfig } from "./entry-cloud-config.js";
import { loadCloudEntrySecrets, type CloudDeploymentSecrets } from "./entry-cloud-secrets.js";
import {
  createCloudDriverRegistry,
  createConfiguredSandboxTemplateResolver,
  createDriverSecretReader,
  resolveDriverDeploymentConfigs,
  resolveProductionDriverBindings,
} from "./entry-cloud-drivers.js";
import type { SandboxDriverBinding } from "./sandbox/providers.js";
import { startCloudHostBody, type CloudHostBody } from "./entry-cloud-host-body.js";
import {
  createCloudHostChannelServices,
  createProvisioningSourceChangeObserver,
  mountCloudHostWebSocket,
  readCloudHostProvisioningSource,
  type ProvisioningSourceChangeObserver,
} from "./entry-cloud-host-ws.js";
import { createIntervalLoopScheduler } from "./entry-cloud-loop-scheduler.js";
import {
  assertStorageReady,
  buildCloudControlPlane,
  openCloudStorage,
  resolveCloudConfig,
  resolveCloudStorageWorkerEntryPath,
  resolveDefaultCloudControlPlaneFactory,
  type CloudBackgroundLoop,
  type CloudControlPlane,
  type CloudControlPlaneContext,
  type CloudControlPlaneFactory,
  type CloudEntryLogger,
  type CloudStorageReadinessSource,
} from "./entry-cloud-startup.js";
import { closeServerWithConnections, errorEnvelope, listenCloudApp } from "./entry-cloud-http.js";

export {
  resolveCloudStorageWorkerEntryPath,
  resolveDefaultCloudControlPlaneFactory,
  type CloudBackgroundLoop,
  type CloudControlPlane,
  type CloudControlPlaneContext,
  type CloudControlPlaneFactory,
  type CloudEntryLogger,
  type CloudStorageReadinessSource,
} from "./entry-cloud-startup.js";

export interface StartCloudServerOptions {
  readonly env?: Record<string, string | undefined>;
  /** 已解析配置（测试注入；生产由 env 读出）。 */
  readonly config?: CloudEntryConfig;
  readonly hostServices?: ServiceCollection;
  readonly hostBody?: CloudHostBody;
  readonly hostProvisioningSource?: ProviderProvisioningSource;
  readonly secrets?: CloudDeploymentSecrets;
  readonly drivers?: SandboxDriverRegistryPort;
  /** 生产 driver 绑定表（W3 落地后登记）；测试可注入自定义绑定验证门控/版本矩阵。 */
  readonly driverBindings?: readonly SandboxDriverBinding[];
  /** 沙箱模板解析器（缺省由 `sandboxTemplateRefs` 配置构造）；测试/嵌入方可注入。 */
  readonly templates?: SandboxTemplateResolverPort;
  /** GitHub token 服务（缺省由 `secrets.gitHubApp` 构造 W4 adapter）；测试注入 fake。 */
  readonly gitHubTokens?: GitHubTokenService;
  /**
   * 存储就绪门（03 §8）。入口在生产路径上拿不到控制面内部的 `StoragePort`，因此
   * 只要注入本项入口就会先跑一次迁移/可写性校验；控制面工厂若自行持有 StoragePort，
   * 必须在返回前完成同一校验，不得先返回再服务。
   */
  readonly storage?: CloudStorageReadinessSource;
  readonly controlPlane?: CloudControlPlane;
  readonly createControlPlane?: CloudControlPlaneFactory;
  /** 测试注入监听端口（0 = 由系统分配）；生产取配置。 */
  readonly listenPort?: number;
  readonly listenHost?: string;
  readonly logger?: CloudEntryLogger;
  readonly provisioningSourceChanges?: ProvisioningSourceChangeObserver;
  /** storage worker 入口覆盖（默认按构建形态解析）。 */
  readonly storageWorkerEntryPath?: string;
  /** 循环定时器注入缝：生产用 interval 实现，测试注入手动调度器逐拍驱动。 */
  readonly loopScheduler?: LoopSchedulerPort;
}

export interface CloudServerHandle {
  readonly port: number;
  readonly config: CloudEntryConfig;
  readonly principalId: string;
  readonly controlPlane: CloudControlPlane;
  readonly loops: CloudControlPlane["loops"];
  readonly hostBody: CloudHostBody;
  close(): Promise<void>;
}

function mountStaticAssets(app: Hono, webDir: string, logger: CloudEntryLogger): void {
  app.get("*", async (c) => {
    const pathname = new URL(c.req.url).pathname;
    if (isChannelOrApiPath(pathname)) {
      // 静态层不得吞掉 `/api/*` 与 `/ws/*`（W5 §5），**包括**豁免 lite-token 的
      // bridge 通道：普通 GET 打过去是 404，绝不回 index.html。未注册的云端点同理。
      return c.notFound();
    }
    const filePath = await resolveStaticFile(webDir, pathname, true);
    if (!filePath) {
      return c.notFound();
    }
    const body = await readFile(filePath);
    return c.body(body, 200, {
      "Cache-Control": filePath.endsWith("index.html")
        ? "no-cache"
        : "public, max-age=31536000, immutable",
      "Content-Type": staticContentType(filePath),
    });
  });
  logger.info(undefined, "[cloud-entry] static assets mounted", webDir);
}

export async function startCloudServer(
  options: StartCloudServerOptions = {},
): Promise<CloudServerHandle> {
  const env = options.env ?? process.env;
  const logger = options.logger ?? createServiceLogger("cloud-entry");

  const config = await resolveCloudConfig(options, env);
  const storageWorkerEntryPath =
    options.storageWorkerEntryPath ??
    config.storageWorkerEntryPath ??
    resolveCloudStorageWorkerEntryPath();

  // 1) provider 门控与 driver 契约版本：全部在创建 driver 之前完成（W5 §5/§6）。
  //    生产绑定表由 W3 的工厂按部署秘密产出；声明的 provider 产不出绑定即 fail-closed。
  const readDriverSecret = createDriverSecretReader(env);
  const templates =
    options.templates ??
    createConfiguredSandboxTemplateResolver(config.sandboxTemplateRefs, logger);
  const drivers =
    options.drivers ??
    (await createCloudDriverRegistry({
      providers: config.providers,
      bindings:
        options.driverBindings ??
        resolveProductionDriverBindings(
          resolveDriverDeploymentConfigs(readDriverSecret, config.sandboxMaxLifetimeSeconds),
          logger,
        ),
      readSecret: readDriverSecret,
      allowUnverified: config.allowUnverifiedProviders,
      logger,
    }));

  // 2) host 本体（决议⑧）。失败前的所有校验都已通过，不会留下半启动进程。
  const observer = options.provisioningSourceChanges ?? createProvisioningSourceChangeObserver();
  const hostBody =
    options.hostBody ??
    (await startCloudHostBody({
      dataDir: config.dataDir,
      onProvisioningSourceChanged: (trigger) => observer.notify(trigger),
      ...(options.hostServices ? { hostServices: options.hostServices } : {}),
    }));

  let controlPlane: CloudControlPlane | undefined;
  let server: ServerType | undefined;
  let ownedStorage: CloudStorageReadinessSource | undefined;
  const intervalScheduler = createIntervalLoopScheduler({ logger });
  const loopScheduler = options.loopScheduler ?? intervalScheduler;

  try {
    // 3) 部署秘密（03 §8：host 本体启动之后加载，失败回落 dispose）。
    const secrets = options.secrets ?? (await loadCloudEntrySecrets({ refs: config.secrets, env }));

    // 4) 存储：注入优先，否则由入口打开（入口自持 → 入口负责关闭）。
    //    入口打开的理由：`storageWorkerEntryPath` 由入口按构建形态解析，且执行节点的
    //    git-grant 端点需要客户端上的 `grants` 端；控制面复用同一实例，不二次开库。
    const storageSource =
      options.storage ?? (await openCloudStorage(config, storageWorkerEntryPath));
    ownedStorage = options.storage ? undefined : storageSource;
    await assertStorageReady(storageSource, logger);

    // 5) HTTP 传输先建：同一 app 只能 `createNodeWebSocket` 一次，而控制面装配需要
    //    这个 upgrader 才能开两条 cloud WS 通道（03 §7.1）。
    const app = new Hono();
    app.use(
      "*",
      // 401 = `CLOUD_ERROR_HTTP_STATUS.unauthenticated`（shared 冻结的状态映射）。
      createLiteTokenGuard(secrets.authToken, (c) =>
        c.json(errorEnvelope("unauthenticated", "Unauthorized"), 401),
      ),
    );
    const { upgradeWebSocket, injectWebSocket } = createNodeWebSocket({ app });

    // 6) 控制面装配（含启动恢复扫描）。
    const factory = options.createControlPlane ?? resolveDefaultCloudControlPlaneFactory();
    const hostChannelServices = createCloudHostChannelServices(hostBody.services);
    const hostProvisioningSource =
      options.hostProvisioningSource ?? readCloudHostProvisioningSource(hostBody.services);
    if (options.controlPlane) {
      controlPlane = options.controlPlane;
    } else {
      {
        controlPlane = await buildCloudControlPlane(factory, {
          config,
          secrets,
          host: hostBody,
          hostChannelServices,
          drivers,
          ...(hostProvisioningSource ? { hostProvisioningSource } : {}),
          storage: storageSource,
          loopScheduler,
          provisioningSourceChanges: observer,
          storageWorkerEntryPath,
          templates,
          // hono 的 `UpgradeWebSocket` 与 W1 的结构类型只在 createEvents 返回类型上
          // 不可逆变；两侧都刻意不把 WS 库绑进签名，这里按 W1 的公开约定收敛一次。
          upgradeWebSocket: upgradeWebSocket as unknown as CloudUpgradeWebSocket,
          ...(options.gitHubTokens ? { gitHubTokens: options.gitHubTokens } : {}),
          logger,
        });
      }
    }

    // 6.5) 执行节点 git-grant 端点：兑换必须与签发共用**同一个 broker 实例**（否则撤销会退化成
    //      `token-not-held`），因此等控制面装配完成后再建路由，从控制面取注入的服务（01 §7.2）。
    const gitGrant =
      controlPlane.gitGrants && storageSource?.grants
        ? createCloudGitGrantRoute({
            gitGrants: controlPlane.gitGrants,
            storage: storageSource.storage as CloudGitGrantStorage,
            logger,
            configured: secrets.gitHubApp !== undefined,
          })
        : undefined;

    // 7) 监听认证入口：host `/ws` 与 cloud 路由同源（03 §7.1、03 §8）。
    // 不挂 `/api/server-info`：该 schema 把 `desktopContinuous` 冻结为 literal true，
    // 而云客户端一律 `web-remote-replayable`（04 §2），挂上去等于谎报能力。云模式、
    // provider 能力与协议版本由 `/api/cloud/capabilities` 提供（03 §6）。
    mountCloudHostWebSocket(app, { services: hostChannelServices, upgradeWebSocket });
    // 先挂执行节点端点：它与浏览器面分开鉴权（Bearer，见 rpcChannelServer 的豁免谓词）。
    if (gitGrant) {
      app.get("/api/cloud/runs/:runId/git-grant", (c) => gitGrant.handle(c));
    }
    controlPlane.registerRoutes(app);
    if (config.webDir) {
      mountStaticAssets(app, config.webDir, logger);
    }

    const listenPort = options.listenPort ?? config.listenPort;
    const listenHost = options.listenHost ?? config.listenHost;
    const listening = await listenCloudApp(app, listenPort, listenHost);
    server = listening.server;
    injectWebSocket(listening.server);
    logger.info(undefined, "[cloud-entry] listening", {
      origin: config.publicOrigin,
      port: listening.port,
    });

    // 8) 后台循环：先生命周期（保活/对账事实刷新），再投递出站。
    controlPlane.loops.lifecycle.start();
    controlPlane.loops.delivery.start();

    const boundPort = listening.port;
    let closed = false;
    return {
      port: boundPort,
      config,
      principalId: controlPlane.principalId,
      controlPlane,
      loops: controlPlane.loops,
      hostBody,
      async close() {
        if (closed) {
          return;
        }
        closed = true;
        const active = controlPlane;
        try {
          // 关闭顺序（W5 §6）：delivery → lifecycle → server → cloud → host 本体。
          await active?.loops.delivery.stop();
          await active?.loops.lifecycle.stop();
          await intervalScheduler.stopAll();
          if (server) {
            await closeServerWithConnections(server);
          }
          await active?.close();
        } finally {
          // 只有入口打开的存储才由入口关闭（注入方持有生命周期）。
          await ownedStorage?.close?.().catch((closeError: unknown) => {
            logger.warn(undefined, "[cloud-entry] storage close 报错", closeError);
          });
          await hostBody.dispose();
        }
      },
    };
  } catch (error) {
    await intervalScheduler.stopAll();
    if (server) {
      await closeServerWithConnections(server);
    }
    await controlPlane?.close().catch((closeError: unknown) => {
      logger.warn(undefined, "[cloud-entry] 启动失败回落时 cloud close 报错", closeError);
    });
    await ownedStorage?.close?.().catch(() => undefined);
    await hostBody.dispose();
    throw error;
  }
}

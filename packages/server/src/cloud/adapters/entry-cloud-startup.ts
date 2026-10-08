/**
 * 云入口启动期装配（specs/cloud-agent/03 §8、W5 §3/§4）。
 *
 * 只做「把部署配置变成可用的启动决策」：配置解析、存储就绪门槛、控制面工厂解析、
 * storage worker 入口路径解析，以及入口与 W1 之间的冻结类型。HTTP 路由组装与进程
 * 生命周期在 `entry-cloud-server.ts`（对外符号原样从那里 re-export）。
 */
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServiceLogger, type ProviderProvisioningSource } from "@zcode/services/node";
import type { ServiceCollection } from "@zcode/services";
import type { Hono } from "hono";
import type { StoragePort, StorageReadiness } from "../app/ports/storagePort.js";
import type { OperationOutboxPort } from "../app/ports/operationOutboxPort.js";
import type { SandboxDriverRegistryPort } from "../app/ports/sandboxDriverRegistryPort.js";
import type { SandboxRuntimeSettingsPort } from "../app/ports/sandboxRuntimeSettingsPort.js";
import type { SandboxTemplateResolverPort } from "../app/ports/sandboxDriverPort.js";
import type { CloudGitGrantService } from "../app/gitGrants.js";
import type { GitGrantStore } from "../app/ports/gitGrantPort.js";
import { createCloudStorage, type CloudStorage } from "./storage/cloudStorageClient.js";
import type { LoopSchedulerPort } from "../app/ports/loopSchedulerPort.js";
import {
  CloudEntryStartupError,
  configIssuesToStartupError,
  readCloudEntryConfig,
  type CloudEntryConfig,
} from "./entry-cloud-config.js";
import type { CloudDeploymentSecrets } from "./entry-cloud-secrets.js";
import type { CloudHostBody } from "./entry-cloud-host-body.js";
import type { ProvisioningSourceChangeObserver } from "./entry-cloud-host-ws.js";
import type { GitHubTokenService } from "./github/tokens.js";
import {
  assembleCloudControlPlane,
  CloudControlPlaneAssemblyError,
  type CloudUpgradeWebSocket,
} from "../contract.js";

export type CloudEntryLogger = ReturnType<typeof createServiceLogger>;

/** W2 客户端的启动门返回值（`createCloudStorage.assertReady`）。 */
type StoredStorageReadiness = Awaited<ReturnType<CloudStorage["assertReady"]>>;

/** 存储就绪门（03 §8）：`StoragePort` 结构上满足本接口。 */
export interface CloudStorageReadinessSource {
  readiness(): Promise<StorageReadiness>;
  /**
   * 注入 W2 客户端时一并透传：控制面复用同一实例（不二次开库），关闭由注入方负责
   * （03 §4：控制面不替调用方关闭它没打开的库）。
   */
  readonly storage?: StoragePort;
  readonly operations?: OperationOutboxPort;
  /**
   * git grant 持久端（W2 客户端上与本端口同源）。入口自持存储时从这里取，
   * 用于装配执行节点的 `/api/cloud/runs/:runId/git-grant`。
   */
  readonly grants?: GitGrantStore;
  /** W2 客户端的启动门（迁移/可写性/磁盘/锁）；注入裸 `StoragePort` 时不存在。 */
  assertReady?(): Promise<StoredStorageReadiness>;
  /** 只有**打开方**负责关闭：注入方持有生命周期时入口不调它。 */
  close?(): Promise<void>;
}

export interface CloudBackgroundLoop {
  readonly name: string;
  /** 监听成功后启动；幂等。 */
  start(): void;
  /** 停止并等待在飞的一拍收尾；重复调用无副作用。 */
  stop(): Promise<void>;
}

/** 控制面装配结果（W1 §4）。入口只按端口调用，不内联任何 Task/Run 业务规则。 */
export interface CloudControlPlane {
  readonly principalId: string;
  /**
   * W1 的 git grant 服务（01 §7.2）：签发在控制面、兑换在 HTTP 层，**必须共用同一实例**
   * （broker 的内存 heldTokens 负责撤销）；未装配时执行节点 git-grant 端点不挂载。
   */
  readonly gitGrants?: CloudGitGrantService;
  /** 注册 `/api/cloud/*`、`/ws/cloud/tasks/:taskId`、`/ws/cloud/bridge/:runId`。 */
  registerRoutes(app: Hono): void;
  readonly loops: {
    /** durable outbox 投递（03 §6.2）：先停，保证关停期间不再产生新的出站投递。 */
    readonly delivery: CloudBackgroundLoop;
    /** 保活/对账/reconciler（03 §8）：后停。 */
    readonly lifecycle: CloudBackgroundLoop;
  };
  close(): Promise<void>;
}

export interface CloudControlPlaneContext {
  readonly config: CloudEntryConfig;
  readonly secrets: CloudDeploymentSecrets;
  readonly host: CloudHostBody;
  /** 裁剪后的 host 暴露面（账号域），注册路由需要时可用；执行域不在其中。 */
  readonly hostChannelServices: ServiceCollection;
  readonly drivers: SandboxDriverRegistryPort;
  /**
   * 沙箱运行时账号设置端口（01 §4.3/§5.1 修订 2026-10-08）：capabilities 投影
   * `apiKeyConfigured` 与 env 核实上限的来源；host 本体启动后由入口接上服务图。
   */
  readonly sandboxRuntimeSettings?: SandboxRuntimeSettingsPort;
  /**
   * 沙箱模板解析（01 §5.1）：镜像引用的唯一部署侧来源；未配置的 provider 返回 null，
   * 由接纳事务按 `unsupported_template` 明确失败，不在 create 期读新默认值。
   */
  readonly templates: SandboxTemplateResolverPort;
  /** host 的 provisioning source（12 §6）：envelope 的账号态来源，控制面只读。 */
  readonly hostProvisioningSource?: ProviderProvisioningSource;
  readonly storage?: CloudStorageReadinessSource;
  readonly loopScheduler: LoopSchedulerPort;
  /** 12 §6 A-08 代际事件源：控制面订阅后做「标记 + 下次 bridge 连接重装」。 */
  readonly provisioningSourceChanges: ProvisioningSourceChangeObserver;
  /**
   * storage worker 入口绝对路径（W2 `createCloudStorage({ workerEntryPath })`）。
   * 由入口按构建形态解析，不靠 cwd 猜；打包部署的输出名与默认解析一致（`storageWorkerMain`）。
   */
  readonly storageWorkerEntryPath: string;
  /**
   * 入口已创建的 WebSocket upgrader：同一 Hono app 只能 `createNodeWebSocket` 一次，
   * 控制面用它开 `/ws/cloud/bridge/:runId` 与 `/ws/cloud/tasks/:taskId`（03 §7.1）。
   * 缺省时控制面按 501 结构化拒绝，不静默降级；入口生产路径始终注入。
   */
  readonly upgradeWebSocket: CloudUpgradeWebSocket;
  /**
   * GitHub token 服务覆盖点：缺省由 `secrets.gitHubApp` 构造 W4 adapter。控制面装配是
   * git grant 的唯一装配点（签发与兑换共用同一 broker 实例，01 §7.2），因此测试/嵌入方
   * 注入的 fake 必须从这里进控制面，而不是在入口另建第二个 broker。
   */
  readonly gitHubTokens?: GitHubTokenService;
  readonly logger: CloudEntryLogger;
}

export type CloudControlPlaneFactory = (
  context: CloudControlPlaneContext,
) => Promise<CloudControlPlane>;

/**
 * storage worker 入口解析：源码形态（`.ts`，tsx 运行）走同目录源码，构建产物（`.js`）
 * 走 bundle 同目录的 `storageWorkerMain.js`（tsup 入口名与之一致）。两者都由入口显式
 * 计算并传给控制面，不依赖 cwd（W2 `storageWorkerEntryPath` 覆盖点）。
 */
export function resolveCloudStorageWorkerEntryPath(moduleUrl: string = import.meta.url): string {
  const current = fileURLToPath(moduleUrl);
  // 源码形态：与本文件同级的 `storage/` 子目录（`cloud/adapters/storage/`）；
  // 构建产物：tsup 把入口输出为 bundle 同目录的 `storageWorkerMain.js`。
  return extname(current) === ".ts"
    ? fileURLToPath(new URL("./storage/storageWorkerMain.ts", moduleUrl))
    : join(dirname(current), "storageWorkerMain.js");
}

/** 生产默认：模块公开入口（`contract.ts`）的 `assembleCloudControlPlane`。 */
export function resolveDefaultCloudControlPlaneFactory(): CloudControlPlaneFactory {
  return assembleCloudControlPlane;
}

// ── 启动 ──

export async function assertStorageReady(
  storage: CloudStorageReadinessSource,
  logger: CloudEntryLogger,
): Promise<void> {
  if (storage.assertReady) {
    // W2 客户端的启动门含迁移/可写性/磁盘/锁四项（03 §4）；有它就先用它，别只查 readiness。
    try {
      await storage.assertReady();
    } catch (error) {
      throw new CloudEntryStartupError(
        "not_configured",
        `cloud 存储未就绪（迁移/可写性/容量）: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const readiness = await storage.readiness();
  const ready =
    readiness.writable &&
    readiness.attachmentsWritable &&
    readiness.lastAppliedMigrationId !== null;
  if (!ready) {
    // migration 未就绪不得服务，也不得开始任何 provider 操作（03 §8）。
    throw new CloudEntryStartupError("not_configured", "cloud 存储未就绪（迁移/可写性）", {
      lastAppliedMigrationId: readiness.lastAppliedMigrationId,
      schemaVersion: readiness.schemaVersion,
      writable: readiness.writable,
      attachmentsWritable: readiness.attachmentsWritable,
    });
  }
  logger.info(undefined, "[cloud-entry] storage ready", {
    lastAppliedMigrationId: readiness.lastAppliedMigrationId,
    schemaVersion: readiness.schemaVersion,
  });
}

// ── 启动期解析 ──

/**
 * 打开云存储客户端（入口自持时的唯一打开点）。
 *
 * 为什么由入口打开：`storageWorkerEntryPath` 由入口按构建形态解析，且执行节点端点
 * （git-grant）需要客户端上的 `grants` 端；控制面随后**复用同一实例**（03 §4：不二次开库）。
 * 关闭责任在打开方：入口在关闭链里关它，注入方提供时入口不碰。
 */
export async function openCloudStorage(
  config: CloudEntryConfig,
  storageWorkerEntryPath: string,
): Promise<CloudStorageReadinessSource> {
  const client = await createCloudStorage({
    dataDir: config.dataDir,
    attachmentsDir: join(config.dataDir, "attachments"),
    workerEntryPath: storageWorkerEntryPath,
  });
  return {
    storage: client.storage,
    operations: client.operations,
    grants: client.grants,
    readiness: () => client.readiness(),
    assertReady: () => client.assertReady(),
    close: () => client.close(),
  };
}

/** 配置：注入优先，否则由 env 读出；local 模式不提供回退（W5 §5、04 §2）。 */
export async function resolveCloudConfig(
  options: { readonly config?: CloudEntryConfig },
  env: Record<string, string | undefined>,
): Promise<CloudEntryConfig> {
  if (options.config) {
    return options.config;
  }
  const result = await readCloudEntryConfig(env);
  if (!result.ok) {
    throw configIssuesToStartupError(result.issues);
  }
  if (result.config.mode !== "cloud") {
    throw new CloudEntryStartupError(
      "not_configured",
      "cloud 入口要求显式 ZCODE_SERVER_MODE=cloud；local 请使用本地入口",
    );
  }
  return result.config;
}

/** 调控制面工厂并把 W1 的装配错误归一为入口错误契约（进程入口只认一种错误类型）。 */
export async function buildCloudControlPlane(
  factory: CloudControlPlaneFactory,
  context: CloudControlPlaneContext,
): Promise<CloudControlPlane> {
  try {
    return await factory(context);
  } catch (error) {
    if (error instanceof CloudControlPlaneAssemblyError) {
      throw new CloudEntryStartupError(error.code, error.message);
    }
    throw error;
  }
}

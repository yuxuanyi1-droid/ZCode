/**
 * 入口级控制面装配（W5 冻结的 `CloudControlPlaneFactory` 面；03 §2/§8 启动顺序）。
 *
 * 与 `app/assembleCloudControlPlane.ts`（只依赖端口的 app 服务图）的分工：
 * - app 版是**内部实现**（测试与 W1 用例直接消费）；
 * - 本文件把入口 context 映射成 deps：真实 `clock`/`hash`/`idGenerator` 默认值、
 *   由 W2 `createCloudStorage({workerEntryPath})` 自持存储（未注入时）、bridge 通道、
 *   GitHub（部署秘密存在时用 W4 adapter，否则 fail-closed stub）、后台循环句柄与 close 顺序。
 *
 * 硬性约束（W5 契约）：
 * - `storageWorkerEntryPath` 原样透传给 `createCloudStorage`（打包后 worker 是独立产物）；
 * - 自持 StoragePort 时**返回前**完成 `readiness()` 门槛（迁移未就绪不得服务）；
 * - **不自建定时器**：一律用 context 的 `loopScheduler`；
 * - envelope 来源只用 context 的 `hostProvisioningSource`（12 §6），不另建第二来源。
 *
 * 类型说明：本文件不 import W5 的 `entry-cloud-server.ts`，而是声明结构兼容的入参/出参，
 * 避免 `contract.ts → adapters/entry-cloud-server.ts → contract.ts` 的循环依赖。
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Hono } from "hono";
import type { GitHubPort } from "../app/ports/gitHubPort.js";
import type { AttachmentRegistry } from "../app/attachments/registry.js";
import type { LoopSchedulerPort } from "../app/ports/loopSchedulerPort.js";
import type { OperationOutboxPort } from "../app/ports/operationOutboxPort.js";
import type { SandboxDriverRegistryPort } from "../app/ports/sandboxDriverRegistryPort.js";
import type { StoragePort, StorageReadiness } from "../app/ports/storagePort.js";
import type { ArtifactRead, ExecutionProjectionRead } from "../app/ports/projectionPort.js";
import type { InteractionDecisionRepo } from "../app/ports/inputPort.js";
import type { ProvisioningEnvelopeSource } from "../app/ports/provisioningEnvelopePort.js";
import type { SandboxTemplateResolverPort } from "../app/ports/sandboxDriverPort.js";
import {
  assembleCloudControlPlane as assembleCloudCoreControlPlane,
  type CloudControlPlane as CloudCoreControlPlane,
} from "../app/assembleCloudControlPlane.js";
import { createAttachmentRegistry } from "../app/attachments/registry.js";
import { resolveCloudCoreConfig, type CloudCoreConfig } from "../app/config.js";
import {
  createDeliveryLoop,
  createLifecycleLoop,
  type CloudBackgroundLoop,
} from "../app/lifecycleLoops.js";
import { cloudCoreLogger } from "../app/logger.js";
import { createCloudBridgeChannel, type CloudCommandTransport } from "./ws/bridgeChannel.js";
import {
  registerCloudRoutes,
  type CloudBranchCatalogSource,
  type CloudHttpRouteDeps,
  type CloudRepositoryCatalogSource,
  type CloudUpgradeWebSocket,
} from "./http/registerCloudRoutes.js";
import { createCloudStorage } from "./storage/cloudStorageClient.js";
import { createGitHubAdapter } from "./github/adapter.js";
import { assembleGitGrantBroker } from "./gitGrantAssembly.js";
import { CloudControlPlaneAssemblyError } from "./controlPlaneAssemblyError.js";
import type { CloudGitGrantService } from "../app/gitGrants.js";
import type { GitHubTokenService } from "./github/tokens.js";

/** 原样转出（定义已移到独立模块）：沿用本模块的既有导入路径，避免调用方被迫改 import。 */
export { CloudControlPlaneAssemblyError } from "./controlPlaneAssemblyError.js";
import type { CloudDeploymentSecrets } from "./entry-cloud-secrets.js";
import type { GitGrantStore } from "../app/ports/gitGrantPort.js";

/** 入参：W5 `CloudControlPlaneContext` 的结构子集（不 import 其类型，避免成环）。 */
export interface CloudControlPlaneContext {
  readonly config: {
    readonly dataDir: string;
    readonly maxConcurrentRuns: number;
    readonly publicOrigin: string;
    readonly storageWorkerEntryPath?: string;
  };
  readonly secrets: CloudDeploymentSecrets;
  readonly drivers: SandboxDriverRegistryPort;
  /** worker 入口绝对路径（W2 `createCloudStorage({workerEntryPath})`）。 */
  readonly storageWorkerEntryPath: string;
  /** 定时器：入口创建并注入；控制面不得自建。 */
  readonly loopScheduler: LoopSchedulerPort;
  /** 12 §6 envelope 来源（账号态）；控制面只读。 */
  readonly hostProvisioningSource?: { read(syncId: string): Promise<unknown> };
  /** A-08 代际事件源（`generation` 即下发帧的 credentialGeneration）。 */
  readonly provisioningSourceChanges?: { readonly generation: number };
  /** 已就绪判定的存储入口（W5 注入时不再自持）。 */
  readonly storage?: CloudStorageReadinessSource;
  readonly logger?: unknown;
  /** W1 追加注入缝（可选）：GitHub 端口、模板解析、交互决定、执行/产物投影、命令转接。 */
  readonly github?: GitHubPort;
  /** 仓库目录（W4 `GitHubRepositoryCatalog` 的结构子集）：`repositories` 端点用。 */
  readonly githubCatalog?: CloudRepositoryCatalogSource;
  /** 分支枚举（W4 `listBranches`，见 support.ts 的契约缺口注释）：未注入即 `not_implemented`。 */
  readonly githubBranchCatalog?: CloudBranchCatalogSource;
  readonly templates?: SandboxTemplateResolverPort;
  readonly interactionDecisions?: InteractionDecisionRepo;
  readonly executionProjections?: ExecutionProjectionRead;
  readonly artifacts?: ArtifactRead;
  readonly commandTransport?: CloudCommandTransport;
  /** 入口已创建的 `upgradeWebSocket`（同一 app 只能建一次）→ 开启两条 cloud WS 通道。 */
  readonly upgradeWebSocket?: CloudUpgradeWebSocket;
  /** 附件目录覆盖（缺省 `<dataDir>/attachments`）。 */
  readonly attachmentsDir?: string;
  /** 控制面核心配置覆盖（08 §6/§7 默认值的部署级调整）。 */
  readonly coreConfig?: Partial<CloudCoreConfig>;
  /**
   * GitHub token 服务覆盖点（测试/嵌入方注入 fake）：git grant 的装配点只有控制面一处
   * （签发与兑换共用 broker），因此 fake 必须从这里进，而不是在入口另建 broker。
   */
  readonly gitHubTokens?: GitHubTokenService;
}

/** W5 冻结的存储就绪门（结构兼容）。 */
export interface CloudStorageReadinessSource {
  readiness(): Promise<StorageReadiness>;
}

/** 注入的存储可能是 W2 客户端（同时带 storage/operations/close）或裸 StoragePort。 */
export interface CloudEntryStorageSource extends CloudStorageReadinessSource {
  readonly storage?: StoragePort;
  readonly operations?: OperationOutboxPort;
  /** W2 客户端的 git grant store（01 §7.2）：签发幂等查询与兑换都经它。 */
  readonly grants?: GitGrantStore;
  close?(): Promise<void>;
}

/** W5 冻结的装配结果形状（`principalId` + registerRoutes + loops + close）。 */
export interface CloudControlPlane {
  readonly principalId: string;
  /**
   * 签发与兑换共用的 git grant 服务（01 §7.2）：入口把**同一个实例**接到执行节点的
   * `/api/cloud/runs/:runId/git-grant`；未装配（无 store）时端点不挂载。
   */
  readonly gitGrants: CloudGitGrantService;
  registerRoutes(app: Hono): void;
  readonly loops: {
    readonly delivery: CloudBackgroundLoop;
    readonly lifecycle: CloudBackgroundLoop;
  };
  close(): Promise<void>;
}

export async function assembleCloudControlPlane(
  context: CloudControlPlaneContext,
): Promise<CloudControlPlane> {
  const config = resolveCloudCoreConfig({
    maxConcurrentRuns: context.config.maxConcurrentRuns,
    publicControlPlaneUrl: context.config.publicOrigin,
    ...context.coreConfig,
  });
  const clock = { now: () => Date.now() };
  const ids = { newId: () => randomUUID(), newSecret: () => randomBytes(32).toString("base64url") };
  const hash = {
    sha256Hex: async (value: string) => createHash("sha256").update(value).digest("hex"),
  };

  // 1) 存储：注入优先，否则由 W2 客户端自持（worker 入口路径显式透传）。
  const storage = await resolveStorage(context);
  const readiness = await storage.storage.readiness();
  if (!readiness.writable || readiness.lastAppliedMigrationId === null) {
    await storage.close?.();
    throw new CloudControlPlaneAssemblyError(
      "not_configured",
      `cloud storage not ready (writable=${readiness.writable}, migration=${readiness.lastAppliedMigrationId ?? "none"})`,
    );
  }

  // 2) bridge 通道先建：它为 app 提供 `AttachmentPort` 与命令事实查询端口。
  const registry: AttachmentRegistry = createAttachmentRegistry();
  let planeRef: CloudCoreControlPlane | undefined;
  const bridge = createCloudBridgeChannel({
    services: () => {
      if (!planeRef) throw new Error("cloud control plane accessed before assembly completed");
      return planeRef;
    },
    registry,
    storage: storage.storage,
    clock,
    hash,
    ids,
    ...(context.commandTransport ? { commandTransport: context.commandTransport } : {}),
  });

  const github = resolveGitHubPort(context);
  const envelopeSource = createEnvelopeSource(context);
  // git grant（01 §7.2）：签发（app 层）与兑换（入口端点）共用**同一个 broker 实例**，
  // 保证撤销看到的 heldTokens 是同一份；装配细节在 `gitGrantAssembly.ts`。
  const gitGrantStore = storage.grants;
  const gitGrantBroker = assembleGitGrantBroker({
    ...(gitGrantStore ? { store: gitGrantStore } : {}),
    secrets: context.secrets,
    ...(context.gitHubTokens ? { injectedTokens: context.gitHubTokens } : {}),
    now: () => clock.now(),
  });
  const plane = assembleCloudCoreControlPlane(
    {
      storage: storage.storage,
      operations: storage.operations,
      github: github.port,
      drivers: context.drivers,
      attachments: bridge.port,
      runtimeCommands: bridge.runtimeCommands,
      clock,
      ids,
      hash,
      config,
      ...(context.templates ? { templates: context.templates } : {}),
      ...(context.interactionDecisions
        ? { interactionDecisions: context.interactionDecisions }
        : {}),
      ...(context.executionProjections
        ? { executionProjections: context.executionProjections }
        : {}),
      ...(context.artifacts ? { artifacts: context.artifacts } : {}),
      ...(envelopeSource ? { provisioningEnvelope: envelopeSource } : {}),
      ...(gitGrantStore ? { gitGrantStore } : {}),
      ...(gitGrantBroker ? { gitGrantBroker } : {}),
    },
    { registry },
  );
  planeRef = plane;

  // 3) 启动恢复扫描（03 §8：恢复操作/租期核验先于监听认证入口）。
  await plane.reconciler.reconcileOnStartup();

  const delivery = createDeliveryLoop(plane, { scheduler: context.loopScheduler });
  const lifecycle = createLifecycleLoop(plane, { scheduler: context.loopScheduler });

  return {
    principalId: context.secrets.principalId,
    // 签发（app 层）与兑换（执行节点 HTTP 层）必须是同一实例：暴露给入口的是 app 装配出的
    // 那一个 `CloudGitGrantService`，入口不得另建 broker（否则撤销退化成 token-not-held）。
    gitGrants: plane.gitGrants,
    registerRoutes(app: Hono) {
      const routeDeps: CloudHttpRouteDeps = {
        plane,
        router: plane.router,
        bridge,
        principalId: context.secrets.principalId,
        githubConfigured: github.configured,
        ...(github.catalog ? { repositoryCatalog: github.catalog } : {}),
        ...((context.githubBranchCatalog ?? github.branchCatalog)
          ? { branchCatalog: context.githubBranchCatalog ?? github.branchCatalog }
          : {}),
      };
      registerCloudRoutes(
        app,
        routeDeps,
        context.upgradeWebSocket ? { upgradeWebSocket: context.upgradeWebSocket } : {},
      );
    },
    loops: { delivery, lifecycle },
    async close() {
      // 关闭顺序：先停出站投递，再停生命周期，最后关连接与存储（W5 沿用同一顺序）。
      await delivery.stop();
      await lifecycle.stop();
      await bridge.close();
      await storage.close?.();
    },
  };
}

async function resolveStorage(context: CloudControlPlaneContext): Promise<{
  storage: StoragePort;
  operations: OperationOutboxPort;
  grants?: GitGrantStore;
  close?: () => Promise<void>;
}> {
  const injected = context.storage as CloudEntryStorageSource | undefined;
  if (injected?.storage && injected.operations) {
    // 注入方持有存储生命周期：控制面只复用，不在 close() 里替它关闭（避免双重关闭）。
    return {
      storage: injected.storage,
      operations: injected.operations,
      ...(injected.grants ? { grants: injected.grants } : {}),
    };
  }
  // 自持：worker 入口路径由入口显式给出（打包后是独立产物）。
  const client = await createCloudStorage({
    dataDir: context.config.dataDir,
    attachmentsDir: context.attachmentsDir ?? join(context.config.dataDir, "attachments"),
    workerEntryPath: context.storageWorkerEntryPath,
  });
  await client.assertReady();
  return {
    storage: client.storage,
    operations: client.operations,
    grants: client.grants,
    close: () => client.close(),
  };
}

function resolveGitHubPort(context: CloudControlPlaneContext): {
  port: GitHubPort;
  configured: boolean;
  catalog?: CloudRepositoryCatalogSource;
  branchCatalog?: CloudBranchCatalogSource;
} {
  if (context.github) {
    // 注入端口时也允许单独注入目录/分支来源（测试与自定义装配）。
    return {
      port: context.github,
      configured: true,
      ...(context.githubCatalog ? { catalog: context.githubCatalog } : {}),
      ...(context.githubBranchCatalog ? { branchCatalog: context.githubBranchCatalog } : {}),
    };
  }
  const app = context.secrets.gitHubApp;
  if (!app) return { port: failClosedGitHubPort(), configured: false };
  const appId = Number.parseInt(app.appId, 10);
  if (!Number.isFinite(appId) || appId <= 0) {
    throw new CloudControlPlaneAssemblyError("not_configured", "github app id invalid");
  }
  const adapter = createGitHubAdapter({
    config: {
      principalId: context.secrets.principalId,
      appId,
      privateKeyPem: app.privateKeyPem,
      allowedInstallationIds: app.allowedInstallationIds,
    },
  });
  // W4 适配器：catalog 提供 installation allowlist 列举/分页/stale 降级与 allowlist 校验；
  // branches.listBranches 提供分支枚举（游标只随 `Link: rel="next"` 出现，末页不造游标）。
  return {
    port: adapter.port,
    configured: true,
    catalog: adapter.catalog,
    branchCatalog: adapter.branches,
  };
}

/**
 * 未配置 GitHub App 时的 fail-closed 端口：所有读取返回空、所有副作用拒绝。
 * 不伪造仓库、不在没有授权来源时创建 Project（11 §4.3）。
 */
function failClosedGitHubPort(): GitHubPort {
  const denied = async (): Promise<never> => {
    throw new CloudControlPlaneAssemblyError("not_configured", "github app not configured");
  };
  return {
    async listRepositories() {
      return { items: [] };
    },
    async getRepository() {
      return null;
    },
    async getBranchHead() {
      return null;
    },
    mintToken: denied,
    async getPullRequest() {
      return null;
    },
    publishDraftPullRequest: denied,
    enqueueEffect: denied,
  };
}

/** envelope 唯一来源：host 的 provisioning source（12 §6）；未接线即不提供端口。 */
function createEnvelopeSource(
  context: CloudControlPlaneContext,
): ProvisioningEnvelopeSource | undefined {
  const source = context.hostProvisioningSource;
  if (!source) return undefined;
  return {
    async buildProvisioningEnvelopeJsonForRun({ runId, runGeneration }) {
      // syncId 绑定 run+generation：执行节点据此核对代际（12 §6 A-08）。
      const syncId = `${runId}:${runGeneration}`;
      let envelope: unknown;
      try {
        envelope = await source.read(syncId);
      } catch (error) {
        cloudCoreLogger.warn(undefined, "cloud provisioning envelope read failed", {
          runId,
          error: error instanceof Error ? error.message : "unknown",
        });
        return null;
      }
      if (envelope === undefined || envelope === null) return null;
      return {
        envelopeJson: JSON.stringify(envelope),
        credentialGeneration: context.provisioningSourceChanges?.generation ?? 0,
      };
    },
  };
}

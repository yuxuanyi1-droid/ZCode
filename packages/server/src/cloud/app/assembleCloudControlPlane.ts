/**
 * 控制面 app 装配（W1 §4 对 W5 的入口：`assembleCloudControlPlane()`）。
 *
 * 只装配 app 层服务与端口依赖：没有 SQLite、没有 provider SDK、没有 Hono、没有 WS 路由
 * （那些是 W2–W5 的 adapters）。入口层拿到本对象后：
 * - HTTP/WS 路由（W5）调用各用例方法；
 * - bridge 入站帧（W6 经 W5 路由）走 `attachments`/`ingest`/`runs` 的公开方法；
 * - 后台循环由 `startCloudLifecycleLoops(plane, …)` 驱动。
 *
 * 依赖方向恒为 adapters → app → domain（03 §2 分层），装配顺序即依赖顺序，无环。
 */
import { resolveCloudCoreConfig, type CloudCoreConfig } from "./config.js";
import type { CloudCoreDeps } from "./deps.js";
import type { SandboxDriverCapabilities } from "./ports/sandboxDriverPort.js";
import type { SandboxRuntimeSettingsPort } from "./ports/sandboxRuntimeSettingsPort.js";
import { createAttachmentRegistry, type AttachmentRegistry } from "./attachments/registry.js";
import { createCloudCommandRouter, type CloudCommandRouter } from "./attachments/router.js";
import { createHeartbeatWatchdog, type HeartbeatWatchdog } from "./attachments/watchdog.js";
import {
  createInputDeliveryControl,
  type InputDeliveryControl,
} from "./inputDelivery/deliveryControl.js";
import { createInputDispatcher, type InputDispatcher } from "./inputDelivery/dispatcher.js";
import { createInputGateway, type InputGateway } from "./inputDelivery/gateway.js";
import { createInteractionCommands, type InteractionCommands } from "./commands/interactions.js";
import { createReopenOperations, type ReopenOperations } from "./commands/reopenOperations.js";
import { createStopOperations, type StopOperations } from "./commands/stopOperations.js";
import {
  createTaskLifecycleCommands,
  type TaskLifecycleCommands,
} from "./commands/taskLifecycle.js";
import {
  createRunAuthorizationPolicy,
  type RunAuthorizationPolicy,
} from "./credentialAuthorization/authorization.js";
import { createCheckpointPipeline, type CheckpointPipeline } from "./lifecycle/checkpoints.js";
import { createDrainLoop, type DrainLoop } from "./lifecycle/drain.js";
import { createKeepaliveLoop, type KeepaliveLoop } from "./lifecycle/keepalive.js";
import { createPauseResumeControl, type PauseResumeControl } from "./lifecycle/pauseResume.js";
import {
  createProjectionHistoryService,
  type ProjectionHistoryService,
} from "./projections/history.js";
import {
  createProjectionIngestService,
  type ProjectionIngestService,
} from "./projections/ingest.js";
import {
  createCreateOperationRunner,
  type CreateOperationRunner,
} from "./provisioning/createOperation.js";
import {
  createBootstrapConfigSender,
  type BootstrapConfigSender,
} from "./provisioning/bootstrapConfig.js";
import { createRunCompensation, type RunCompensation } from "./provisioning/compensation.js";
import { createReadinessWatchdog, type ReadinessWatchdog } from "./provisioning/readiness.js";
import { createStartupReconciler, type StartupReconciler } from "./reconciler/startup.js";
import { createRunOrchestrator, type RunOrchestrator } from "./runOrchestrator.js";
import { createCloudGitGrantService, type CloudGitGrantService } from "./gitGrants.js";
import { createTaskDetailService, type TaskDetailService } from "./taskDetail.js";
import { createTaskService, type TaskService } from "./taskService.js";

/** `capabilitiesResponseSchema.providers` 的元素形状（shared 的 provider 能力声明）。 */
export interface CloudProviderCapability extends SandboxDriverCapabilities {
  provider: string;
  /** 生效 key 是否已配置（credential ?? env）；布尔投影，不含值与来源细节。 */
  apiKeyConfigured: boolean;
}

export interface CloudControlPlane {
  config: CloudCoreConfig;
  /**
   * provider 能力清单（03 §6 capabilities 端点；只列已配置且实际解禁项）。
   * 2026-10-08 修订：每条附 `apiKeyConfigured`（生效 key = credential ?? env 是否已
   * 配置，布尔投影不含值）；`maxLifetimeSeconds` 维持 env 核实上限语义（硬上界）。
   */
  providers(): Promise<CloudProviderCapability[]>;
  tasks: TaskService;
  taskDetail: TaskDetailService;
  /** git grant 签发/兑换（01 §7.2）：入口的 git-grant 端点与 create/drain 路径共用同一实例。 */
  gitGrants: CloudGitGrantService;
  inputs: InputGateway;
  delivery: InputDispatcher;
  inputControl: InputDeliveryControl;
  attachments: AttachmentRegistry;
  router: CloudCommandRouter;
  watchdog: HeartbeatWatchdog;
  runs: RunOrchestrator;
  provisioning: {
    create: CreateOperationRunner;
    readiness: ReadinessWatchdog;
    compensation: RunCompensation;
    /** welcome 之后、ready 之前的配置下发（02 §5.3、12 §6）。 */
    bootstrapConfig: BootstrapConfigSender;
  };
  lifecycle: {
    keepalive: KeepaliveLoop;
    drain: DrainLoop;
    checkpoints: CheckpointPipeline;
    /** paused 通路（2026-10-09 生命周期 v2）：自驱 resume、暂停中停止推进、pause 助手。 */
    pauseResume: PauseResumeControl;
  };
  commands: {
    taskLifecycle: TaskLifecycleCommands;
    interactions: InteractionCommands;
    reopen: ReopenOperations;
    stop: StopOperations;
  };
  projections: {
    ingest: ProjectionIngestService;
    history: ProjectionHistoryService;
  };
  reconciler: StartupReconciler;
  credentials: RunAuthorizationPolicy;
}

export function assembleCloudControlPlane(
  input: Omit<CloudCoreDeps, "config"> & {
    config?: Partial<CloudCoreConfig>;
  },
  options: {
    /**
     * 复用的 attachment 注册表：入口装配把 bridge 通道的注册表传进来，保证「连接与投递
     * 事实」只有一份（否则 ready 门控与 bootstrap 下发会各自看到不同的空表）。
     */
    registry?: AttachmentRegistry;
  } = {},
): CloudControlPlane {
  const deps: CloudCoreDeps = {
    storage: input.storage,
    operations: input.operations,
    github: input.github,
    drivers: input.drivers,
    ...(input.sandboxRuntimeSettings
      ? { sandboxRuntimeSettings: input.sandboxRuntimeSettings }
      : {}),
    attachments: input.attachments,
    ...(input.browserWatch ? { browserWatch: input.browserWatch } : {}),
    runtimeCommands: input.runtimeCommands,
    clock: input.clock,
    ids: input.ids,
    hash: input.hash,
    config: resolveCloudCoreConfig(input.config),
    // 可选注入缝按原样透传：未接线时各消费点按自己的结构化降级处理（见 deps.ts 注释）。
    ...(input.templates ? { templates: input.templates } : {}),
    ...(input.interactionDecisions ? { interactionDecisions: input.interactionDecisions } : {}),
    ...(input.executionProjections ? { executionProjections: input.executionProjections } : {}),
    ...(input.artifacts ? { artifacts: input.artifacts } : {}),
    ...(input.provisioningEnvelope ? { provisioningEnvelope: input.provisioningEnvelope } : {}),
    ...(input.gitGrantStore ? { gitGrantStore: input.gitGrantStore } : {}),
    ...(input.gitGrantBroker ? { gitGrantBroker: input.gitGrantBroker } : {}),
  };

  const registry = options.registry ?? createAttachmentRegistry();
  const taskService = createTaskService(deps);
  const gitGrants = createCloudGitGrantService(deps);
  const taskDetail = createTaskDetailService(deps);
  const gateway = createInputGateway(deps);
  const dispatcher = createInputDispatcher(deps, registry);
  const inputControl = createInputDeliveryControl(deps, registry);
  const runs = createRunOrchestrator(deps, registry);
  const compensation = createRunCompensation(deps, runs);
  const create = createCreateOperationRunner(deps, runs, compensation, gitGrants);
  const bootstrapConfig = createBootstrapConfigSender(deps, registry);
  const readiness = createReadinessWatchdog(deps, runs, compensation);
  const drain = createDrainLoop(deps, gitGrants);
  const keepalive = createKeepaliveLoop(deps, runs);
  const pauseResume = createPauseResumeControl(deps, runs, compensation, registry, gateway, drain);
  const checkpoints = createCheckpointPipeline(deps, gitGrants);
  const taskLifecycle = createTaskLifecycleCommands(deps, taskDetail, drain);
  // stop 受理路径与 pauseResume 拍共用「暂停中停止推进」同一实现（第 2 批遗留 1 去重）。
  const stop = createStopOperations(deps, runs, compensation, drain, taskDetail, pauseResume);
  const interactions = createInteractionCommands(deps, registry);
  const reopen = createReopenOperations(deps);
  const router = createCloudCommandRouter(deps, registry, gateway);
  const watchdog = createHeartbeatWatchdog(deps, registry, runs);
  const ingest = createProjectionIngestService(deps, registry, inputControl, gitGrants);
  const history = createProjectionHistoryService(deps);
  const reconciler = createStartupReconciler(deps, runs);
  const credentials = createRunAuthorizationPolicy(deps);

  return {
    config: deps.config,
    providers: async () =>
      Promise.all(
        (await deps.drivers.listProviders()).map(async (entry) => {
          if (!deps.sandboxRuntimeSettings) {
            // 未接端口（测试/嵌入装配）：providers 只会来自通过启动期 env 秘密校验的
            // 绑定，生效 key 视为已配置；不伪造端口读取。
            return { provider: entry.provider, ...entry.capabilities, apiKeyConfigured: true };
          }
          const runtime = await deps.sandboxRuntimeSettings.readEffectiveSandboxConfig(
            entry.provider,
          );
          return {
            provider: entry.provider,
            ...entry.capabilities,
            ...(runtime.envMaxLifetimeSeconds === undefined
              ? {}
              : { maxLifetimeSeconds: runtime.envMaxLifetimeSeconds }),
            apiKeyConfigured: runtime.apiKeyConfigured,
          };
        }),
      ),
    tasks: taskService,
    taskDetail,
    gitGrants,
    inputs: gateway,
    delivery: dispatcher,
    inputControl,
    attachments: registry,
    router,
    watchdog,
    runs,
    provisioning: { create, readiness, compensation, bootstrapConfig },
    lifecycle: { keepalive, drain, checkpoints, pauseResume },
    commands: { taskLifecycle, interactions, reopen, stop },
    projections: { ingest, history },
    reconciler,
    credentials,
  };
}

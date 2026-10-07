/**
 * 沙箱 supervisor 装配（specs/cloud-agent/02 §3 进程结构、07 §2.7 交互同构；
 * W6 §3「supervisor 常驻进程」）。
 *
 * 装配只做接线：把 adapters（WSS/stdio/文件/git）与 app（会话、bootstrap、exporter、
 * relay、checkpoint）连起来，并保证生命周期边界不被跨层破坏：
 * - 网络断开 → 只关 bridge socket 与 relay 会话；
 * - runtime 退出 → 真实退出事实，交给上层诊断/恢复；
 * - 显式停止 → 依次关闭 bridge、drain 网络 facade、释放 stdio（写 EOF 属于停止通路）。
 */
import { randomUUID } from "node:crypto";
import type { CloudRunAddress } from "@zcode/shared";
import { buildCloudTaskWorkspaceIdentity, ServiceChannels } from "@zcode/shared";
import { createBridgeSession, type BridgeSession } from "../app/bridgeSession.js";
import { createBootstrap, type Bootstrap } from "../app/bootstrap.js";
import { createCheckpoint } from "../app/checkpoint.js";
import { createProjectionExporter, type ProjectionExporter } from "../app/projectionExporter.js";
import { createRpcRelay } from "../app/rpcRelay.js";
import { createSandboxGit } from "../app/sandboxGit.js";
import type { DrainPort, ExecutionClock, ExecutionLogger } from "../app/ports.js";
import { createBridgeTransport } from "./bridgeTransport.js";
import { createCredentialStateFile, ensureRuntimeStateDir } from "./credentialStateFile.js";
import { createExecutionLogger, createProcessClock } from "./executionSupport.js";
import { createGitGrantClient, createGitRunner } from "./gitRunner.js";
import { createLocalRpcOwner } from "./localRpcOwner.js";
import { createProjectionWalStore } from "./projectionWalStore.js";
import {
  createPolicySnapshotInstaller,
  createProvisioningInstaller,
  createSandboxWorkspace,
} from "./provisioningInstaller.js";
import { createRuntimeOwner } from "./runtimeOwner.js";
import { bridgeUrl } from "./supervisorConfig.js";
import { createSessionTopicSource } from "./sessionTopicSource.js";
import type { SupervisorBootstrapConfig } from "./supervisorConfig.js";
import { createCredentialState } from "../domain/credentialRotation.js";
import { encodeBridgeFrame } from "../domain/bridgeFrames.js";

export interface SandboxSupervisor {
  start(): Promise<void>;
  stop(reason: string): Promise<void>;
  session(): BridgeSession;
  /** 不可恢复的本地失败（如状态目录不可写）时 resolve：入口据此以非 0 退出并留证据。 */
  whenFatal(): Promise<string>;
}

export interface SandboxSupervisorOptions {
  config: SupervisorBootstrapConfig;
  /** 沙箱内 workspace 根（`/workspace`）。 */
  workspaceRoot?: string;
  clock?: ExecutionClock;
  logger?: ExecutionLogger;
  /** 测试注入：接管 runtime owner 的 spawn。 */
  runtimeRoot?: string;
}

export function createSandboxSupervisor(options: SandboxSupervisorOptions): SandboxSupervisor {
  const { config } = options;
  const logger = options.logger ?? createExecutionLogger("cloud-execution", process.pid);
  const clock = options.clock ?? createProcessClock();
  const stateDir = config.stateDir;
  const workspaceRoot = options.workspaceRoot ?? "/workspace";

  const identity = buildCloudTaskWorkspaceIdentity(config.taskId);
  const address: CloudRunAddress = {
    taskId: config.taskId,
    runId: config.runId,
    runGeneration: config.runGeneration,
    workspaceIdentity: identity,
    // hello 地址里的路径来自自举描述（真实 checkout 路径以 bootstrap.config 为准）。
    workspacePath: config.workspacePath,
    remoteSessionId: `${config.runId}:${config.operationKey}`,
  };

  // 状态目录在 supervisor 进程里自建（`~/.zcode/run`，见 credentialStateFile 的 E2B 实测注释）：
  // 不依赖模板预建，也不假定系统目录可写。
  const fatal = deferredFatal();
  const runtime = createRuntimeOwner({ logger, root: options.runtimeRoot });
  const localRpc = createLocalRpcOwner({ logger });
  const projectionStore = createProjectionWalStore({ stateDir, logger });
  const credentials = createCredentialStateFile({ stateDir, logger });
  const git = createSandboxGit({
    runner: createGitRunner({ logger }),
    grants: createGitGrantClient({
      publicOrigin: config.publicOrigin,
      runId: config.runId,
      credential: async () => {
        const state = await credentials.load();
        if (!state) throw new Error("credential state missing for git grant");
        return state.currentToken;
      },
      logger,
    }),
    logger,
  });

  const topics = createSessionTopicSource({
    channel: () => localRpc.channel(ServiceChannels.ZCodeAgent),
    workspace: () => ({
      workspacePath: address.workspacePath,
      workspaceIdentity: identity,
      remoteSessionId: address.remoteSessionId,
    }),
    logger,
  });

  const exporter: ProjectionExporter = createProjectionExporter({
    taskId: config.taskId,
    runId: config.runId,
    runGeneration: config.runGeneration,
    // runtime incarnation 在 bootstrap 之后才有稳定值；导出记录用它做代际维度。
    runtimeIncarnation: `${config.runId}:${config.operationKey}`,
    sessionIndexTopic: `sessions-index/${identity}`,
    extractSessionIds: extractSessionIdsFromIndexFrame,
    source: topics,
    walStore: projectionStore,
    logger,
    reportFault: (fault) => logger.warn(undefined, "projection fault", fault),
  });

  // 出站通道持有器：rpc.response 必须走当前已认证连接；连接释放后自动丢弃（不缓存、不重放）。
  const outbound = createOutboundHolder();

  const relay = createRpcRelay({
    channel: (name) => localRpc.channel(name),
    send: (frame) => outbound.send(encodeBridgeFrame(frame)),
    logger,
  });

  const bootstrap: Bootstrap = createBootstrap({
    git,
    runtime,
    localRpc,
    provisioning: createProvisioningInstaller({
      channel: () => localRpc.channel(ServiceChannels.ProviderProvisioningTarget),
      logger,
      stateDir,
    }),
    policy: createPolicySnapshotInstaller({ logger, stateDir }),
    workspace: createSandboxWorkspace({ workspaceRoot, logger }),
    exporter,
    logger,
    workspaceRoot,
    commitMessage: (cfg) => `checkpoint ${cfg.clone.taskBranch}`,
  });

  const checkpoint = createCheckpoint({
    git,
    quiesce: {
      async quiesce() {
        // 投递屏障：先停网络侧写入面（新输入不再进 runtime），再交回结果。
        relay.releaseAll("quiesce");
        return { ok: true as const };
      },
      async release() {
        // manual checkpoint 之后放开屏障：连接层面的新增会话会自动恢复。
      },
    },
    checkout: () => bootstrap.checkout(),
    logger,
    clock,
  });

  const drain: DrainPort = {
    async onDrain({ operationId }) {
      // 停止屏障（08 §8.1）：先保存，再由上层 terminate provider；本进程不自行 kill runtime。
      const context = session.context();
      if (!context) return;
      await checkpoint.run({
        protocolVersion: 1,
        type: "checkpoint.request",
        operationId,
        runId: config.runId,
        runGeneration: config.runGeneration,
        connectionEpoch: context.connectionEpoch,
        purpose: "drain",
      });
    },
  };

  const session = createBridgeSession({
    address,
    bridgeUrl: bridgeUrl(config.publicOrigin, config.runId),
    workspacePathHint: config.workspacePath,
    transport: createBridgeTransport({ logger }),
    credentials,
    projection: exporter,
    rpcRelay: relay,
    bootstrap,
    checkpoint,
    drain,
    clock,
    logger,
    newAttemptId: () => randomUUID(),
    newResumeToken: () => randomUUID(),
    jitter: () => Math.random(),
    onConnection: (connection) => outbound.bind((text) => connection.send(text)),
    onFatal: (reason) => fatal.settle(reason),
  });

  return {
    async start() {
      // 早期失败要当场暴露：目录建不出来就没法满足「候选先落盘再 hello」（02 §5.1）。
      await ensureRuntimeStateDir(stateDir).catch((error: unknown) => {
        throw new Error(
          `runtime state dir is not writable: ${stateDir}: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      // 自举起点只有 ticket；候选/attemptId 由会话在发 hello 前持久化（02 §5.1 第 2 条）。
      const existing = await credentials.load();
      if (!existing) {
        await credentials.save(
          createCredentialState({
            address: {
              taskId: config.taskId,
              runId: config.runId,
              runGeneration: config.runGeneration,
            },
            initialToken: config.bootstrapTicket,
            nextResumeToken: randomUUID(),
            helloAttemptId: randomUUID(),
          }),
        );
      }
      session.start();
    },

    async stop(reason) {
      await session.stop(reason);
      await exporter.stop();
      topics.dispose();
      localRpc.dispose();
      await runtime.stop(reason);
    },

    session: () => session,
    whenFatal: () => fatal.promise,
  };
}

/** 一次性致命失败信号（首个原因获胜；未发生时永不 resolve）。 */
function deferredFatal(): { promise: Promise<string>; settle(reason: string): void } {
  let settle!: (reason: string) => void;
  const promise = new Promise<string>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

/**
 * sessions-index 帧 → 会话 id：只取已提交投影里的 `sessionId` 字段（严格解析交给
 * sessions-index 契约；这里只做有界提取，形状不符即忽略，不猜）。
 */
export function extractSessionIdsFromIndexFrame(frame: {
  payload: { kind: "snapshot" | "deltas"; [key: string]: unknown };
}): string[] {
  const ids = new Set<string>();
  const snapshot = frame.payload.snapshot as { sessions?: unknown } | undefined;
  if (snapshot && Array.isArray(snapshot.sessions)) {
    for (const entry of snapshot.sessions) {
      const id = (entry as { sessionId?: unknown })?.sessionId;
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  const deltas = frame.payload.deltas;
  if (Array.isArray(deltas)) {
    for (const delta of deltas) {
      const id = (delta as { session?: { sessionId?: unknown } })?.session?.sessionId;
      if (typeof id === "string" && id.length > 0) ids.add(id);
    }
  }
  return [...ids];
}

/**
 * 出站消息持有器：绑定当前连接的 write 通道；连接释放后 send 变为丢弃。
 * 这样 relay/projection 等出站方不必各自持有 socket，也不会在断网后误写到旧 epoch。
 */
export function createOutboundHolder(): {
  bind(send: (text: string) => void): { dispose(): void };
  send(text: string): void;
  bound(): boolean;
} {
  let sender: ((text: string) => void) | null = null;
  return {
    bind(send) {
      sender = send;
      return {
        dispose: () => {
          if (sender === send) sender = null;
        },
      };
    },
    send(text) {
      sender?.(text);
    },
    bound: () => sender !== null,
  };
}

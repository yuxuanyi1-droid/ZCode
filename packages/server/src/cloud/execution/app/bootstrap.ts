/**
 * bootstrap 管线（specs/cloud-agent/02 §5.3 ready 条件、01 §6.2 步骤 2–6、12 §6 envelope
 * 安装；14 §6 偏好快照；W6 §3「bootstrap/」）。
 *
 * 顺序即契约：welcome 只证明认证，ready 必须逐条满足（02 §5.3）——
 *   registering → cloning → handshaking → installing-config → exporter-starting → reconciling。
 * 每一步失败都带阶段与归一错误码上报（`bridge.phase`），不存在「假 ready」；
 * clone 事实、workspacePath、envelope 全部来自已认证通道的 `bootstrap.config`，不走
 * provider env/元数据（01 §6.2、12 §6）。
 *
 * ready 清单里的每一项都必须是**真实证据**：`preferencesInstalled` 由偏好快照安装器的
 * 落盘结果驱动（14 §6「凡必须有真实证据的条件不得写死 true」）。
 *
 * 2026-10-11 简化改造（14 §4.8/§9.5）：自举期资源安装整体退役——`bootstrap.resources` 帧、
 * `resources-installed` 条件与 `installing-resources` 相位全部移除；用户资源同步改在
 * **连接期**由控制面经 bridge relay 调沙箱既有 sync 服务（与 bootstrap 无关）。
 */
import type {
  BootstrapConfigFrame,
  CloudBootstrapPreferences,
  CloudErrorCode,
} from "@zcode/shared";
import { evaluateReady, type BootstrapPhase, type ReadyChecklist } from "../domain/readyGate.js";
import type { ProjectionExporter } from "./projectionExporter.js";
import type { SandboxGit } from "./sandboxGit.js";
import type {
  BootstrapPort,
  ExecutionLogger,
  LocalRpcOwnerPort,
  RuntimeOwnerPort,
} from "./ports.js";

export interface ProvisioningInstallPort {
  /** 本地已安装的凭据代际（A-08 核对用；无记录返回 null）。 */
  appliedGeneration(): Promise<number | null>;
  /** 安装 run 授权清单内的 provider/model 配置与凭据（不复制整个 credential store）。 */
  install(envelopeJson: string, credentialGeneration: number): Promise<void>;
}

export interface PolicySnapshotPort {
  /**
   * 安装版本化 runtime preferences/policy snapshot（执行节点自己应答，不依赖页面，07 §8）。
   * `preferences` 缺席=旧版 `bootstrap.config` 语义（只记 policyVersion）；返回**实际落盘**的
   * 已应用配置版本（真实证据，供 ready 门控与 `bridge.ready.configVersion` 上报）。
   */
  install(input: {
    policyVersion: string;
    preferences?: CloudBootstrapPreferences;
  }): Promise<{ configVersion: string }>;
  /** 已应用的策略快照版本（无记录/不可解析返回 null）。 */
  applied(): Promise<{ configVersion: string } | null>;
}

export interface WorkspacePort {
  ensure(path: string): Promise<void>;
  /** 已存在的 checkout（崩溃后重连）返回 true：跳过 clone，只核对事实。 */
  exists(path: string): Promise<boolean>;
}

export interface BootstrapOptions {
  git: SandboxGit;
  runtime: RuntimeOwnerPort;
  localRpc: LocalRpcOwnerPort;
  provisioning: ProvisioningInstallPort;
  policy: PolicySnapshotPort;
  workspace: WorkspacePort;
  exporter: ProjectionExporter;
  logger: ExecutionLogger;
  /** 沙箱内 workspace 根（01 §6.2 步骤 2 的 `/workspace`）；子路径由 config.workspacePath 提供。 */
  workspaceRoot: string;
  /** 运行端能力清单（上报给控制面；不含秘密）。 */
  executionCapabilities?: readonly string[];
  commitMessage?(config: BootstrapConfigFrame): string;
}

export interface Bootstrap extends BootstrapPort {
  /** checkpoint 用的 checkout 路径与任务分支（来自最近一次 config）。 */
  checkout(): { workspacePath: string; taskBranch: string } | null;
  /** 命令事实 / 投影 cursor 对账（02 §5.3 第 6 条）；v1 以运行端可达与 WAL 健康为证据。 */
  reconcile(): Promise<{ ok: boolean; detail?: string }>;
}

export function createBootstrap(options: BootstrapOptions): Bootstrap {
  let current: BootstrapConfigFrame | null = null;
  let installedGeneration: number | null = null;
  /** 已落盘的偏好快照版本（真实证据；null = 未安装，ready 门控据此拒绝）。 */
  let installedPolicyVersion: string | null = null;
  /** 已应用的配置版本（偏好快照 configVersion；无 preferences 块时 = policyVersion）。 */
  let appliedConfigVersion: string | null = null;
  let phase: BootstrapPhase | undefined;
  let runtimeStarted = false;
  const phaseListeners = new Set<
    (phase: { phase: string; errorCode?: string; diagnostics?: string }) => void
  >();

  function emitPhase(next: BootstrapPhase, errorCode?: string, diagnostics?: string): void {
    phase = next;
    options.logger.info(undefined, `bootstrap phase: ${next}`, errorCode ? { errorCode } : {});
    for (const listener of phaseListeners) {
      listener(errorCode ? { phase: next, errorCode, diagnostics } : { phase: next });
    }
  }

  /** 命令事实 / 投影 cursor 对账（02 §5.3 第 6 条）；v1 以运行端可达与 WAL 健康为证据。 */
  async function reconcile(): Promise<{ ok: boolean; detail?: string }> {
    const facts = options.runtime.facts();
    if (facts.pid === null) return { ok: false, detail: "runtime-not-alive" };
    const exporterState = options.exporter.ready();
    if (!exporterState.exporterReady) return { ok: false, detail: "exporter-not-ready" };
    return { ok: true };
  }

  async function applyConfig(config: BootstrapConfigFrame): Promise<void> {
    // 每次自举都是新的一次尝试：真实证据标志先归零，避免上一次尝试的结论被当成当前证据。
    installedPolicyVersion = null;
    appliedConfigVersion = null;
    emitPhase("registering");
    await options.workspace.ensure(options.workspaceRoot);

    const alreadyCloned = await options.workspace.exists(config.workspacePath);
    if (!alreadyCloned) {
      emitPhase("cloning");
      const cloned = await options.git.cloneAtBase(
        {
          repositoryId: config.clone.repositoryId,
          repositoryFullName: config.clone.repositoryFullName,
          baseSha: config.clone.baseSha,
          taskBranch: config.clone.taskBranch,
        },
        config.workspacePath,
        options.workspaceRoot,
      );
      if (!cloned.ok) throw new BootstrapFailure(cloned.code, `clone failed: ${cloned.message}`);
    } else {
      // 崩溃/重连后不重复 clone：只核对本地 HEAD 与冻结 baseSha 的关系留给 checkpoint 对账。
      options.logger.info(undefined, "workspace already cloned; skipping clone", {
        repositoryId: config.clone.repositoryId,
      });
    }

    emitPhase("handshaking");
    if (!runtimeStarted) {
      const started = await options.runtime.start();
      runtimeStarted = true;
      options.logger.info(undefined, "sandbox runtime started", { pid: started.pid });
      await options.localRpc.connect(started.stream);
    }

    emitPhase("installing-config");
    const applied = await options.provisioning.appliedGeneration();
    if (applied !== null && applied > config.credentialGeneration) {
      // 代际落后于本地已安装内容：按 fault 上报，不用旧凭据覆盖新代际（12 §6 A-08）。
      throw new BootstrapFailure(
        "protocol_incompatible",
        "bootstrap config credentialGeneration is behind applied generation",
      );
    }
    if (applied === null || applied < config.credentialGeneration) {
      await options.provisioning.install(
        config.provisioningEnvelopeJson,
        config.credentialGeneration,
      );
      installedGeneration = config.credentialGeneration;
    }
    // 偏好快照（14 §6/§9.3）：有 preferences 块就落实值 + configVersion；没有则维持
    // 旧版语义（只记 policyVersion）。返回的是**实际落盘**的版本，供 ready 与 ready 帧上报。
    const appliedPolicy = await options.policy.install({
      policyVersion: config.policyVersion,
      ...(config.preferences ? { preferences: config.preferences } : {}),
    });
    installedPolicyVersion = appliedPolicy.configVersion;
    appliedConfigVersion = appliedPolicy.configVersion;

    emitPhase("exporter-starting");
    await options.exporter.start();
    const exporterState = options.exporter.ready();
    if (!exporterState.walReady) {
      throw new BootstrapFailure("data_at_risk", "projection WAL is not writable");
    }

    emitPhase("reconciling");
    const reconciled = await reconcile();
    if (!reconciled.ok) {
      throw new BootstrapFailure("not_ready", reconciled.detail ?? "reconciliation failed");
    }
  }

  const bootstrap: Bootstrap = {
    async run(config) {
      current = config;
      try {
        await applyConfig(config);
      } catch (error) {
        const failure =
          error instanceof BootstrapFailure
            ? error
            : new BootstrapFailure(
                "bootstrap_failed",
                error instanceof Error ? error.message : String(error),
              );
        emitPhase(phase ?? "registering", failure.code, failure.message);
        throw failure;
      }
      const facts = options.runtime.facts();
      const exporterState = options.exporter.ready();
      const checklist: ReadyChecklist = {
        localRuntimeHandshake: facts.pid !== null,
        provisioningInstalled:
          installedGeneration !== null || (await options.provisioning.appliedGeneration()) !== null,
        // 真实证据：本次安装的落盘版本，或状态文件里既有版本（重连/既有状态）；不写死 true。
        preferencesInstalled:
          installedPolicyVersion !== null || (await options.policy.applied()) !== null,
        exporterReady: exporterState.exporterReady,
        walReady: exporterState.walReady,
        reconciliationDone: true,
        previousFacadeReleased: true,
      };
      const verdict = evaluateReady(checklist);
      if (!verdict.ready) {
        const failure = new BootstrapFailure("not_ready", `${verdict.blockedBy}:${verdict.detail}`);
        emitPhase(phase ?? "reconciling", failure.code, failure.message);
        throw failure;
      }
      return {
        // 已应用配置版本（14 §6）：有偏好快照时 = 快照 configVersion，否则维持 policyVersion。
        configVersion: appliedConfigVersion ?? config.policyVersion,
        runtimeIncarnation: facts.incarnation ?? "runtime-unknown",
        executionCapabilities: [
          ...(options.executionCapabilities ?? ["stdio-rpc", "projection-wal", "checkpoint"]),
        ],
      };
    },

    onPhase(listener) {
      phaseListeners.add(listener);
      return { dispose: () => phaseListeners.delete(listener) };
    },

    runtimeFacts() {
      return options.runtime.facts();
    },

    checkout() {
      return current
        ? { workspacePath: current.workspacePath, taskBranch: current.clone.taskBranch }
        : null;
    },

    reconcile,
  };

  return bootstrap;
}

/** bootstrap 阶段失败：带归一错误码与脱敏诊断，供 `bridge.phase` 上报（01 §5.2/§9）。 */
export class BootstrapFailure extends Error {
  constructor(
    readonly code: CloudErrorCode,
    message: string,
  ) {
    super(message.slice(0, 512));
    this.name = "BootstrapFailure";
  }
}

/**
 * Bridge 会话编排（specs/cloud-agent 02 §5 握手/旋转/ready 门控、§8 背压与故障、
 * 07 §10 故障表；W6 §3「出站 WSS bridge」）。
 *
 * 一次连接的生命周期：
 *   persist(候选) → hello → welcome(epoch/rotationId/ingestCursors) → bootstrap.config
 *   → bootstrap(clone/runtime/envelope/偏好快照/exporter) → ready → heartbeat/批次 → 断开重连。
 *
 * 边界（02 §2 不变量 7、§3）：
 * - 本文件**不持有**本地 stdio 与 runtime：网络断开只关自己的 socket 与 relay 会话；
 * - 不引入第二队列：投影重投只有「WAL + ACK」一条路径；
 * - 旧 epoch 的任何出站帧都不再发送（每个连接捕获自己的 epoch）；
 * - 断线不是终态：Run 是否 disconnected/expired 由控制面裁决（03 §2），本进程不宣称终止。
 *
 * 拆分：握手在 bridgeHandshake.ts、入站路由在 bridgeInbound.ts、共享状态在 bridgeState.ts。
 */
import { CLOUD_BRIDGE_PROTOCOL_VERSION, cloudErrorCodeSchema } from "@zcode/shared";
import { applyHelloRejection, applyHelloUnconfirmed } from "../domain/credentialRotation.js";
import { persistCredentials } from "./bridgeState.js";
import { classifyDisconnect, nextReconnectDelayMs } from "../domain/supervision.js";
import { parseBootstrapPhase } from "../domain/readyGate.js";
import { startBridgeHeartbeat, type HeartbeatHandle } from "./bridgeHeartbeat.js";
import { performHandshake, prepareAttempt, waitForBootstrapConfig } from "./bridgeHandshake.js";
import { handleInboundText } from "./bridgeInbound.js";
import {
  DEFAULT_BRIDGE_TIMINGS,
  FatalBridgeError,
  ProtocolError,
  connectionContext,
  createBridgeRuntimeState,
  logBridgeState,
  sendFrame,
  type BridgeRuntimeState,
  type BridgeSession,
  type BridgeSessionOptions,
  type BridgeSessionState,
  type BridgeTimings,
} from "./bridgeState.js";
import type { BridgeConnectionPort } from "./ports.js";

export {
  DEFAULT_BRIDGE_TIMINGS,
  type BridgeSession,
  type BridgeSessionOptions,
  type BridgeSessionState,
  type BridgeTimings,
} from "./bridgeState.js";

export function createBridgeSession(options: BridgeSessionOptions): BridgeSession {
  const timings: BridgeTimings = { ...DEFAULT_BRIDGE_TIMINGS, ...options.timings };
  const { logger } = options;
  const state: BridgeRuntimeState = createBridgeRuntimeState();
  let loop: Promise<void> | null = null;
  let heartbeat: HeartbeatHandle | null = null;

  /** 网络断开只释放网络 facade：不清 WAL、不碰 stdio/runtime（02 §2 不变量 7、§3）。 */
  function releaseNetworkFacade(reason: string): void {
    options.rpcRelay.releaseAll(reason);
    heartbeat?.dispose();
    heartbeat = null;
    state.epoch = null;
    state.connectionReady = false;
  }

  async function connectOnce(): Promise<void> {
    logBridgeState(state, logger, "connecting");
    await prepareAttempt(state, options);

    state.closeReason = "socket-close";
    const connection = await options.transport.connect(options.bridgeUrl);
    state.connection = connection;
    // 出站通道绑定：连接关闭时先解绑，再释放网络 facade（旧 epoch 不再发送任何帧）。
    const binding = options.onConnection?.(connection);
    connection.onClose((info) => {
      binding?.dispose();
      state.closeReason = info.reason.startsWith("frame-rejected")
        ? "protocol-error"
        : "socket-close";
      releaseNetworkFacade(info.reason);
    });
    connection.onText((text) => handleInboundText(state, options, text, connection));

    const welcome = await performHandshake(state, options, timings, connection);
    if (!welcome) {
      connection.close("welcome-timeout");
      state.closeReason = "welcome-timeout";
      // 没有 welcome：initial 步必须前进（控制面的 CAS 可能已提交），其余步原地重试。
      state.unconfirmed = true;
      await advanceRecoveryLadder();
      return;
    }
    const bootstrapApplied = await bootstrapIfNeeded(connection);
    if (!bootstrapApplied) {
      // 自举未完成：`bootstrap.config` 超时未到（自举失败已在上面按 fault 抛出）。02 §5.3
      // 要求 welcome 只证明认证、条件逐条满足才 ready——这里**不得**补发 ready（否则
      // `preferences-installed` 等真实证据条件会被静默绕过，等于假 ready）。关连接走既有
      // 重连路径，等下次连接重试（2026-10-11 P19b 修复：此前该分支会带着
      // configVersion="unknown" 直接发 ready）。
      logBridgeState(state, logger, "bootstrapping", { reason: "bootstrap-incomplete" });
      connection.close("bootstrap-incomplete");
      state.closeReason = "socket-close";
      return;
    }
    sendReady(connection);
    logBridgeState(state, logger, "ready", {
      connectionEpoch: state.epoch,
      bootstrapped: state.bootstrapped,
    });

    const heartbeatHandle = startBridgeHeartbeat({
      connection,
      clock: options.clock,
      logger,
      projection: options.projection,
      intervalMs: timings.heartbeatIntervalMs,
      batchSize: timings.projectionBatchSize,
      epoch: () => state.epoch,
      isReady: () => state.connectionReady,
      runtimeFacts: () => options.bootstrap.runtimeFacts(),
    });
    await waitUntilClosed(connection);
    // 用本连接的句柄释放：releaseNetworkFacade 可能已经把模块级引用清空。
    heartbeatHandle.dispose();
    heartbeat = null;
    await advanceRecoveryLadder();
  }

  /**
   * 每次新连接都等待并应用 `bootstrap.config`（02 §5.3）：
   * - 首次：完整 clone/runtime/envelope/exporter 自举（行为不变）；
   * - 已 bootstrap：只核对并重装 envelope/policy（A-08），不重新 clone、不重启 runtime、
   *   不重新 start exporter，完成后继续 ready。
   *
   * 修复依据（2026-10-17 review R5 A-08）：原实现 `if (state.bootstrapped) return` 让重连
   * 完全忽略新的 `bootstrap.config`——token 刷新后的更高 `credentialGeneration` 永远不会
   * 被安装。现在每次连接都经 `configSlot` 等待控制面重推，未有变化时 refresh 是 no-op。
   */
  async function bootstrapIfNeeded(connection: BridgeConnectionPort): Promise<boolean> {
    logBridgeState(state, logger, "bootstrapping", { connectionEpoch: state.epoch });
    const delivered = await waitForBootstrapConfig(state, options, timings, connection);
    if (!delivered) return false;
    if (state.bootstrapped) {
      try {
        // 重连只应用代际/policy 变化；进程级资源（workspace/runtime/exporter）保持原状。
        const report = await options.bootstrap.refresh(delivered);
        state.config = delivered;
        // 已应用配置版本（14 §6）：ready 帧必须反映本次重推后的新版本（A-08）。
        state.configVersion = report.configVersion;
      } catch (error) {
        reportBootstrapFailure(connection, error);
        throw error;
      }
      return true;
    }
    // 阶段上报（02 §4 `bridge.phase`）：只带阶段与归一错误码，无 token/prompt/秘密。
    const phases = options.bootstrap.onPhase((phase) => {
      const parsedCode = phase.errorCode ? cloudErrorCodeSchema.safeParse(phase.errorCode) : null;
      const validPhase = parseBootstrapPhase(phase.phase);
      if (!validPhase) return;
      sendFrame(connection, {
        protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
        type: "bridge.phase",
        phase: validPhase,
        ...(parsedCode?.success ? { errorCode: parsedCode.data } : {}),
        ...(phase.diagnostics ? { diagnostics: phase.diagnostics.slice(0, 512) } : {}),
      });
    });
    try {
      const report = await options.bootstrap.run(delivered);
      state.config = delivered;
      // 已应用配置版本（14 §6）：偏好快照 configVersion（无快照时 = policyVersion）；
      // ready 帧按它上报"Run 已应用配置版本"（重连沿用同一值）。
      state.configVersion = report.configVersion;
      state.bootstrapped = true;
    } catch (error) {
      reportBootstrapFailure(connection, error);
      throw error;
    } finally {
      phases.dispose();
    }
    return true;
  }

  /** 自举/重推失败：明确阶段 + fault 上报，不制造假 ready（01 §5.2、02 §8）。 */
  function reportBootstrapFailure(connection: BridgeConnectionPort, error: unknown): void {
    const failure = error as { code?: string; message?: string };
    const parsedCode = failure.code ? cloudErrorCodeSchema.safeParse(failure.code) : null;
    logger.error(undefined, "bootstrap failed", { code: failure.code ?? "unknown" });
    sendFrame(connection, {
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "bridge.fault",
      faultCode: parsedCode?.success ? parsedCode.data : "bootstrap_failed",
      message: (failure.message ?? "bootstrap failed").slice(0, 512),
      retryable: true,
      ...(state.epoch === null ? {} : { connectionEpoch: state.epoch }),
    });
  }

  function sendReady(connection: BridgeConnectionPort): void {
    const facts = options.bootstrap.runtimeFacts();
    const projectionReady = options.projection.ready();
    state.connectionReady = true;
    sendFrame(connection, {
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "bridge.ready",
      connectionEpoch: state.epoch,
      // 已应用配置版本（14 §6）：有偏好快照时是快照 configVersion，否则维持 policyVersion。
      configVersion: state.configVersion ?? state.config?.policyVersion ?? "unknown",
      runtimeIncarnation: facts.incarnation ?? `runtime-${process.pid}`,
      exporterReady: projectionReady.exporterReady,
      walReady: projectionReady.walReady,
      executionCapabilities: ["stdio-rpc", "projection-wal", "checkpoint"],
    });
  }

  /**
   * 恢复阶梯推进（02 §5.2）：显式拒绝按阶梯前进；无 welcome 只在 initial 步前进。
   * 两者都要落盘——下一次 hello 用的材料必须来自持久状态。
   */
  async function advanceRecoveryLadder(): Promise<void> {
    if (!state.credentials || (!state.rejected && !state.unconfirmed)) return;
    const rejected = state.rejected;
    state.rejected = false;
    state.unconfirmed = false;
    state.credentials = rejected
      ? applyHelloRejection(state.credentials)
      : applyHelloUnconfirmed(state.credentials);
    await persistCredentials(options, state.credentials);
    logger.warn(undefined, "recovery ladder advanced", {
      recovery: state.credentials.recovery,
      rejected,
    });
  }

  function waitUntilClosed(connection: BridgeConnectionPort): Promise<void> {
    return new Promise<void>((resolve) => {
      connection.onClose(() => resolve());
    });
  }

  return {
    start() {
      if (loop) return;
      loop = (async () => {
        let attempt = 0;
        while (!state.stopped) {
          let reason = state.closeReason;
          try {
            await connectOnce();
            if (state.closeReason === "socket-close") attempt = 0;
            reason = state.closeReason;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (message === "credentials-exhausted") {
              logBridgeState(state, logger, "failed-closed", { reason: "credentials-exhausted" });
              return;
            }
            if (error instanceof FatalBridgeError) {
              // 本地事实源不可用：不进入退避重连（重试不会好，只会拖到控制面超时）。
              logger.error(undefined, "bridge failed: irreversible local error", {
                error: message,
              });
              logBridgeState(state, logger, "failed-closed", { reason: "fatal-local-error" });
              options.onFatal?.(message);
              return;
            }
            reason = error instanceof ProtocolError ? "protocol-error" : "socket-error";
            logger.warn(undefined, "bridge connect failed", { error: message });
          }
          if (state.stopped) break;
          const policy = classifyDisconnect(reason);
          if (!policy.reconnect) {
            logBridgeState(state, logger, "failed-closed", { reason });
            return;
          }
          // timer 只触发探测/恢复，不证明死亡（02 §8）。
          const delay = nextReconnectDelayMs(attempt, options.jitter());
          attempt += 1;
          logBridgeState(state, logger, "connecting", { reconnectInMs: delay, reason });
          await options.clock.wait(delay);
        }
      })();
    },

    async stop(reason) {
      state.stopped = true;
      state.connection?.close(reason);
      state.connection = null;
      heartbeat?.dispose();
      heartbeat = null;
      logBridgeState(state, logger, "stopped", { reason });
      await loop?.catch(() => undefined);
    },

    state: () => state.status,
    connectionEpoch: () => state.epoch,
    context: () => connectionContext(state, options.address),
  };
}

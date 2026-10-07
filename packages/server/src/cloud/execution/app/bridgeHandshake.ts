/**
 * Bridge 握手与凭据旋转阶梯（specs/cloud-agent/02 §5.1/§5.2、§5.3 ready 门控）。
 *
 * 顺序是不可调换的契约：**先持久候选与 attemptId，再发 hello**；welcome 只证明认证，
 * 之后还要等 `bootstrap.config` 才能 bootstrap/ready。
 */
import type { BootstrapConfigFrame, BridgeWelcomeFrame } from "@zcode/shared";
import { CLOUD_BRIDGE_PROTOCOL_VERSION } from "@zcode/shared";
import { applyWelcome, beginFreshAttempt, planHello } from "../domain/credentialRotation.js";
import { awaitSignal, deferred } from "./deferred.js";
import {
  ProtocolError,
  logBridgeState,
  persistCredentials,
  sendFrame,
  type BridgeRuntimeState,
  type BridgeSessionOptions,
  type BridgeTimings,
} from "./bridgeState.js";
import type { BridgeConnectionPort } from "./ports.js";

/** 读取本地凭据状态，并核对 run 一致性（拿旧 run 的凭据连新 run 是越权）。 */
export async function loadCredentials(
  state: BridgeRuntimeState,
  options: BridgeSessionOptions,
): Promise<void> {
  if (state.credentials) return;
  const loaded = await options.credentials.load();
  if (!loaded) {
    throw new Error("credential state missing: bootstrap ticket must be provisioned before hello");
  }
  if (
    loaded.runId !== options.address.runId ||
    loaded.runGeneration !== options.address.runGeneration
  ) {
    throw new Error("persisted credential state belongs to a different run");
  }
  state.credentials = loaded;
}

/**
 * 02 §5.1 第 2 条：候选与 attemptId 先在本地落盘，再发 hello。
 * 已确认过的 attempt 开启新周期；未确认的按 §5.2 阶梯复用原 attempt。
 */
export async function prepareAttempt(
  state: BridgeRuntimeState,
  options: BridgeSessionOptions,
): Promise<void> {
  await loadCredentials(state, options);
  const current = state.credentials!;
  if (current.recovery === "exhausted") throw new Error("credentials-exhausted");
  if (current.confirmed) {
    // 上一 attempt 已被 welcome 确认：开启新旋转周期（新 attemptId + 新候选，先落盘）。
    const fresh = beginFreshAttempt(current, {
      helloAttemptId: options.newAttemptId(),
      nextResumeToken: options.newResumeToken(),
    });
    await persistCredentials(options, fresh);
    state.credentials = fresh;
    return;
  }
  // 恢复路径同样要求候选已在本地：写失败是终态，不进入 hello。
  await persistCredentials(options, current);
}

/**
 * 发送 hello 并消费 welcome（含 epoch 接管与凭据确认）。
 * 返回 welcome 帧；超时/关闭返回 null，由调用方按 welcome-timeout 分类重连。
 */
export async function performHandshake(
  state: BridgeRuntimeState,
  options: BridgeSessionOptions,
  timings: BridgeTimings,
  connection: BridgeConnectionPort,
): Promise<BridgeWelcomeFrame | null> {
  const prepared = state.credentials!;
  const incarnation = options.bootstrap.runtimeFacts().incarnation;
  const plan = planHello(prepared, {
    attemptId: prepared.helloAttemptId,
    runtimeIncarnation: incarnation ?? `runtime-${process.pid}`,
    workspacePath: state.config?.workspacePath ?? options.workspacePathHint,
  });
  if (!plan.ok) throw new Error("credentials-exhausted");

  // 两个等待槽必须在发出 hello 之前就位：控制面可能在同一个 tick 内回 welcome + config。
  state.welcomeSlot = deferred<BridgeWelcomeFrame>();
  state.configSlot = deferred<BootstrapConfigFrame>();

  logBridgeState(state, options.logger, "authenticating");
  sendFrame(connection, plan.frame);

  const rawWelcome = await awaitSignal(state.welcomeSlot, {
    timeoutMs: timings.welcomeTimeoutMs,
    clock: options.clock,
    connection,
  });
  if (!rawWelcome) return null;
  const applied = applyWelcome(prepared, rawWelcome);
  if (!applied.ok) {
    // epoch 倒退：不接受旧 socket 的接管结果（02 §2 不变量 3）。
    connection.close("stale-epoch");
    throw new ProtocolError(`welcome rejected: ${applied.reason}`);
  }
  state.credentials = applied.next;
  await persistCredentials(options, applied.next);
  state.epoch = rawWelcome.connectionEpoch;
  state.rejected = false;
  options.logger.info(undefined, "bridge welcome", {
    connectionEpoch: state.epoch,
    rotationId: rawWelcome.rotationId,
    ingestCursors: rawWelcome.ingestCursors.length,
  });
  return rawWelcome;
}

/** welcome 之后、ready 之前必须收到 config；未到即上报阶段（不假装 ready）。 */
export async function waitForBootstrapConfig(
  state: BridgeRuntimeState,
  options: BridgeSessionOptions,
  timings: BridgeTimings,
  connection: BridgeConnectionPort,
): Promise<BootstrapConfigFrame | null> {
  const slot = state.configSlot;
  if (!slot) return null;
  const frame = await awaitSignal(slot, {
    timeoutMs: timings.bootstrapConfigTimeoutMs,
    clock: options.clock,
    connection,
  });
  if (!frame) {
    sendFrame(connection, {
      protocolVersion: CLOUD_BRIDGE_PROTOCOL_VERSION,
      type: "bridge.phase",
      phase: "installing-config",
      diagnostics: "bootstrap.config not delivered before ready gate",
    });
  }
  return frame;
}

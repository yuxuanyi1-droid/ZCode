/**
 * 执行节点凭据旋转状态机（specs/cloud-agent/02 §5.1/§5.2，W6 §3「token 轮换与候选恢复」）。
 *
 * 纯决策层：不读写文件、不碰网络，只产出「下一次 hello 应该用什么」与「必须持久化什么」。
 * 事实源是 Bridge 本地凭据文件（顺序：**先持久候选，再发 hello**）；控制面只存 hash，
 * 用 CAS 把 A-hash 切成 B-hash。
 *
 * 恢复阶梯（02 §5.2）：
 *   initial(A) → candidate(B) → fallback(A) → exhausted
 * - 首次/未经验证的 attempt：用当前凭据 A 证明，携带发送前已持久化的候选 B；
 * - welcome 丢失（CAS 可能已提交）：下一连接改用**候选 B + 原 attemptId**；
 * - B 被控制面拒绝（首次事务未提交）：才退回本地 A + 原 attemptId + 原候选 B；
 * - A 也被拒绝：fail closed，不设置旧 token 的通用有效重叠窗口。
 *
 * 「推进阶梯」的触发分两类：显式拒绝（`bridge.fault`）按阶梯前进；无 welcome
 * （超时/连接关闭）只在 initial 步必须前进（否则丢了 welcome 就永远无法恢复），
 * 在 candidate/fallback 步原地重试——网络原因不是凭据失效的证据。
 */
import type { BridgeHelloFrame, BridgeWelcomeFrame } from "@zcode/shared";
import { cloudRunAddressSchema } from "@zcode/shared";

/** 恢复阶梯位置。 */
export type RecoveryStep = "initial" | "candidate" | "fallback" | "exhausted";

/** 本地凭据文件的内容（有界、版本化；未知版本整份拒绝，不按旧字段猜测）。 */
export interface CredentialStateSnapshot {
  version: 1;
  taskId: string;
  runId: string;
  runGeneration: number;
  /** 当前已确认可用的 token（首次为 provisioning 注入的明文 ticket）。 */
  currentToken: string;
  /** 发送前已持久化的候选 resume token（02 §5.1 第 2 条）。 */
  candidateNextResumeToken: string;
  /** 本次 attempt 的稳定标识；恢复时必须复用同一个（02 §5.1 第 5 条）。 */
  helloAttemptId: string;
  /** 恢复阶梯位置。 */
  recovery: RecoveryStep;
  /** 上一次 attempt 是否已被 welcome 确认（确认后开启新周期：新 attemptId + 新候选）。 */
  confirmed: boolean;
  /** 已由 welcome 确认的旋转标识。 */
  rotationId?: string;
  /** 最近一次确认的 attachment 代际；新 welcome 的 epoch 不得倒退（02 §2 不变量 3）。 */
  connectionEpoch?: number;
}

export interface CredentialRotationInput {
  address: { taskId: string; runId: string; runGeneration: number };
  /** 首次 token（provisioning 注入，只走秘密注入通道）。 */
  initialToken: string;
  /** 候选 resume token（调用方生成，保证发送前已持久）。 */
  nextResumeToken: string;
  /** uuid 形状（shared 的 hello 帧契约）。 */
  helloAttemptId: string;
}

export function createCredentialState(input: CredentialRotationInput): CredentialStateSnapshot {
  return {
    version: 1,
    taskId: input.address.taskId,
    runId: input.address.runId,
    runGeneration: input.address.runGeneration,
    currentToken: input.initialToken,
    candidateNextResumeToken: input.nextResumeToken,
    helloAttemptId: input.helloAttemptId,
    recovery: "initial",
    confirmed: false,
  };
}

export type HelloPlan =
  | { ok: true; frame: BridgeHelloFrame }
  | { ok: false; reason: "credentials-exhausted" };

/**
 * 计算本次 hello 使用的凭据材料（纯函数；调用方负责先把 attemptId/候选写盘）。
 *
 * `workspacePath` 只作 hello 地址的形状要求（帧内必须带可解析的绝对路径），真实 checkout
 * 路径以 `bootstrap.config.workspacePath` 为准（02 §2 不变量 1：identity 不作 cwd）。
 */
export function planHello(
  state: CredentialStateSnapshot,
  input: { attemptId: string; runtimeIncarnation: string; workspacePath: string },
): HelloPlan {
  if (state.recovery === "exhausted") return { ok: false, reason: "credentials-exhausted" };
  const credentialToken =
    state.recovery === "candidate" ? state.candidateNextResumeToken : state.currentToken;
  const parsed = cloudRunAddressSchema.safeParse({
    taskId: state.taskId,
    runId: state.runId,
    runGeneration: state.runGeneration,
    workspaceIdentity: `cloud-task:${state.taskId}`,
    workspacePath: input.workspacePath,
    remoteSessionId: `${state.runId}:${input.attemptId}`,
  });
  if (!parsed.success) return { ok: false, reason: "credentials-exhausted" };
  return {
    ok: true,
    frame: {
      protocolVersion: 1,
      type: "bridge.hello",
      address: parsed.data,
      helloAttemptId: input.attemptId,
      credentialToken,
      candidateNextResumeToken: state.candidateNextResumeToken,
      runtimeIncarnation: input.runtimeIncarnation,
    },
  };
}

export type WelcomeVerdict =
  | { ok: true; next: CredentialStateSnapshot }
  | { ok: false; reason: "stale-epoch" | "run-mismatch" };

/**
 * 消费 welcome（02 §5.1 第 5 条、§5.2 末段）：
 * - epoch 必须不低于本地已知 epoch（同 socket 重复 hello 返回原 epoch，新 socket 递增）；
 * - 确认后 currentToken 换成候选 B（旧 A 不再保留使用权），阶梯归位到 initial。
 */
export function applyWelcome(
  state: CredentialStateSnapshot,
  frame: BridgeWelcomeFrame,
): WelcomeVerdict {
  if (state.connectionEpoch !== undefined && frame.connectionEpoch < state.connectionEpoch) {
    return { ok: false, reason: "stale-epoch" };
  }
  return {
    ok: true,
    next: {
      ...state,
      currentToken: state.candidateNextResumeToken,
      recovery: "initial",
      confirmed: true,
      rotationId: frame.rotationId,
      connectionEpoch: frame.connectionEpoch,
    },
  };
}

/**
 * 控制面**显式拒绝**本次 hello（`bridge.fault` / 鉴权关闭）：按 02 §5.2 阶梯前进。
 * - initial 的 A 被拒 → 说明首次 CAS 可能已提交，改用候选 B；
 * - candidate 的 B 被拒 → 首次事务未提交，退回 A（原 attempt + 原候选）；
 * - fallback 的 A 也被拒 → fail closed。
 */
export function applyHelloRejection(state: CredentialStateSnapshot): CredentialStateSnapshot {
  switch (state.recovery) {
    case "initial":
      return { ...state, recovery: "candidate" };
    case "candidate":
      return { ...state, recovery: "fallback" };
    default:
      return { ...state, recovery: "exhausted" };
  }
}

/**
 * 本次 hello 没有得到 welcome（超时/连接关闭，无拒绝证据）：
 * 只有 initial 步必须前进——welcome 丢失时控制面可能已把 hash 切成候选 B；
 * candidate/fallback 步原地重试，网络原因不被当成凭据失效。
 */
export function applyHelloUnconfirmed(state: CredentialStateSnapshot): CredentialStateSnapshot {
  return state.recovery === "initial" ? { ...state, recovery: "candidate" } : state;
}

/** 已确认过凭据时，开启新一轮旋转周期：换 attemptId 与新候选（先落盘再发 hello）。 */
export function beginFreshAttempt(
  state: CredentialStateSnapshot,
  input: { helloAttemptId: string; nextResumeToken: string },
): CredentialStateSnapshot {
  return {
    ...state,
    helloAttemptId: input.helloAttemptId,
    candidateNextResumeToken: input.nextResumeToken,
    recovery: "initial",
    confirmed: false,
  };
}

/** 严格解析本地凭据文件（未知版本/字段一律拒绝，不猜测）。 */
export function parseCredentialState(raw: unknown): CredentialStateSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.version !== 1) return null;
  const strings = [
    "taskId",
    "runId",
    "currentToken",
    "candidateNextResumeToken",
    "helloAttemptId",
  ] as const;
  for (const key of strings) {
    if (typeof value[key] !== "string" || (value[key] as string).length === 0) return null;
  }
  if (typeof value.runGeneration !== "number" || !Number.isInteger(value.runGeneration)) {
    return null;
  }
  const recovery = value.recovery;
  if (
    recovery !== "initial" &&
    recovery !== "candidate" &&
    recovery !== "fallback" &&
    recovery !== "exhausted"
  ) {
    return null;
  }
  const snapshot: CredentialStateSnapshot = {
    version: 1,
    taskId: value.taskId as string,
    runId: value.runId as string,
    runGeneration: value.runGeneration,
    currentToken: value.currentToken as string,
    candidateNextResumeToken: value.candidateNextResumeToken as string,
    helloAttemptId: value.helloAttemptId as string,
    recovery,
    confirmed: value.confirmed === true,
  };
  if (typeof value.rotationId === "string") snapshot.rotationId = value.rotationId;
  if (typeof value.connectionEpoch === "number" && Number.isInteger(value.connectionEpoch)) {
    snapshot.connectionEpoch = value.connectionEpoch;
  }
  return snapshot;
}

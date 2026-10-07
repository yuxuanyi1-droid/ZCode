/**
 * 租期、业务活动与保存策略（specs/cloud-agent/08 §7 租期与业务活动、§8.1 停止屏障、
 * §8.2 保存与终止事实，第三批 checkpoint 完整性决议）。
 *
 * 纯策略层：所有判定取注入的 `now` 与已持久事实，不读系统时钟、不发起副作用。
 *
 * 已知边界（08 §8.1，实施决议第三批，必须如实对待）：
 * `quiesce v1 = 控制面投递屏障 + 工作区收口提交（无等待面）`。v4 权威协议没有可等待的
 * in-flight 命令数/会话空闲面（CommandAck 只是准入结论，commandsQuery 只回同一准入 ACK，
 * conversation 投影是推送式），因此**不得用 sleep 冒充同步**，也没有「等待在途命令结束」
 * 的有界等待实现；收口提交如实捕获 checkpoint 时刻的工作区状态。把该投影接成有界等待
 * （含超时口径）是后续项，见 `QUIESCE_BOUNDARY`。
 */
import { cloudGitObjectIdSchema, type CloudDeadlineConfidence } from "@zcode/shared";

/** 08 §7 默认候选值（待真实 provider 能力测量后冻结；此处可被部署配置覆盖）。 */
export const SAVE_POLICY_DEFAULTS = {
  /** 闲置归档阈值：execution idle、无 pending input/interaction、无 checkpoint、无业务写入。 */
  idleArchiveThresholdMs: 15 * 60 * 1000,
  /** 被动观看续期默认关：attach、heartbeat、侧栏轮询本身不算业务活动。 */
  passiveViewRenewalEnabled: false,
  /** 硬 run 时长候选：取部署预算与 provider 上限较小值。 */
  hardRunDurationMs: 4 * 60 * 60 * 1000,
  /** 到期前 drain 预算：至少 5 分钟候选。 */
  drainBudgetMs: 5 * 60 * 1000,
  /** 周期保存候选：优先轮次安全点，dirty 且能获得写屏障才执行。 */
  periodicCheckpointMs: 5 * 60 * 1000,
  /** 自动续期默认开：业务 running/写操作/pending 交互保护需要时续期。 */
  autoRenewEnabled: true,
} as const;

/** 08 §8.1 的 quiesce 边界说明，供实现与验收引用（不是可执行逻辑）。 */
export const QUIESCE_BOUNDARY =
  "quiesce v1 = 控制面投递屏障 + 工作区收口提交（无等待面）；不 sleep 冒充同步，不伪称在途命令已结束";

/** 业务活动类别（08 §7）：只有业务活动更新 lastBusinessActivityAt。 */
export type ActivityKind =
  | "user-input"
  | "runtime-execution"
  | "tool-execution"
  | "write-operation"
  | "pending-interaction"
  | "attach"
  | "heartbeat"
  | "polling"
  | "sse"
  | "log"
  | "protocol-ack";

export function isBusinessActivity(kind: ActivityKind): boolean {
  switch (kind) {
    case "user-input":
    case "runtime-execution":
    case "tool-execution":
    case "write-operation":
    case "pending-interaction":
      return true;
    default:
      // heartbeat 只证明连接可见；attach/轮询/SSE/日志/协议 ACK 都不证明业务活跃。
      return false;
  }
}

/** 待续期审计（08 §7）：autoRenew 只在存在业务需要时触发。 */
export function shouldRenewLease(input: {
  now: number;
  execution: "unknown" | "idle" | "running" | "awaiting-input";
  pendingInputCount: number;
  pendingInteractionCount: number;
  writeInFlight: boolean;
  /** 硬期限不允许无限保活：到达硬期限即为上界。 */
  hardDeadlineAt?: number;
  autoRenewEnabled?: boolean;
}): boolean {
  if (input.autoRenewEnabled === false) return false;
  if (input.hardDeadlineAt !== undefined && input.now >= input.hardDeadlineAt) return false;
  if (input.execution === "running") return true;
  if (input.execution === "awaiting-input") {
    // 审批等待不是业务空闲（08 §3.3）：保留明确审批窗口；无 pending 交互时不无限续期。
    return input.pendingInteractionCount > 0;
  }
  return input.writeInFlight || input.pendingInputCount > 0 || input.pendingInteractionCount > 0;
}

/**
 * 有效期限解析（08 §7「provider 续期失败或到期时间未知时保留上一次已确认 expiresAt；
 * 无法读取真实期限的 provider 持久保守 deadlineEstimate/deadlineConfidence」）。
 * 取所有已知上界的最小值作为保守截止，并标记是否含估计值。
 */
export interface EffectiveDeadline {
  at: number;
  confidence: "confirmed" | "estimated";
  source: "expiresAt" | "deadlineEstimate" | "hardDeadlineAt";
}

export function resolveEffectiveDeadline(input: {
  expiresAt?: number;
  deadlineEstimate?: number;
  hardDeadlineAt?: number;
}): EffectiveDeadline | null {
  const candidates: EffectiveDeadline[] = [];
  if (input.expiresAt !== undefined) {
    candidates.push({ at: input.expiresAt, confidence: "confirmed", source: "expiresAt" });
  }
  if (input.deadlineEstimate !== undefined) {
    candidates.push({
      at: input.deadlineEstimate,
      confidence: "estimated",
      source: "deadlineEstimate",
    });
  }
  if (input.hardDeadlineAt !== undefined) {
    candidates.push({
      at: input.hardDeadlineAt,
      confidence: "confirmed",
      source: "hardDeadlineAt",
    });
  }
  if (candidates.length === 0) return null;
  return candidates.reduce((earliest, candidate) =>
    candidate.at < earliest.at ? candidate : earliest,
  );
}

/** 硬 run 时长 = 部署预算与 provider 上限的较小值（08 §7；不承诺三家都支持 4 小时）。 */
export function resolveHardDeadline(input: {
  runStartedAt: number;
  deploymentBudgetMs: number;
  providerMaxLifetimeSeconds?: number;
}): number {
  const deployment = input.runStartedAt + input.deploymentBudgetMs;
  if (input.providerMaxLifetimeSeconds === undefined) return deployment;
  const provider = input.runStartedAt + input.providerMaxLifetimeSeconds * 1000;
  return Math.min(deployment, provider);
}

/**
 * 请求寿命计划（01 §4.3「可用期取部署预算与 provider 能力较小值；provider 更小时收敛并提示」、
 * 08 §7「不支持 extend 返回能力错报，不伪造续期；provider 只给估计值时用估计值 + 置信度」）。
 *
 * **唯一计算点**：接纳期算一次，`requestedDeadline`（下发给 provider）、持久化的
 * `hardDeadlineAt`、以及 drain/期限策略读取的都是这同一个值，create 不再重算。
 *
 * 如实投影：
 * - provider 声明了上限且 `deadlineSource === "estimated"` → 同时给 `deadlineEstimate` +
 *   `deadlineConfidence`（不得伪装精确确认）；
 * - provider 声明了上限且 `deadlineSource === "provider"` → 不写估计值（create 成功后会由
 *   `recordProviderHandle` 落 provider 确认的 `expiresAt`）；
 * - provider **未声明**上限 → 不虚构收敛，用部署预算作硬期限，并以低置信度估计表达
 *   「实际可用期可能更短、provider 上限未知」。
 */
export interface RunLifetimePlan {
  /** 绝对硬期限（epoch ms）= now + effectiveLifetimeMs。 */
  hardDeadlineAt: number;
  effectiveLifetimeMs: number;
  basis: "provider-max" | "deployment-budget";
  providerLimitKnown: boolean;
  /** provider 上限严格小于部署预算：本次发生了收敛（日志/详情据此解释原因）。 */
  converged: boolean;
  deadlineEstimate?: number;
  deadlineConfidence?: CloudDeadlineConfidence;
}

export function planRunLifetime(input: {
  now: number;
  deploymentBudgetMs: number;
  providerMaxLifetimeSeconds?: number;
  deadlineSource?: "provider" | "estimated";
}): RunLifetimePlan {
  const budget = Math.max(1, Math.trunc(input.deploymentBudgetMs));
  if (input.providerMaxLifetimeSeconds === undefined) {
    const hardDeadlineAt = input.now + budget;
    return {
      hardDeadlineAt,
      effectiveLifetimeMs: budget,
      basis: "deployment-budget",
      providerLimitKnown: false,
      converged: false,
      // 上限未知：实际可用期可能更短，用低置信度估计表达（不虚构精确确认）。
      deadlineEstimate: hardDeadlineAt,
      deadlineConfidence: "low",
    };
  }
  const providerMs = Math.max(1, Math.trunc(input.providerMaxLifetimeSeconds * 1000));
  const effectiveLifetimeMs = Math.min(budget, providerMs);
  const hardDeadlineAt = input.now + effectiveLifetimeMs;
  const plan: RunLifetimePlan = {
    hardDeadlineAt,
    effectiveLifetimeMs,
    basis: providerMs < budget ? "provider-max" : "deployment-budget",
    providerLimitKnown: true,
    converged: providerMs < budget,
  };
  if (input.deadlineSource === "estimated") {
    // provider 只能给估计：按保守估计投影，标注置信度（不冒充 provider 确认期限）。
    plan.deadlineEstimate = hardDeadlineAt;
    plan.deadlineConfidence = "medium";
  }
  return plan;
}

/** 到达期限前停止接收新工作并保存（08 §7）：进入 drain 预算窗口即触发 drain。 */
export function shouldBeginDrain(input: {
  now: number;
  deadline: EffectiveDeadline | null;
  drainBudgetMs?: number;
  /** 用户已请求停止：停止意图优先于闲置/期限判定。 */
  stopRequested?: boolean;
}): boolean {
  if (input.stopRequested) return true;
  if (!input.deadline) return false;
  const budget = input.drainBudgetMs ?? SAVE_POLICY_DEFAULTS.drainBudgetMs;
  return input.now >= input.deadline.at - budget;
}

/** 闲置归档判定（08 §7 首行）：四类保护条件任一存在都不算闲置。 */
export function isIdleArchiveEligible(input: {
  now: number;
  lastBusinessActivityAt?: number;
  execution: "unknown" | "idle" | "running" | "awaiting-input";
  pendingInputCount: number;
  pendingInteractionCount: number;
  checkpointInFlight: boolean;
  idleArchiveThresholdMs?: number;
}): boolean {
  if (input.execution === "running" || input.execution === "awaiting-input") return false;
  if (input.execution === "unknown") return false;
  if (input.pendingInputCount > 0 || input.pendingInteractionCount > 0) return false;
  if (input.checkpointInFlight) return false;
  const threshold = input.idleArchiveThresholdMs ?? SAVE_POLICY_DEFAULTS.idleArchiveThresholdMs;
  const last = input.lastBusinessActivityAt;
  if (last === undefined) return false;
  return input.now - last >= threshold;
}

/** 周期保存窗口：优先轮次安全点；未到 interval 不重复请求（08 §7）。 */
export function shouldRequestPeriodicCheckpoint(input: {
  now: number;
  lastCheckpointAt?: number;
  execution: "unknown" | "idle" | "running" | "awaiting-input";
  checkpointInFlight: boolean;
  periodicCheckpointMs?: number;
}): boolean {
  if (input.checkpointInFlight) return false;
  if (input.execution !== "running" && input.execution !== "idle") return false;
  const interval = input.periodicCheckpointMs ?? SAVE_POLICY_DEFAULTS.periodicCheckpointMs;
  if (input.lastCheckpointAt === undefined) return true;
  return input.now - input.lastCheckpointAt >= interval;
}

export function isGitObjectId(value: string): boolean {
  return cloudGitObjectIdSchema.safeParse(value).success;
}

/**
 * checkpoint 结果判定（08 §8.1 第三批 checkpoint 完整性）：
 * - `saved` 必须有形如 git object id 的 remoteSha，否则 fail-closed：不写 saved、进对账；
 * - remoteSha 落在冻结 baseSha 且帧报「无新提交」→ 允许 saved，记 no-new-commits，
 *   不标 dataAtRisk（PR 通路按 09 §5.1 no-changes 处理）；
 * - remoteSha 仍停在 baseSha 但帧报有新提交 → 提交没落在发布分支，saved 但如实标
 *   dataAtRisk + 告警；
 * - `failed`/`unknown` 不伪装 saved，`failed` 带 dataAtRisk（08 §8.2）。
 */
export interface CheckpointOutcome {
  state: "saved" | "failed" | "pending";
  confirmedRemoteSha?: string;
  dataAtRisk: boolean;
  noNewCommits?: boolean;
  riskSummary?: string;
}

export function evaluateCheckpointOutcome(input: {
  status: "saved" | "failed" | "unknown";
  branch?: string;
  remoteSha?: string;
  hadNewCommits?: boolean;
  errorCode?: string;
  frozenBaseSha?: string;
  errorMessage?: string;
}): CheckpointOutcome {
  if (input.status === "saved") {
    if (!input.remoteSha || !isGitObjectId(input.remoteSha)) {
      // fail-closed：无合法远端 SHA 证据不得写 saved（08 §8.1 第三批）。
      return {
        state: "pending",
        dataAtRisk: true,
        riskSummary: "checkpoint reported saved without a verifiable remote sha",
      };
    }
    const stuckAtBase =
      input.frozenBaseSha !== undefined && input.remoteSha === input.frozenBaseSha;
    if (stuckAtBase && input.hadNewCommits === true) {
      return {
        state: "saved",
        confirmedRemoteSha: input.remoteSha,
        dataAtRisk: true,
        riskSummary: "new commits reported but remote branch still at frozen base sha",
      };
    }
    return {
      state: "saved",
      confirmedRemoteSha: input.remoteSha,
      dataAtRisk: false,
      noNewCommits: input.hadNewCommits === false || (stuckAtBase && input.hadNewCommits !== true),
    };
  }
  // failed / unknown：保存失败不伪装 saved；unknown 进对账，按 pending 保留事实。
  if (input.status === "unknown") {
    return {
      state: "pending",
      dataAtRisk: true,
      riskSummary: input.errorMessage ?? "checkpoint result unknown, awaiting reconciliation",
    };
  }
  return {
    state: "failed",
    dataAtRisk: true,
    riskSummary: input.errorMessage ?? input.errorCode ?? "checkpoint failed",
  };
}

/**
 * 硬期限优先于「保存失败不停机」（08 §7 尾段）：到期必须 drain；保存失败可在剩余
 * 预算内重试，但不能靠重试无限保活。
 */
export function drainRetryAllowed(input: {
  now: number;
  deadline: EffectiveDeadline | null;
  retries: number;
  maxRetries?: number;
}): boolean {
  const max = input.maxRetries ?? 3;
  if (input.retries >= max) return false;
  if (!input.deadline) return true;
  return input.now < input.deadline.at;
}

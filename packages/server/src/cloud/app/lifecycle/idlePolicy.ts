/**
 * 空闲 pause 策略（决策文档 D3 定稿附录、specs/cloud-agent/08 §7 修订 2026-10-09）。
 *
 * 纯决策层（D5：决策与 IO/效果分离，测试不打桩）：输入全部是已确定的持久事实、
 * 连接事实与部署配置，无 IO、无时钟（调用方传入 `now`）；输出是「本拍对这条 run
 * 做什么」的单一裁决。执行（pauseRun 的 B-4 顺序、provider 确认、detach、CAS）在
 * `pauseResume.ts`，本文件不触碰任何端口。
 *
 * 与 background-agents 的「广播即将暂停 + 顺延」相比是**保守简化**（v1，08 §7 修订）：
 * 浏览器有打开的观看连接（任务通道 rpc 流）即不算空闲、不 pause——v1 没有「即将暂停」
 * 广播倒计时面，就先不暂停有人看着的 run；广播+顺延列为后续项。
 *
 * 单轨（F-3、08 §7 修订）：`pauseResume=none`（A-7 门禁未实测解禁）时决策恒 skip，
 * 整条空闲 pause 路径天然休眠，idle drain 照旧；memory/disk 级 provider 才可能 pause，
 * idle drain 对 memory 级 provider 由 drain.sweep 的单轨守卫关闭（见 drain.ts），
 * 同一 run 不会既被 pause 又被 idle drain。
 */
import type { CloudRunStatus } from "@zcode/shared";

export type IdlePauseSkipReason =
  | "disabled" // 阈值 0：部署显式禁用（ZCODE_CLOUD_SANDBOX_IDLE_PAUSE_SECONDS=0）
  | "not-ready" // 仅 ready run 参与空闲 pause（08 §3.2 修订准入）
  | "stop-requested" // 停止意图优先：归 stop/drain 通路，空闲 pause 不参与
  | "capability-none" // A-7 门禁：pauseResume=none，路径不可达（fail-closed）
  | "browser-watching" // v1 简化：有浏览器观看连接即不算空闲（无「即将暂停」广播面）
  | "pending-input" // 有待投递输入：工作将恢复，不算空闲（08 §7 闲置条件）
  | "checkpoint-in-flight" // 保存通道占用：不与保存竞争（结果未落即视为占用）
  | "no-activity-fact" // 无业务活动事实：不猜空闲（与 isIdleArchiveEligible 同口径）
  | "below-threshold"; // 有事实但未持续达到阈值

export interface IdlePauseFacts {
  readonly runStatus: CloudRunStatus;
  /** 是否已受理停止（持久屏障）。 */
  readonly stopRequested: boolean;
  /** 生效 pauseResume 能力（driver describeCapabilities 经 A-7 收敛后的值）。 */
  readonly pauseResume: "memory" | "disk" | "none";
  /** 08 §7 业务活动事实（非心跳）；undefined = 无事实。 */
  readonly lastBusinessActivityAt?: number;
  /** 浏览器是否有该 run 的打开观看连接（任务通道 rpc 流，关即清；08 §7「客户端连接」）。 */
  readonly hasBrowserWatcher: boolean;
  /** 待投递输入数（accepted/delivering）。 */
  readonly pendingInputCount: number;
  /** 保存中的 checkpoint（saving/pending 都算占用）。 */
  readonly checkpointInFlight: boolean;
  readonly now: number;
  /** 空闲 pause 阈值（ms）；0 = 禁用。 */
  readonly thresholdMs: number;
}

export type IdlePauseDecision =
  | { readonly action: "pause"; readonly reason: "idle-threshold-met" }
  | { readonly action: "skip"; readonly reason: IdlePauseSkipReason };

/**
 * 空闲 pause 裁决（08 §7 修订的闲置条件 + D3 的连接条件）。判定顺序即排除顺序：
 * 配置 → 状态准入 → 停止意图 → 能力门禁 → 连接 → 工作面 → 事实 → 阈值。
 * 阈值边界取 `now - last >= thresholdMs`（与 isIdleArchiveEligible 同一口径）。
 */
export function decideIdlePause(facts: IdlePauseFacts): IdlePauseDecision {
  if (facts.thresholdMs === 0) return { action: "skip", reason: "disabled" };
  if (facts.runStatus !== "ready") return { action: "skip", reason: "not-ready" };
  if (facts.stopRequested) return { action: "skip", reason: "stop-requested" };
  if (facts.pauseResume === "none") return { action: "skip", reason: "capability-none" };
  if (facts.hasBrowserWatcher) return { action: "skip", reason: "browser-watching" };
  if (facts.pendingInputCount > 0) return { action: "skip", reason: "pending-input" };
  if (facts.checkpointInFlight) return { action: "skip", reason: "checkpoint-in-flight" };
  if (facts.lastBusinessActivityAt === undefined) {
    return { action: "skip", reason: "no-activity-fact" };
  }
  if (facts.now - facts.lastBusinessActivityAt < facts.thresholdMs) {
    return { action: "skip", reason: "below-threshold" };
  }
  return { action: "pause", reason: "idle-threshold-met" };
}

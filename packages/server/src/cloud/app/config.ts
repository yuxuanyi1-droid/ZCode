/**
 * 控制面 app 的运行配置（08 §6/§7 规划默认值、01 §5.2 readiness 预算、01 §6.1 模板资源、
 * 03 §6 capabilities）。
 *
 * 配置由入口层（W5）读取部署配置后注入；app 不读 `process.env`（W5 §5「禁止散落
 * process.env 直读」）。本文件只做「默认值 + 覆盖 + 边界校验」，是纯函数。
 */
import { SAVE_POLICY_DEFAULTS } from "../domain/savePolicy.js";
import { DEFAULT_MAX_CONCURRENT_RUNS } from "../domain/quota.js";

export interface CloudCoreConfig {
  /** 全局并发上限（08 §6 建议初始 3，可配置）。 */
  maxConcurrentRuns: number;
  /** 部署硬 run 预算，与 provider 上限取较小值（08 §7）。 */
  hardRunDurationMs: number;
  idleArchiveThresholdMs: number;
  drainBudgetMs: number;
  periodicCheckpointMs: number;
  autoRenewEnabled: boolean;
  /** provisioning soft timeout（01 §5.2 默认 120s）。 */
  readinessSoftTimeoutMs: number;
  /** 心跳缺失判定为 disconnected 的阈值（02 §8 心跳 30s、退避上限 60s）。 */
  heartbeatTimeoutMs: number;
  /** 沙箱 provider 出站回连的公开控制面地址（01 §4.1 create 入参）。 */
  publicControlPlaneUrl: string;
  /**
   * 下发并安装到执行节点的策略/偏好快照版本（02 §5.3 第 3 条、§4 welcome.policyVersion）。
   * 部署级常量：改变安装内容时必须递增，让执行节点能识别快照落后。
   */
  bootstrapPolicyVersion: string;
  /** 是否开放 task-owned 上传（03 §6 输入契约、11 §9 附件边界）；默认关闭。 */
  taskOwnedAttachments: boolean;
}

/**
 * 01 §6.1 目标资源（2vCPU/4GiB/10GiB；按 provider 能力显式收敛，不静默降级）。
 */
export const DEFAULT_SANDBOX_RESOURCES = {
  cpu: 2,
  memoryMiB: 4096,
  diskGiB: 10,
} as const;

export const CLOUD_CORE_DEFAULTS: CloudCoreConfig = {
  maxConcurrentRuns: DEFAULT_MAX_CONCURRENT_RUNS,
  hardRunDurationMs: SAVE_POLICY_DEFAULTS.hardRunDurationMs,
  idleArchiveThresholdMs: SAVE_POLICY_DEFAULTS.idleArchiveThresholdMs,
  drainBudgetMs: SAVE_POLICY_DEFAULTS.drainBudgetMs,
  periodicCheckpointMs: SAVE_POLICY_DEFAULTS.periodicCheckpointMs,
  autoRenewEnabled: SAVE_POLICY_DEFAULTS.autoRenewEnabled,
  readinessSoftTimeoutMs: 120_000,
  // 心跳周期 30s、退避上限 60s（02 §8）：阈值必须大于单次退避，避免把正常退避误判为断线。
  heartbeatTimeoutMs: 90_000,
  publicControlPlaneUrl: "https://localhost.invalid",
  bootstrapPolicyVersion: "cloud-policy-1",
  taskOwnedAttachments: false,
};

/** 覆盖校验：非法值 fail-closed 取默认，不静默接受越界配置（W5 §5 配置 fail-closed）。 */
export function resolveCloudCoreConfig(overrides: Partial<CloudCoreConfig> = {}): CloudCoreConfig {
  const merged: CloudCoreConfig = { ...CLOUD_CORE_DEFAULTS, ...overrides };
  return {
    ...merged,
    maxConcurrentRuns: positiveInt(merged.maxConcurrentRuns, CLOUD_CORE_DEFAULTS.maxConcurrentRuns),
    hardRunDurationMs: positiveInt(merged.hardRunDurationMs, CLOUD_CORE_DEFAULTS.hardRunDurationMs),
    idleArchiveThresholdMs: positiveInt(
      merged.idleArchiveThresholdMs,
      CLOUD_CORE_DEFAULTS.idleArchiveThresholdMs,
    ),
    drainBudgetMs: positiveInt(merged.drainBudgetMs, CLOUD_CORE_DEFAULTS.drainBudgetMs),
    periodicCheckpointMs: positiveInt(
      merged.periodicCheckpointMs,
      CLOUD_CORE_DEFAULTS.periodicCheckpointMs,
    ),
    readinessSoftTimeoutMs: positiveInt(
      merged.readinessSoftTimeoutMs,
      CLOUD_CORE_DEFAULTS.readinessSoftTimeoutMs,
    ),
    heartbeatTimeoutMs: positiveInt(
      merged.heartbeatTimeoutMs,
      CLOUD_CORE_DEFAULTS.heartbeatTimeoutMs,
    ),
    publicControlPlaneUrl: merged.publicControlPlaneUrl.trim().length
      ? merged.publicControlPlaneUrl
      : CLOUD_CORE_DEFAULTS.publicControlPlaneUrl,
    bootstrapPolicyVersion: merged.bootstrapPolicyVersion.trim().length
      ? merged.bootstrapPolicyVersion
      : CLOUD_CORE_DEFAULTS.bootstrapPolicyVersion,
  };
}

function positiveInt(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
}

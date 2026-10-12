/**
 * 沙箱服务通道白名单（specs/cloud-agent 02 §0、03 §7.1、14 §4.2）。
 *
 * 单独成文件的原因与 `userProfileEndpoints.ts` 同款：`endpoints.ts` 贴近架构门禁的
 * 文件行数上限（max-lines），通道白名单是可整体搬迁的独立事实源；`endpoints.ts` 以
 * `export * from "./serviceChannelAllowlists.js"` 保持公共入口与导出名不变（浏览器面与
 * 控制面面两份白名单仍在同一文件内定义，不得分开维护——14 §4.2 的"同文件落位"约束指
 * 两份白名单必须一同冻结）。
 *
 * 通道名、命令名与帧事件名一律沿用既有 V4 协议（`ServiceChannels`），云侧只冻结
 * 「允许暴露哪些 channel」，禁止 UI/SDK/服务端各自硬编码字符串。账号域 channel 只在
 * host `/ws` 暴露，沙箱通道不得借用。
 */
import { ServiceChannels } from "../channels.js";

/** 允许经 `/ws/cloud/tasks/:taskId` 暴露的执行域 channel（既有 V4 名，不另造）。 */
export const CLOUD_ATTACHMENT_SERVICE_ALLOWLIST = [
  ServiceChannels.File,
  ServiceChannels.FileWatcher,
  ServiceChannels.MediaPreview,
  ServiceChannels.Git,
  ServiceChannels.GitCheckpoint,
  ServiceChannels.System,
  ServiceChannels.Terminal,
  ServiceChannels.ZCodeAgent,
  ServiceChannels.ZCodeSession,
] as const;

export type CloudAttachmentServiceChannel = (typeof CLOUD_ATTACHMENT_SERVICE_ALLOWLIST)[number];

/**
 * 显式拒绝的 channel：账号域与 host 本体能力（登录/凭据/套餐/模型目录/provider
 * provisioning target）只在 host `/ws` 提供；浏览器在 host 通道已认证也不放宽本通道
 * （03 §7.1、12 §5）。denylist 对浏览器面与控制面面继续生效。
 */
export const CLOUD_ATTACHMENT_DENIED_SERVICE_CHANNELS = [
  ServiceChannels.OAuth,
  ServiceChannels.Credential,
  ServiceChannels.UsageStats,
  ServiceChannels.Setting,
  ServiceChannels.ProviderSettings,
  ServiceChannels.ModelSelection,
  ServiceChannels.ProviderProvisioningTarget,
  ServiceChannels.CodingPlanSubscription,
  ServiceChannels.ClientConfig,
] as const;

export function isCloudAttachmentServiceAllowed(channelName: string): boolean {
  return (CLOUD_ATTACHMENT_SERVICE_ALLOWLIST as readonly string[]).includes(channelName);
}

/**
 * 控制面发起的 rpc 会话可触达的沙箱服务通道**增量**（14 §4.2，2026-10-11 A 批冻结；
 * C 批定夺并集语义）。
 *
 * 用户资源同步 = 控制面经 bridge relay 调沙箱 runtime 的**既有** sync 服务（与桌面调
 * SSH 远端同构，14 §4.1）：本表只放行这批既有服务通道，不放行文件/Git/终端等浏览器面通道。
 * 分面由 `rpc.open.serviceScope` 承担：`"client"` 沿用 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST`，
 * `"control-plane"` 的**准入集 = 浏览器面白名单 ∪ 本表**（控制面是受信基础设施，能力 ⊇
 * 浏览器——命令投递复用浏览器面的 `zcode-agent`；并集在执行侧准入点派生，本表自身只是增量）。
 * 浏览器面白名单**不变**（不新增 mcp/skills 类通道，14 §5）；denylist 对两面生效。
 */
export const CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST = [
  ServiceChannels.McpSync,
  ServiceChannels.SkillSync,
  ServiceChannels.PluginSync,
  ServiceChannels.Commands,
  ServiceChannels.Subagents,
  ServiceChannels.SettingsSync,
] as const;

export type CloudControlPlaneServiceChannel =
  (typeof CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST)[number];

export function isCloudControlPlaneServiceAllowed(channelName: string): boolean {
  return (CLOUD_CONTROL_PLANE_SERVICE_ALLOWLIST as readonly string[]).includes(channelName);
}

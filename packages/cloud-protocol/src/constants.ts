export const CLOUD_PROTOCOL_VERSION = 1;

/** bridge 出站连接的控制面路径。 */
export const BRIDGE_ATTACH_PATH = "/api/cloud/bridge/attach";

export const CLOUD_LIMITS = {
  maxControlFrameBytes: 64 * 1024,
  maxDataFrameBytes: 1024 * 1024,
  maxStreamsPerAttachment: 32,
  heartbeatIntervalMs: 10_000,
  heartbeatMissLimit: 3,
  reconnectBaseMs: 500,
  reconnectMaxMs: 30_000,
  attachTokenMinLength: 16,
  maxPromptBytes: 200_000,
  maxHistoryPageSize: 200,
} as const;

/** 任务 attachment 允许的通道：执行域只读/控制面。 */
export const TASK_ATTACHMENT_CHANNELS = [
  "zcode-agent",
  "zcode-session",
  "zcode-task",
  "file",
  "file-watcher",
  "git",
  "git-checkpoint",
  "terminal",
  "system",
  "media-preview",
  "prompt-attachment-transfer",
] as const;

/** 账号 attachment 代理到 account daemon 的通道。 */
export const ACCOUNT_PROXY_CHANNELS = [
  "setting",
  "credential",
  "oauth",
  "usage-stats",
  "coding-plan-subscription",
  "client-config",
  "client-scenes",
  "model-selection",
  "provider-settings",
  "skills",
  "mcp-sync",
  "plugins",
  "subagents",
  "commands",
  "hooks",
  "memory",
  "settings-sync",
  "feedback",
  "onboarding-record",
  "conversation-share",
] as const;

/** 明确禁止出现在任务 attachment 上的通道（账号域/宿主能力/管理面）。 */
export const TASK_ATTACHMENT_FORBIDDEN_CHANNELS = [
  "credential",
  "setting",
  "oauth",
  "usage-stats",
  "coding-plan-subscription",
  "client-config",
  "model-selection",
  "provider-settings",
  "provider-provisioning-target",
  "source-server-workspace",
  "source-server-management",
  "window-controller",
  "broadcast",
  "plugins",
  "plugin-management",
  "skill-sync",
  "mcp-sync",
  "settings-sync",
] as const;

export const CLOUD_TASK_STATUSES = ["draft", "active", "completed", "failed", "archived"] as const;

export const CLOUD_RUN_STATUSES = [
  "provisioning",
  "ready",
  "paused",
  "draining",
  "stopped",
  "expired",
  "failed",
] as const;

export const CLOUD_INPUT_INTENTS = ["start", "append", "stop"] as const;

export const CLOUD_ERROR_CODES = [
  "unauthorized",
  "not_found",
  "invalid_request",
  "conflict",
  "task_stopping",
  "recovery_required",
  "attachment_unavailable",
  "provider_unavailable",
  "internal",
] as const;

/**
 * 云服务作用域（specs/cloud-agent/W8 §3、03 §7.1、04 §3.0/§4、12 §5）。
 *
 * 云客户端有两个语义不同的服务通道，权限边界不能互相借用：
 * - host `/ws`：账号域（oauth/credential/usage/setting/provider registry/模型目录）
 *   与 host 本体能力，是 `createCloudBrowserServices` 的 **base**；登录、套餐、模型
 *   设置页按原 web 模式路径走这里，**不加云分支**（12 §5）。
 * - `/ws/cloud/tasks/:taskId`：当前 Run 的沙箱 attachment，只按
 *   `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` 覆盖执行域。
 *
 * 本文件是「哪些服务来自哪个通道」的唯一事实源：绑定表由 shared 的冻结常量派生，
 * 任何一侧新增 channel 都会在 `assertCloudExecutionBindingsMatchAllowlist` 处失败，
 * 而不是在某个组件里长出第二个分支判断（W8 §8 风险项）。
 */
import {
  CLOUD_ATTACHMENT_SERVICE_ALLOWLIST,
  CLOUD_SERVICE_CHANNEL_FACETS,
  ServiceChannels,
} from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";

/** 服务来源通道：host 本体 / 当前 Run 的沙箱 attachment。 */
export type CloudServiceScope = "host" | "task-attachment";

/**
 * 执行域的覆盖面：只有拿到 ready attachment 时才可用；否则显式 unavailable，
 * 既不回落 host 本机执行域，也不伪造空数据（04 §4、03 §2 不变量 7）。
 */
export type CloudExecutionScope = "attachment-ready" | "unavailable";

/**
 * 单个服务的目标描述（04 §9 要求的「服务目标证据」）：
 * 记录某个 accessor 字段的调用会落到哪个通道，供测试与排障断言，
 * 而不是靠读组件代码猜。
 */
export interface CloudServiceTargetDescriptor {
  readonly scope: CloudServiceScope;
  readonly accessorKey: keyof IServiceAccessor;
  /** V4 ServiceChannels 名（禁止硬编码 channel 字符串，CONTRACT「白名单」段）。 */
  readonly channel: string;
  /** 该通道的 upgrade 路径，取自 shared 冻结分面。 */
  readonly endpoint: string;
}

/** host `/ws` 通道的 upgrade 路径（唯一来源：shared 分面）。 */
export const CLOUD_HOST_CHANNEL_ENDPOINT = CLOUD_SERVICE_CHANNEL_FACETS.host?.upgradePath ?? "/ws";
/** 当前 Run attachment 通道的 upgrade 路径（唯一来源：shared 分面）。 */
export const CLOUD_TASK_ATTACHMENT_ENDPOINT =
  CLOUD_SERVICE_CHANNEL_FACETS.taskAttachment?.upgradePath ?? "/ws/cloud/tasks/:taskId";

/**
 * 执行域绑定表：`CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` 里的每个 channel 映射到
 * `IServiceAccessor` 上的字段名。表外服务一律留在 host base，不由 attachment 覆盖。
 */
export const CLOUD_EXECUTION_SERVICE_BINDINGS = [
  { channel: ServiceChannels.File, accessorKey: "fileService" },
  { channel: ServiceChannels.FileWatcher, accessorKey: "fileWatcherService" },
  { channel: ServiceChannels.MediaPreview, accessorKey: "mediaPreviewService" },
  { channel: ServiceChannels.Git, accessorKey: "gitService" },
  { channel: ServiceChannels.GitCheckpoint, accessorKey: "gitCheckpointService" },
  { channel: ServiceChannels.System, accessorKey: "systemService" },
  { channel: ServiceChannels.Terminal, accessorKey: "terminalService" },
  { channel: ServiceChannels.ZCodeAgent, accessorKey: "zcodeAgentService" },
  { channel: ServiceChannels.ZCodeSession, accessorKey: "zcodeSessionService" },
] as const satisfies readonly {
  channel: string;
  accessorKey: keyof IServiceAccessor;
}[];

export type CloudExecutionServiceBinding = (typeof CLOUD_EXECUTION_SERVICE_BINDINGS)[number];
export type CloudExecutionAccessorKey = CloudExecutionServiceBinding["accessorKey"];

/**
 * 绑定表 ↔ shared 冻结白名单的一致性校验：两侧任一漂移即 fail-closed，
 * 不允许「少覆盖一个 channel」或「多覆盖一个 channel」静默通过。
 */
export function assertCloudExecutionBindingsMatchAllowlist(): void {
  const bound = CLOUD_EXECUTION_SERVICE_BINDINGS.map((binding) => binding.channel).sort();
  const allowlisted = [...CLOUD_ATTACHMENT_SERVICE_ALLOWLIST].sort();
  if (
    bound.length !== allowlisted.length ||
    bound.some((channel, index) => channel !== allowlisted[index])
  ) {
    throw new Error(
      `cloud execution bindings drifted from CLOUD_ATTACHMENT_SERVICE_ALLOWLIST: bound=${bound.join(",")} allowlisted=${allowlisted.join(",")}`,
    );
  }
}

/** 执行域 target 描述（供证据落地）。 */
export function describeCloudExecutionTargets(): readonly CloudServiceTargetDescriptor[] {
  return CLOUD_EXECUTION_SERVICE_BINDINGS.map((binding) => ({
    scope: "task-attachment" as const,
    accessorKey: binding.accessorKey,
    channel: binding.channel,
    endpoint: CLOUD_TASK_ATTACHMENT_ENDPOINT,
  }));
}

/**
 * 账号域/模型目录的 target 描述：这些服务不经 attachment 覆盖，
 * 永远来自 host `/ws`（12 §5）。
 */
export function describeCloudHostTargets(): readonly CloudServiceTargetDescriptor[] {
  const bindings = [
    { channel: ServiceChannels.OAuth, accessorKey: "oauthService" },
    { channel: ServiceChannels.Credential, accessorKey: "credentialService" },
    { channel: ServiceChannels.UsageStats, accessorKey: "usageStatsService" },
    { channel: ServiceChannels.Setting, accessorKey: "settingService" },
    { channel: ServiceChannels.ProviderSettings, accessorKey: "providerSettingsService" },
    { channel: ServiceChannels.ModelSelection, accessorKey: "modelSelectionService" },
    {
      channel: ServiceChannels.CodingPlanSubscription,
      accessorKey: "codingPlanSubscriptionService",
    },
  ] as const satisfies readonly { channel: string; accessorKey: keyof IServiceAccessor }[];

  return bindings.map((entry) => ({
    scope: "host" as const,
    accessorKey: entry.accessorKey,
    channel: entry.channel,
    endpoint: CLOUD_HOST_CHANNEL_ENDPOINT,
  }));
}

/** 完整 target 矩阵（host base + attachment 覆盖），供测试与排障断言。 */
export function describeCloudServiceTargets(): readonly CloudServiceTargetDescriptor[] {
  return [...describeCloudHostTargets(), ...describeCloudExecutionTargets()];
}

/** 判定某个 accessor 字段是否属于「由 attachment 覆盖」的执行域。 */
export function isCloudExecutionServiceKey(key: keyof IServiceAccessor): boolean {
  return CLOUD_EXECUTION_SERVICE_BINDINGS.some((binding) => binding.accessorKey === key);
}

/**
 * Cloud 端点矩阵、通道分面、wire 协议版本与错误码 → HTTP 状态映射（specs/cloud-agent
 * 03 §6 端点表、§7.1 两个服务通道分面、02 §0 沙箱 attachment 白名单、07 §9 执行节点
 * 端点、09 §2.2 installation 对账）。
 *
 * 与 `http-contracts.ts` 的分工：那里冻结「请求形状」，这里冻结「有哪些端点、谁暴露
 * 什么、每个端点引用哪份 request/response schema、允许暴露哪些既有 channel」。矩阵里的
 * schema 名由 `packages/shared/test/cloudHttpContracts.test.ts` 断言可在公开入口解析到。
 */
import { z } from "zod";
import { ServiceChannels } from "../channels.js";

// ── wire 协议版本（W7 CR-1；00 §8 独立版本化）──
//
// 云 HTTP/WS 客户端面（`/api/cloud/*` 与 `/ws/cloud/*`）的协商版本。bridge 控制帧、
// RPC 帧与投影记录各自另有版本常量；这里的版本只覆盖客户端面信封与能力协商。
// 客户端读到不在支持集内的版本必须 fail-closed（归一为 protocol_incompatible），
// 不得按旧字段猜测解析。

export const CLOUD_WIRE_PROTOCOL_VERSION = 1 as const;

/** 本实现可解析的版本集；升级时先加入支持集，再切换对外声明的默认版本。 */
export const CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS = [CLOUD_WIRE_PROTOCOL_VERSION] as const;

export type CloudWireProtocolVersion = (typeof CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS)[number];

/** `capabilitiesResponseSchema.protocolVersion` 的唯一来源（未知版本直接拒绝）。 */
export const cloudWireProtocolVersionSchema = z.literal(CLOUD_WIRE_PROTOCOL_VERSION);

export function isSupportedCloudWireProtocolVersion(value: number): boolean {
  return (CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS as readonly number[]).includes(value);
}

// ── 沙箱 attachment 的白名单（02 §0、03 §7.1）──
//
// 通道名、命令名与帧事件名一律沿用既有 V4 协议（`ServiceChannels`），云侧只冻结
// 「允许经 attachment 暴露哪些 channel」，禁止 UI/SDK/服务端各自硬编码字符串。
// 账号域 channel 只在 host `/ws` 暴露，沙箱通道不得借用。

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
 * （03 §7.1、12 §5）。
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

// ── 两个服务通道的分面（03 §7.1，决议⑧）──
//
// 云服务端对外有两个语义不同的通道，权限边界不能互相借用：host `/ws` 是账号域
// 唯一入口，沙箱 attachment 通道只做当前 Task 的执行域代理；两通道各自校验主体
// 与代际，不能因为浏览器在 host 通道已认证就放宽沙箱通道白名单。

export interface CloudChannelFacet {
  readonly upgradePath: string;
  readonly auth: string;
  /** 允许的服务域（跨包服务面）。 */
  readonly domains: readonly string[];
  /** 显式拒绝的能力族：任何一条命中即拒绝，不做本机 fallback。 */
  readonly deniedCapabilities: readonly string[];
  readonly source: string;
}

export const CLOUD_SERVICE_CHANNEL_FACETS: Readonly<Record<string, CloudChannelFacet>> = {
  host: {
    upgradePath: "/ws",
    auth: "lite-token-query（同源 ?token=，web 模式同款）",
    domains: ["oauth", "credential", "usage", "setting", "provider-registry"],
    deniedCapabilities: ["cloud-task-execution-target", "sandbox-attachment-proxy"],
    source: "03 §7.1；12 §1.2/§4/§5",
  },
  taskAttachment: {
    upgradePath: "/ws/cloud/tasks/:taskId",
    // 客户端手里的 {runId, runGeneration, connectionEpoch} 事实源是 task detail 的
    // activeRun，只作 expected 值用于 stale 检测；WS upgrade 时由服务端自行解析
    // activeRun，不接受客户端自报（04 §5）——因此不新增浏览器侧握手帧。
    auth: "服务端在 WS upgrade 解析 activeRun 并绑定（客户端只把 activeRun 当 expected 值）",
    domains: CLOUD_ATTACHMENT_SERVICE_ALLOWLIST,
    deniedCapabilities: [
      "secret-read",
      "secret-save",
      "provider-provisioning-target",
      "main-native-operation",
      "host-local-workspace-fallback",
      "account-domain",
    ],
    source: "02 §0；03 §7.1/§7.2；04 §5；12 §5",
  },
  bridge: {
    upgradePath: "/ws/cloud/bridge/:runId",
    auth: "执行节点出站专用凭据（不复用浏览器 cookie 或 host capability）",
    domains: ["bridge-control-frame", "rpc-relay", "projection-ingest"],
    deniedCapabilities: ["browser-subject-scope", "account-domain"],
    source: "02 §4/§5；07 §9",
  },
};

// ── 端点矩阵（03 §6 表 + 07 §9 执行节点端点 + 09 §2.2 installation 对账）──

export type CloudEndpointAvailability = "available" | "not_configured" | "not_implemented";

/** 端点矩阵条目：request/response 为对应 schema 常量名，null 表示 W0 未冻结形状。 */
export interface CloudHttpEndpointDescriptor {
  readonly id: string;
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly path: string;
  readonly request: string | null;
  readonly response: string | null;
  readonly availability: CloudEndpointAvailability;
  readonly note: string;
}

function ep(
  id: string,
  method: CloudHttpEndpointDescriptor["method"],
  path: string,
  request: string | null,
  response: string | null,
  note: string,
  availability: CloudEndpointAvailability = "available",
): CloudHttpEndpointDescriptor {
  return { id, method, path, request, response, availability, note };
}

export const CLOUD_HTTP_ENDPOINTS: readonly CloudHttpEndpointDescriptor[] = [
  ep(
    "capabilities",
    "GET",
    "/api/cloud/capabilities",
    null,
    "capabilitiesResponseSchema",
    "当前模式、主体 id（客户端 scope 隔离键，非凭据）、provider 能力、客户端能力与协议版本，不含 secret",
  ),
  ep(
    "repositories",
    "GET",
    "/api/cloud/repositories",
    null,
    "cloudRepositoryPageSchema",
    "当前主体可选择的仓库，分页/搜索",
    "not_configured",
  ),
  ep(
    "repositoryBranches",
    "GET",
    "/api/cloud/repositories/:repoId/branches",
    null,
    "cloudBranchPageSchema",
    "分支与 SHA；repo 授权后查询",
  ),
  ep("listProjects", "GET", "/api/cloud/projects", null, "cloudProjectPageSchema", "分页列表"),
  ep(
    "createProject",
    "POST",
    "/api/cloud/projects",
    "createCloudProjectRequestSchema",
    "cloudProjectRecordSchema",
    "显式选择 repositoryId；creation key 或唯一约束去重",
  ),
  ep(
    "patchProject",
    "PATCH",
    "/api/cloud/projects/:projectId",
    "patchCloudProjectRequestSchema",
    "cloudProjectRecordSchema",
    "仅展示元数据 + revision CAS",
  ),
  ep(
    "deleteProject",
    "DELETE",
    "/api/cloud/projects/:projectId",
    null,
    "cloudDeletedResponseSchema",
    "默认有活动任务时 409；明确归档，不静默销毁",
  ),
  ep(
    "projectTasks",
    "GET",
    "/api/cloud/projects/:projectId/tasks",
    null,
    "cloudTaskPageSchema",
    "服务端任务列表；不查询沙箱",
  ),
  ep(
    "createTask",
    "POST",
    "/api/cloud/tasks",
    "createCloudTaskRequestSchema",
    "cloudTaskRecordSchema",
    "建 draft；creation key 去重，允许正文仍未提交",
  ),
  ep(
    "taskDetail",
    "GET",
    "/api/cloud/tasks/:taskId",
    null,
    "taskDetailResponseSchema",
    "Task + activeRun + 执行/保存投影",
  ),
  ep(
    "patchTask",
    "PATCH",
    "/api/cloud/tasks/:taskId",
    "patchCloudTaskRequestSchema",
    "cloudTaskRecordSchema",
    "仅标题/draftStartConfig + expectedRevision",
  ),
  ep(
    "submitInput",
    "POST",
    "/api/cloud/tasks/:taskId/inputs",
    "submitTaskInputSchema",
    "inputReceiptSchema",
    "202 = 持久接收，不是 runtime admission",
  ),
  ep(
    "listInputs",
    "GET",
    "/api/cloud/tasks/:taskId/inputs",
    null,
    "inputRecordPageSchema",
    "输入/回执分页",
  ),
  ep(
    "getInput",
    "GET",
    "/api/cloud/tasks/:taskId/inputs/:commandId",
    null,
    "inputReceiptSchema",
    "解决响应丢失；同 commandId 返回同 receipt",
  ),
  ep(
    "cancelInput",
    "POST",
    "/api/cloud/tasks/:taskId/inputs/:commandId/cancel",
    "cloudEmptyBodySchema",
    "inputReceiptSchema",
    "幂等撤销；已 admitted 用独立 cancelCommandId",
  ),
  ep(
    "reopenTask",
    "POST",
    "/api/cloud/tasks/:taskId/reopen",
    "reopenCloudTaskRequestSchema",
    "taskDetailResponseSchema",
    "旧 run 终止证据充分时创建新 generation，不重放未知输入",
  ),
  ep(
    "stopTask",
    "POST",
    "/api/cloud/tasks/:taskId/stop",
    "cloudEmptyBodySchema",
    "taskDetailResponseSchema",
    "原子持久 stopRequested/操作，先阻断启动与投递",
  ),
  ep(
    "forceStopTask",
    "POST",
    "/api/cloud/tasks/:taskId/force-stop",
    "forceStopCloudTaskRequestSchema",
    "taskDetailResponseSchema",
    "显式丢失确认；不能由普通 stop 失败自动触发",
  ),
  ep(
    "extendTask",
    "POST",
    "/api/cloud/tasks/:taskId/extend",
    "cloudEmptyBodySchema",
    "cloudExtensionResponseSchema",
    "返回 provider 确认期限或明确标记的保守估计",
  ),
  ep(
    "completeTask",
    "POST",
    "/api/cloud/tasks/:taskId/complete",
    "cloudEmptyBodySchema",
    "taskDetailResponseSchema",
    "显式验收；先检查保存/产物状态，必要时 drain",
  ),
  ep(
    "archiveTask",
    "POST",
    "/api/cloud/tasks/:taskId/archive",
    "cloudEmptyBodySchema",
    "taskDetailResponseSchema",
    "无活动写入 run 时归档；历史仍可读",
  ),
  ep(
    "reactivateTask",
    "POST",
    "/api/cloud/tasks/:taskId/reactivate",
    "cloudEmptyBodySchema",
    "taskDetailResponseSchema",
    "completed 且 PR 未 merged 时转 active，不自动建 run",
  ),
  ep(
    "restoreTask",
    "POST",
    "/api/cloud/tasks/:taskId/restore",
    "cloudEmptyBodySchema",
    "taskDetailResponseSchema",
    "从 archived 恢复 archivedFromStatus；仍需显式 reopen 才有新 run",
  ),
  ep(
    "taskHistory",
    "GET",
    "/api/cloud/tasks/:taskId/history",
    null,
    "cloudHistoryPageSchema",
    "控制面历史分页；不要求沙箱存活",
  ),
  ep(
    "taskEvents",
    "GET",
    "/api/cloud/tasks/:taskId/events",
    null,
    "cloudTaskEventsResponseSchema",
    "按 cursor 结构化恢复；带 retention floor",
    "not_implemented",
  ),
  ep(
    "taskSnapshot",
    "GET",
    "/api/cloud/tasks/:taskId/snapshot",
    null,
    "cloudProjectionSnapshotSchema",
    "匹配 epoch/cursor 的权威投影 snapshot",
  ),
  ep(
    "metadataEvents",
    "GET",
    "/api/cloud/events",
    null,
    "cloudMetadataEventSchema",
    "SSE 元数据变化；断线后全量拉列表对账",
  ),
  ep(
    "uploadAttachment",
    "POST",
    "/api/cloud/attachments",
    null,
    "cloudAttachmentUploadResponseSchema",
    "multipart/form-data，字段固定 file（单文件）+ 可选 taskId；未支持 task-owned 上传返回 not_configured",
  ),
  ep(
    "githubReconcile",
    "POST",
    "/api/cloud/github/installations/:id/reconcile",
    null,
    "cloudEmptyBodySchema",
    "管理者主动对账 installation 投影（09 §2.2）",
  ),
  ep(
    "githubWebhook",
    "POST",
    "/api/cloud/github/webhook",
    null,
    "cloudEmptyBodySchema",
    "验签 + 持久 delivery inbox（M7 条件性）",
    "not_implemented",
  ),
  ep(
    "gitGrant",
    "GET",
    "/api/cloud/runs/:runId/git-grant",
    null,
    "cloudGitGrantResponseSchema",
    "执行节点出站、run-scoped 单次兑换；仅沙箱 bridge 凭据可用",
  ),
  ep(
    "runtimeAssets",
    "GET",
    "/api/cloud/assets/:assetId",
    null,
    null,
    "bootstrap/runtime bundle 分发；版本/hash 清单校验（01 §6）",
  ),
];

/** 端点矩阵按 id 反查（W1–W9 与测试共用的唯一来源）。 */
export function findCloudHttpEndpoint(id: string): CloudHttpEndpointDescriptor | undefined {
  return CLOUD_HTTP_ENDPOINTS.find((endpoint) => endpoint.id === id);
}

/** 错误码在 HTTP 层的建议状态码（03 §6 错误信封；未列出的一律 400）。 */
export const CLOUD_ERROR_HTTP_STATUS: Readonly<Record<string, number>> = {
  unauthenticated: 401,
  unauthorized: 403,
  installation_revoked: 403,
  permission_revoked: 403,
  not_found: 404,
  validation_failed: 400,
  invalid_ref: 400,
  unsupported_template: 400,
  resource_unsupported: 400,
  quota_exceeded: 409,
  budget_exceeded: 409,
  provider_create_unknown: 502,
  provider_termination_unknown: 502,
  bootstrap_failed: 502,
  protocol_incompatible: 409,
  bridge_disconnected: 503,
  provider_unreachable: 503,
  checkpoint_failed: 502,
  non_fast_forward: 409,
  data_at_risk: 409,
  recovery_required: 409,
  attachment_unavailable: 503,
  idempotency_conflict: 409,
  stale: 409,
  not_ready: 409,
  not_implemented: 501,
  not_configured: 503,
  repo_not_found: 404,
  branch_conflict: 409,
  rate_limited: 429,
  network_unknown: 502,
};

/**
 * 错误码 → HTTP 状态码的实施约定（03 §6 错误信封）。spec 明示的状态必须遵守：
 * 跨主体资源 404、删除有活动任务的项目 409、分阶段端点的 501/503、接收时 202。
 * 其余由 W0 冻结，保证 W1–W9 不各自决定；目录完整性由测试断言（每个错误码都有
 * 状态），未知 code 按 CLOUD_ERROR_HTTP_STATUS_DEFAULT 处理。
 */
export const CLOUD_ERROR_HTTP_STATUS_DEFAULT = 400;

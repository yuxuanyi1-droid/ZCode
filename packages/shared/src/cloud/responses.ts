/**
 * Cloud HTTP 响应信封与投影形状（specs/cloud-agent/03 §6、§6.2 响应、02 §7.3/§7.4）。
 *
 * 统一约束（03 §6 尾段）：
 * - 错误信封 `{code,message,retryable,traceId,details?}`，不透传 token/provider 原始响应；
 * - 列表/历史/输入统一 cursor 分页信封 `{items,nextCursor?}`；
 * - 任务详情为 `{task, activeRun?, execution?, latestCheckpoint?}`。
 * 本文件只放响应形状；请求形状在 `http-contracts.ts`，领域实体在 `domain.ts`。
 */
import { z } from "zod";
import { cloudErrorCodeSchema } from "./errors.js";
import {
  cloudCheckpointRecordSchema,
  cloudExecutionStatusSchema,
  cloudProjectRecordSchema,
  cloudRunRecordSchema,
  cloudTaskActionSchema,
  cloudTaskArtifactRecordSchema,
  cloudTaskInputRecordSchema,
  cloudTaskRecordSchema,
  cloudGitObjectIdSchema,
  inputDeliveryStatusSchema,
  CLOUD_TASK_ACTIONS,
} from "./domain.js";
import { commandAckSchema } from "../zcode-protocol-v4/command.js";
import { cloudProjectionKindSchema } from "./bridge-protocol.js";
import { cloudTaskIdSchema, cloudUuidSchema } from "./identity.js";
import { cloudHistoryCursorSchema, CLOUD_HISTORY_LIMIT_MAX } from "./http-contracts.js";
import { cloudWireProtocolVersionSchema, CLOUD_WIRE_PROTOCOL_VERSION } from "./endpoints.js";

const nonEmptyString = z.string().trim().min(1);
const epochMs = z.number().int().nonnegative();

/** traceId 只用于关联日志（03 §9）：不含 prompt、token 或私有代码。 */
export const cloudTraceIdSchema = nonEmptyString.max(128);

/** 错误细节包：必须是合法 JSON 且总体有界；禁止塞入正文、token 或 provider 原始响应。 */
export const CLOUD_ERROR_DETAILS_MAX_JSON_CHARS = 8 * 1024;

export const cloudErrorDetailsSchema = z
  .record(z.string(), z.json())
  .refine(
    (value) => JSON.stringify(value).length <= CLOUD_ERROR_DETAILS_MAX_JSON_CHARS,
    `error details exceed ${CLOUD_ERROR_DETAILS_MAX_JSON_CHARS} chars`,
  );

/** 统一错误信封（03 §6）：新增错误码必须先同步 errors.ts 与对应 spec 章节。 */
export const cloudErrorEnvelopeSchema = z
  .object({
    code: cloudErrorCodeSchema,
    message: nonEmptyString.max(512),
    retryable: z.boolean(),
    traceId: cloudTraceIdSchema,
    details: cloudErrorDetailsSchema.optional(),
  })
  .strict();
export type CloudErrorEnvelope = z.infer<typeof cloudErrorEnvelopeSchema>;

/** cursor 分页信封（03 §6）：`{items,nextCursor?}`，nextCursor 缺失表示已到末页。 */
export function cloudCursorPageSchema<Item extends z.ZodType>(
  item: Item,
  maxItems: number,
): z.ZodType<{ items: z.infer<Item>[]; nextCursor?: string }> {
  return z
    .object({
      items: z.array(item).max(maxItems),
      nextCursor: nonEmptyString.max(512).optional(),
    })
    .strict();
}

/**
 * Execution 投影（08 §3.3）：runtime 来源的执行活动。缺可靠 runtime 事实时
 * status=unknown 并保留 last-known；heartbeat/浏览器在线不算执行活动。
 */
export const cloudExecutionProjectionSchema = z
  .object({
    status: cloudExecutionStatusSchema,
    observedAt: epochMs,
    /** runtime 代际：执行投影更新必须能追溯到来源（08 §3.3）。 */
    runtimeIncarnation: nonEmptyString.max(128).optional(),
  })
  .strict();
export type CloudExecutionProjection = z.infer<typeof cloudExecutionProjectionSchema>;

/** GET /api/cloud/tasks/:taskId 响应（03 §6 端点分阶段语义）。 */
export const taskDetailResponseSchema = z
  .object({
    task: cloudTaskRecordSchema,
    activeRun: cloudRunRecordSchema.optional(),
    execution: cloudExecutionProjectionSchema.optional(),
    /** 最近确认 checkpoint：saved 必须已有 remote SHA 证据（08 §2）。 */
    latestCheckpoint: cloudCheckpointRecordSchema.optional(),
    /** 最近产物投影（分支/PR 状态），与保存状态分离（08 §3.3）。 */
    artifact: cloudTaskArtifactRecordSchema.optional(),
    /**
     * 服务端推导的能力投影（04 §3.3）：客户端只用于呈现与门控；服务端写操作仍独立校验，
     * 客户端不得据此跳过校验（见 `CLOUD_TASK_ACTIONS`）。
     */
    actions: z.array(cloudTaskActionSchema).max(CLOUD_TASK_ACTIONS.length),
  })
  .strict();
export type TaskDetailResponse = z.infer<typeof taskDetailResponseSchema>;

/**
 * 输入接收回执（03 §6）：accepted 只表示控制面已持久接受（202），不表示 runtime
 * 已执行；runtimeAck 是 CLI CommandAck 投影，由 runtime 唯一裁决（02 §6.2）。
 */
export const inputReceiptSchema = z
  .object({
    taskId: cloudTaskIdSchema,
    commandId: cloudUuidSchema,
    deliveryStatus: inputDeliveryStatusSchema,
    runId: cloudUuidSchema.optional(),
    runGeneration: z.number().int().positive().optional(),
    runtimeAck: commandAckSchema.optional(),
  })
  .strict();
export type InputReceipt = z.infer<typeof inputReceiptSchema>;

export const inputRecordPageSchema = cloudCursorPageSchema(cloudTaskInputRecordSchema, 100);
export type InputRecordPage = z.infer<typeof inputRecordPageSchema>;

export const cloudProjectPageSchema = cloudCursorPageSchema(cloudProjectRecordSchema, 100);
export const cloudTaskPageSchema = cloudCursorPageSchema(cloudTaskRecordSchema, 100);

// 分页响应类型别名（W7 CR-6）：SDK/UI 直接引用，不各自 `z.infer` 推导，避免分页信封
// 形状变化时漏改某端。
export type CloudProjectPage = z.infer<typeof cloudProjectPageSchema>;
export type CloudTaskPage = z.infer<typeof cloudTaskPageSchema>;

// ── 仓库与分支（03 §6、09 §2.2、11 §4）──

export const cloudRepositoryAvailabilitySchema = z.enum(["available", "stale", "unavailable"]);

/** 仓库条目：只投影授权与展示事实，不携带 installation token 或 secret。 */
export const cloudRepositoryRecordSchema = z
  .object({
    repositoryId: z.number().int().positive(),
    installationId: z.number().int().positive(),
    owner: nonEmptyString.max(128),
    name: nonEmptyString.max(256),
    defaultBranch: nonEmptyString.max(256).optional(),
    availability: cloudRepositoryAvailabilitySchema,
    /** 最近一次授权校验时间；none 表示尚未校验（09 §2.2 short 缓存语义）。 */
    lastCheckedAt: epochMs.optional(),
  })
  .strict();
export type CloudRepositoryRecord = z.infer<typeof cloudRepositoryRecordSchema>;

export const cloudRepositoryPageSchema = cloudCursorPageSchema(cloudRepositoryRecordSchema, 100);
/** 分页类型别名（W7 CR-6）：SDK 直接引用，避免各端自行推导分页信封。 */
export type CloudRepositoryPage = z.infer<typeof cloudRepositoryPageSchema>;

export const cloudBranchRecordSchema = z
  .object({
    name: nonEmptyString.max(256),
    sha: cloudGitObjectIdSchema,
    isDefault: z.boolean(),
  })
  .strict();
export type CloudBranchRecord = z.infer<typeof cloudBranchRecordSchema>;

export const cloudBranchPageSchema = cloudCursorPageSchema(cloudBranchRecordSchema, 100);
export type CloudBranchPage = z.infer<typeof cloudBranchPageSchema>;

// ── 能力声明（03 §6 capabilities 行、01 §4.1 driver 能力）──

export const sandboxProviderCapabilitiesSchema = z
  .object({
    provider: nonEmptyString.max(64),
    /** 按 operationKey 查询 create 结果的能力（01 §4.1）。 */
    createOperationLookup: z.enum(["native-key", "metadata-search", "none"]),
    canInspect: z.boolean(),
    canExtendDeadline: z.boolean(),
    canConfirmTermination: z.boolean(),
    maxLifetimeSeconds: z.number().int().positive().optional(),
    deadlineSource: z.enum(["provider", "estimated"]),
    supportsOutboundWss: z.boolean(),
    /**
     * 生效 provider key 是否已配置（01 §4.3 修订 2026-10-08、12 §2 修订）：生效 key =
     * credential 存储值 ?? env 部署值。布尔投影，不暴露值与来源细节；key 本体
     * 任何路径不得进响应体（01 §7.1）。
     */
    apiKeyConfigured: z.boolean(),
  })
  .strict();
export type SandboxProviderCapabilities = z.infer<typeof sandboxProviderCapabilitiesSchema>;

export const cloudCapabilitiesResponseSchema = z
  .object({
    mode: z.literal("cloud"),
    /**
     * 当前主体 id（部署/账号 principal）。
     *
     * 用途仅限**客户端 scope 隔离键**（草稿 scope = principal + origin + taskId，04 §3.4.1）：
     * 它**不是认证凭据**，也不含 token——认证仍走 bearer / host lite-token（03 §3）。
     * `GET /api/cloud/capabilities` 是已认证端点，主体 id 非秘密，因此在此返回；
     * 不另开 `/api/cloud/principal`，也不恢复 `ui-bootstrap` 静态投影（决议⑧）。
     */
    principalId: cloudUuidSchema,
    providers: z.array(sandboxProviderCapabilitiesSchema).max(16),
    /** 已启用的客户端能力开关（durable-input / replayable-history 等）。 */
    features: z.array(nonEmptyString.max(64)).max(64),
    /**
     * cloud wire 协议版本，取自 `CLOUD_WIRE_PROTOCOL_VERSION`（W7 CR-1）：不在
     * `CLOUD_WIRE_PROTOCOL_SUPPORTED_VERSIONS` 内的版本必须 fail-closed，归一为
     * `protocol_incompatible`，不得按旧字段猜测解析（00 §8 独立版本化）。
     */
    protocolVersion: cloudWireProtocolVersionSchema,
    /** 是否支持 task-owned 上传；false 时 draft 不发附件（03 §6、11 §9）。 */
    taskOwnedAttachments: z.boolean(),
  })
  .strict();
export type CloudCapabilitiesResponse = z.infer<typeof cloudCapabilitiesResponseSchema>;

/**
 * 本地模式的模式探测响应（04 §2.1，2026-10-07 修订：模式判定服务端驱动）。
 *
 * Web 客户端不再有 `?mode=` / 构建期 `VITE_*`，改为启动时用同源
 * `GET /api/cloud/capabilities` 探测，因此**本地入口也必须无鉴权回答这个端点**：
 * 否则客户端分不清「本地部署」与「不可达」，只能把本地开发误判成错误屏。
 *
 * 本地响应没有主体、没有能力、也没有秘密：`providers`/`features` 是空集，
 * `taskOwnedAttachments` 恒 false（本地没有 cloud task 上传通道）。`protocolVersion`
 * 与云分支同源（同一个 `CLOUD_WIRE_PROTOCOL_VERSION`），两个分支都保持 `.strict()`：
 * 未知字段（含误塞的 principalId）一律拒绝，不用「忽略多余字段」掩盖契约漂移。
 */
export const localCapabilitiesResponseSchema = z
  .object({
    mode: z.literal("local"),
    providers: z.array(sandboxProviderCapabilitiesSchema).max(0),
    features: z.array(nonEmptyString.max(64)).max(0),
    protocolVersion: cloudWireProtocolVersionSchema,
    taskOwnedAttachments: z.literal(false),
  })
  .strict();
export type LocalCapabilitiesResponse = z.infer<typeof localCapabilitiesResponseSchema>;

/**
 * `GET /api/cloud/capabilities` 的响应，按 `mode` 判别联合（04 §2.1）。
 *
 * 云分支字段与冻结前完全一致（`principalId` 仍必填）；本地分支是新增的最小面，
 * 但**保留云分支出现的所有非主体键**（providers/features/protocolVersion/
 * taskOwnedAttachments），使消费方（W8/W9）在模式判定前读这些字段仍是合法访问，
 * 不因分支差异被迫在编译期处处加分支。
 */
export const capabilitiesResponseSchema = z.discriminatedUnion("mode", [
  cloudCapabilitiesResponseSchema,
  localCapabilitiesResponseSchema,
]);
export type CapabilitiesResponse = z.infer<typeof capabilitiesResponseSchema>;

/**
 * 本地探测响应的唯一构造点（本地入口 `http.ts` 与测试共用）。
 *
 * 字段固定为空集/恒 false，协议版本只取 `CLOUD_WIRE_PROTOCOL_VERSION` 这一份来源，
 * 不在入口里写字面量，避免本地与云声明出两个版本号。
 */
export function createLocalCapabilitiesResponse(): LocalCapabilitiesResponse {
  return {
    mode: "local",
    providers: [],
    features: [],
    protocolVersion: CLOUD_WIRE_PROTOCOL_VERSION,
    taskOwnedAttachments: false,
  };
}

// ── 生命周期动作响应（03 §6）──

export const cloudDeletedResponseSchema = z.object({ deleted: z.literal(true) }).strict();
export type CloudDeletedResponse = z.infer<typeof cloudDeletedResponseSchema>;

/** extend：返回 provider 确认期限或明确标记的保守估计；不支持则返回能力错误（01 §4.3）。 */
export const cloudExtensionResponseSchema = z
  .object({
    extended: z.boolean(),
    expiresAt: epochMs.optional(),
    deadlineEstimate: epochMs.optional(),
    deadlineConfidence: z.enum(["low", "medium", "high"]).optional(),
  })
  .strict();
export type CloudExtensionResponse = z.infer<typeof cloudExtensionResponseSchema>;

/** 附件上传响应：owner 级持久引用；浏览器临时路径不得成为 durable 引用（03 §4）。 */
export const cloudAttachmentUploadResponseSchema = z
  .object({
    attachmentId: nonEmptyString.max(128),
    fileName: nonEmptyString.max(256),
    mime: nonEmptyString.max(128),
    bytes: z.number().int().nonnegative(),
    createdAt: epochMs,
  })
  .strict();
export type CloudAttachmentUploadResponse = z.infer<typeof cloudAttachmentUploadResponseSchema>;

/** git grant 兑换响应（01 §7.2）：短效单次、run-scoped；token 只过内存，不落盘、不进日志。 */
export const cloudGitGrantResponseSchema = z
  .object({
    grantId: nonEmptyString.max(128),
    token: nonEmptyString.max(4096),
    expiresAt: epochMs,
    repositoryId: z.number().int().positive(),
    purpose: z.enum(["clone", "fetch", "push"]),
  })
  .strict();
export type CloudGitGrantResponse = z.infer<typeof cloudGitGrantResponseSchema>;

// ── 历史、增量与快照（03 §6、02 §7.3）──

/** 单条历史回放行：与 projection.batch 记录同源（02 §7.1），payload 由服务端解码。 */
export const cloudHistoryItemSchema = z
  .object({
    topic: nonEmptyString.max(256),
    logEpoch: nonEmptyString.max(256),
    /** 执行节点 export cursor（sourceSeq）；与控制面 ingest cursor 分别计量。 */
    seq: z.number().int().nonnegative(),
    kind: cloudProjectionKindSchema,
    payload: z.json(),
    /** 控制面 ingest 时间（epoch 毫秒）；runtime 帧时间在 payload 内。 */
    ts: epochMs,
  })
  .strict();
export type CloudHistoryItem = z.infer<typeof cloudHistoryItemSchema>;

export const cloudHistoryPageSchema = z
  .object({
    items: z.array(cloudHistoryItemSchema).max(CLOUD_HISTORY_LIMIT_MAX),
    nextCursor: cloudHistoryCursorSchema.optional(),
    /** 游标越出保留窗时客户端必须 resync（03 §9）；此处只声明事实不静默从零猜。 */
    resyncRequired: z.boolean().optional(),
  })
  .strict();
export type CloudHistoryPage = z.infer<typeof cloudHistoryPageSchema>;

/** events：有界长轮询增量提示；超时无新记录返回空 items 与 timedOut=true（03 §6）。 */
export const cloudTaskEventsResponseSchema = z
  .object({
    items: z.array(cloudHistoryItemSchema).max(CLOUD_HISTORY_LIMIT_MAX),
    nextCursor: cloudHistoryCursorSchema.optional(),
    timedOut: z.boolean(),
  })
  .strict();
export type CloudTaskEventsResponse = z.infer<typeof cloudTaskEventsResponseSchema>;

/** 权威投影快照：必须声明所覆盖的事件范围（03 §4 projection_snapshots 约束）。 */
export const cloudProjectionSnapshotSchema = z
  .object({
    taskId: cloudTaskIdSchema,
    topic: nonEmptyString.max(256),
    logEpoch: nonEmptyString.max(256),
    /** 快照覆盖到的 sourceSeq（含）：后续 delta 必须从 seq+1 连续。 */
    coveredSourceSeq: z.number().int().nonnegative(),
    snapshot: z.json(),
    createdAt: epochMs,
  })
  .strict();
export type CloudProjectionSnapshot = z.infer<typeof cloudProjectionSnapshotSchema>;

/** SSE 元数据事件：只承载 task.changed/run.changed 与 revision，不承担对话投递（03 §7）。 */
export const cloudMetadataEventSchema = z
  .object({
    kind: z.enum(["task.changed", "run.changed"]),
    entityId: nonEmptyString.max(128),
    revision: z.number().int().nonnegative(),
    at: epochMs,
  })
  .strict();
export type CloudMetadataEvent = z.infer<typeof cloudMetadataEventSchema>;

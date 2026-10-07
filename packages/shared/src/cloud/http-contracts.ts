/**
 * Cloud 控制面对外 HTTP 请求契约（specs/cloud-agent/03 §6 HTTP API 表、§6.1
 * fingerprint 与 recipe、11 §3/§4/§5 创建与草稿）。
 *
 * 全部 wire schema 严格校验：约束长度/枚举、拒绝未知字段；caller 不能指定主体、
 * workspacePath、provider secret 或 trusted role——schema 层直接不收这些字段
 * （03 §6 尾段）。响应信封见 `responses.ts`；端点矩阵与通道分面见 `endpoints.ts`。
 */
import { z } from "zod";
import { cloudDraftStartConfigSchema, cloudExecutionConfigSchema } from "./domain.js";
import { cloudUuidSchema } from "./identity.js";

const nonEmptyString = z.string().trim().min(1);
const positiveGeneration = z.number().int().positive();

/** 输入与错误消息规模上限（03 §6：限制长度与附件总量，超限在 schema 层拒绝）。 */
export const CLOUD_INPUT_LIMITS = {
  promptMaxChars: 200_000,
  maxAttachmentIds: 16,
  attachmentIdMaxChars: 128,
  errorMaxMessageChars: 512,
  titleMaxChars: 512,
  creationKeyMaxChars: 128,
} as const;

const commandIdSchema = cloudUuidSchema;
const promptSchema = z.string().trim().min(1).max(CLOUD_INPUT_LIMITS.promptMaxChars);
const attachmentIdsSchema = z
  .array(nonEmptyString.max(CLOUD_INPUT_LIMITS.attachmentIdMaxChars))
  .max(CLOUD_INPUT_LIMITS.maxAttachmentIds);

/**
 * 附件上传的 multipart 字段名（03 §6 `POST /api/cloud/attachments`，W7 CR-4 冻结）：
 * 单文件字段固定 `file`，可选 `taskId` 表示归属任务；未声明支持 task-owned 上传的
 * 部署返回 `not_configured`，不得静默忽略该字段。SDK/UI/服务端共用本常量，不各自硬编码。
 */
export const CLOUD_ATTACHMENT_UPLOAD_FORM = {
  contentType: "multipart/form-data",
  fileField: "file",
  taskIdField: "taskId",
  /** 单文件：多文件上传由多次请求表达，避免 part 顺序成为隐式协议。 */
  maxFiles: 1,
} as const;
export type CloudAttachmentUploadForm = typeof CLOUD_ATTACHMENT_UPLOAD_FORM;

/** 无请求体的动作端点（stop/extend/complete/archive/reactivate/restore 等）。 */
export const cloudEmptyBodySchema = z.object({}).strict();

// ── Project / Task 元数据（03 §6、11 §4/§5）──

export const createCloudProjectRequestSchema = z
  .object({
    /** 客户端只选 repositoryId；权限由服务端按 09 核验，不接受 owner/name 自证（11 §4.2）。 */
    repositoryId: z.number().int().positive(),
    displayName: nonEmptyString.max(256).optional(),
    /** 响应丢失时以原 key 恢复同一 Project（03 §6 creation key 去重）。 */
    creationKey: nonEmptyString.max(CLOUD_INPUT_LIMITS.creationKeyMaxChars).optional(),
  })
  .strict();
export type CreateCloudProjectRequest = z.infer<typeof createCloudProjectRequestSchema>;

export const patchCloudProjectRequestSchema = z
  .object({
    /** 仅展示元数据；不接受任意 credential/path 改写（03 §6 PATCH projects 行）。 */
    displayName: nonEmptyString.max(256).optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export type PatchCloudProjectRequest = z.infer<typeof patchCloudProjectRequestSchema>;

export const createCloudTaskRequestSchema = z
  .object({
    projectId: cloudUuidSchema,
    title: nonEmptyString.max(CLOUD_INPUT_LIMITS.titleMaxChars),
    /** 稳定创建键：草稿响应丢失后以原 key 恢复，不重复创建（11 §5）。 */
    creationKey: nonEmptyString.max(CLOUD_INPUT_LIMITS.creationKeyMaxChars),
    draftStartConfig: cloudDraftStartConfigSchema.optional(),
  })
  .strict();
export type CreateCloudTaskRequest = z.infer<typeof createCloudTaskRequestSchema>;

export const patchCloudTaskRequestSchema = z
  .object({
    title: nonEmptyString.max(CLOUD_INPUT_LIMITS.titleMaxChars).optional(),
    /** 启动配置只在 draft 可改，且必须随 expectedRevision 提交（03 §6、11 §5）。 */
    draftStartConfig: cloudDraftStartConfigSchema.optional(),
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict()
  .refine(
    (body) => body.title !== undefined || body.draftStartConfig !== undefined,
    "PATCH task requires title or draftStartConfig",
  );
export type PatchCloudTaskRequest = z.infer<typeof patchCloudTaskRequestSchema>;

// ── 输入接纳：start | append（03 §6 输入请求概念契约）──

const taskInputBody = {
  /** 客户端生成、重试不变；与 HTTP 幂等键统一（03 §6.2）。 */
  commandId: commandIdSchema,
  prompt: promptSchema,
  /** 仅声明支持 task-owned 上传的部署开放（03 §6、11 §9 附件边界）。 */
  attachmentIds: attachmentIdsSchema.optional(),
  requestedConfig: cloudExecutionConfigSchema.optional(),
};

/**
 * start 仅属于 draft 首发：携带当前已保存 draftStartConfig 的完整选择与 Task
 * revision，事务验证两者一致；active 上的新 start 冲突，不忽略选择降为 append
 * （03 §6、11 §6）。append 要求当前 ready Run、generation 匹配且无 stopRequested。
 */
export const submitTaskInputSchema = z.discriminatedUnion("intent", [
  z
    .object({
      intent: z.literal("start"),
      ...taskInputBody,
      expectedTaskRevision: z.number().int().nonnegative(),
      start: cloudDraftStartConfigSchema,
    })
    .strict(),
  z
    .object({
      intent: z.literal("append"),
      ...taskInputBody,
      expectedRunGeneration: positiveGeneration,
    })
    .strict(),
]);
export type SubmitTaskInput = z.infer<typeof submitTaskInputSchema>;

/**
 * 幂等撤销：未投递的 outbox 输入经事务 CAS 标 cancelled；已投递但 ACK 未知先对账
 * （02 §6.3）。请求体为空，直接复用 `cloudEmptyBodySchema`，不另立第二份规则。
 */
export type CancelCloudTaskInputRequest = z.infer<typeof cloudEmptyBodySchema>;

/**
 * 恢复选择（08 §9）：有 checkpoint 时新 Run 固定 resumeSha=最后确认 checkpoint SHA；
 * 没有 checkpoint 的任务只能显式选择从冻结 baseSha 重新开始。分支两侧都必须在
 * 请求中显式声明，服务端按持久事实校验可用性。
 */
export const cloudReopenResumeChoiceSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("checkpoint") }).strict(),
  z.object({ mode: z.literal("restart-from-base") }).strict(),
]);
export type CloudReopenResumeChoice = z.infer<typeof cloudReopenResumeChoiceSchema>;

/** 显式重开：独立命令，不借普通 append 自动启动（03 §6、08 §8.2/§9）。 */
export const reopenCloudTaskRequestSchema = z
  .object({
    commandId: commandIdSchema,
    prompt: promptSchema,
    provider: nonEmptyString.max(64),
    resume: cloudReopenResumeChoiceSchema,
    /** Task revision CAS；不匹配返回 stale。 */
    expectedTaskRevision: z.number().int().nonnegative(),
    attachmentIds: attachmentIdsSchema.optional(),
    requestedConfig: cloudExecutionConfigSchema.optional(),
  })
  .strict();
export type ReopenCloudTaskRequest = z.infer<typeof reopenCloudTaskRequestSchema>;

/**
 * force-stop 是单独显式动作：必须携带丢失确认、revision 与 operationId；
 * 不得由普通 stop 失败后自动触发（03 §6、08 §8.2）。
 */
export const forceStopCloudTaskRequestSchema = z
  .object({
    lossAcknowledgement: z.literal(true),
    expectedRevision: z.number().int().nonnegative(),
    operationId: cloudUuidSchema,
  })
  .strict();
export type ForceStopCloudTaskRequest = z.infer<typeof forceStopCloudTaskRequestSchema>;

// ── 能力与列表查询（03 §6、11 §4.1）──

export const cloudRepositoriesQuerySchema = z
  .object({
    cursor: nonEmptyString.max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    /** 展示层搜索；权限过滤在服务端按 installation 授权进行（11 §4.1）。 */
    query: nonEmptyString.max(256).optional(),
  })
  .strict();
export type CloudRepositoriesQuery = z.infer<typeof cloudRepositoriesQuerySchema>;

export const cloudListQuerySchema = z
  .object({
    cursor: nonEmptyString.max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  })
  .strict();
export type CloudListQuery = z.infer<typeof cloudListQuerySchema>;

// ── 历史/事件读取（03 §6、02 §7.3）──

export const CLOUD_HISTORY_LIMIT_MAX = 200;
/** events 有界长轮询上限：避免占满 HTTP 连接（02 §7.3 慢客户端不拖 Bridge）。 */
export const CLOUD_EVENTS_WAIT_MAX_MS = 25_000;

/** 不透明游标 `${logEpoch}:${seq}`；logEpoch 不含 ':' 与空白，客户端只回传不解析。 */
export const cloudHistoryCursorSchema = z
  .string()
  .min(3)
  .max(512)
  .regex(/^[^\s:]+:\d+$/u, "cursor must be <logEpoch>:<seq>");

export const cloudHistoryQuerySchema = z
  .object({
    /** v1 canonical 流是 conversation；缺省即该族名（02 §7.4 实施决议）。 */
    topic: nonEmptyString.max(256).optional(),
    limit: z.coerce.number().int().min(1).max(CLOUD_HISTORY_LIMIT_MAX).optional(),
    cursor: cloudHistoryCursorSchema.optional(),
  })
  .strict();
export type CloudHistoryQuery = z.infer<typeof cloudHistoryQuerySchema>;

export const cloudTaskEventsQuerySchema = z
  .object({
    topic: nonEmptyString.max(256).optional(),
    since: cloudHistoryCursorSchema.optional(),
    /** 有界长轮询：0 = 立即返回（缺省 0）。 */
    waitMs: z.coerce.number().int().min(0).max(CLOUD_EVENTS_WAIT_MAX_MS).optional(),
  })
  .strict();
export type CloudTaskEventsQuery = z.infer<typeof cloudTaskEventsQuerySchema>;

export const cloudSnapshotQuerySchema = z
  .object({
    topic: nonEmptyString.max(256).optional(),
    /** 客户端持有一致状态时携带的 {logEpoch,seq}；epoch 不匹配或越出保留窗则回快照。 */
    logEpoch: nonEmptyString.max(256).optional(),
    cursor: cloudHistoryCursorSchema.optional(),
  })
  .strict();
export type CloudSnapshotQuery = z.infer<typeof cloudSnapshotQuerySchema>;

/**
 * Cloud 领域实体与状态全集（specs/cloud-agent/08 §2 字段表、§3 三态分离、
 * 00 §5 身份与状态）。
 *
 * 这是控制面持久记录对外投影的严格 schema：Task / Run / Execution / 输入回执 /
 * 保存 / PR 状态分别维护——provider 存活不是 CLI 执行，bridge 在线不是任务完成，
 * 202 接收不是 runtime admission（00 §4、08 §3.3）。
 * 时间戳统一 epoch 毫秒（对齐 zcode-protocol-v4 Timestamp，01 §4.1 实施决议）。
 */
import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";
import { commandAckSchema } from "../zcode-protocol-v4/command.js";
import { submissionModeSchema } from "../zcode-protocol-v4/submission.js";
import {
  cloudTaskIdSchema,
  cloudTaskWorkspaceIdentitySchema,
  cloudUuidSchema,
} from "./identity.js";

const nonEmptyString = z.string().trim().min(1);
const epochMs = z.number().int().nonnegative();

/** Git object id：SHA-1（40 hex）或 SHA-256（64 hex）仓库形态。 */
export const cloudGitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);
export type CloudGitObjectId = z.infer<typeof cloudGitObjectIdSchema>;

// ── 状态全集（00 §5、08 §3）──

/** Task：工作委托生命周期（08 §3.1）。 */
export const cloudTaskStatusSchema = z.enum(["draft", "active", "completed", "failed", "archived"]);
export type CloudTaskStatus = z.infer<typeof cloudTaskStatusSchema>;

/**
 * Task 能力投影（04 §3.3）：控制面按状态表 + run/stop/验收事实推导出的**期望动作集**，
 * 与生命周期端点一一对应（03 §6）。
 *
 * 语义：它是**服务端裁决的结果**，客户端只用于呈现与门控（按钮可点/置灰、菜单项）；
 * 服务端在每次写操作时**仍独立校验**同一状态表（04 §3.3 原话），客户端不得据此跳过
 * 校验，也不得自行推导第二份动作表。
 */
export const CLOUD_TASK_ACTIONS = [
  "send-input",
  "cancel-input",
  "stop",
  "force-stop",
  "reopen",
  "extend",
  "complete",
  "archive",
  "reactivate",
  "restore",
] as const;
export const cloudTaskActionSchema = z.enum(CLOUD_TASK_ACTIONS);
export type CloudTaskAction = z.infer<typeof cloudTaskActionSchema>;

/** Run：执行载体/连接状态（08 §3.2 状态机；迁移表在控制面 domain 层）。 */
export const cloudRunStatusSchema = z.enum([
  "provisioning",
  "ready",
  "disconnected",
  "draining",
  "stopped",
  "expired",
  "failed",
]);
export type CloudRunStatus = z.infer<typeof cloudRunStatusSchema>;

/** Execution：runtime 来源的执行投影（08 §3.3）；更新必须有 runtime 来源与 epoch。 */
export const cloudExecutionStatusSchema = z.enum(["unknown", "idle", "running", "awaiting-input"]);
export type CloudExecutionStatus = z.infer<typeof cloudExecutionStatusSchema>;

/** 保存（checkpoint）状态（08 §3.3）：saved 必须有 confirmedRemoteSha 证据。 */
export const checkpointStateSchema = z.enum(["none", "pending", "saving", "saved", "failed"]);
export type CheckpointState = z.infer<typeof checkpointStateSchema>;

/** PR 发布状态（08 §3.3）。 */
export const prPublicationStatusSchema = z.enum([
  "none",
  "creating",
  "draft",
  "open",
  "merged",
  "closed",
  "publication-failed",
]);
export type PrPublicationStatus = z.infer<typeof prPublicationStatusSchema>;

/** 期限置信度（08 §7、01 §4.3）：只能估计期限的 provider 必须标估计并保守 drain。 */
export const cloudDeadlineConfidenceSchema = z.enum(["low", "medium", "high"]);
export type CloudDeadlineConfidence = z.infer<typeof cloudDeadlineConfidenceSchema>;

/**
 * 输入投递状态（03 §6 InputReceipt、02 §6.1 唯一写入路径）：
 * accepted → delivering → admitted/rejected/uncertain/cancelled。
 * 未开始投递的输入可经事务 CAS 标 cancelled，已投递但 ACK 未知必须先对账（02 §6.3）。
 */
export const inputDeliveryStatusSchema = z.enum([
  "accepted",
  "delivering",
  "admitted",
  "rejected",
  "uncertain",
  "cancelled",
]);
export type InputDeliveryStatus = z.infer<typeof inputDeliveryStatusSchema>;

// ── 启动与执行配置（03 §6.1、11 §5/§6）──

/**
 * 输入接纳时固定并计入 payloadHash 的执行配置（03 §6.1）：模型/模式/plan 复用既有
 * 共享类型，不重造；省略的默认值在首次接纳时解析固定，不随浏览器全局设置漂移。
 */
export const cloudExecutionConfigSchema = z
  .object({
    modelSelection: modelSelectionSchema.optional(),
    mode: submissionModeSchema.optional(),
    planEnabled: z.boolean().optional(),
  })
  .strict();
export type CloudExecutionConfig = z.infer<typeof cloudExecutionConfigSchema>;

/**
 * Task 草稿的启动选择（11 §5）：分支取已核验仓库分支，provider 来自服务端
 * capabilities，templateRef 是服务端受控引用（不允许任意镜像/脚本/秘密）。
 * 配置唯一 owner 是控制面 Task 服务；只在 draft 可改并带 expectedRevision。
 */
export const cloudDraftStartConfigSchema = z
  .object({
    baseBranch: nonEmptyString.max(256),
    provider: nonEmptyString.max(64),
    templateRef: nonEmptyString.max(256).optional(),
  })
  .strict();
export type CloudDraftStartConfig = z.infer<typeof cloudDraftStartConfigSchema>;

/**
 * Run 的执行配方（03 §6.1、11 §6）：首次接纳时固定 provider、模板版本/image
 * digest、资源、基础/恢复 SHA、首命令配置与非秘密授权引用；后续 append 不能改写
 * 启动 recipe，secret 只经 broker，不落 payload。
 */
export const cloudExecutionRecipeSchema = z
  .object({
    provider: nonEmptyString.max(64),
    templateRef: nonEmptyString.max(256).optional(),
    templateVersion: nonEmptyString.max(128).optional(),
    imageDigest: nonEmptyString.max(256).optional(),
    /** 资源规格沿用 01 §4.1 driver 契约字段名，不另造第二套。 */
    resources: z
      .object({
        cpu: z.number().positive(),
        memoryMiB: z.number().int().positive(),
        diskGiB: z.number().int().positive(),
      })
      .strict(),
    /** 首次 Run 的冻结基线（11 §6：采用接纳事务中查询到的分支 SHA）。 */
    baseSha: cloudGitObjectIdSchema.optional(),
    /** 重开 Run 的恢复起点（08 §9：最后确认的 checkpoint SHA）。 */
    resumeSha: cloudGitObjectIdSchema.optional(),
    firstCommandConfig: cloudExecutionConfigSchema,
    /** 非秘密授权连接引用；secret 只经 broker 解析（01 §7.1）。 */
    authorizationRef: nonEmptyString.max(128).optional(),
  })
  .strict();
export type CloudExecutionRecipe = z.infer<typeof cloudExecutionRecipeSchema>;

// ── Project（08 §2、11 §4）──
//
// 云 SSH attachment 已按 2026-10-06 范围决议移除（00 §11⑥、08 §4.3）：
// 云 Project 只保留 GitHub 仓库一种类型，`ssh-folder` 与 `sshTargetRef` 不在此契约中。

export const cloudProjectKindSchema = z.enum(["github-repo"]);
export type CloudProjectKind = z.infer<typeof cloudProjectKindSchema>;

export const cloudProjectRecordSchema = z
  .object({
    projectId: cloudUuidSchema,
    ownerPrincipalId: cloudUuidSchema,
    kind: cloudProjectKindSchema,
    /** 仓库数值 ID 是授权/重命名后的关联键；owner/name 只作展示与远端 URL 来源（08 §2）。 */
    repositoryId: z.number().int().positive().optional(),
    installationId: z.number().int().positive().optional(),
    repoOwner: nonEmptyString.max(128).optional(),
    repoName: nonEmptyString.max(256).optional(),
    defaultBranch: nonEmptyString.max(256).optional(),
    /** 可独立编辑的展示名，不能覆盖仓库身份（11 §4.4）。 */
    displayName: nonEmptyString.max(256).optional(),
    /** 元数据 revision CAS（03 §4 projects 行）。 */
    revision: z.number().int().nonnegative(),
    createdAt: epochMs,
    updatedAt: epochMs,
  })
  .strict()
  .superRefine((project, context) => {
    for (const field of ["repositoryId", "repoOwner", "repoName"] as const) {
      if (project[field] === undefined) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: `github-repo project requires ${field}`,
          path: [field],
        });
      }
    }
  });
export type CloudProjectRecord = z.infer<typeof cloudProjectRecordSchema>;

// ── Task（08 §2、03 §4 tasks 表）──

export const cloudTaskRecordSchema = z
  .object({
    taskId: cloudTaskIdSchema,
    ownerPrincipalId: cloudUuidSchema,
    projectId: cloudUuidSchema,
    title: nonEmptyString.max(512),
    status: cloudTaskStatusSchema,
    /** 创建去重键：响应丢失后以原 key 恢复同一 Task，不重复创建（11 §5）。 */
    creationKey: nonEmptyString.max(128),
    /** 草稿启动配置：只有 draft 可改，带 revision CAS（11 §5）。 */
    draftStartConfig: cloudDraftStartConfigSchema.optional(),
    /** 首次接纳后冻结的基线；不并行维护两份可变分支（11 §5 尾段）。 */
    baseBranch: nonEmptyString.max(256).optional(),
    baseSha: cloudGitObjectIdSchema.optional(),
    taskBranch: nonEmptyString.max(256).optional(),
    /** 首次创建时固定为 cloud-task:<taskId>，跨 provider/run 永不改变（08 §4.1）。 */
    workspaceIdentity: cloudTaskWorkspaceIdentitySchema,
    activeRunId: cloudUuidSchema.optional(),
    nextRunGeneration: z.number().int().positive(),
    lastCheckpointSha: cloudGitObjectIdSchema.optional(),
    completeRequested: z.boolean().optional(),
    prRef: nonEmptyString.max(128).optional(),
    /** archived 恢复为原前置状态：恢复后仍需显式 reopen 才获得新 run（03 §6）。 */
    archivedFromStatus: cloudTaskStatusSchema.optional(),
    /** 元数据 revision CAS：PATCH 必须携带 expectedRevision（03 §6、11 §5）。 */
    revision: z.number().int().nonnegative(),
    createdAt: epochMs,
    updatedAt: epochMs,
  })
  .strict()
  .superRefine((task, context) => {
    if (task.workspaceIdentity !== `cloud-task:${task.taskId}`) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "workspaceIdentity must be cloud-task:<taskId> of this task",
        path: ["workspaceIdentity"],
      });
    }
  });
export type CloudTaskRecord = z.infer<typeof cloudTaskRecordSchema>;

// ── ExecutionRun（08 §2、§4.2 代际与租约）──
//
// executionKind 只保留 sandbox（云 SSH attachment 已移除，08 §4.3）。

export const cloudExecutionKindSchema = z.enum(["sandbox"]);
export type CloudExecutionKind = z.infer<typeof cloudExecutionKindSchema>;

export const cloudRunRecordSchema = z
  .object({
    runId: cloudUuidSchema,
    taskId: cloudTaskIdSchema,
    /** Task 内每次新 run 事务性递增；task+generation 唯一（08 §4.2、03 §4 runs 表）。 */
    runGeneration: z.number().int().positive(),
    executionKind: cloudExecutionKindSchema,
    /** 首次接纳事务固定的首命令；重开/新 run 不能用 acceptedAt/UUID 重选（08 §5）。 */
    firstInputCommandId: cloudUuidSchema.optional(),
    executionRecipe: cloudExecutionRecipeSchema.optional(),
    stopRequested: z.boolean().optional(),
    stopOperationId: cloudUuidSchema.optional(),
    provider: nonEmptyString.max(64).optional(),
    providerHandle: nonEmptyString.max(512).optional(),
    /** 当前 Run 真实 checkout 路径；客户端不可指定（08 §4.1）。 */
    workspacePath: nonEmptyString.startsWith("/").optional(),
    status: cloudRunStatusSchema,
    /** 有效 run 每次 attachment 接管递增；旧 epoch 不得投递或发布在线状态（02 §2 不变量 3）。 */
    connectionEpoch: z.number().int().positive(),
    runtimeSessionId: nonEmptyString.max(128).optional(),
    /** provider 确认的到期时间。 */
    expiresAt: epochMs.optional(),
    /** 只能估计期限时的估计值与置信度：以保守截止 drain（08 §7、01 §4.3）。 */
    deadlineEstimate: epochMs.optional(),
    deadlineConfidence: cloudDeadlineConfidenceSchema.optional(),
    hardDeadlineAt: epochMs.optional(),
    /** 只有业务活动更新该字段；heartbeat/观看不算活动（08 §7）。 */
    lastBusinessActivityAt: epochMs.optional(),
    endReason: nonEmptyString.max(256).optional(),
    lastError: nonEmptyString.max(512).optional(),
    /** 保存风险可见：true 时不得宣称工作全部保住（08 §8.2）。 */
    dataAtRisk: z.boolean(),
    createdAt: epochMs,
    updatedAt: epochMs,
  })
  .strict()
  .superRefine((run, context) => {
    if (run.executionKind === "sandbox" && run.provider === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "sandbox run requires provider",
        path: ["provider"],
      });
    }
  });
export type CloudRunRecord = z.infer<typeof cloudRunRecordSchema>;

// ── TaskInput（08 §2、03 §6 输入契约）──

/** 输入意图：start 只属于 draft 首发，append 绑定当前 generation，reopen 独立显式（03 §6、08 §9）。 */
export const cloudTaskInputIntentSchema = z.enum(["start", "append", "reopen"]);
export type CloudTaskInputIntent = z.infer<typeof cloudTaskInputIntentSchema>;

/**
 * 输入记录投影：正文只经受控投影读取（03 §6 GET inputs 行），本记录只保存
 * fingerprint、附件引用与配置快照，不保存正文本身、也不保存任何 secret。
 */
export const cloudTaskInputRecordSchema = z
  .object({
    taskId: cloudTaskIdSchema,
    commandId: cloudUuidSchema,
    intent: cloudTaskInputIntentSchema,
    /** 规范结构化编码的 fingerprint：同 key 不同 payload 409（02 §6.2、03 §6.1）。 */
    payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
    /** Task 内事务性递增的持久投递顺序；不是 CLI admissionSeq（03 §6.2）。 */
    acceptanceSeq: z.number().int().positive(),
    attachmentRefs: z.array(nonEmptyString.max(128)).max(16).optional(),
    requestedConfig: cloudExecutionConfigSchema.optional(),
    /** 该命令解析后的执行配置；不得改写 Run 的启动 recipe（03 §6.1）。 */
    resolvedExecutionConfig: cloudExecutionConfigSchema.optional(),
    /** 非秘密授权连接引用；secret 仅经 broker 解析（01 §7.1）。 */
    resolvedAuthorizationRef: nonEmptyString.max(128).optional(),
    /** 显式重试/重开关联的原失败记录；不伪装旧命令执行成功（08 §5）。 */
    retryOfCommandId: cloudUuidSchema.optional(),
    acceptedAt: epochMs,
    targetRunId: cloudUuidSchema.optional(),
    runtimeSessionId: nonEmptyString.max(128).optional(),
    deliveryStatus: inputDeliveryStatusSchema,
    /** runtime 唯一裁决的 CommandAck 投影（02 §6.2）；控制面不得伪造 accepted。 */
    runtimeAck: commandAckSchema.optional(),
    lastError: nonEmptyString.max(512).optional(),
  })
  .strict();
export type CloudTaskInputRecord = z.infer<typeof cloudTaskInputRecordSchema>;

// ── Checkpoint（08 §2、§8 统一 checkpoint/stop 通路）──

export const cloudCheckpointRecordSchema = z
  .object({
    operationId: cloudUuidSchema,
    taskId: cloudTaskIdSchema,
    runId: cloudUuidSchema,
    runGeneration: z.number().int().positive(),
    state: checkpointStateSchema,
    /** 允许提交的文件范围：尊重 gitignore 与显式排除（08 §8.2）。 */
    includedFiles: z.array(nonEmptyString.max(1024)).max(4096),
    localSha: cloudGitObjectIdSchema.optional(),
    /** 仅当远端 ref 查询确认后才允许出现：saved 必须有 remote SHA 证据（08 §8.2）。 */
    confirmedRemoteSha: cloudGitObjectIdSchema.optional(),
    riskSummary: nonEmptyString.max(512).optional(),
    createdAt: epochMs,
    updatedAt: epochMs,
  })
  .strict()
  .superRefine((checkpoint, context) => {
    if (checkpoint.state === "saved" && checkpoint.confirmedRemoteSha === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "saved checkpoint requires confirmedRemoteSha",
        path: ["confirmedRemoteSha"],
      });
    }
  });
export type CloudCheckpointRecord = z.infer<typeof cloudCheckpointRecordSchema>;

// ── TaskArtifact（08 §2、§9、09）──

export const cloudTaskArtifactRecordSchema = z
  .object({
    taskId: cloudTaskIdSchema,
    /** 无差异的调查/答疑允许 kind=noChanges 且必须有持久结果摘要，不创建空 PR（08 §9）。 */
    kind: z.enum(["code", "noChanges"]),
    taskBranch: nonEmptyString.max(256).optional(),
    prHead: nonEmptyString.max(256).optional(),
    prBase: nonEmptyString.max(256).optional(),
    prNumber: z.number().int().positive().optional(),
    prUrl: nonEmptyString.max(512).optional(),
    prStatus: prPublicationStatusSchema,
    publishedSha: cloudGitObjectIdSchema.optional(),
    summaryRef: nonEmptyString.max(128).optional(),
    lastCheckedAt: epochMs.optional(),
  })
  .strict()
  .superRefine((artifact, context) => {
    if (artifact.kind === "code" && artifact.taskBranch === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "code artifact requires taskBranch",
        path: ["taskBranch"],
      });
    }
    if (artifact.kind === "noChanges" && artifact.summaryRef === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "noChanges artifact requires summaryRef",
        path: ["summaryRef"],
      });
    }
  });
export type CloudTaskArtifactRecord = z.infer<typeof cloudTaskArtifactRecordSchema>;

/**
 * Cloud Bridge 控制协议契约（specs/cloud-agent/02 §4 地址与网络帧、§5 握手、
 * §7.1 结构化投影记录）。
 *
 * 控制面（`packages/server/src/cloud`）与沙箱 bridge（`cloud/execution`）之间的
 * WSS 控制帧带版本化 discriminator；未知版本必须整帧拒绝（fail-closed），不得
 * 按旧字段猜测解析（02 §4 尾段）。所有帧 `.strict()`：未知字段、越界尺寸一律拒。
 * 时间戳统一 epoch 毫秒（对齐 zcode-protocol-v4 Timestamp）。
 */
import { z } from "zod";
import { cloudErrorCodeSchema } from "./errors.js";
import {
  cloudTaskIdSchema,
  cloudTaskWorkspaceIdentitySchema,
  cloudUuidSchema,
} from "./identity.js";

export const CLOUD_BRIDGE_PROTOCOL_VERSION = 1 as const;

/** 帧级协议版本 discriminator；升级协议时递增并按版本路由（00 §8：bridge protocol 独立版本化）。 */
export const cloudBridgeProtocolVersionSchema = z.literal(CLOUD_BRIDGE_PROTOCOL_VERSION);

const positiveGeneration = z.number().int().positive();
const nonEmptyString = z.string().trim().min(1);
const epochMs = z.number().int().nonnegative();

/** SHA-256 十六进制内容哈希（contentHash / payloadHash 共用形态）。 */
export const cloudSha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/** Git object id：SHA-1（40 hex）或 SHA-256（64 hex）。 */
export const cloudBridgeGitObjectIdSchema = z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/);

// ── 地址（02 §4）──

export const cloudRunAddressSchema = z
  .object({
    taskId: cloudTaskIdSchema,
    runId: cloudUuidSchema,
    /** Task 内单调正整数，由控制面在事务中递增签发（02 §2 不变量 3）。 */
    runGeneration: positiveGeneration,
    /** 仓库任务恒为 cloud-task:<taskId>；路由不得从 identity 推导执行路径。 */
    workspaceIdentity: cloudTaskWorkspaceIdentitySchema,
    /** 当前 Run 真实 checkout 路径（沙箱内绝对 posix 路径），由服务端下发。 */
    workspacePath: nonEmptyString.startsWith("/"),
    /** 当前 Run attachment 的路由键（`remoteSessionId`，与本地/SSH 模式同名字段）。 */
    remoteSessionId: nonEmptyString,
  })
  .strict();
export type CloudRunAddress = z.infer<typeof cloudRunAddressSchema>;

export const cloudAttachmentAddressSchema = cloudRunAddressSchema
  .extend({
    /** Run 内单调；新 socket 接管时由数据库 CAS 递增，旧 epoch 无写权（02 §5.1）。 */
    connectionEpoch: positiveGeneration,
  })
  .strict();
export type CloudAttachmentAddress = z.infer<typeof cloudAttachmentAddressSchema>;

// ── 结构化投影记录（02 §7.1）──

export const CLOUD_PROJECTION_SCHEMA_VERSION = 1 as const;

/** 单条投影 payload 的有界 JSON 尺寸（02 §8：容量耗尽禁止无限内存与静默丢记录）。 */
export const CLOUD_PROJECTION_PAYLOAD_MAX_JSON_CHARS = 512 * 1024;

export const cloudProjectionKindSchema = z.enum([
  "snapshot",
  "delta",
  "command-result",
  "lifecycle",
]);
export type CloudProjectionKind = z.infer<typeof cloudProjectionKindSchema>;

/**
 * payload 的 topic 级严格 schema 由 canonical 投影契约（V4 conversation topic）
 * 决定，属 W6/执行节点侧（02 §7.1、§7.4 实施决议）；W0 只冻结「必须是合法 JSON
 * 且有界」，不用 unknown 兜业务字段。
 */
export const cloudProjectionPayloadSchema = z
  .json()
  .refine(
    (value) => JSON.stringify(value).length <= CLOUD_PROJECTION_PAYLOAD_MAX_JSON_CHARS,
    `projection payload exceeds ${CLOUD_PROJECTION_PAYLOAD_MAX_JSON_CHARS} chars`,
  );

export const cloudProjectionRecordSchema = z
  .object({
    schemaVersion: z.literal(CLOUD_PROJECTION_SCHEMA_VERSION),
    taskId: cloudTaskIdSchema,
    runId: cloudUuidSchema,
    runGeneration: positiveGeneration,
    /** runtime 进程代际（重启后变化）；与网络 connectionEpoch 是不同维度（02 §7.1）。 */
    runtimeIncarnation: nonEmptyString,
    topic: nonEmptyString,
    /** 内容代际 logEpoch，不是 connectionEpoch。 */
    logEpoch: nonEmptyString,
    /** topic/epoch 内单调的执行节点持久 export cursor（0 起）。 */
    sourceSeq: z.number().int().nonnegative(),
    kind: cloudProjectionKindSchema,
    payload: cloudProjectionPayloadSchema,
    contentHash: cloudSha256HexSchema,
  })
  .strict();
export type CloudProjectionRecord = z.infer<typeof cloudProjectionRecordSchema>;

/**
 * 持久去重键：(runId, runtimeIncarnation, topic, logEpoch, sourceSeq)。
 * 同键同 contentHash 幂等；同键不同 contentHash 是一致性 fault（02 §7.1）。
 */
export function cloudProjectionDedupKey(record: {
  runId: string;
  runtimeIncarnation: string;
  topic: string;
  logEpoch: string;
  sourceSeq: number;
}): string {
  return [
    record.runId,
    record.runtimeIncarnation,
    record.topic,
    record.logEpoch,
    record.sourceSeq,
  ].join("\u0000");
}

/** 源流水位：topic + logEpoch 内的连续 sourceSeq（ACK 只覆盖连续持久水位，不跳缺口）。 */
export const cloudStreamCursorSchema = z
  .object({
    topic: nonEmptyString,
    logEpoch: nonEmptyString,
    sourceSeq: z.number().int().nonnegative(),
  })
  .strict();
export type CloudStreamCursor = z.infer<typeof cloudStreamCursorSchema>;

// ── 控制帧（02 §4 帧表）──
// 所有帧 .strict()：未知字段/未知版本整帧拒绝后再路由。

export const bridgeHelloFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("bridge.hello"),
    address: cloudRunAddressSchema,
    helloAttemptId: cloudUuidSchema,
    /** 当前凭据（证明材料）：控制面只持久其 hash，禁止进入日志（02 §5.1）。 */
    credentialToken: nonEmptyString,
    /** 发送前已在 Bridge 本地持久化的候选 resume token（02 §5.2 旋转恢复算法）。 */
    candidateNextResumeToken: nonEmptyString,
    runtimeIncarnation: nonEmptyString,
  })
  .strict();
export type BridgeHelloFrame = z.infer<typeof bridgeHelloFrameSchema>;

export const bridgeWelcomeFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("bridge.welcome"),
    /** 本次 attachment 的接管结果；同 socket 重复 hello 返回原 epoch（02 §5.1）。 */
    connectionEpoch: positiveGeneration,
    /** 相同 attemptId 且内容一致时复用的旋转标识（02 §5.1 第 5 条）。 */
    rotationId: nonEmptyString,
    /** 本控制面允许 bridge 使用的 capability 清单。 */
    capabilities: z.array(nonEmptyString.max(64)).max(64),
    /** 各源流的持久 ingest 水位；bridge 据此决定 snapshot/续传起点（02 §7.3）。 */
    ingestCursors: z.array(cloudStreamCursorSchema).max(64),
    policyVersion: nonEmptyString,
  })
  .strict();
export type BridgeWelcomeFrame = z.infer<typeof bridgeWelcomeFrameSchema>;

/** `provisioningEnvelopeJson` 的有界尺寸（12 §6：envelope 只经认证通道下发，不进日志）。 */
export const CLOUD_BOOTSTRAP_ENVELOPE_JSON_MAX_CHARS = 256 * 1024;

/**
 * clone 事实（01 §6.2 步骤 2–4）：首次 Run 从冻结 baseSha 建 taskBranch；重开按
 * lastCheckpointSha 核对远端。`baseSha` 形状即 git object id，非法形状由控制面拒绝。
 */
export const bootstrapCloneFactsSchema = z
  .object({
    repositoryId: z.number().int().positive(),
    /** `owner/name`：展示与 clone origin 来源；权限仍按 repositoryId 核验（11 §4.3）。 */
    repositoryFullName: nonEmptyString.max(256),
    baseSha: cloudBridgeGitObjectIdSchema,
    taskBranch: nonEmptyString.max(256),
  })
  .strict();
export type BootstrapCloneFacts = z.infer<typeof bootstrapCloneFactsSchema>;

/**
 * 控制面 → Bridge：welcome 之后、ready 之前下发运行配置、clone 事实与 provisioning
 * envelope（02 §4、01 §6.2、12 §6）。
 *
 * 为什么不走 provider env/元数据：provider API 对 provider env 与元数据可读，不得承载
 * 凭据；provider 命令通道只下发自举要素（runId/runGeneration/ticket/operationKey/
 * publicOrigin）。本帧走已认证的 bridge 通道，run 由 socket 绑定，故帧内不再声明地址。
 *
 * `provisioningEnvelopeJson` 只冻结为有界字符串：envelope 内部结构归 provisioning
 * 契约所有，shared 不复刻其 schema。凭据正文禁止进日志。
 */
export const bootstrapConfigFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("bootstrap.config"),
    taskId: cloudTaskIdSchema,
    /** 当前 Run 真实 checkout 路径（沙箱内绝对 posix 路径）；identity 不作 cwd（01 §6.2 步骤 2）。 */
    workspacePath: nonEmptyString.startsWith("/"),
    clone: bootstrapCloneFactsSchema,
    provisioningEnvelopeJson: nonEmptyString.max(CLOUD_BOOTSTRAP_ENVELOPE_JSON_MAX_CHARS),
    /** 账号/app 凭据代际：供 A-08 核对，bridge 发现落后于本地已安装代际时按 fault 上报（12 §6）。 */
    credentialGeneration: z.number().int().nonnegative(),
    policyVersion: nonEmptyString.max(64),
  })
  .strict();
export type BootstrapConfigFrame = z.infer<typeof bootstrapConfigFrameSchema>;

export const bridgeReadyFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("bridge.ready"),
    connectionEpoch: positiveGeneration,
    configVersion: nonEmptyString,
    runtimeIncarnation: nonEmptyString,
    /** ready 门控（02 §5.3）：exporter/WAL 可写是 ready 的必要条件。 */
    exporterReady: z.boolean(),
    walReady: z.boolean(),
    executionCapabilities: z.array(nonEmptyString.max(64)).max(64),
  })
  .strict();
export type BridgeReadyFrame = z.infer<typeof bridgeReadyFrameSchema>;

export const bridgeHeartbeatFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("bridge.heartbeat"),
    connectionEpoch: positiveGeneration,
    processAlive: z.boolean(),
    /** 脱敏活动摘要：不含 prompt、token 或完整工具输出（02 §9）。 */
    activitySummary: nonEmptyString.max(512),
    /** WAL 中尚未获得持久 ACK 的各源流水位。 */
    walHighWatermarks: z.array(cloudStreamCursorSchema).max(64),
    /** heartbeat 不是轮次/权限裁决，也不证明业务活跃（08 §7）。 */
    sentAt: epochMs,
  })
  .strict();
export type BridgeHeartbeatFrame = z.infer<typeof bridgeHeartbeatFrameSchema>;

export const bridgePhaseFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("bridge.phase"),
    phase: z.enum([
      "registering",
      "cloning",
      "handshaking",
      "installing-config",
      "exporter-starting",
      "reconciling",
    ]),
    errorCode: cloudErrorCodeSchema.optional(),
    /** 脱敏诊断（有界）；无 token/prompt/秘密（01 §5.2）。 */
    diagnostics: nonEmptyString.max(512).optional(),
  })
  .strict();
export type BridgePhaseFrame = z.infer<typeof bridgePhaseFrameSchema>;

export const bridgeFaultFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("bridge.fault"),
    faultCode: cloudErrorCodeSchema,
    message: nonEmptyString.max(512),
    /** 是否可用同一幂等键安全地自动重试（见 errors.ts 的 retryable 语义）。 */
    retryable: z.boolean(),
    /** 关联的 attachment 代际；鉴权阶段（welcome 之前）无代际，故可选（02 §2 不变量 3）。 */
    connectionEpoch: positiveGeneration.optional(),
  })
  .strict();
export type BridgeFaultFrame = z.infer<typeof bridgeFaultFrameSchema>;

export const bridgeDrainFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("bridge.drain"),
    /** drain 关联的持久 lifecycle operationId（幂等键，08 §8.1 停止屏障）。 */
    operationId: cloudUuidSchema,
    reason: z.enum(["user-stop", "idle", "hard-deadline", "reclaim"]),
    connectionEpoch: positiveGeneration.optional(),
  })
  .strict();
export type BridgeDrainFrame = z.infer<typeof bridgeDrainFrameSchema>;

// ── checkpoint 控制帧（02 §4 帧表、01 §8 保存/停止通路、08 §8.1 事实要求）──
//
// 这两帧只承载「保存/停止通路」的结果，不替代 outbox operation 事实：result 未确认时
// 按 operationId 对账，不重做 commit、不伪造 saved（02 §4 尾段）。

/** 保存触发来源：stop/硬期限 drain 的保存依赖 terminate；manual 是显式动作（08 §8）。 */
export const checkpointPurposeSchema = z.enum(["stop", "drain", "manual"]);
export type CheckpointPurpose = z.infer<typeof checkpointPurposeSchema>;

/**
 * 控制面 → Bridge：要求沙箱对当前 run 执行一次 checkpoint（固定文件范围、正常 push
 * 禁止 force）。operationId 与 outbox operation 同键：bridge 重放同一 operationId 必须
 * 复用结果，不能产生第二个保存事实（01 §8）。
 */
export const checkpointRequestFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("checkpoint.request"),
    operationId: cloudUuidSchema,
    runId: cloudUuidSchema,
    runGeneration: positiveGeneration,
    /** 发送时的 attachment 路由代际；新 socket 接管后旧 request 不适用（02 §2 不变量 3）。 */
    connectionEpoch: positiveGeneration,
    purpose: checkpointPurposeSchema,
  })
  .strict();
export type CheckpointRequestFrame = z.infer<typeof checkpointRequestFrameSchema>;

/**
 * Bridge → 控制面：一次 checkpoint 的结果。只有 status=saved 且携带 remoteSha 才允许
 * 控制面写 confirmedRemoteSha（远端 SHA 核验由沙箱 push 通路完成）；failed/unknown 不得
 * 被当成已保存（08 §8.1「保存失败不伪装 saved」）。
 * 代际校验由承载该帧的已认证 attachment socket 承担——帧内不重复声明 epoch，避免与
 * socket 事实不一致；correlation 一律走 operationId。
 */
export const checkpointResultFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("checkpoint.result"),
    operationId: cloudUuidSchema,
    status: z.enum(["saved", "failed", "unknown"]),
    /** 保存所在任务分支（status=saved 时控制面要求非空，08 §8.1）。 */
    branch: nonEmptyString.max(256).optional(),
    /** push 后核验的远端 SHA；形状即 git object id，非法形状由控制面 fail-closed 对账。 */
    remoteSha: cloudBridgeGitObjectIdSchema.optional(),
    /**
     * 本次 checkpoint 是否生成了沙箱侧收口提交（08 §8.1）：工作区干净时不建空提交，
     * 此时 false。additive 可选字段——缺席表示旧沙箱未上报，控制面不得据缺席推断「有提交」；
     * false 是「相对 HEAD 无暂存差异」的事实，供控制面记 no-changes 并避免空 PR，不改变保存判定。
     */
    hadNewCommits: z.boolean().optional(),
    /** 归一错误码（01 §9 目录）；failed/unknown 时携带，不透传 provider 原始错误。 */
    errorCode: cloudErrorCodeSchema.optional(),
    /** 脱敏诊断（有界）；无 token/prompt/私有代码。 */
    error: nonEmptyString.max(512).optional(),
  })
  .strict()
  .superRefine((frame, context) => {
    if (frame.status === "saved" && frame.remoteSha === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "saved checkpoint result requires remoteSha evidence",
        path: ["remoteSha"],
      });
    }
  });
export type CheckpointResultFrame = z.infer<typeof checkpointResultFrameSchema>;

export const CLOUD_PROJECTION_BATCH_MAX_RECORDS = 256;

export const projectionBatchFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("projection.batch"),
    /** 网络批次携带 attachment epoch；record 本身不含网络代际，可跨连接重投（02 §7.1）。 */
    connectionEpoch: positiveGeneration,
    records: z.array(cloudProjectionRecordSchema).min(1).max(CLOUD_PROJECTION_BATCH_MAX_RECORDS),
  })
  .strict();
export type ProjectionBatchFrame = z.infer<typeof projectionBatchFrameSchema>;

export const projectionAckFrameSchema = z
  .object({
    protocolVersion: cloudBridgeProtocolVersionSchema,
    type: z.literal("projection.ack"),
    connectionEpoch: positiveGeneration,
    topic: nonEmptyString,
    logEpoch: nonEmptyString,
    /** 已连续持久化的 sourceSeq；不跨缺口确认（02 §7.1）。 */
    lastContiguousSourceSeq: z.number().int().nonnegative(),
    /** 控制面持久 ingest cursor 的不透明表示；bridge 只按源流 sourceSeq 清 WAL。 */
    ingestCursor: nonEmptyString,
  })
  .strict();
export type ProjectionAckFrame = z.infer<typeof projectionAckFrameSchema>;

/** 控制帧全集；按 type discriminate，未列出的一律拒绝。 */
export const cloudBridgeControlFrameSchema = z.discriminatedUnion("type", [
  bridgeHelloFrameSchema,
  bridgeWelcomeFrameSchema,
  bootstrapConfigFrameSchema,
  bridgeReadyFrameSchema,
  bridgeHeartbeatFrameSchema,
  bridgePhaseFrameSchema,
  bridgeFaultFrameSchema,
  bridgeDrainFrameSchema,
  checkpointRequestFrameSchema,
  checkpointResultFrameSchema,
  projectionBatchFrameSchema,
  projectionAckFrameSchema,
]);
export type CloudBridgeControlFrame = z.infer<typeof cloudBridgeControlFrameSchema>;
export type CloudBridgeFrameType = CloudBridgeControlFrame["type"];

// ── 方向（02 §4 帧表）──
// 同一 wire 上的联合 schema 不区分方向；方向在两侧路由处 fail-closed 校验：
// 收到本方向之外的帧即整条连接作废。

export type CloudBridgeFrameDirection =
  | "control-plane-to-bridge"
  | "bridge-to-control-plane"
  | "both";

/**
 * 每个帧型的合法方向。`bridge.fault` / `bridge.drain` 按 02 §4 帧表冻结为双向
 * （鉴权、协议、容量、撤销与受控回收两侧都可能发起）；`projection.batch` /
 * `projection.ack` 按 02 §7.2 写入与确认顺序各取单向；`checkpoint.request` /
 * `checkpoint.result` 按 02 §4 保存/停止通路各取单向；`bootstrap.config` 是控制面
 * 在 welcome 之后向 bridge 下发的单向帧（02 §4、01 §6.2）。
 */
export const CLOUD_BRIDGE_FRAME_DIRECTIONS: Readonly<
  Record<CloudBridgeFrameType, CloudBridgeFrameDirection>
> = {
  "bridge.hello": "bridge-to-control-plane",
  "bridge.welcome": "control-plane-to-bridge",
  "bootstrap.config": "control-plane-to-bridge",
  "bridge.ready": "bridge-to-control-plane",
  "bridge.heartbeat": "bridge-to-control-plane",
  "bridge.phase": "bridge-to-control-plane",
  "bridge.fault": "both",
  "bridge.drain": "both",
  "checkpoint.request": "control-plane-to-bridge",
  "checkpoint.result": "bridge-to-control-plane",
  "projection.batch": "bridge-to-control-plane",
  "projection.ack": "control-plane-to-bridge",
};

/** 该帧型是否允许入站到 receiver（否则是反向帧，必须整帧拒绝）。 */
export function isCloudBridgeFrameInboundAllowed(
  type: CloudBridgeFrameType,
  receiver: "control-plane" | "bridge",
): boolean {
  const direction = CLOUD_BRIDGE_FRAME_DIRECTIONS[type];
  if (direction === "both") return true;
  return receiver === "control-plane"
    ? direction === "bridge-to-control-plane"
    : direction === "control-plane-to-bridge";
}

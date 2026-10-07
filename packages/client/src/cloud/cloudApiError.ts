/**
 * Cloud SDK 错误归一（specs/cloud-agent/03 §6 错误信封、§6.2 投递与失败、00 §8 版本纪律）。
 *
 * 规则：
 * 1) 语义判定只读 `code` / `retryable` / `httpStatus`；`message` 只用于展示，SDK 与上层
 *    都不得解析文案（03 §6 尾段「不依赖错误文案解析」、04 §6「UI 不解析异常文字」）。
 * 2) 错误码一律取 shared 的 `CloudErrorCode` 目录，SDK 不新增平行错误码；`source` 只说明
 *    这条错误是服务端信封还是 SDK 本地判定，避免上层把本地配置问题当成服务端拒绝。
 * 3) 响应体不符合冻结信封时 fail-closed：不按状态码猜语义（00 §8 未知版本整帧拒绝）。
 * 4) `CloudResyncRequiredError` 是客户端恢复控制信号（cursor 越出保留窗 / logEpoch 变化），
 *    不是 wire 错误码——wire 侧只以 `cloudHistoryPageSchema.resyncRequired` 声明事实（03 §9）。
 */
import {
  CLOUD_ERROR_RETRYABLE,
  cloudErrorDetailsSchema,
  cloudErrorEnvelopeSchema,
  isCloudErrorCode,
  type CloudErrorCode,
  type CloudErrorEnvelope,
} from "@zcode/shared";

/** 错误来源：不引入新错误码，只标注判定发生在哪一侧。 */
export type CloudApiErrorSource =
  /** 服务端返回的冻结错误信封（03 §6）。 */
  | "envelope"
  /** HTTP 传输层失败：超时、网络错误、连接中断，服务端结果未知。 */
  | "transport"
  /** wire 不符合冻结契约：未知字段、未知协议版本、非 JSON 信封。 */
  | "protocol"
  /** SDK 在发出请求前按冻结 request schema 拒绝的本地校验失败。 */
  | "validation"
  /** SDK 配置错误：origin 非法、缺少 taskId、端点不在冻结矩阵里。 */
  | "configuration"
  /** attachment 连接状态：未连接 / 已断，可用同一订阅重新建立（07 §9）。 */
  | "connection";

export interface CloudApiErrorInit {
  readonly code: CloudErrorCode;
  readonly message: string;
  readonly retryable: boolean;
  readonly source: CloudApiErrorSource;
  readonly traceId?: string | undefined;
  readonly details?: CloudErrorEnvelope["details"];
  readonly httpStatus?: number | undefined;
  /** 调用方自己的 AbortSignal 触发的中断；与超时区分，不做自动重试。 */
  readonly canceled?: boolean | undefined;
}

/**
 * 类型化错误：所有 SDK 失败路径的统一出口。
 * `retryable` 语义沿用 shared（=true 表示可用同一幂等键安全重试同一操作），SDK 不重新推导。
 */
export class CloudApiError extends Error {
  readonly code: CloudErrorCode;
  readonly retryable: boolean;
  readonly source: CloudApiErrorSource;
  readonly traceId: string | undefined;
  readonly details: CloudErrorEnvelope["details"] | undefined;
  readonly httpStatus: number | undefined;
  readonly canceled: boolean;

  constructor(init: CloudApiErrorInit) {
    super(init.message);
    this.name = "CloudApiError";
    this.code = init.code;
    this.retryable = init.retryable;
    this.source = init.source;
    this.traceId = init.traceId;
    this.details = init.details;
    this.httpStatus = init.httpStatus;
    this.canceled = init.canceled ?? false;
  }

  /** 直接用服务端信封构造：code/retryable/traceId/details 原样保留，不参与文案解析。 */
  static fromEnvelope(
    envelope: CloudErrorEnvelope,
    options?: {
      readonly httpStatus?: number | undefined;
      readonly source?: CloudApiErrorSource | undefined;
    },
  ): CloudApiError {
    return new CloudApiError({
      code: envelope.code,
      message: envelope.message,
      retryable: envelope.retryable,
      source: options?.source ?? "envelope",
      traceId: envelope.traceId,
      details: envelope.details,
      httpStatus: options?.httpStatus,
    });
  }

  /** 还原信封形状，便于测试与日志关联；不携带 response 原文。 */
  toEnvelope(): CloudErrorEnvelope {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      traceId: this.traceId ?? "sdk-local",
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function isCloudApiError(value: unknown): value is CloudApiError {
  return value instanceof CloudApiError;
}

/** 只认冻结信封；解析失败返回 undefined，由调用方 fail-closed。 */
export function readCloudErrorEnvelope(payload: unknown): CloudErrorEnvelope | undefined {
  const parsed = cloudErrorEnvelopeSchema.safeParse(payload);
  return parsed.success ? parsed.data : undefined;
}

/** SDK 本地校验失败（发出请求前）：语义等价于服务端 `validation_failed`，但不占用网络往返。 */
export function cloudValidationError(message: string, details?: CloudErrorEnvelope["details"]) {
  return new CloudApiError({
    code: "validation_failed",
    message,
    retryable: false,
    source: "validation",
    details,
  });
}

/** wire 违约（未知字段、未知协议版本、非 JSON 信封）：拒绝而不是猜测（00 §8）。 */
export function cloudProtocolError(message: string, details?: CloudErrorEnvelope["details"]) {
  return new CloudApiError({
    code: "protocol_incompatible",
    message,
    retryable: false,
    source: "protocol",
    details,
  });
}

/** SDK 配置错误（origin/taskId/端点 id）。 */
export function cloudConfigurationError(message: string, details?: CloudErrorEnvelope["details"]) {
  return new CloudApiError({
    code: "validation_failed",
    message,
    retryable: false,
    source: "configuration",
    details,
  });
}

/**
 * HTTP 传输失败：服务端结果未知。retryable=true 只表示可用同一幂等键重试
 * （写操作必须复用原 commandId/creationKey，见 03 §6.2）。
 */
export function cloudTransportError(
  message: string,
  options?: { readonly canceled?: boolean; readonly details?: CloudErrorEnvelope["details"] },
) {
  return new CloudApiError({
    code: "network_unknown",
    message,
    retryable: options?.canceled !== true,
    source: "transport",
    details: options?.details,
    canceled: options?.canceled,
  });
}

/**
 * attachment 不可用：断线时的在线文件/终端/git 操作用 `attachment_unavailable`
 * （shared errors.ts 的目录语义：retryable 只表示 attachment 恢复后可重试同一操作），
 * UI 据此显示不可用面，不回落本机执行域（04 §6、07 §9）。
 */
export function cloudAttachmentUnavailableError(message: string, retryable = true) {
  return new CloudApiError({
    code: "attachment_unavailable",
    message,
    retryable,
    source: "connection",
  });
}

/**
 * channel 不在 attachment 白名单（03 §7.1）：账号域/host 本体能力只在 host `/ws` 提供，
 * 沙箱通道不借用；用冻结的 `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` 判定，不硬编码通道名。
 */
export function cloudChannelNotAllowedError(channelName: string) {
  return new CloudApiError({
    code: "unauthorized",
    message: `channel ${channelName} is not exposed on the cloud attachment`,
    retryable: false,
    source: "configuration",
    details: { channel: channelName },
  });
}

/**
 * 把 RPC 侧错误归一成 `CloudApiError`。
 * ChannelClient 在 PromiseError 上透传 code/traceId/details 等字段（channels.shared.ts），
 * 这里只做形状归一：`code` 必须是 shared 目录里的码，`retryable` 缺失时取目录默认值；
 * 没有 code 的错误按连接类失败处理，不透传服务端文案做语义判定。
 */
export function normalizeCloudRpcError(error: unknown, fallbackMessage: string): CloudApiError {
  if (isCloudApiError(error)) return error;
  const record: Record<string, unknown> =
    typeof error === "object" && error !== null ? (error as Record<string, unknown>) : {};
  const rawMessage = record.message;
  const message =
    typeof rawMessage === "string" && rawMessage.trim().length > 0 ? rawMessage : fallbackMessage;
  const rawCode = record.code;
  if (typeof rawCode !== "string" || !isCloudErrorCode(rawCode)) {
    return cloudAttachmentUnavailableError(message);
  }
  const parsedDetails = cloudErrorDetailsSchema.safeParse(record.details);
  const rawRetryable = record.retryable;
  const rawTraceId = record.traceId;
  return new CloudApiError({
    code: rawCode,
    message,
    retryable: typeof rawRetryable === "boolean" ? rawRetryable : CLOUD_ERROR_RETRYABLE[rawCode],
    source: "envelope",
    traceId: typeof rawTraceId === "string" ? rawTraceId : undefined,
    details: parsedDetails.success ? parsedDetails.data : undefined,
  });
}

// ── 恢复控制信号 ──

/**
 * 需要重新同步的原因：
 * - `retention-window`：历史 cursor 越出保留窗（03 §9、02 §7.3）；
 * - `log-epoch-changed`：runtime/log epoch 变化，旧增量作废（07 §9）；
 * - `gap`：声明的水位无法续接（服务端只能给快照）。
 */
export type CloudResyncReason = "retention-window" | "log-epoch-changed" | "gap";

/**
 * 显式上抛的 resync 信号：调用方必须改读权威快照，不能静默从零猜测
 * （03 §9「不静默从零猜测」、02 §7.3「持久 snapshot + delta」）。
 */
export class CloudResyncRequiredError extends Error {
  readonly reason: CloudResyncReason;
  readonly topic: string | undefined;
  readonly logEpoch: string | undefined;

  constructor(init: {
    readonly reason: CloudResyncReason;
    readonly topic?: string | undefined;
    readonly logEpoch?: string | undefined;
    readonly message?: string | undefined;
  }) {
    super(
      init.message ??
        `cloud projection requires resync (${init.reason})${init.topic ? `: ${init.topic}` : ""}`,
    );
    this.name = "CloudResyncRequiredError";
    this.reason = init.reason;
    this.topic = init.topic;
    this.logEpoch = init.logEpoch;
  }
}

export function isCloudResyncRequiredError(value: unknown): value is CloudResyncRequiredError {
  return value instanceof CloudResyncRequiredError;
}

/**
 * 创建结果对账与补偿终止分类（specs/cloud-agent/01 §4.1、§5.1、§5.3、§9）。
 * 三家 driver 共用同一套对账语义（差异只在 provider 查询通道）：
 *
 * - 标签关联：create 时把 operationKey/runId/runGeneration 写进 provider 的
 *   labels/metadata/tags，findCreateResult 按同一键反查。标签只含这些对账键与调用方
 *   提供的非敏感标签，**不含 prompt、用户内容或凭据**（01 §4.1 禁止项）。
 * - 未知结果：provider 查询失败/不可达 → `unknown`，保留 operation 与 quota
 *   （03 §5），绝不写成 failed、绝不自动第二次 create。
 * - 「查不到」不等于「没创建」：只有能证明 create 尝试已超出对账窗口时才可返回
 *   `notFound`（重试安全）。没有时间锚点（例如控制面重启后内存清空）时保守返回
 *   `unknown`，等待运营确认（01 §4.1）。
 * - 补偿终止：bootstrap 失败后的 cleanup 只有 provider 确认（成功或 404）才算已
 *   清理（→ `bootstrap_failed`）；未确认保留计费槽与 cleanup operation
 *   （→ `provider_termination_unknown`，01 §5.1、§9）。
 */
import type {
  CreateReconciliation,
  SandboxCreateInput,
} from "../../app/ports/sandboxDriverPort.js";
import { CloudAdapterError } from "./adapterError.js";

/** 对账键的固定名（三家 provider 的标签通道都用同一组键名）。 */
export const SANDBOX_RECONCILE_KEYS = {
  operationKey: "operationKey",
  runId: "runId",
  runGeneration: "runGeneration",
} as const;

const RESERVED_RECONCILE_KEYS = new Set<string>(Object.values(SANDBOX_RECONCILE_KEYS));

/** 对账窗口内的未知结论统一用该码（CLOUD_ERROR_RETRYABLE=false，只能对账）。 */
export const CREATE_RECONCILE_UNKNOWN_CODE = "provider_create_unknown" as const;

/** provider 标签通道名（错误信息用词随 provider 变化，规则不分叉）。 */
export type SandboxLabelChannel = "label" | "metadata" | "tag";

export type SandboxLabelSource = Pick<
  SandboxCreateInput,
  "operationKey" | "runId" | "runGeneration" | "labels"
>;

/**
 * 合并调用方标签与对账键，并做本地校验（01 §4.1/§9：非法或保留键占用在
 * create 前拒绝，不占 quota）。返回的 Record 直接作为 provider 的
 * labels/metadata/tags 载荷。
 */
export function buildReconcileLabels(
  input: SandboxLabelSource,
  channel: SandboxLabelChannel = "label",
): Record<string, string> {
  const labels: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.labels ?? {})) {
    if (RESERVED_RECONCILE_KEYS.has(key)) {
      throw new CloudAdapterError("validation_failed", `${channel} key reserved: ${key}`, {
        labelKey: key,
      });
    }
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(key) || value === "" || value.length > 256) {
      throw new CloudAdapterError("validation_failed", `invalid provider ${channel}: ${key}`, {
        labelKey: key,
      });
    }
    labels[key] = value;
  }
  labels[SANDBOX_RECONCILE_KEYS.operationKey] = input.operationKey;
  labels[SANDBOX_RECONCILE_KEYS.runId] = input.runId;
  labels[SANDBOX_RECONCILE_KEYS.runGeneration] = String(input.runGeneration);
  return labels;
}

/**
 * create 尝试时间锚点（**仅进程内内存，不持久**）。控制面对账的持久事实在
 * operation 记录里（03 §5），并通过 `findCreateResult` 的 `operationAttemptedAtMs`
 * 传入；本锚点只是同一进程内的兜底，控制面重启后由 durable 值补上。
 */
export interface CreateAttemptAnchors {
  record(operationKey: string): void;
  resolve(operationKey: string): number | undefined;
  forget(operationKey: string): void;
}

export function createCreateAttemptAnchors(now: () => number): CreateAttemptAnchors {
  const attempts = new Map<string, number>();
  return {
    record: (operationKey) => void attempts.set(operationKey, now()),
    resolve: (operationKey) => attempts.get(operationKey),
    forget: (operationKey) => void attempts.delete(operationKey),
  };
}

export interface CreateReconcileContext {
  /**
   * 控制面持久的 create 尝试时间（epoch ms，`findCreateResult` 的
   * `operationAttemptedAtMs`）：跨重启可用，优先于进程内锚点。
   */
  durableAttemptedAtMs?: number | undefined;
  /** 进程内记录的尝试时间（同一实例内的兜底）。 */
  localAttemptedAtMs?: number | undefined;
  /** 对账窗口：窗口内的「查不到」不足以判定未创建（在途 create 可能稍后落地）。 */
  windowMs: number;
  now: number;
}

/**
 * provider 清单查询结论 → CreateReconciliation（01 §4.1 三分支）。
 * `matchedHandle` 是清单里按 operationKey 命中的资源；未命中时的判定：
 * - 有锚点（durable 优先）且已超出对账窗口 → `notFound`（可安全重试）；
 * - 有锚点但仍在窗口内 → `unknown`（provider 元数据可能尚未可见，保守对账）；
 * - 完全没有锚点（跨进程且调用方未提供）→ `unknown`：无从证明尝试已结束，
 *   交给运营确认（01 §4.1），不猜测「未创建」。
 */
export function resolveCreateReconciliation(
  matchedHandle: { provider: string; sandboxId: string } | undefined,
  context: CreateReconcileContext,
): CreateReconciliation {
  if (matchedHandle) {
    return { status: "created", handle: matchedHandle };
  }
  const { windowMs, now } = context;
  const attemptedAtMs = context.durableAttemptedAtMs ?? context.localAttemptedAtMs;
  if (attemptedAtMs === undefined || now - attemptedAtMs < windowMs) {
    return { status: "unknown", errorCode: CREATE_RECONCILE_UNKNOWN_CODE };
  }
  return { status: "notFound" };
}

/** provider 清单/元数据查询不可用时的统一未知结论（provider_unreachable 语义见 01 §9）。 */
export function createReconcileUnknown(): CreateReconciliation {
  return { status: "unknown", errorCode: CREATE_RECONCILE_UNKNOWN_CODE };
}

/** 从 provider 清单条目里读标签对象（三家 provider 字段名不同，判定逻辑相同）。 */
export function readLabelsOf(
  entry: Record<string, unknown> | null,
  field: string,
): Record<string, unknown> | null {
  if (!entry) return null;
  const value = entry[field];
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 清单条目里 operationKey 与本操作的匹配判定。 */
export function matchesOperationKey(
  entry: Record<string, unknown> | null,
  labelField: string,
  operationKey: string,
): boolean {
  const labels = readLabelsOf(entry, labelField);
  return labels?.[SANDBOX_RECONCILE_KEYS.operationKey] === operationKey;
}

// ── 补偿终止分类（01 §5.1、§9）──

/** provider 终止探测结果：ok/status 是 provider 事实，不推测。 */
export interface TerminationProbeResult {
  ok: boolean;
  status: number;
}

export type CompensationTermination = "terminated" | "unknown";

/**
 * 补偿终止分类：只有 provider 明确确认（2xx 或 404 资源不存在）才算已清理；
 * 其余（网络错误、5xx、权限丢失）归未确认，调用方保留槽位与 cleanup operation。
 */
export function classifyCompensationTermination(
  probe: TerminationProbeResult,
): CompensationTermination {
  return probe.ok || probe.status === 404 ? "terminated" : "unknown";
}

/**
 * 补偿失败的错误码：已确认清理 → `bootstrap_failed`；未确认 →
 * `provider_termination_unknown`（保留计费槽与告警，01 §9）。
 */
export function compensationErrorCode(
  outcome: CompensationTermination,
): "bootstrap_failed" | "provider_termination_unknown" {
  return outcome === "terminated" ? "bootstrap_failed" : "provider_termination_unknown";
}

// ── provider 观测证据（01 §9 审计边界：有界、可运营、不含秘密）──

/** 观测证据的长度上限（字符）；对齐 ProviderObservation.evidence 的契约上界。 */
export const OBSERVATION_EVIDENCE_MAX_CHARS = 160;

/**
 * 归一观测证据：压成单行并截断到上限。
 * 只允许传 provider 状态原文的关键片段、HTTP 状态、退出码、错误类别等**非敏感**片段：
 * **不得**包含凭据、prompt、用户内容、私有代码或请求/响应原文（01 §9）。
 */
export function boundEvidence(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= OBSERVATION_EVIDENCE_MAX_CHARS
    ? singleLine
    : `${singleLine.slice(0, OBSERVATION_EVIDENCE_MAX_CHARS - 1)}…`;
}

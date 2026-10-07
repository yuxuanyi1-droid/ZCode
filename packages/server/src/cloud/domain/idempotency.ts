/**
 * 幂等与请求 fingerprint（specs/cloud-agent/03 §6.1 请求 fingerprint 与执行 recipe、
 * §6.2 投递与响应、08 §5 首输入与不确定结果、02 §6.2 同 commandId 不同 payload 冲突）。
 *
 * 规则：
 * - `payloadHash` 是规范结构化编码后的 fingerprint，覆盖语义字段：intent、完整正文、
 *   附件引用与顺序、requestedConfig、start 选择、expectedTaskRevision 或
 *   expectedRunGeneration。不得只比较 prompt，也不得把可变字段拼成含歧义的分隔符字符串。
 * - 省略默认值仍按原请求计算；解析出的默认值（resolvedExecutionConfig）与冻结 SHA
 *   不混入原请求 hash（03 §6.1）——重放不重新解析默认值，部署默认变更不改变结果。
 * - 去重先于新请求 CAS：原 commandId 同 fingerprint 返回原 receipt，不因 task revision
 *   增长失败；不同 fingerprint 返回 `idempotency_conflict`（03 §6.1、11 §7）。
 *
 * 本文件只做规范化与判定，不计算摘要（sha256 属 IO 能力，经 `HashPort` 由 app 注入）。
 */
import type { CloudTaskInputRecord } from "@zcode/shared";

/** 参与 fingerprint 的语义输入；字段名与 HTTP schema 对齐，避免两套命名。 */
export interface InputFingerprintInput {
  intent: "start" | "append" | "reopen";
  prompt: string;
  attachmentIds?: readonly string[];
  requestedConfig?: unknown;
  /** start/reopen 的启动选择（draftStartConfig 或 reopen 的 provider/resume）。 */
  start?: unknown;
  expectedTaskRevision?: number;
  expectedRunGeneration?: number;
}

/** 无法规范化编码（非 JSON 值、NaN/Infinity、循环引用）时的确定性失败。 */
export class NonCanonicalInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonCanonicalInputError";
  }
}

/**
 * 确定性规范编码：对象键排序、丢弃 `undefined`（= 请求未提供该字段，与「省略默认值」
 * 同义）、数组保持顺序（附件顺序是语义的一部分）。字符串一律 JSON 转义，
 * 不依赖分隔符，避免歧义拼接。
 */
export function canonicalizeForFingerprint(value: unknown): string {
  return encode(value, 0);
}

function encode(value: unknown, depth: number): string {
  if (depth > 32) throw new NonCanonicalInputError("fingerprint payload nested too deep");
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new NonCanonicalInputError("non-finite number");
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new NonCanonicalInputError(`unsupported fingerprint value: ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => encode(item, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${encode(item, depth + 1)}`).join(",")}}`;
}

/** fingerprint 版本前缀：将来改变语义编码时必须显式升级，不静默改变已有 hash。 */
export const INPUT_FINGERPRINT_VERSION = 1 as const;

/**
 * 生成参与 `HashPort` 摘要的规范串。调用方把结果交给 HashPort 得到 `payloadHash`；
 * 二者分离保证 domain 无 IO。
 */
export function canonicalInputFingerprint(input: InputFingerprintInput): string {
  // 语义字段白名单：显式列出，避免将来请求体新增字段时无意改变既有 fingerprint。
  const semantic: Record<string, unknown> = {
    v: INPUT_FINGERPRINT_VERSION,
    intent: input.intent,
    prompt: input.prompt,
    attachments: input.attachmentIds ?? [],
    requestedConfig: input.requestedConfig ?? null,
    start: input.start ?? null,
  };
  if (input.expectedTaskRevision !== undefined) {
    semantic.expectedTaskRevision = input.expectedTaskRevision;
  }
  if (input.expectedRunGeneration !== undefined) {
    semantic.expectedRunGeneration = input.expectedRunGeneration;
  }
  return encode(semantic, 0);
}

export type DuplicateDecision =
  | { kind: "new" }
  | { kind: "duplicate"; existing: CloudTaskInputRecord }
  | { kind: "conflict"; code: "idempotency_conflict" };

/**
 * 同 commandId 去重判定（03 §6.1）：先查原 commandId 再谈新请求 CAS。
 * 注意 duplicate 返回原 receipt 时可以反映「最新投递状态」（03 §6.1），
 * 因此这里只判定「是否同 fingerprint」，不冻结 receipt 内容。
 */
export function decideDuplicate(input: {
  existing: CloudTaskInputRecord | null;
  incomingPayloadHash: string;
}): DuplicateDecision {
  if (!input.existing) return { kind: "new" };
  if (input.existing.payloadHash === input.incomingPayloadHash) {
    return { kind: "duplicate", existing: input.existing };
  }
  return { kind: "conflict", code: "idempotency_conflict" };
}

/**
 * 投递顺序（03 §6.2）：`acceptanceSeq` 在 Task 内事务性递增，用于 durable delivery
 * 顺序；它不是 CLI admissionSeq。首条必须是事务固定的 firstInputCommandId
 * （08 §5：不得按 acceptedAt/随机 UUID 选首条）。
 */
export function compareAcceptanceSeq(
  left: CloudTaskInputRecord,
  right: CloudTaskInputRecord,
): number {
  return left.acceptanceSeq - right.acceptanceSeq;
}

export function isFirstInput(input: CloudTaskInputRecord, firstInputCommandId?: string): boolean {
  return firstInputCommandId !== undefined && input.commandId === firstInputCommandId;
}

/**
 * 外部操作幂等键（01 §8 同 operationId、08 §8.2 publish-pr 键、03 §5 同 key 返回同 operation）：
 * 重试复用同一 id，不生成第二个 operation。
 */
export function createOperationKey(runId: string): string {
  return `create:${runId}`;
}

export function checkpointOperationKey(runId: string, operationId: string): string {
  return `checkpoint:${runId}:${operationId}`;
}

export function terminateOperationKey(runId: string, runGeneration: number): string {
  return `terminate:${runId}:${runGeneration}`;
}

export function cleanupOperationKey(runId: string, runGeneration: number): string {
  return `cleanup:${runId}:${runGeneration}`;
}

export function extendOperationKey(runId: string, runGeneration: number, at: number): string {
  return `extend:${runId}:${runGeneration}:${at}`;
}

/** 08 §8.2 冻结的 PR 发布幂等键；重复请求返回既有 PR，不重复建 PR。 */
export function publishPullRequestKey(runId: string, checkpointId: string): string {
  return `publish-pr:${runId}:${checkpointId}`;
}

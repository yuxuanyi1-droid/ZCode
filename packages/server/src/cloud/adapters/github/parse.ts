/**
 * GitHub 响应体的最小运行时校验（specs/cloud-agent/09 §8「解析严格 schema」、
 * W0 CONTRACT「业务字段禁止 unknown 兜底」）。
 *
 * GitHub 返回的是外部输入：缺字段/类型不符时必须明确失败或明确降级，
 * 不允许用 `as` 断言把畸形响应带进业务判断（09 §8、§3「token 作为 opaque string」）。
 */

export type JsonRecord = Record<string, unknown>;

export function asRecord(value: unknown): JsonRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonRecord;
}

export function readRecord(record: JsonRecord | null, key: string): JsonRecord | null {
  return record ? asRecord(record[key]) : null;
}

export function readString(record: JsonRecord | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function readStringOr(record: JsonRecord | null, key: string, fallback: string): string {
  return readString(record, key) ?? fallback;
}

export function readNumber(record: JsonRecord | null, key: string): number | null {
  const value = record?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readBooleanOr(record: JsonRecord | null, key: string, fallback: boolean): boolean {
  const value = record?.[key];
  return typeof value === "boolean" ? value : fallback;
}

export function readArray(record: JsonRecord | null, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

export function readStringArray(record: JsonRecord | null, key: string): string[] {
  return readArray(record, key).filter((item): item is string => typeof item === "string");
}

/** 权限对象：`{contents: "read", pull_requests: "write"}`；未知值一律丢弃。 */
export function readPermissionMap(record: JsonRecord | null, key: string): Record<string, string> {
  const source = readRecord(record, key);
  if (!source) return {};
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (typeof value === "string") result[name] = value;
  }
  return result;
}

/** ISO8601（GitHub 统一用 `2026-10-06T00:00:00Z`）→ epoch 毫秒；不可解析返回 null。 */
export function readIsoTimestamp(record: JsonRecord | null, key: string): number | null {
  const value = readString(record, key);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

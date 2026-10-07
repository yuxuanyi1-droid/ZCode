/**
 * 不透明分页游标编解码（03 §6 分页信封 `{items, nextCursor?}`、W2 §4）。
 *
 * 游标是 adapter 内部状态，调用方不得解析或拼接：只按本文件重新导出回传。
 * 编码为 base64url(JSON)，解码失败一律当成非法游标（validation_failed），
 * 不静默从头开始分页——静默重置会让客户端重复消费同一页。
 */
import { CloudStorageError } from "../cloudStorageError.js";

export function encodeCursor(parts: readonly (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): (string | number)[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch (cause) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-cursor",
      message: "分页游标不可解析",
      cause,
    });
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length === 0 ||
    !parsed.every((part) => typeof part === "string" || typeof part === "number")
  ) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-cursor",
      message: "分页游标形状非法",
    });
  }
  return parsed;
}

/** 分页 limit 归一：必须为正整数且不超过上界（03 §6 拒绝无限拉取）。 */
export function normalizeLimit(limit: number, max: number): number {
  if (!Number.isInteger(limit) || limit <= 0) {
    throw new CloudStorageError({
      code: "validation_failed",
      reason: "invalid-limit",
      message: "分页 limit 必须是正整数",
    });
  }
  return Math.min(limit, max);
}

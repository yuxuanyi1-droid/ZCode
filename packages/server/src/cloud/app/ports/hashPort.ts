/**
 * 摘要端口（03 §6.1：`payloadHash` 是规范结构化编码后的 fingerprint；02 §7.1
 * `contentHash` 是投影记录的完整性摘要）。
 *
 * domain 只产出「规范串」（domain/idempotency.ts），摘要计算属 IO 能力，经本端口
 * 由 adapter 实现（node:crypto 或等效），app 不直接 import `node:*`。
 */
export interface HashPort {
  sha256Hex(value: string): Promise<string>;
}

/**
 * 摘要端口（03 §6.1：`payloadHash` 是规范结构化编码后的 fingerprint；02 §7.1
 * `contentHash` 是投影记录的完整性摘要）。
 *
 * domain 只产出「规范串」（domain/idempotency.ts），摘要计算属 IO 能力，经本端口
 * 由 adapter 实现（node:crypto 或等效），app 不直接 import `node:*`。
 */
export interface HashPort {
  sha256Hex(value: string): Promise<string>;
  /**
   * 任意字节的 sha256（M8 连接期同步的归档分块/整包摘要，14 §4.4）。
   *
   * 字符串形态的 `sha256Hex` 会把二进制按 UTF-8 摘要，不能用于归档字节——分块导入的
   * `chunkSha256`/`archiveSha256` 必须按**解码后字节**逐字节摘要（与 store 派生口径一致）。
   */
  sha256HexBytes(bytes: Uint8Array): Promise<string>;
}

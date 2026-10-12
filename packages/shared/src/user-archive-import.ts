/**
 * 用户级归档分块导入契约（specs/cloud-agent 14 §4.4）。
 *
 * 归档上限（skills 20MiB / plugins 50MiB）远超单帧 RPC 上限（4MiB），因此大归档走
 * 「收块缓冲 → 复用既有导入实现」的分块导入：调用方 `begin` 建立会话，逐块 `append`
 * （`chunkIndex` 严格从 0 递增、逐块核对 `chunkSha256`），收齐后 `complete`（整包
 * `archiveSha256` 核对通过才交给既有导入链路 `importSkillsArchive`/`importPluginsArchive`），
 * 放弃或断连时 `abort` 释放缓冲。
 *
 * 同一形状由 `skill-sync` 与 `plugin-sync` 两个服务共用（方法名与参数一致，字段名在此
 * 唯一冻结）；本文件不依赖 bridge 或控制面，SSH 同步将来可共用（14 §4.4 尾段）。
 */

/** 单块原始字节上限（14 §4.4 冻结值）：base64 编码后 ≤ `USER_ARCHIVE_IMPORT_CHUNK_MAX_BASE64_CHARS`。 */
export const USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES = 2 * 1024 * 1024;

/** base64 编码后的字符上限：保证解码后不超过 `USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES`。 */
export const USER_ARCHIVE_IMPORT_CHUNK_MAX_BASE64_CHARS =
  Math.ceil(USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES / 3) * 4;

export interface UserArchiveImportBeginParams {
  /** 完整归档字节的 sha256（16 进制小写）；收齐后核对，不符 fail-closed 不半安装。 */
  archiveSha256: string;
  /** 归档总字节数（≤ 类别上限，由调用方与服务两侧各自校验）。 */
  totalBytes: number;
  /** 分块数：每块 ≥1 字节且 ≤ 单块上限，因此 `ceil(totalBytes / 单块上限) ≤ chunkCount ≤ totalBytes`。 */
  chunkCount: number;
}

export interface UserArchiveImportBeginResult {
  /** 本次导入会话标识；后续 `append`/`complete`/`abort` 据此定位会话。 */
  importId: string;
}

export interface UserArchiveImportAppendChunkParams {
  importId: string;
  /** 严格从 0 递增（缺块/乱序/重复一律拒绝，不做乱序缓冲）。 */
  chunkIndex: number;
  /** 解码后该块字节的 sha256（逐块核对后才落缓冲）。 */
  chunkSha256: string;
  /** canonical base64；解码字节 ≤ `USER_ARCHIVE_IMPORT_CHUNK_MAX_BYTES`。 */
  payloadBase64: string;
}

/** 已接收水位：`receivedChunks` 从 0 起（= 下一期望的 `chunkIndex`），`receivedBytes` 为累计字节。 */
export interface UserArchiveImportAppendChunkResult {
  receivedChunks: number;
  receivedBytes: number;
}

export interface UserArchiveImportCompleteParams {
  importId: string;
}

export interface UserArchiveImportAbortParams {
  importId: string;
}

/** `abort` 结果：false = 会话不存在或已被超时/新 `begin` 清理（幂等，不抛）。 */
export interface UserArchiveImportAbortResult {
  aborted: boolean;
}

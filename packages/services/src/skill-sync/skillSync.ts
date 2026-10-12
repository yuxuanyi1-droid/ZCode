import type {
  SkillSyncArchiveExportResult,
  SkillSyncCandidateListResult,
  SkillSyncImportResult,
  SkillSyncRemoteStatusResult,
  RemoteSyncWriteAccessResult,
  UserArchiveImportAbortParams,
  UserArchiveImportAbortResult,
  UserArchiveImportAppendChunkParams,
  UserArchiveImportAppendChunkResult,
  UserArchiveImportBeginParams,
  UserArchiveImportBeginResult,
  UserArchiveImportCompleteParams,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISkillSyncService {
  listLocalUserSkillCandidates(): Promise<SkillSyncCandidateListResult>;
  listRemoteUserSkillStatuses(params: {
    directoryNames: string[];
    skills?: Array<{
      directoryName: string;
      name: string;
    }>;
  }): Promise<SkillSyncRemoteStatusResult>;
  exportSkillsArchive(params: { skillIds: string[] }): Promise<SkillSyncArchiveExportResult>;
  checkRemoteUserSkillWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importSkillsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<SkillSyncImportResult>;
  /**
   * 分块导入（14 §4.4；控制面连接期同步的大归档通路，突破单帧 RPC 4MiB 上限）：
   * `begin` 建立会话 → `append` 逐块收齐（严格 index 递增、逐块 sha256）→ `complete`
   * 核对整包 sha256 后交给既有导入实现并返回其逐条结果 → `abort` 释放缓冲。
   * 同一服务同一时刻最多 1 个会话；新 `begin` 废弃旧会话，空闲超时同样释放。
   */
  beginUserArchiveImport(
    params: UserArchiveImportBeginParams,
  ): Promise<UserArchiveImportBeginResult>;
  appendUserArchiveImportChunk(
    params: UserArchiveImportAppendChunkParams,
  ): Promise<UserArchiveImportAppendChunkResult>;
  completeUserArchiveImport(
    params: UserArchiveImportCompleteParams,
  ): Promise<SkillSyncImportResult>;
  abortUserArchiveImport(
    params: UserArchiveImportAbortParams,
  ): Promise<UserArchiveImportAbortResult>;
}

export const ISkillSyncService = createServiceDescriptor<ISkillSyncService>(
  ServiceChannels.SkillSync,
);

import type {
  PluginSyncArchiveExportResult,
  PluginSyncCandidateListResult,
  PluginSyncImportResult,
  PluginSyncRemoteStatusResult,
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

export interface IPluginSyncService {
  listLocalUserPluginCandidates(): Promise<PluginSyncCandidateListResult>;
  listRemoteUserPluginStatuses(params: {
    plugins: Array<{
      pluginId: string;
      directoryName: string;
    }>;
  }): Promise<PluginSyncRemoteStatusResult>;
  exportPluginsArchive(params: { pluginIds: string[] }): Promise<PluginSyncArchiveExportResult>;
  exportMarketplaceSourceArchive(params: {
    marketplaceId: string;
    pluginNames: string[];
    source: Record<string, unknown>;
  }): Promise<{
    archive: Uint8Array;
    archiveBytes: number;
    marketplaceId: string;
    pluginNames: string[];
  }>;
  importPluginsArchive(params: {
    archive: Uint8Array;
    overwrite?: false;
  }): Promise<PluginSyncImportResult>;
  checkRemoteUserPluginWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  importMarketplaceSourceArchive(params: { archive: Uint8Array; overwrite?: false }): Promise<{
    marketplaceId: string;
    path: string;
    status: "skipped" | "synced";
  }>;
  /**
   * 分块导入（14 §4.4；控制面连接期同步的大归档通路，突破单帧 RPC 4MiB 上限）：
   * 形状与 skill-sync 同款（唯一来源 shared 的 `user-archive-import.ts`）——`begin` →
   * `append`（严格 index 递增、逐块 sha256）→ `complete`（整包 sha256 核对后委派既有
   * `importPluginsArchive`）→ `abort`；同一时刻最多 1 个会话，空闲超时释放。
   */
  beginUserArchiveImport(
    params: UserArchiveImportBeginParams,
  ): Promise<UserArchiveImportBeginResult>;
  appendUserArchiveImportChunk(
    params: UserArchiveImportAppendChunkParams,
  ): Promise<UserArchiveImportAppendChunkResult>;
  completeUserArchiveImport(
    params: UserArchiveImportCompleteParams,
  ): Promise<PluginSyncImportResult>;
  abortUserArchiveImport(
    params: UserArchiveImportAbortParams,
  ): Promise<UserArchiveImportAbortResult>;
}

export const IPluginSyncService = createServiceDescriptor<IPluginSyncService>(
  ServiceChannels.PluginSync,
);

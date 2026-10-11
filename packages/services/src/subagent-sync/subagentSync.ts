import type {
  BuiltInSubagentName,
  ModelSelection,
  RemoteSyncWriteAccessResult,
  SubagentSyncCandidateListResult,
  SubagentSyncExportResult,
  SubagentSyncImportResult,
  SubagentSyncItemKind,
  SubagentSyncRemoteStatusResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 用户级子智能体配置的远端同步（手动）。
 *
 * 同一份接口注册在两侧：本机实例负责候选扫描与导出，远端实例负责状态判定与导入。
 * 「本地/远端」由调用方拿着哪个实例决定，与 skill / MCP 同步一致。
 */
export interface ISubagentSyncService {
  /** 本机用户级候选：内置模型覆盖（已配置的）+ 用户级 agent Markdown。 */
  listLocalUserSubagentCandidates(): Promise<SubagentSyncCandidateListResult>;
  /** 远端状态判定：缺失 / 内容一致 / 已存在但不同。 */
  listRemoteUserSubagentStatuses(params: {
    candidates: Array<{
      id: string;
      kind: SubagentSyncItemKind;
      agentName?: BuiltInSubagentName;
      modelSelection?: ModelSelection;
      relativePath?: string;
      contentHash?: string;
    }>;
  }): Promise<SubagentSyncRemoteStatusResult>;
  /** 按 id 导出被勾选条目的完整内容。 */
  exportSubagentConfig(params: { ids: string[] }): Promise<SubagentSyncExportResult>;
  /** 导入前的可写性预检：用户级 agents 根与 state 文件所在目录。 */
  checkRemoteUserSubagentWriteAccess(): Promise<RemoteSyncWriteAccessResult>;
  /**
   * 整批导入；任一写入失败时回滚本次已写入的文件与状态（all-or-nothing）。
   * 调用方只传用户勾选的条目，覆盖是用户的显式选择，不再单列 overwrite 开关。
   */
  importSubagentConfig(params: {
    entries: SubagentSyncExportResult["entries"];
  }): Promise<SubagentSyncImportResult>;
}

export const ISubagentSyncService = createServiceDescriptor<ISubagentSyncService>(
  ServiceChannels.SubagentSync,
);

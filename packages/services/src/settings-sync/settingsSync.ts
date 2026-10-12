import type {
  SettingsSyncDiscoveryResult,
  SettingsSyncClaudeAgentsFileCopyResult,
  SettingsSyncClaudeAgentsFileMigrationStatus,
  SettingsSyncFirstRunPromptState,
  SettingsSyncImportResult,
  SettingsSyncProgressEvent,
  SettingsSyncSelection,
  SettingsSyncUserAgentsFileWriteResult,
} from "@zcode/shared";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface ISettingsSyncService {
  getClaudeAgentsFileMigrationStatus(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<SettingsSyncClaudeAgentsFileMigrationStatus>;
  copyClaudeAgentsFileToZcodeAgentsFile(request?: {
    workspacePath?: string;
    workspaceIdentity?: string;
    overwrite?: boolean;
  }): Promise<SettingsSyncClaudeAgentsFileCopyResult>;
  /**
   * 用户级 `~/.zcode/AGENTS.md` 最小写入方法（14 §4.5，2026-10-11 简化定调）：
   * **整文件覆盖**（不合并、不追加）、UTF-8 ≤ `SETTINGS_SYNC_USER_AGENTS_FILE_MAX_BYTES`、
   * 自动创建父目录、原子写（临时文件 + rename）、文件模式 0600。
   *
   * 供云连接期用户资源同步落 AGENTS.md 单例条目用；不提供 `overwrite:false` 分支
   * （覆盖语义由 14 §4.7 决议固定）。返回落点、UTF-8 字节数与正文 sha256 供调用方核对
   * 条目元数据；正文不进日志。
   */
  writeUserAgentsFile(request: { content: string }): Promise<SettingsSyncUserAgentsFileWriteResult>;
  detect(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    categories?: SettingsSyncSelection["category"][];
    intent?: "firstRun" | "manualImport";
  }): Promise<SettingsSyncDiscoveryResult>;
  importSelected(request: {
    workspacePath?: string;
    workspaceIdentity?: string;
    selections: SettingsSyncSelection[];
    onProgress?: (event: SettingsSyncProgressEvent) => void;
  }): Promise<SettingsSyncImportResult>;
  getFirstRunPromptState(): Promise<SettingsSyncFirstRunPromptState>;
  markFirstRunPromptHandled(): Promise<void>;
}

export const ISettingsSyncService = createServiceDescriptor<ISettingsSyncService>(
  ServiceChannels.SettingsSync,
);

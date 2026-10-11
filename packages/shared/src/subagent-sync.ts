import type { ModelSelection } from "./model-selection.js";
import type { BuiltInSubagentName } from "./subagents-types.js";

/**
 * 用户级子智能体配置的远端同步（手动）。
 *
 * 本机是唯一权威与唯一写入路径；远端那份是同步副本，只在用户勾选并确认后写入。
 * 同步单位分两类：内置子智能体的模型覆盖（state 字段）与用户级 agent Markdown（文件）。
 */
export type SubagentSyncItemKind = "builtInModelOverride" | "userAgent";

/** 远端与当前选择的差异：缺失 / 完全一致 / 已存在但不同（可覆盖）。 */
export type SubagentSyncRemoteItemState = "missing" | "same" | "different";

export type SubagentSyncImportStatus = "synced" | "skipped" | "failed";

export interface SubagentSyncCandidate {
  /** `builtin:<agentName>` 或 `user:<posix 相对路径>` */
  id: string;
  kind: SubagentSyncItemKind;
  name: string;
  /** userAgent：相对用户级 agents 根的 posix 相对路径，跨平台一致 */
  relativePath?: string;
  /** builtInModelOverride */
  agentName?: BuiltInSubagentName;
  /** builtInModelOverride：本机当前覆盖值 */
  modelSelection?: ModelSelection;
  /** userAgent：来自本机 disabledAgentIds 的启用状态 */
  enabled?: boolean;
  /** userAgent：文件内容 sha256 */
  contentHash?: string;
  sizeBytes?: number;
  /** 本机绝对路径，仅用于展示 */
  path: string;
}

export interface SubagentSyncCandidateListResult {
  candidates: SubagentSyncCandidate[];
  /** 本机用户级配置根（<storageRoot>），用于展示同步来源 */
  localRoot: string;
}

export interface SubagentSyncRemoteStatus {
  id: string;
  state: SubagentSyncRemoteItemState;
  /** 已存在时的远端绝对路径 */
  path?: string;
}

export interface SubagentSyncRemoteStatusResult {
  statuses: SubagentSyncRemoteStatus[];
  /** 远端用户级配置根（<storageRoot>） */
  remoteRoot: string;
}

/** 导出条目：只包含用户勾选的内容，是导入端的唯一输入。 */
export interface SubagentSyncExportedEntry {
  id: string;
  kind: SubagentSyncItemKind;
  name: string;
  agentName?: BuiltInSubagentName;
  modelSelection?: ModelSelection;
  relativePath?: string;
  enabled?: boolean;
  /** userAgent：完整 Markdown 内容 */
  content?: string;
}

export interface SubagentSyncExportResult {
  entries: SubagentSyncExportedEntry[];
  localRoot: string;
}

export interface SubagentSyncImportResultItem {
  id: string;
  name: string;
  status: SubagentSyncImportStatus;
  path?: string;
  error?: string;
}

export interface SubagentSyncImportResult {
  results: SubagentSyncImportResultItem[];
  remoteRoot: string;
  /** 整批失败并已回滚本次写入时为 true */
  rolledBack: boolean;
}

/** 单个 agent Markdown 与单批内容的同步上限；超限必须给出可操作的错误。 */
export const SUBAGENT_SYNC_MAX_AGENT_BYTES = 1024 * 1024;
export const SUBAGENT_SYNC_MAX_BATCH_BYTES = 4 * 1024 * 1024;

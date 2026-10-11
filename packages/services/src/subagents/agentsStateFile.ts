import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import {
  parsePluginSubagentModelSelectionOverrides,
  modelSelectionSchema,
  type BuiltInSubagentModelSelectionOverrides,
  type PluginSubagentModelSelectionOverrides,
} from "@zcode/shared";
import { migrateSubagentStateFile } from "@zcode/shared/node";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import { resolveSubagentStateFile, type SubagentStorageOptions } from "./subagentStorage.js";

/**
 * 用户级子智能体状态文件（`<storageRoot>/v2/agents-state.json`）的唯一读写实现。
 * 设置页服务与远端同步服务都会写这份文件，格式解析与原子写必须共用一处。
 */
export interface AgentsStateFile {
  builtInModelSelectionOverrides: BuiltInSubagentModelSelectionOverrides;
  pluginAgentModelSelectionOverrides: PluginSubagentModelSelectionOverrides;
  disabledAgentIds: string[];
  // 仅供旧版本回滚保留；新版存在选择字段后，禁止再从这两个字段恢复覆盖。
  builtInModelOverrides?: unknown;
  builtInThoughtLevelOverrides?: unknown;
}

function emptyAgentsState(): AgentsStateFile {
  return {
    builtInModelSelectionOverrides: {},
    pluginAgentModelSelectionOverrides: {},
    disabledAgentIds: [],
  };
}

/** Host 启动 Agent 前的一次性存储导入：CLI 会独立读同一文件，迁移必须先完成。 */
export async function migrateSubagentStateStorage(options?: SubagentStorageOptions): Promise<void> {
  await migrateSubagentStateFile(await resolveSubagentStateFile(options));
}

export async function readAgentsStateFile(
  options?: SubagentStorageOptions,
): Promise<AgentsStateFile> {
  await migrateSubagentStateFile(await resolveSubagentStateFile(options));
  try {
    const raw = await readFile(await resolveSubagentStateFile(options), "utf-8");
    const parsed = JSON.parse(raw) as {
      builtInModelSelectionOverrides?: unknown;
      pluginAgentModelSelectionOverrides?: unknown;
      builtInModelOverrides?: unknown;
      builtInThoughtLevelOverrides?: unknown;
      disabledAgentIds?: unknown;
    };
    const selections = normalizeBuiltInSelectionOverrides(parsed.builtInModelSelectionOverrides);
    return {
      ...parsed,
      builtInModelSelectionOverrides: selections,
      pluginAgentModelSelectionOverrides: parsePluginSubagentModelSelectionOverrides(
        parsed.pluginAgentModelSelectionOverrides,
      ),
      disabledAgentIds: Array.isArray(parsed.disabledAgentIds)
        ? parsed.disabledAgentIds.filter(
            (id): id is string => typeof id === "string" && id.trim().length > 0,
          )
        : [],
    };
  } catch {
    return emptyAgentsState();
  }
}

export async function writeAgentsStateFile(
  next: AgentsStateFile,
  options?: SubagentStorageOptions,
): Promise<void> {
  const stateFile = await resolveSubagentStateFile(options);
  await mkdir(dirname(stateFile), { recursive: true });
  await atomicWriteText(stateFile, JSON.stringify(next, null, 2));
}

export function normalizeBuiltInSelectionOverrides(
  structured: unknown,
): BuiltInSubagentModelSelectionOverrides {
  const result: BuiltInSubagentModelSelectionOverrides = {};
  const structuredRecord = isRecord(structured) ? structured : {};
  const generalPurpose = modelSelectionSchema.safeParse(structuredRecord["general-purpose"]).data;
  const explore = modelSelectionSchema.safeParse(structuredRecord.Explore).data;
  if (generalPurpose) result["general-purpose"] = generalPurpose;
  if (explore) result.Explore = explore;
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

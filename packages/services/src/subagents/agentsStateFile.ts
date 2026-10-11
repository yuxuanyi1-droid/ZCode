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

export async function readAgentsStateFile(
  options?: SubagentStorageOptions,
): Promise<AgentsStateFile> {
  return readAgentsStateAtPath(await resolveSubagentStateFile(options));
}

/** 按绝对路径读取：runtime config 缓存要为多个 workspace 复用同一份解析。 */
export async function readAgentsStateAtPath(stateFile: string): Promise<AgentsStateFile> {
  await migrateSubagentStateFile(stateFile);
  try {
    const raw = await readFile(stateFile, "utf-8");
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
  } catch (error) {
    // 文件缺失/损坏沿用既有空覆盖语义；IO 失败不能伪装为空配置并重新启用已禁用 agent。
    if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT")
      return emptyAgentsState();
    throw error;
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

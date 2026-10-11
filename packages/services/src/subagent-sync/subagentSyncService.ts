/* eslint-disable max-lines -- 同步服务集中维护候选扫描、远端判定、整批导入与回滚，拆分会让一次同步的原子性边界散落多处。 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { dirname, posix, relative, sep } from "node:path";
import {
  createAgentStateId,
  modelSelectionSchema,
  SUBAGENT_SYNC_MAX_AGENT_BYTES,
  SUBAGENT_SYNC_MAX_BATCH_BYTES,
  type BuiltInSubagentName,
  type ModelSelection,
  type RemoteSyncWriteAccessResult,
  type SubagentSyncCandidate,
  type SubagentSyncCandidateListResult,
  type SubagentSyncExportResult,
  type SubagentSyncExportedEntry,
  type SubagentSyncImportResult,
  type SubagentSyncImportResultItem,
  type SubagentSyncRemoteStatus,
  type SubagentSyncRemoteStatusResult,
} from "@zcode/shared";
import { atomicWriteText } from "#src/fs/atomicFileUtils.js";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import {
  normalizeSkillSyncRelativePath,
  resolveSkillSyncPathWithin,
} from "../skill-sync/skillSyncPath.js";
import { checkRemoteSyncDirectoriesWriteAccess } from "../remote-sync/remoteSyncWriteAccess.js";
import {
  readAgentsStateFile,
  writeAgentsStateFile,
  type AgentsStateFile,
} from "../subagents/agentsStateFile.js";
import { parseSubagentMarkdown } from "../subagents/subagentMarkdown.js";
import {
  resolveSubagentStateFile,
  resolveUserSubagentRoot,
  resolveZCodeStorageRoot,
  type SubagentStorageOptions,
} from "../subagents/subagentStorage.js";
import { collectAgentMarkdownPaths } from "../subagents/subagentsService.js";
import type { ISubagentSyncService } from "./subagentSync.js";

const subagentSyncLogger = createServiceLogger("subagent-sync");

const BUILT_IN_AGENT_NAMES: readonly BuiltInSubagentName[] = ["general-purpose", "Explore"];
const BUILT_IN_ID_PREFIX = "builtin:";
const USER_ID_PREFIX = "user:";

export function createSubagentSyncService(options?: SubagentStorageOptions): ISubagentSyncService {
  const storageOptions: SubagentStorageOptions = { homeDir: options?.homeDir };
  return {
    async listLocalUserSubagentCandidates(): Promise<SubagentSyncCandidateListResult> {
      const state = await readAgentsStateFile(storageOptions);
      const userRoot = await resolveUserSubagentRoot(storageOptions);
      const stateFile = await resolveSubagentStateFile(storageOptions);
      return {
        localRoot: await resolveZCodeStorageRoot(storageOptions),
        candidates: [
          ...collectBuiltInOverrideCandidates(state, stateFile),
          ...(await collectUserAgentCandidates(userRoot, state)),
        ],
      };
    },

    async listRemoteUserSubagentStatuses(params): Promise<SubagentSyncRemoteStatusResult> {
      const state = await readAgentsStateFile(storageOptions);
      const userRoot = await resolveUserSubagentRoot(storageOptions);
      const statuses: SubagentSyncRemoteStatus[] = [];
      for (const candidate of params.candidates) {
        if (candidate.kind === "builtInModelOverride") {
          statuses.push(resolveBuiltInRemoteStatus(state, candidate));
          continue;
        }
        const relativePath = normalizeSkillSyncRelativePath(candidate.relativePath ?? "", {
          unsafePathLabel: "unsafe subagent sync path",
        });
        const targetPath = resolveSkillSyncPathWithin(userRoot, relativePath, {
          unsafePathLabel: "unsafe subagent sync path",
        });
        const { state: remoteState, path } = await resolveUserAgentRemoteStatus(
          targetPath,
          candidate.contentHash,
        );
        statuses.push({ id: candidate.id, state: remoteState, ...(path ? { path } : {}) });
      }
      return { statuses, remoteRoot: await resolveZCodeStorageRoot(storageOptions) };
    },

    async exportSubagentConfig(params): Promise<SubagentSyncExportResult> {
      const state = await readAgentsStateFile(storageOptions);
      const userRoot = await resolveUserSubagentRoot(storageOptions);
      const candidates = new Map(
        [
          ...collectBuiltInOverrideCandidates(
            state,
            await resolveSubagentStateFile(storageOptions),
          ),
          ...(await collectUserAgentCandidates(userRoot, state)),
        ].map((candidate) => [candidate.id, candidate]),
      );
      const entries: SubagentSyncExportedEntry[] = [];
      let totalBytes = 0;
      for (const id of params.ids) {
        const candidate = candidates.get(id);
        if (!candidate) {
          throw new Error(`subagent sync candidate not found: ${id}`);
        }
        if (candidate.kind === "builtInModelOverride") {
          entries.push({
            id: candidate.id,
            kind: candidate.kind,
            name: candidate.name,
            ...(candidate.agentName ? { agentName: candidate.agentName } : {}),
            ...(candidate.modelSelection ? { modelSelection: candidate.modelSelection } : {}),
          });
          continue;
        }
        const content = await readFile(candidate.path, "utf-8");
        const contentBytes = Buffer.byteLength(content, "utf-8");
        if (contentBytes > SUBAGENT_SYNC_MAX_AGENT_BYTES) {
          throw new Error(
            `subagent sync agent exceeds ${SUBAGENT_SYNC_MAX_AGENT_BYTES} bytes: ${candidate.name} (${contentBytes} bytes)`,
          );
        }
        totalBytes += contentBytes;
        if (totalBytes > SUBAGENT_SYNC_MAX_BATCH_BYTES) {
          throw new Error(
            `subagent sync batch exceeds ${SUBAGENT_SYNC_MAX_BATCH_BYTES} bytes: ${totalBytes} bytes`,
          );
        }
        entries.push({
          id: candidate.id,
          kind: candidate.kind,
          name: candidate.name,
          ...(candidate.relativePath ? { relativePath: candidate.relativePath } : {}),
          ...(candidate.enabled === undefined ? {} : { enabled: candidate.enabled }),
          content,
        });
      }
      return { entries, localRoot: await resolveZCodeStorageRoot(storageOptions) };
    },

    async checkRemoteUserSubagentWriteAccess(): Promise<RemoteSyncWriteAccessResult> {
      const stateFile = await resolveSubagentStateFile(storageOptions);
      return checkRemoteSyncDirectoriesWriteAccess([
        await resolveUserSubagentRoot(storageOptions),
        dirname(stateFile),
      ]);
    },

    async importSubagentConfig(params): Promise<SubagentSyncImportResult> {
      const userRoot = await resolveUserSubagentRoot(storageOptions);
      const parsedEntries = params.entries.map((entry) => normalizeImportedEntry(entry, userRoot));
      assertNoDuplicateEntryIds(parsedEntries.map((entry) => entry.entry.id));
      const stateFile = await resolveSubagentStateFile(storageOptions);
      const previousState = await readAgentsStateFile(storageOptions);
      const previousStateRaw = existsSync(stateFile) ? await readFile(stateFile, "utf-8") : null;
      // 先备份所有会被触碰的文件，失败时按同一批恢复；新建文件恢复为删除。
      const fileBackups = await captureFileBackups(parsedEntries);
      const nextState = cloneAgentsState(previousState);
      const appliedFiles: Array<{ path: string; previousContent: string | null }> = [];
      let stateApplied = false;
      let stateChanges: AppliedStateChanges = {
        builtInChangedIds: new Set<string>(),
        disabledChangedAgentIds: new Set<string>(),
      };
      try {
        for (const parsed of parsedEntries) {
          const targetPath = parsed.targetPath;
          if (parsed.entry.kind !== "userAgent" || !targetPath) continue;
          const previousContent = fileBackups.get(targetPath) ?? null;
          if (previousContent === parsed.entry.content) {
            continue;
          }
          await mkdir(dirname(targetPath), { recursive: true });
          // 与 state 文件同一套原子写：避免半份 Markdown 被远端 agent 读到，
          // 也让 E2E 的 FS 故障注入能在同一处覆盖两类写入。
          await atomicWriteText(targetPath, parsed.entry.content ?? "");
          appliedFiles.push({ path: targetPath, previousContent });
        }
        stateChanges = applyEntriesToState(nextState, parsedEntries);
        if (
          stateChanges.builtInChangedIds.size > 0 ||
          stateChanges.disabledChangedAgentIds.size > 0
        ) {
          await writeAgentsStateFile(nextState, storageOptions);
          stateApplied = true;
        }
      } catch (error) {
        const rollbackFailures = await rollbackImportedChanges(
          appliedFiles,
          stateFile,
          stateApplied ? previousStateRaw : undefined,
        );
        if (rollbackFailures.length > 0) {
          subagentSyncLogger.warn(undefined, "subagent sync rollback incomplete", {
            failures: rollbackFailures,
          });
        }
        // 整批按 all-or-nothing 处理：任一项失败后本次写入已回滚，全部条目都报失败。
        const message = error instanceof Error ? error.message : String(error);
        return {
          remoteRoot: await resolveZCodeStorageRoot(storageOptions),
          rolledBack: rollbackFailures.length === 0,
          results: parsedEntries.map((parsed) => ({
            id: parsed.entry.id,
            name: parsed.entry.name,
            status: "failed",
            ...(parsed.targetPath ? { path: parsed.targetPath } : {}),
            error: message,
          })),
        };
      }

      const writtenPaths = new Set(appliedFiles.map((applied) => applied.path));
      const results: SubagentSyncImportResultItem[] = parsedEntries.map((parsed) => ({
        id: parsed.entry.id,
        name: parsed.entry.name,
        // 内容与状态都已一致的条目如实报 skipped：重复同步不产生写入。
        status: wasEntryApplied(parsed, writtenPaths, stateChanges) ? "synced" : "skipped",
        ...(parsed.targetPath ? { path: parsed.targetPath } : {}),
      }));
      subagentSyncLogger.info(undefined, "subagent sync import completed", {
        entryCount: results.length,
        userAgentCount: parsedEntries.filter((parsed) => parsed.entry.kind === "userAgent").length,
      });
      return {
        results,
        remoteRoot: await resolveZCodeStorageRoot(storageOptions),
        rolledBack: false,
      };
    },
  };
}

interface ParsedImportedEntry {
  entry: SubagentSyncExportedEntry;
  targetPath?: string;
}

/** 只接受两类已知条目；字段形状必须在写入前收敛，避免把远端文件写成半份配置。 */
function normalizeImportedEntry(
  entry: SubagentSyncExportedEntry,
  userRoot: string,
): ParsedImportedEntry {
  if (entry.kind === "builtInModelOverride") {
    const agentName = entry.agentName;
    if (!agentName || !BUILT_IN_AGENT_NAMES.includes(agentName)) {
      throw new Error(`subagent sync entry has unknown built-in agent: ${entry.id}`);
    }
    if (entry.id !== `${BUILT_IN_ID_PREFIX}${agentName}`) {
      throw new Error(`subagent sync entry id does not match built-in agent: ${entry.id}`);
    }
    const selection = modelSelectionSchema.safeParse(entry.modelSelection).data;
    if (!selection) {
      throw new Error(`subagent sync entry has invalid model selection: ${entry.id}`);
    }
    return { entry: { ...entry, agentName, modelSelection: selection } };
  }
  if (entry.kind !== "userAgent") {
    throw new Error(`subagent sync entry has unknown kind: ${String(entry.kind)}`);
  }
  const relativePath = normalizeSkillSyncRelativePath(entry.relativePath ?? "", {
    unsafePathLabel: "unsafe subagent sync path",
  });
  if (typeof entry.content !== "string") {
    throw new Error(`subagent sync entry is missing content: ${entry.id}`);
  }
  const contentBytes = Buffer.byteLength(entry.content, "utf-8");
  if (contentBytes > SUBAGENT_SYNC_MAX_AGENT_BYTES) {
    throw new Error(
      `subagent sync agent exceeds ${SUBAGENT_SYNC_MAX_AGENT_BYTES} bytes: ${entry.name} (${contentBytes} bytes)`,
    );
  }
  return {
    entry: { ...entry, relativePath },
    targetPath: resolveSkillSyncPathWithin(userRoot, relativePath, {
      unsafePathLabel: "unsafe subagent sync path",
    }),
  };
}

function assertNoDuplicateEntryIds(ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      throw new Error(`subagent sync entry duplicated: ${id}`);
    }
    seen.add(id);
  }
}

function collectBuiltInOverrideCandidates(
  state: AgentsStateFile,
  stateFile: string,
): SubagentSyncCandidate[] {
  const candidates: SubagentSyncCandidate[] = [];
  for (const agentName of BUILT_IN_AGENT_NAMES) {
    const modelSelection = state.builtInModelSelectionOverrides[agentName];
    // 本机没有覆盖就没有可同步的内容；远端可能残留旧值，但本机权威下无从判定「清除」。
    if (!modelSelection) continue;
    candidates.push({
      id: `${BUILT_IN_ID_PREFIX}${agentName}`,
      kind: "builtInModelOverride",
      name: agentName,
      agentName,
      modelSelection,
      path: stateFile,
    });
  }
  return candidates;
}

async function collectUserAgentCandidates(
  userRoot: string,
  state: AgentsStateFile,
): Promise<SubagentSyncCandidate[]> {
  const disabledIds = new Set(state.disabledAgentIds);
  const candidates: SubagentSyncCandidate[] = [];
  // 候选枚举必须与运行时发现共用同一实现：自定义 profile 只认 agents 根目录的直接文件。
  for (const filePath of await collectAgentMarkdownPaths(userRoot)) {
    const content = await readFile(filePath, "utf-8");
    const relativePath = toPosixRelativePath(userRoot, filePath);
    const parsed = parseSubagentMarkdown({ content, path: filePath, scope: "user" });
    const name = parsed.agent?.name ?? posix.basename(relativePath, posix.extname(relativePath));
    const enabled = parsed.agent
      ? !disabledIds.has(
          createAgentStateId({ name: parsed.agent.name, scope: "user", source: "user" }),
        )
      : true;
    candidates.push({
      id: `${USER_ID_PREFIX}${relativePath}`,
      kind: "userAgent",
      name,
      relativePath,
      enabled,
      contentHash: hashContent(content),
      sizeBytes: Buffer.byteLength(content, "utf-8"),
      path: filePath,
    });
  }
  return candidates.sort((left, right) => left.id.localeCompare(right.id));
}

function resolveBuiltInRemoteStatus(
  state: AgentsStateFile,
  candidate: { id: string; agentName?: BuiltInSubagentName; modelSelection?: ModelSelection },
): SubagentSyncRemoteStatus {
  if (!candidate.agentName) {
    return { id: candidate.id, state: "missing" };
  }
  const current = state.builtInModelSelectionOverrides[candidate.agentName];
  if (!current) {
    return { id: candidate.id, state: "missing" };
  }
  return {
    id: candidate.id,
    state: sameModelSelection(current, candidate.modelSelection) ? "same" : "different",
  };
}

async function resolveUserAgentRemoteStatus(
  targetPath: string,
  expectedHash: string | undefined,
): Promise<{ state: SubagentSyncRemoteStatus["state"]; path?: string }> {
  if (!existsSync(targetPath)) {
    return { state: "missing" };
  }
  const content = await readFile(targetPath, "utf-8");
  return {
    path: targetPath,
    state: expectedHash && hashContent(content) === expectedHash ? "same" : "different",
  };
}

interface AppliedStateChanges {
  /** 本次真正更新了覆盖的内置条目 id。 */
  builtInChangedIds: Set<string>;
  /** 本次真正改变了启用状态的 agent state id。 */
  disabledChangedAgentIds: Set<string>;
}

function applyEntriesToState(
  next: AgentsStateFile,
  parsedEntries: readonly ParsedImportedEntry[],
): AppliedStateChanges {
  const changes: AppliedStateChanges = {
    builtInChangedIds: new Set<string>(),
    disabledChangedAgentIds: new Set<string>(),
  };
  const disabledIds = new Set(next.disabledAgentIds);
  for (const parsed of parsedEntries) {
    if (parsed.entry.kind === "builtInModelOverride") {
      const agentName = parsed.entry.agentName;
      const selection = parsed.entry.modelSelection;
      if (!agentName || !selection) continue;
      if (sameModelSelection(next.builtInModelSelectionOverrides[agentName], selection)) continue;
      next.builtInModelSelectionOverrides = {
        ...next.builtInModelSelectionOverrides,
        [agentName]: selection,
      };
      changes.builtInChangedIds.add(parsed.entry.id);
      continue;
    }
    if (parsed.entry.kind !== "userAgent" || parsed.entry.enabled === undefined) continue;
    // 启用状态属于该 agent 的配置；只增删被同步条目的 id，其它 agent 状态保持原样。
    const agentId = createAgentStateId({
      name: parsed.entry.name,
      scope: "user",
      source: "user",
    });
    const shouldDisable = !parsed.entry.enabled;
    if (disabledIds.has(agentId) === shouldDisable) continue;
    if (shouldDisable) {
      disabledIds.add(agentId);
    } else {
      disabledIds.delete(agentId);
    }
    changes.disabledChangedAgentIds.add(agentId);
  }
  if (changes.disabledChangedAgentIds.size > 0) {
    next.disabledAgentIds = [...disabledIds].sort();
  }
  return changes;
}

function wasEntryApplied(
  parsed: ParsedImportedEntry,
  writtenPaths: ReadonlySet<string>,
  stateChanges: AppliedStateChanges,
): boolean {
  if (parsed.entry.kind === "builtInModelOverride") {
    return stateChanges.builtInChangedIds.has(parsed.entry.id);
  }
  if (parsed.targetPath && writtenPaths.has(parsed.targetPath)) {
    return true;
  }
  return stateChanges.disabledChangedAgentIds.has(
    createAgentStateId({ name: parsed.entry.name, scope: "user", source: "user" }),
  );
}

async function captureFileBackups(
  parsedEntries: readonly ParsedImportedEntry[],
): Promise<Map<string, string | null>> {
  const backups = new Map<string, string | null>();
  for (const parsed of parsedEntries) {
    if (parsed.entry.kind !== "userAgent" || !parsed.targetPath) continue;
    backups.set(
      parsed.targetPath,
      existsSync(parsed.targetPath) ? await readFile(parsed.targetPath, "utf-8") : null,
    );
  }
  return backups;
}

/** 回滚本次写入：文件恢复为备份内容（新建的删除），state 文件恢复为写入前原文。 */
async function rollbackImportedChanges(
  appliedFiles: readonly { path: string; previousContent: string | null }[],
  stateFile: string,
  previousStateRaw: string | null | undefined,
): Promise<string[]> {
  const failures: string[] = [];
  if (previousStateRaw !== undefined) {
    try {
      if (previousStateRaw === null) {
        await rm(stateFile, { force: true });
      } else {
        await atomicWriteText(stateFile, previousStateRaw);
      }
    } catch (error) {
      failures.push(`${stateFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  for (const applied of appliedFiles) {
    try {
      if (applied.previousContent === null) {
        await rm(applied.path, { force: true });
        continue;
      }
      await atomicWriteText(applied.path, applied.previousContent);
    } catch (error) {
      failures.push(`${applied.path}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return failures;
}

function cloneAgentsState(state: AgentsStateFile): AgentsStateFile {
  return {
    ...state,
    builtInModelSelectionOverrides: { ...state.builtInModelSelectionOverrides },
    pluginAgentModelSelectionOverrides: { ...state.pluginAgentModelSelectionOverrides },
    disabledAgentIds: [...state.disabledAgentIds],
  };
}

function sameModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel
  );
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex");
}

function toPosixRelativePath(root: string, filePath: string): string {
  return relative(root, filePath).split(sep).join("/");
}

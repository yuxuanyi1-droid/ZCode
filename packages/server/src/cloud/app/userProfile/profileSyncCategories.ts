/**
 * 连接期同步的逐类别执行器（specs/cloud-agent 14 §4.3–§4.5；W11 §13B）。
 *
 * 从 `profileSyncService.ts` 拆出（架构门禁 max-lines）：本文件只放「一个条目 → 既有服务
 * 调用序列」的翻译与既有条目索引（commands/subagents 的 create-or-update 判定）。
 * 编排（门控、单飞、汇总、日志）仍在 `profileSyncService.ts`。
 *
 * 全部调用经上层传入的 `SyncCall`（已含通道白名单预检与 RPC 端口），本文件不直接触网。
 */
import type {
  McpSyncImportResult,
  UserArchiveImportAppendChunkResult,
  UserArchiveImportBeginResult,
} from "@zcode/shared";
import type { UserProfileEntryRecord } from "../ports/userProfileStorePort.js";
import {
  decodeCanonicalBase64,
  encodeCanonicalBase64,
  planArchiveChunks,
  planCommandFileWrite,
  subagentConfigFromMarkdown,
} from "../../domain/userProfileSync.js";

/**
 * 既有 subagents 服务的 `provider` 取值：`ZCodeProvider` 是 **agent provider**
 * （`packages/shared/src/providers.ts`，当前唯一值 `"glm"`），与沙箱 provider（e2b/…）无关。
 */
const CLOUD_SUBAGENT_PROVIDER = "glm" as const;

export interface SyncTarget {
  taskId: string;
  runId: string;
  runGeneration: number;
  connectionEpoch: number;
  /** 沙箱侧工作区路径（attachment 地址的持久事实；既有 list 入参形状需要）。 */
  workspacePath: string;
}

/** 控制面 RPC 调用（编排层已做通道白名单预检）；失败以异常抛出（逐条 try 收口）。 */
export type SyncCall = (
  target: SyncTarget,
  channel: string,
  method: string,
  args: readonly unknown[],
) => Promise<unknown>;

/** 归档条目的 `entryId` == 落盘文件名（14 §4.5）：既有列表回投的路径取其 basename。 */
function basenameOf(path: string): string {
  const segments = path.split(/[\\/]+/u);
  return segments[segments.length - 1] ?? path;
}

/** mcp 分批导入（14 §4.2/§4.3）：servers 形状 = `{name, config, enabled}`，`localHomeDir` 占位。 */
export async function syncMcpBatch(
  call: SyncCall,
  target: SyncTarget,
  batch: readonly { entryId: string; config: Record<string, unknown> }[],
): Promise<McpSyncImportResult | null> {
  const outcome = await call(target, "mcp-sync", "importMcpServers", [
    {
      // 14 §4.2：`localHomeDir` 固定占位（云 profile 没有"本机 home"来源，不做 home 重写）；
      // `enabled` 显式 true——既有服务只在停用时才写该字段，省略会被判成停用
      // （`setServerEnabled(config, undefined)` 走停用分支）。
      servers: batch.map((item) => ({
        name: item.entryId,
        config: item.config,
        enabled: true,
      })),
      localHomeDir: "/",
    },
  ]);
  return (outcome as McpSyncImportResult) ?? null;
}

/**
 * 归档分块导入（14 §4.4）：begin → append×N（逐块 sha256）→ complete（整包 sha256 由服务核对）。
 * `hashBytes` 注入字节摘要（HashPort 的字节方法）：块摘要必须按**解码后字节**计算。
 */
export async function syncArchiveEntry(
  call: SyncCall,
  hashBytes: (bytes: Uint8Array) => Promise<string>,
  target: SyncTarget,
  record: UserProfileEntryRecord,
  channel: "skill-sync" | "plugin-sync",
): Promise<void> {
  // 正文 = canonical base64 归档字节（store 写入时已校验）；sha256 = 解码后字节摘要。
  const archive = decodeCanonicalBase64(record.content);
  const chunks = planArchiveChunks(archive);
  if (chunks.length === 0) throw new Error("archive entry has no bytes");
  const begin = (await call(target, channel, "beginUserArchiveImport", [
    {
      archiveSha256: record.sha256,
      totalBytes: archive.byteLength,
      chunkCount: chunks.length,
    },
  ])) as UserArchiveImportBeginResult;
  const importId = begin?.importId;
  if (typeof importId !== "string" || importId.length === 0) {
    throw new Error("archive import session missing importId");
  }
  for (const [index, chunk] of chunks.entries()) {
    const appended = (await call(target, channel, "appendUserArchiveImportChunk", [
      {
        importId,
        chunkIndex: index,
        chunkSha256: await hashBytes(chunk),
        payloadBase64: encodeCanonicalBase64(chunk),
      },
    ])) as UserArchiveImportAppendChunkResult;
    if (appended?.receivedChunks !== index + 1) {
      throw new Error(
        `archive chunk ${index} not acknowledged (receivedChunks=${String(appended?.receivedChunks)})`,
      );
    }
  }
  // complete 已委派既有导入链路（manifest/膨胀/穿越校验 + 解包落盘，14 §4.4）。
  await call(target, channel, "completeUserArchiveImport", [{ importId }]);
}

/** commands 逐条：新键走 write、已存在走 update（覆盖语义，14 §4.5/§4.7②）。 */
export async function syncCommandEntry(
  call: SyncCall,
  target: SyncTarget,
  record: UserProfileEntryRecord,
  existing: ReadonlyMap<string, { commandId: string; filePath: string }>,
): Promise<void> {
  const write = planCommandFileWrite({ entryId: record.entryId, content: record.content });
  const current = existing.get(record.entryId);
  if (!current) {
    await call(target, "commands", "writeCommandFile", [
      { config: { name: write.name, prompt: write.prompt }, storageLevel: "user" },
    ]);
    return;
  }
  await call(target, "commands", "updateCommandFile", [
    {
      commandId: current.commandId,
      config: { name: write.name, prompt: write.prompt },
      oldFilePath: current.filePath,
      storageLevel: "user",
    },
  ]);
}

/** subagents 逐条：markdown front-matter → 既有 create/update 的 `SubAgentConfig`（14 §4.5）。 */
export async function syncSubagentEntry(
  call: SyncCall,
  target: SyncTarget,
  record: UserProfileEntryRecord,
  existing: ReadonlyMap<string, { agentId: string; filePath: string }>,
): Promise<void> {
  const config = subagentConfigFromMarkdown({ entryId: record.entryId, content: record.content });
  const current = existing.get(record.entryId);
  if (!current) {
    await call(target, "subagents", "createAgent", [
      { config, provider: CLOUD_SUBAGENT_PROVIDER, scope: "user" },
    ]);
    return;
  }
  await call(target, "subagents", "updateAgent", [
    {
      agentId: current.agentId,
      config,
      oldFilePath: current.filePath,
      provider: CLOUD_SUBAGENT_PROVIDER,
      scope: "user",
    },
  ]);
}

/** AGENTS.md 单例：settings-sync 的最小写入方法整文件覆盖 `~/.zcode/AGENTS.md`（14 §4.5）。 */
export async function syncAgentsMdEntry(
  call: SyncCall,
  target: SyncTarget,
  record: UserProfileEntryRecord,
): Promise<void> {
  await call(target, "settings-sync", "writeUserAgentsFile", [{ content: record.content }]);
}

// ── 既有条目索引（create-or-update 判定来源；列表失败由编排层按类别整体记 failed）──

export async function listExistingCommands(
  call: SyncCall,
  target: SyncTarget,
): Promise<Map<string, { commandId: string; filePath: string }>> {
  const listed = (await call(target, "commands", "list", [{ agentSource: "zcodeAgent" }])) as
    | { commands?: { id?: unknown; filePath?: unknown; source?: unknown }[] }
    | undefined;
  const map = new Map<string, { commandId: string; filePath: string }>();
  for (const command of listed?.commands ?? []) {
    if (command.source !== "user") continue;
    if (typeof command.id !== "string" || typeof command.filePath !== "string") continue;
    map.set(basenameOf(command.filePath), { commandId: command.id, filePath: command.filePath });
  }
  return map;
}

export async function listExistingSubagents(
  call: SyncCall,
  target: SyncTarget,
): Promise<Map<string, { agentId: string; filePath: string }>> {
  const listed = (await call(target, "subagents", "list", [
    {
      workspacePath: target.workspacePath,
      provider: CLOUD_SUBAGENT_PROVIDER,
      // 只读用户级（settingsUserOnly 不扫 workspace scope）；workspacePath 仅满足既有入参形状。
      mode: "settingsUserOnly",
    },
  ])) as { agents?: { id?: unknown; path?: unknown; scope?: unknown; source?: unknown }[] };
  const map = new Map<string, { agentId: string; filePath: string }>();
  for (const agent of listed?.agents ?? []) {
    if (agent.scope !== "user" || agent.source !== "user") continue;
    if (typeof agent.id !== "string" || typeof agent.path !== "string") continue;
    map.set(basenameOf(agent.path), { agentId: agent.id, filePath: agent.path });
  }
  return map;
}

/** mcp 结果条目 → 逐条结论（`synced`/`skipped`/`failed`；缺失即 fail-closed）。 */
export function mcpEntryStatus(
  batchResult: McpSyncImportResult | null,
  entryId: string,
): "synced" | "skipped" | "failed" {
  const item = batchResult?.results?.find((entry) => entry.name === entryId);
  if (!item) return "failed";
  if (item.status === "failed" || item.status === "skipped") return item.status;
  return "synced";
}

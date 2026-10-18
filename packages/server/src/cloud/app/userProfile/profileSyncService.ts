/**
 * 连接期用户资源同步编排（M8；specs/cloud-agent 14 §4.1–§4.7、§9.5；W11 §13B；03 §6）。
 *
 * 语义（唯一执行器，自动/手动共用）：
 * - **取最新 profile**（不追踪 Run 版本，14 §4.7⑤）：`snapshot()` → `readVersionEntries()`，
 *   只同步 `enabled` 条目（条目级开关即交付集合，14 §9.1②）；
 * - **前置门控**（手动端点与自动触发同一入口）：Run 存在且非终态、无 `stopRequested`、
 *   当前 attachment 存在且 ready；不满足 → 结构化 `not_ready` + 原因
 *   （`run-not-found`/`run-terminal`/`run-not-connected`/`stop-requested`，14 §4.6）；
 * - **逐类别调既有服务**（14 §4.3，翻译在 `profileSyncCategories.ts`）：mcp 分批
 *   `importMcpServers`、skills/plugins 分块导入（begin/append/complete）、commands 经
 *   `writeCommandFile`/`updateCommandFile`、subagents 经 `writeUserAgentMarkdownFile`（原样写入）、
 *   agents-md 经 `writeUserAgentsFile`；全部经**控制面 RPC 端口**
 *   （`serviceScope:"control-plane"`，14 §4.2），通道白名单在此预检；
 * - **逐条 try**：单条失败记 `failed` 不中断其余（14 §4.2「失败不 fail run」）；整体响应
 *   = `{runId, profileVersion, trigger, results[]}`（shared `cloudUserProfileSyncResponseSchema`）；
 * - **单飞**：同一 Run 同一时刻至多一个同步序列；在飞期间自动触发跳过、手动请求等待
 *   同一次结果（不排队第二次调用，14 §4.6；join 回执保留那次同步的真实 `trigger`）；
 *   重连（新 epoch）后的自动触发各一次。
 *
 * 凭据边界（14 §5）：日志与逐条诊断只含 `category`/`entryId`/状态与有界错误文本，
 * 不含条目正文（mcp 的 token/headers/env 是凭据载体）。mcp 正文落库为 `enc:v1:` 密文
 * （R4），本服务在组装批次前解密；密文损坏按该条 `failed` 收口，不向沙箱下发密文。
 */
import {
  isCloudControlPlaneServiceAllowed,
  type CloudUserProfileSyncResponse,
  type CloudUserProfileSyncResultItem,
  type CloudUserProfileSyncTrigger,
  type McpSyncImportResult,
} from "@zcode/shared";
import { createCredentialCipherProvider } from "@zcode/services/node";
import type { AttachmentRegistry } from "../attachments/registry.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { fail, ok, type CloudAppResult } from "../result.js";
import { sortUserProfileEntries } from "../../domain/userProfile.js";
import { planMcpSyncBatches, userProfileSyncErrorText } from "../../domain/userProfileSync.js";
import {
  listExistingCommands,
  listExistingSubagents,
  mcpEntryStatus,
  syncAgentsMdEntry,
  syncArchiveEntry,
  syncCommandEntry,
  syncMcpBatch,
  syncSubagentEntry,
  type SyncCall,
  type SyncTarget,
} from "./profileSyncCategories.js";

export interface ProfileSyncService {
  /**
   * 执行一次同步（自动/手动共用同一执行器）。不满足门控时返回结构化失败
   * （`not_ready` + 原因，或 `not_found`/`not_configured`），不产生半份同步。
   */
  syncTaskProfile(input: {
    taskId: string;
    trigger: CloudUserProfileSyncTrigger;
  }): Promise<CloudAppResult<CloudUserProfileSyncResponse>>;
  /**
   * `bridge.ready` 之后的异步自动触发（14 §4.6）：同 run+epoch 只触发一次；失败只记
   * `warn`（**不 fail run**）。本方法同步返回，调用方不需要等待同步完成。
   */
  triggerAutomatic(input: {
    taskId: string;
    runId: string;
    runGeneration: number;
    connectionEpoch: number;
  }): void;
}

/** 自动触发去重集合的有界上限（FIFO 淘汰；连接态事实、可重建，不持久化）。 */
const AUTO_TRIGGERED_MAX_KEYS = 256;

/** 终态 run 集合（`ACTIVE_RUN_STATUSES` 的补集；此处只列显式终态，08 §3.2）。 */
function isTerminalRunStatus(status: string): boolean {
  return status === "stopped" || status === "expired" || status === "failed";
}

export function createProfileSyncService(
  deps: CloudCoreDeps,
  registry: AttachmentRegistry,
): ProfileSyncService {
  const { storage, userProfile, controlPlaneRpc, hash } = deps;
  // R4（14 §5）：mcp 正文落库为 `enc:v1:` 密文，下发前解密；旧明文行由 decrypt 原样返回。
  const cipher = deps.credentialCipher ?? createCredentialCipherProvider();
  const inflight = new Map<string, Promise<CloudAppResult<CloudUserProfileSyncResponse>>>();
  const autoTriggered = new Set<string>();

  function markAutoTriggered(key: string): void {
    autoTriggered.add(key);
    while (autoTriggered.size > AUTO_TRIGGERED_MAX_KEYS) {
      const oldest = autoTriggered.values().next().value;
      if (oldest === undefined) break;
      autoTriggered.delete(oldest);
    }
  }

  /**
   * 门控（14 §4.6）：Run 存在且非终态、无 stop 屏障、当前 attachment ready。
   * 顺序即语义：先判 Run 事实，再看连接态（终态 run 必然没有有效连接）。
   */
  async function resolveTarget(taskId: string): Promise<CloudAppResult<SyncTarget>> {
    const task = await storage.tasks.get(taskId);
    if (!task) return fail("not_found", "task-not-found");
    const runId = task.activeRunId;
    if (!runId) return fail("not_ready", "run-not-found", { taskId });
    const run = await storage.runs.get(runId);
    if (!run || run.taskId !== taskId) return fail("not_ready", "run-not-found", { taskId });
    if (isTerminalRunStatus(run.status)) {
      return fail("not_ready", "run-terminal", { runId: run.runId });
    }
    if (run.stopRequested) {
      // stop 屏障（08 §8.1）：不再向该 run 写入任何资源；恢复手段是停止/重开流程。
      return fail("not_ready", "stop-requested", { runId: run.runId });
    }
    const session = registry.current(run.runId);
    if (!session || !session.ready) {
      // 未连接/未 ready：同步按构造只发生在连接期（relay 帧 pre-ready 被丢弃，14 §4.2）。
      return fail("not_ready", "run-not-connected", { runId: run.runId });
    }
    return ok({
      taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      connectionEpoch: session.connectionEpoch,
      workspacePath: session.address.workspacePath,
    });
  }

  /** 控制面 RPC 调用的唯一出口：通道白名单预检 + 端口调用 + 结论归一（见 categories 文件）。 */
  const call: SyncCall = async (target, channel, method, args) => {
    if (!isCloudControlPlaneServiceAllowed(channel)) {
      // 白名单预检（14 §4.2）：控制面方向只放行既有 sync 服务通道，不越权到浏览器面通道。
      throw new Error(`channel ${channel} is not allowed for control-plane sync`);
    }
    if (!controlPlaneRpc) throw new Error("control-plane rpc port is not wired");
    const result = await controlPlaneRpc.call({
      runId: target.runId,
      runGeneration: target.runGeneration,
      connectionEpoch: target.connectionEpoch,
      channel,
      method,
      args,
    });
    if (result.status !== "ok") {
      // 断连/超时/旧代际：该次同步整体失败（不重试，靠手动或下次连接恢复，14 §4.6）。
      throw new Error(`${channel}.${method} failed: ${result.reason} (${result.message})`);
    }
    return result.result;
  };

  // ── 执行器 ──

  async function execute(
    target: SyncTarget,
    trigger: CloudUserProfileSyncTrigger,
  ): Promise<CloudAppResult<CloudUserProfileSyncResponse>> {
    if (!userProfile) return fail("not_configured", "user-profile-store-missing");
    if (!controlPlaneRpc) return fail("not_configured", "control-plane-rpc-missing");

    const snapshot = await userProfile.snapshot();
    const records = await userProfile.readVersionEntries(snapshot.profileVersion);
    if (!records) {
      // 刚读到的当前版本解析不到正文：持久层损坏，fail-closed（不装半份）。
      return fail("invalid_ref", "profile-version-unreadable", {
        profileVersion: snapshot.profileVersion,
      });
    }
    const enabled = sortUserProfileEntries(records.filter((record) => record.enabled));
    const results: CloudUserProfileSyncResultItem[] = [];

    // mcp 分批（14 §4.2：序列化后 ≤2MiB/批，批内/批间串行）：先算批次，再逐批调用。
    // 批结论按批号缓存：批内非首条目直接消费同一份结果（不做第二次调用）。
    // 正文不可解析（持久层损坏）的条目不进批：在循环内按该条 failed 收口，不中断其余。
    const mcpUnreadable = new Set<string>();
    const mcpBatches = planMcpSyncBatches(
      enabled
        .filter((record) => record.category === "mcp")
        .flatMap((record) => {
          try {
            // R4（14 §5）：解密后再解析；损坏密文/密钥不匹配与非法 JSON 同口径——
            // 该条 fail-closed，不把密文当正文下发，也不中断其余条目/类别。
            const plaintext = cipher.decrypt(record.content);
            return [
              {
                entryId: record.entryId,
                config: JSON.parse(plaintext) as Record<string, unknown>,
              },
            ];
          } catch {
            mcpUnreadable.add(record.entryId);
            return [];
          }
        }),
    );
    const mcpBatchByEntry = new Map<string, number>();
    mcpBatches.forEach((batch, index) => {
      for (const item of batch) mcpBatchByEntry.set(item.entryId, index);
    });
    const mcpBatchResults = new Map<number, McpSyncImportResult | null>();
    const mcpBatchErrors = new Map<number, string>();

    // commands/subagents 的 create-or-update 判定需要一次既有 list（14 §4.5）；
    // 列表失败不阻断其它类别：这两类整体记 failed（逐条结论仍逐条给出）。
    let commandIndex: Map<string, { commandId: string; filePath: string }> | null = null;
    let subagentIndex: Map<string, { agentId: string; filePath: string }> | null = null;
    let commandIndexError: string | null = null;
    let subagentIndexError: string | null = null;

    for (const record of enabled) {
      try {
        switch (record.category) {
          case "mcp": {
            // 同一批内的条目共享一次调用：批首条目发起，其余条目消费批结论。
            if (mcpUnreadable.has(record.entryId)) {
              // 正文不是合法 JSON（写事务保证不该发生）：按条 fail-closed，不中断其余类别。
              throw new Error("mcp entry content is not readable");
            }
            const batchIndex = mcpBatchByEntry.get(record.entryId);
            const batch = batchIndex === undefined ? undefined : mcpBatches[batchIndex];
            if (!batch || batchIndex === undefined) {
              throw new Error("mcp batch plan missing for entry");
            }
            if (batch[0]?.entryId === record.entryId && !mcpBatchResults.has(batchIndex)) {
              try {
                mcpBatchResults.set(batchIndex, await syncMcpBatch(call, target, batch));
              } catch (error) {
                // 批结论整体失败：同批其余条目消费同一份错误（不重试，14 §4.2）。
                mcpBatchErrors.set(batchIndex, userProfileSyncErrorText(error));
                throw error;
              }
            }
            const batchError = mcpBatchErrors.get(batchIndex);
            if (batchError !== undefined) throw new Error(batchError);
            const status = mcpEntryStatus(mcpBatchResults.get(batchIndex) ?? null, record.entryId);
            if (status === "failed") throw new Error("mcp import failed for entry");
            if (status === "skipped") {
              // 同名已存在：沿用既有 skip 语义（不覆盖，14 §4.7①）。
              results.push({
                category: record.category,
                entryId: record.entryId,
                status: "skipped",
              });
              continue;
            }
            break;
          }
          case "skills":
          case "plugins":
            await syncArchiveEntry(
              call,
              (chunk) => hash.sha256HexBytes(chunk),
              target,
              record,
              record.category === "skills" ? "skill-sync" : "plugin-sync",
            );
            break;
          case "commands": {
            if (commandIndex === null && commandIndexError === null) {
              try {
                commandIndex = await listExistingCommands(call, target);
              } catch (error) {
                commandIndexError = userProfileSyncErrorText(error);
              }
            }
            if (commandIndex === null) throw new Error(commandIndexError ?? "command index failed");
            await syncCommandEntry(call, target, record, commandIndex);
            break;
          }
          case "subagents": {
            if (subagentIndex === null && subagentIndexError === null) {
              try {
                subagentIndex = await listExistingSubagents(call, target);
              } catch (error) {
                subagentIndexError = userProfileSyncErrorText(error);
              }
            }
            if (subagentIndex === null) {
              throw new Error(subagentIndexError ?? "subagent index failed");
            }
            // list 结论用于判断存在（14 §4.5）；新增/已存在都走同一原生 markdown 覆盖写，
            // 不再按存在性分叉 createAgent/updateAgent（后者会规范化正文，见 categories 文件）。
            await syncSubagentEntry(call, target, record);
            break;
          }
          case "agents-md":
            await syncAgentsMdEntry(call, target, record);
            break;
          default:
            throw new Error(`unsupported profile category ${String(record.category)}`);
        }
        results.push({ category: record.category, entryId: record.entryId, status: "synced" });
      } catch (error) {
        // 单条失败不中断其余（14 §4.2）：结果定位到 category/entryId，错误文本有界且无正文。
        results.push({
          category: record.category,
          entryId: record.entryId,
          status: "failed",
          error: userProfileSyncErrorText(error),
        });
      }
    }

    logSyncOutcome(target, trigger, snapshot.profileVersion, results);
    return ok({
      runId: target.runId,
      profileVersion: snapshot.profileVersion,
      trigger,
      results,
    });
  }

  return {
    async syncTaskProfile(input) {
      const resolved = await resolveTarget(input.taskId);
      if (!resolved.ok) return resolved;
      const target = resolved.value;

      const running = inflight.get(target.runId);
      if (running) {
        // 单飞（14 §4.6）：在飞期间自动触发跳过；手动请求等待同一次结果返回
        // （不排队第二次调用）。joined 回执保留那次同步的真实 trigger。
        if (input.trigger === "automatic") return running;
        return running;
      }
      const promise = execute(target, input.trigger);
      inflight.set(target.runId, promise);
      try {
        return await promise;
      } finally {
        if (inflight.get(target.runId) === promise) inflight.delete(target.runId);
      }
    },

    triggerAutomatic(input) {
      const key = `${input.runId}:${input.connectionEpoch}`;
      if (autoTriggered.has(key)) return;
      markAutoTriggered(key);
      void (async () => {
        // 门控在 syncTaskProfile 内统一裁决（自动与手动同一入口）；这里只保证不抛。
        const result = await this.syncTaskProfile({
          taskId: input.taskId,
          trigger: "automatic",
        });
        if (!result.ok) {
          cloudCoreLogger.warn(undefined, "cloud user profile auto sync skipped", {
            taskId: input.taskId,
            runId: input.runId,
            connectionEpoch: input.connectionEpoch,
            code: result.code,
            reason: result.reason,
          });
        }
      })().catch((error: unknown) => {
        // 悬浮 Promise 必须自兜（不 fail run，只记日志，14 §4.6）。
        cloudCoreLogger.warn(undefined, "cloud user profile auto sync failed", {
          taskId: input.taskId,
          runId: input.runId,
          connectionEpoch: input.connectionEpoch,
          error: userProfileSyncErrorText(error),
        });
      });
    },
  };
}

/** 同步结论日志（只记计数与定位，不含正文，14 §5）。 */
function logSyncOutcome(
  target: SyncTarget,
  trigger: CloudUserProfileSyncTrigger,
  profileVersion: number,
  results: readonly CloudUserProfileSyncResultItem[],
): void {
  const failed = results.filter((item) => item.status === "failed");
  const fields = {
    taskId: target.taskId,
    runId: target.runId,
    runGeneration: target.runGeneration,
    connectionEpoch: target.connectionEpoch,
    trigger,
    profileVersion,
    total: results.length,
    synced: results.filter((item) => item.status === "synced").length,
    skipped: results.filter((item) => item.status === "skipped").length,
    failed: failed.length,
  };
  if (failed.length === 0) {
    cloudCoreLogger.info(undefined, "cloud user profile sync completed", fields);
    return;
  }
  cloudCoreLogger.warn(undefined, "cloud user profile sync completed with failures", {
    ...fields,
    // 失败定位到 category/entryId 与有界错误文本（不含正文）。
    failures: failed.map((item) => `${item.category}/${item.entryId}:${item.error ?? ""}`),
  });
}

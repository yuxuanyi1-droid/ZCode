/**
 * 唯一 durable input gateway（02 §6.1「唯一写入路径」、03 §6.1「请求 fingerprint 与执行
 * recipe」、§6.2「投递、失败与响应」、11 §6 首次接纳与启动顺序）。
 *
 * 顺序是冻结的（03 §6.1 尾段），也是最容易实现错的地方：
 *   1. 鉴权与归属 → 2. 按原 commandId 去重（同 fingerprint 返回原 receipt，
 *   不同 fingerprint 冲突）→ 3. 仅新请求做外部预检（分支 SHA、provider、模板）→
 *   4. 事务内再去重并检查 revision/Run/stop/配额，写 Input + Run recipe +
 *   firstInputCommandId + acceptanceSeq + 配额 + create 操作。
 *
 * 硬约束：
 * - HTTP `/inputs` 与 `/ws/cloud/tasks/:taskId` 的发送共用本 gateway；不另建第二套队列
 *   （02 §6.1、03 §7.2）。
 * - 202 表示持久接收，不是 runtime 执行；本文件不伪造 CommandAck（00 §4、02 §2 不变量 6）。
 * - 预检不占 SQLite 写事务；采用预检查询到的分支 SHA，不承诺跨 GitHub/SQLite 原子取得
 *   「点击瞬间最新 HEAD」，此后不再重新解析分支头（11 §6、09 §4.1）。
 */
import type { CloudTaskInputRecord, InputReceipt } from "@zcode/shared";
import {
  canonicalInputFingerprint,
  decideDuplicate,
  type InputFingerprintInput,
} from "../../domain/idempotency.js";
import type { CloudCoreDeps } from "../deps.js";
import { fail, ok, type CloudAppFailure, type CloudAppResult } from "../result.js";
import { cloudCoreLogger } from "../logger.js";
import { createInputPrechecks, type CloudInputRequest } from "./precheck.js";

// 请求联合类型定义在 precheck.ts（唯一判别点），此处只转出，保持单向依赖无环。
export type { CloudInputRequest } from "./precheck.js";

export interface SubmitCloudInput {
  principalId: string;
  taskId: string;
  request: CloudInputRequest;
  /** 来源只用于日志/诊断：两条入口走同一事务与同一投递路径。 */
  source: "http" | "rpc";
}

export interface InputGateway {
  submit(input: SubmitCloudInput): Promise<CloudAppResult<InputReceipt>>;
  getReceipt(input: {
    principalId: string;
    taskId: string;
    commandId: string;
  }): Promise<CloudAppResult<InputReceipt>>;
  listInputs(input: {
    principalId: string;
    taskId: string;
    cursor?: string;
    limit?: number;
  }): Promise<CloudAppResult<{ items: CloudTaskInputRecord[]; nextCursor?: string }>>;
}

const DEFAULT_INPUT_PAGE = 50;

export function createInputGateway(deps: CloudCoreDeps): InputGateway {
  const { storage, clock, hash, config } = deps;
  // 外部预检（分支 SHA/provider/模板/重开前置）单独一个文件，规则与事务边界见 precheck.ts。
  const prechecks = createInputPrechecks(deps);

  async function receiptOf(record: CloudTaskInputRecord): Promise<InputReceipt> {
    const receipt: InputReceipt = {
      taskId: record.taskId,
      commandId: record.commandId,
      deliveryStatus: record.deliveryStatus,
    };
    if (record.targetRunId) {
      receipt.runId = record.targetRunId;
      const run = await storage.runs.get(record.targetRunId);
      if (run) receipt.runGeneration = run.runGeneration;
    }
    if (record.runtimeAck) receipt.runtimeAck = record.runtimeAck;
    return receipt;
  }

  function fingerprintOf(request: CloudInputRequest): InputFingerprintInput {
    switch (request.intent) {
      case "start":
        return {
          intent: "start",
          prompt: request.prompt,
          attachmentIds: request.attachmentIds,
          requestedConfig: request.requestedConfig,
          start: request.start,
          expectedTaskRevision: request.expectedTaskRevision,
        };
      case "reopen":
        return {
          intent: "reopen",
          prompt: request.prompt,
          attachmentIds: request.attachmentIds,
          requestedConfig: request.requestedConfig,
          // reopen 的恢复选择与 provider 是语义字段的一部分（08 §9）。
          start: { provider: request.provider, resume: request.resume },
          expectedTaskRevision: request.expectedTaskRevision,
        };
      default:
        return {
          intent: "append",
          prompt: request.prompt,
          attachmentIds: request.attachmentIds,
          requestedConfig: request.requestedConfig,
          expectedRunGeneration: request.expectedRunGeneration,
        };
    }
  }

  return {
    async submit(input) {
      const task = await storage.tasks.get(input.taskId);
      // 03 §3：跨主体统一 not_found，不泄漏存在性。
      if (!task || task.ownerPrincipalId !== input.principalId) {
        return fail("not_found", "task-not-found");
      }
      // fingerprint 只覆盖原请求语义字段：解析出的默认值/SHA 不混入（03 §6.1）。
      const payloadHash = await hash.sha256Hex(
        canonicalInputFingerprint(fingerprintOf(input.request)),
      );

      // 去重先于新请求 CAS（03 §6.1、CT-07）。
      const existing = await storage.inputs.get(task.taskId, input.request.commandId);
      const duplicate = decideDuplicate({ existing, incomingPayloadHash: payloadHash });
      if (duplicate.kind === "duplicate") {
        // 合法重放不因 task revision 增长失败，也不重新解析默认值（03 §6.1 尾段）。
        return ok(await receiptOf(duplicate.existing));
      }
      if (duplicate.kind === "conflict") {
        return fail("idempotency_conflict", "command-payload-mismatch", {
          commandId: input.request.commandId,
        });
      }

      // 附件门控：协议有 attachments 字段不证明可直接复用（03 §6、11 §9）。
      if (input.request.attachmentIds?.length) {
        if (!config.taskOwnedAttachments) {
          return fail("validation_failed", "attachments-not-enabled");
        }
        return fail("validation_failed", "attachments-materialization-not-implemented");
      }

      const precheck = await prechecks.precheck(input.request, task);
      if (!precheck.ok) return precheck;

      const accepted = await storage.acceptInput({
        taskId: task.taskId,
        commandId: input.request.commandId,
        intent: input.request.intent,
        payloadHash,
        prompt: input.request.prompt,
        attachmentIds: input.request.attachmentIds,
        requestedConfig: input.request.requestedConfig,
        resolvedExecutionConfig: input.request.requestedConfig,
        expectedTaskRevision:
          input.request.intent === "append" ? undefined : input.request.expectedTaskRevision,
        expectedRunGeneration:
          input.request.intent === "append" ? input.request.expectedRunGeneration : undefined,
        ...precheck.acceptFields,
        // 配额上限由 domain 判定后传入，事务内 count+reserve 一次完成（08 §6、01 §4.3）。
        quota: { maxConcurrentRuns: config.maxConcurrentRuns },
        now: clock.now(),
      });

      switch (accepted.status) {
        case "accepted": {
          // 请求寿命只算一次（接纳期，01 §4.3）：D4-7 修复后 hardDeadlineAt 与 runs 行
          // 在 acceptInput **同一事务**落库，这里不再有事务提交后的补写路径——原
          // 「提交后 updateLease 补写 hardDeadlineAt」在崩溃窗口下会让 create worker
          // 读不到期限走本地重算、且永久 NULL 时续期无上界。此处只做审计投影。
          const lease = precheck.acceptFields.lease;
          if (lease && accepted.runId) {
            cloudCoreLogger.info(undefined, "cloud run lifetime planned", {
              taskId: task.taskId,
              runId: accepted.runId,
              ...(accepted.runGeneration === undefined
                ? {}
                : { runGeneration: accepted.runGeneration }),
              hardDeadlineAt: lease.hardDeadlineAt,
              effectiveLifetimeMs: lease.effectiveLifetimeMs,
              basis: lease.basis,
              providerLimitKnown: lease.providerLimitKnown,
              converged: lease.converged,
            });
          }
          return ok(accepted.receipt);
        }
        case "duplicate":
          return ok(accepted.receipt);
        default:
          return conflictToFailure(accepted.reason);
      }
    },

    async getReceipt(input) {
      const task = await storage.tasks.get(input.taskId);
      if (!task || task.ownerPrincipalId !== input.principalId) {
        return fail("not_found", "task-not-found");
      }
      const record = await storage.inputs.get(input.taskId, input.commandId);
      if (!record) return fail("not_found", "input-not-found");
      return ok(await receiptOf(record));
    },

    async listInputs(input) {
      const task = await storage.tasks.get(input.taskId);
      if (!task || task.ownerPrincipalId !== input.principalId) {
        return fail("not_found", "task-not-found");
      }
      const page = await storage.inputs.list(input.taskId, {
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_INPUT_PAGE,
      });
      return ok(page);
    },
  };

  /**
   * 外部预检（03 §6.1）：只对新请求执行，且在事务之外。通过时返回接纳事务需要的
   * 冻结事实（Run recipe、taskBranch、create 意图、runId）。
   */
}

/** 事务冲突 → 结构化错误：code 取 shared 目录，reason 是稳定的机器可读标签（03 §6.2）。 */
function conflictToFailure(reason: string): CloudAppFailure {
  switch (reason) {
    case "payload-mismatch":
      return fail("idempotency_conflict", reason);
    case "revision-mismatch":
    case "generation-stale":
    case "start-on-active":
      return fail("stale", reason);
    case "quota-exceeded":
      return fail("quota_exceeded", reason);
    case "stop-requested":
    case "not-ready":
    case "no-active-run":
      return fail("not_ready", reason);
    default:
      return fail("validation_failed", reason);
  }
}

/**
 * 输入取消、ACK 落地与对账（02 §6.2 保留既有 V4 语义、§6.3 ACK 丢失与执行节点退出、
 * 03 §6 cancel 行、§7.2「命令发送超时先查询 commandId」）。
 *
 * 冻结规则：
 * - RPC timeout/断连不是 runtime rejected：先置 `uncertain`，重连后 query 同 command key
 *   （02 §6.3）；不把未确认命令自动移到新 Run。
 * - `duplicate` 不能一律当 admitted：rejected/stale/noop/failed 保持错误与原因（02 §6.2）。
 * - 未开始投递的输入可经事务 CAS 标 `cancelled`，dispatcher 不再取出；已投递但 ACK 未知时
 *   先对账，不能声称 runtime 已停止（02 §6.3）。
 * - 已 admitted 的取消必须由**新的幂等 runtime 命令**处理（03 §6 cancel 行）：它需要一条
 *   独立的持久投递记录（与 task_inputs 共用投递状态机，见 cloud/CONTRACT.md 表
 *   `task_input_interaction_decisions`），W0 冻结的 `StoragePort` 未暴露该能力，故本函数
 *   在该分支返回结构化 `not_implemented` 且**不发送**未持久化的副作用（见报告 CR-3）。
 */
import type { CloudTaskInputRecord, InputReceipt } from "@zcode/shared";
import type { CommandAck } from "@zcode/shared/zcode-protocol-v4";
import type { CloudRunRecord } from "@zcode/shared";
import type { AttachmentRegistry } from "../attachments/registry.js";
import { resolveRuntimeSession } from "../runSession.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { canAdvanceDeliveryStatus } from "../../domain/deliveryStatus.js";
import { fail, ok, type CloudAppResult } from "../result.js";

export interface RuntimeAckInput {
  taskId: string;
  commandId: string;
  runId: string;
  runGeneration: number;
  deliveryStatus: "admitted" | "rejected";
  runtimeAck: CommandAck;
}

export interface ReconcileReport {
  taskId: string;
  examined: number;
  resolved: number;
  stillUncertain: number;
  resent: number;
}

export interface InputDeliveryControl {
  cancelInput(input: {
    principalId: string;
    taskId: string;
    commandId: string;
  }): Promise<CloudAppResult<InputReceipt>>;
  /** 实现 `AttachmentIngestPort.recordRuntimeAck`（02 §6.2 的 ACK 落地）。 */
  recordRuntimeAck(input: RuntimeAckInput): Promise<void>;
  reconcileTask(taskId: string): Promise<ReconcileReport>;
  reconcileOnce(): Promise<ReconcileReport[]>;
}

export function createInputDeliveryControl(
  deps: CloudCoreDeps,
  registry: AttachmentRegistry,
): InputDeliveryControl {
  const { storage, runtimeCommands, clock } = deps;

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

  async function recordRuntimeAck(input: RuntimeAckInput): Promise<void> {
    const run = await storage.runs.get(input.runId);
    if (!run) {
      cloudCoreLogger.warn(undefined, "runtime ack for unknown run", { runId: input.runId });
      return;
    }
    if (run.runGeneration !== input.runGeneration) {
      // 旧代际帧不得修改新 run（08 §4.2、02 §2 不变量 3）。
      cloudCoreLogger.warn(undefined, "stale runtime ack rejected", {
        runId: input.runId,
        ackGeneration: input.runGeneration,
        currentGeneration: run.runGeneration,
      });
      return;
    }
    const mapped = mapCommandAck(input.runtimeAck);
    if (mapped.deliveryStatus !== input.deliveryStatus) {
      // 控制面按 02 §6.2 自行判定 duplicate/失败语义，传输侧分类只作交叉核对。
      cloudCoreLogger.warn(undefined, "runtime ack classification mismatch", {
        runId: input.runId,
        commandId: input.commandId,
        reported: input.deliveryStatus,
        mapped: mapped.deliveryStatus,
      });
    }
    const runtimeSessionId = sessionIdFromAck(input.runtimeAck);
    if (runtimeSessionId) {
      // CR-6 冻结写口：run↔session 映射按 runGeneration CAS，重连不重造会话（02 §6.2）。
      await storage.runs.setRunRuntimeSessionId({
        runId: run.runId,
        runGeneration: run.runGeneration,
        runtimeSessionId,
        now: clock.now(),
      });
    }
    // 一条 ACK 只属于一类记录：正文输入 receipt，或交互决定的投递记录（按
    // `(taskId, deliveryCommandId)` 反查，deliveryCommandId 就是投递用的 commandId）。
    const inputRecord = await storage.inputs.get(input.taskId, input.commandId);
    if (inputRecord) {
      if (canAdvanceDeliveryStatus(inputRecord.deliveryStatus, mapped.deliveryStatus)) {
        await storage.inputs.markDelivery({
          taskId: input.taskId,
          commandId: input.commandId,
          to: mapped.deliveryStatus,
          runtimeAck: input.runtimeAck,
          runId: run.runId,
          runtimeSessionId,
          lastError: mapped.lastError,
          now: clock.now(),
        });
      } else {
        // 终态不再回退：更慢的 ACK 不得覆盖已落地的结论（02 §6.3）。
        cloudCoreLogger.warn(undefined, "runtime ack ignored: delivery already settled", {
          taskId: input.taskId,
          commandId: input.commandId,
          current: inputRecord.deliveryStatus,
          incoming: mapped.deliveryStatus,
        });
      }
      cloudCoreLogger.info(undefined, "cloud input runtime ack recorded", {
        taskId: input.taskId,
        runId: run.runId,
        commandId: input.commandId,
        deliveryStatus: mapped.deliveryStatus,
      });
      return;
    }

    const decisions = deps.interactionDecisions;
    const decision = decisions
      ? await decisions.findDecisionByDeliveryCommandId(input.taskId, input.commandId)
      : null;
    if (decisions && decision) {
      if (canAdvanceDeliveryStatus(decision.deliveryStatus, mapped.deliveryStatus)) {
        await decisions.setDecisionDeliveryStatus({
          taskId: input.taskId,
          interactionId: decision.interactionId,
          status: mapped.deliveryStatus,
          ...(mapped.lastError ? { lastError: mapped.lastError } : {}),
        });
      } else {
        cloudCoreLogger.warn(undefined, "runtime ack ignored: decision already settled", {
          taskId: input.taskId,
          interactionId: decision.interactionId,
          current: decision.deliveryStatus,
          incoming: mapped.deliveryStatus,
        });
      }
      cloudCoreLogger.info(undefined, "cloud interaction decision ack recorded", {
        taskId: input.taskId,
        runId: run.runId,
        interactionId: decision.interactionId,
        deliveryStatus: mapped.deliveryStatus,
      });
      return;
    }

    // 既不是正文输入也不是决定：不新建记录、不伪造状态，按对账路径留痕（属于异常事实）。
    cloudCoreLogger.warn(undefined, "runtime ack without local record", {
      taskId: input.taskId,
      runId: run.runId,
      commandId: input.commandId,
      ackStatus: input.runtimeAck.status,
    });
  }

  async function reconcileInput(
    run: CloudRunRecord,
    input: CloudTaskInputRecord,
  ): Promise<"resolved" | "still-uncertain" | "resent"> {
    const query = await runtimeCommands.queryCommand({
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      commandId: input.commandId,
      runtimeSessionId: await resolveRuntimeSession(deps, run),
    });
    if (query.status === "found") {
      const mapped = mapCommandAck(query.ack);
      const sessionId = sessionIdFromAck(query.ack);
      if (sessionId) {
        await storage.runs.setRunRuntimeSessionId({
          runId: run.runId,
          runGeneration: run.runGeneration,
          runtimeSessionId: sessionId,
          now: clock.now(),
        });
      }
      await storage.inputs.markDelivery({
        taskId: run.taskId,
        commandId: input.commandId,
        to: mapped.deliveryStatus,
        runtimeAck: query.ack,
        runId: run.runId,
        runtimeSessionId: sessionIdFromAck(query.ack),
        lastError: mapped.lastError,
        now: clock.now(),
      });
      return "resolved";
    }
    if (query.status === "unavailable") {
      // 运行时不可达：保持 uncertain，不跨 Run 重放（02 §6.3）。
      return "still-uncertain";
    }
    // runtime 没有该命令事实：只有确认同 Run/runtime 可安全去重才重发原信封（02 §6.3）。
    const resolution = registry.resolve({
      runId: run.runId,
      runGeneration: run.runGeneration,
      requireReady: true,
    });
    if (resolution.status !== "ok") return "still-uncertain";
    // 发送仍走 dispatcher 的唯一路径：这里只把状态退回 accepted，让 dispatcher 重新投递同 commandId。
    // 依赖：`markDelivery` 的 CAS 允许「对账确认后 uncertain → accepted」这一条回退；
    // 若 W2 实现为严格单向前进，这里返回 null，函数保持 uncertain（不谎称已重发）。
    const requeued = await storage.inputs.markDelivery({
      taskId: run.taskId,
      commandId: input.commandId,
      to: "accepted",
      runId: run.runId,
      lastError: "requeued-after-reconcile",
      now: clock.now(),
    });
    return requeued ? "resent" : "still-uncertain";
  }

  async function reconcileTask(taskId: string): Promise<ReconcileReport> {
    const report: ReconcileReport = {
      taskId,
      examined: 0,
      resolved: 0,
      stillUncertain: 0,
      resent: 0,
    };
    const run = await storage.runs.activeOfTask(taskId);
    if (!run || run.status === "stopped" || run.status === "expired" || run.status === "failed") {
      return report;
    }
    const inputs = await storage.inputs.listDeliverable(taskId);
    for (const input of inputs) {
      // 只对账 `uncertain`：刚投递成功仍在等 ACK 的 `delivering` 由 ingest 落地；
      // 超时/控制面重启由启动对账先把它收口为 uncertain 再进入本路径（02 §6.3、03 §8）。
      if (input.deliveryStatus !== "uncertain") continue;
      report.examined += 1;
      const outcome = await reconcileInput(run, input);
      if (outcome === "resolved") report.resolved += 1;
      else if (outcome === "resent") report.resent += 1;
      else report.stillUncertain += 1;
    }
    return report;
  }

  return {
    async cancelInput(input) {
      const task = await storage.tasks.get(input.taskId);
      if (!task || task.ownerPrincipalId !== input.principalId) {
        return fail("not_found", "task-not-found");
      }
      const record = await storage.inputs.get(input.taskId, input.commandId);
      if (!record) return fail("not_found", "input-not-found");

      switch (record.deliveryStatus) {
        case "cancelled":
        case "rejected":
          // 幂等撤销：已是终态直接回原 receipt（03 §6 cancel 行）。
          return ok(await receiptOf(record));
        case "accepted": {
          const cancelled = await storage.inputs.cancelPending({
            taskId: input.taskId,
            commandId: input.commandId,
            now: clock.now(),
          });
          if (!cancelled) return fail("stale", "cancel-race");
          return ok(await receiptOf(cancelled));
        }
        case "delivering":
        case "uncertain": {
          // 先对账再决定：能证明 runtime 从未收到 → 可撤销；已准入 → 走独立 cancel 命令。
          const run = await storage.runs.activeOfTask(input.taskId);
          if (run) await reconcileInput(run, record);
          const refreshed = await storage.inputs.get(input.taskId, input.commandId);
          if (!refreshed) return fail("not_found", "input-not-found");
          if (refreshed.deliveryStatus === "accepted") {
            const cancelled = await storage.inputs.cancelPending({
              taskId: input.taskId,
              commandId: input.commandId,
              now: clock.now(),
            });
            if (cancelled) return ok(await receiptOf(cancelled));
          }
          if (refreshed.deliveryStatus !== "admitted") {
            // 仍不确定：不报 cancelled（02 §6.3、CP-14）。
            return fail("not_ready", "input-ack-unknown");
          }
          // 已 admitted：落到 default 的独立 cancel 命令分支（不伪造 cancelled）。
        }
        default:
          // admitted：取消须由**新的幂等 runtime 取消命令**处理（03 §6 cancel 行）。
          // 该命令的 V4 语义与持久记录归 runtime/传输侧（W6）与冻结端口之外，
          // 因此这里明确拒绝而不是发送一条无法持久化的副作用（见报告 CR-3 续）。
          return fail("not_implemented", "runtime-cancel-command-mapping-missing");
      }
    },

    recordRuntimeAck,

    reconcileTask,

    async reconcileOnce() {
      const runs = await storage.runs.listNonTerminal();
      const taskIds = [...new Set(runs.map((run) => run.taskId))];
      const reports: ReconcileReport[] = [];
      for (const taskId of taskIds) reports.push(await reconcileTask(taskId));
      return reports;
    },
  };
}

/** 02 §6.2：只有 accepted 与「原结果为接受的 duplicate」算 admitted；其余保持错误与原因。 */
export function mapCommandAck(ack: CommandAck): {
  deliveryStatus: CloudTaskInputRecord["deliveryStatus"];
  lastError?: string;
} {
  switch (ack.status) {
    case "accepted":
    case "duplicate":
      return { deliveryStatus: "admitted" };
    default:
      return {
        deliveryStatus: "rejected",
        lastError: ack.reasonCode ?? ack.status,
      };
  }
}

/** createSession 的 ACK 携带 sessionId：控制面保存 receipt 与 runtime session 的映射（02 §6.2）。 */
function sessionIdFromAck(ack: CommandAck): string | undefined {
  const result = ack.result;
  if (result && result.type === "createSession" && "sessionId" in result) {
    return typeof result.sessionId === "string" ? result.sessionId : undefined;
  }
  return undefined;
}

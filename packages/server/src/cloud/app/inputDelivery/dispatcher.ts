/**
 * durable outbox 投递器（02 §6.1 唯一写入路径、§6.2 保留既有 V4 语义、§5.3 ready 门控、
 * 03 §6.2 投递与失败、01 §6.2 步骤 7）。
 *
 * 语义边界（必须与 runtime 队列区分）：
 * - 本 dispatcher 只负责 `accepted → delivering` 的**控制面投递**；它不计算 queue 位置、
 *   不决定 startNow/guide、不做权限裁决——那些是 CLI CommandInbox/runtime 的唯一职责
 *   （02 §6.1、AGENTS「不得新建第二套输入队列」）。
 * - 202 只表示持久接收；runtime ACK 是另一类事实（02 §2 不变量 6）。
 * - 投递按 Task 内 `acceptanceSeq` 顺序进行，首条恒为事务固定的 firstInputCommandId
 *   （08 §5：不得按 acceptedAt/随机 UUID 选首条）。
 *
 * 崩溃窗口：先投递、后落 `delivering`。若在两步之间崩溃，输入仍是 accepted，重启后重投
 * 同一 commandId——V4 以 commandId 幂等（02 §6.2「retry 不换 commandId」），runtime
 * duplicate 回放原结果，因此不产生第二次副作用。反之若先落 delivering 再投递，
 * 崩溃会留下永远无法确认的 delivering。
 */
import type { CloudRunRecord, CloudTaskInputRecord } from "@zcode/shared";
import { isFirstInput } from "../../domain/idempotency.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import { resolveRuntimeSession } from "../runSession.js";
import { buildCloudCommandEnvelope } from "./envelope.js";
import type { AttachmentRegistry } from "../attachments/registry.js";

export type DispatchOutcome =
  | { commandId: string; result: "sent" }
  | { commandId: string; result: "wait"; reason: string }
  | { commandId: string; result: "uncertain"; reason: string }
  | { commandId: string; result: "skipped"; reason: string };

export interface DispatchReport {
  taskId: string;
  runId?: string;
  outcomes: DispatchOutcome[];
}

export interface InputDispatcher {
  /** 单 Task 投递一轮（HTTP/RPC 与后台循环共用）。 */
  dispatchTask(taskId: string): Promise<DispatchReport>;
  /** 后台循环：遍历非终态 run 的 Task（03 §8 无客户端也继续投递）。 */
  dispatchOnce(): Promise<DispatchReport[]>;
}

/**
 * 投递被挡住的诊断（**2026-10-07 真实链路**：输入停在 `accepted` 却没有任何日志，七道
 * 等待分支全靠翻代码猜是哪一道）。只在**原因变化**时记一条 warn——投递循环按拍调用，
 * 不去重会每秒刷屏。键在成功投递时清掉，之后再次被挡仍会重新记。
 */
const lastDeliveryBlock = new Map<string, string>();

function logDeliveryBlock(taskId: string, runId: string, outcome: DispatchOutcome): void {
  const key = `${taskId}:${outcome.commandId}`;
  if (outcome.result === "sent") {
    lastDeliveryBlock.delete(key);
    return;
  }
  const reason = `${outcome.result}:${outcome.reason}`;
  if (lastDeliveryBlock.get(key) === reason) return;
  lastDeliveryBlock.set(key, reason);
  cloudCoreLogger.warn(undefined, "cloud input delivery blocked", {
    taskId,
    runId,
    commandId: outcome.commandId,
    result: outcome.result,
    reason: outcome.reason,
  });
}

export function createInputDispatcher(
  deps: CloudCoreDeps,
  registry: AttachmentRegistry,
): InputDispatcher {
  const { storage, attachments, clock } = deps;

  async function dispatchTask(taskId: string): Promise<DispatchReport> {
    const run = await storage.runs.activeOfTask(taskId);
    const report: DispatchReport = { taskId, runId: run?.runId, outcomes: [] };
    if (!run) return report;

    const deliverable = await storage.inputs.listDeliverable(taskId);
    for (const input of deliverable) {
      // 顺序投递：任一条等待/不确定即停止本轮，避免后发先至（03 §6.2 顺序语义）。
      const outcome = await dispatchOne(run, input);
      report.outcomes.push(outcome);
      logDeliveryBlock(taskId, run.runId, outcome);
      if (outcome.result !== "sent" && outcome.result !== "skipped") break;
    }
    return report;
  }

  async function dispatchOne(
    run: CloudRunRecord,
    input: CloudTaskInputRecord,
  ): Promise<DispatchOutcome> {
    const commandId = input.commandId;
    if (input.targetRunId && input.targetRunId !== run.runId) {
      // 输入绑定的是另一代 run：不跨 run 投递，也不提拔到新 run（08 §5）。
      return { commandId, result: "skipped", reason: "bound-to-other-run" };
    }
    if (run.stopRequested) {
      // 停止屏障：stop 受理后不再投递（08 §8.1、CT-15）。
      return { commandId, result: "wait", reason: "stop-requested" };
    }
    if (run.status !== "ready") {
      // ready 门控（02 §5.3 第 6 条）：控制面 CAS 写 ready 后才允许发 createSession/首个 prompt。
      return { commandId, result: "wait", reason: `run-${run.status}` };
    }

    // 投递前必须按当前 ready attachment 与代际校验（02 §2 不变量 3）；注册表只记录连接事实。
    const resolution = registry.resolve({
      runId: run.runId,
      runGeneration: run.runGeneration,
      requireReady: true,
    });
    if (resolution.status === "no-attachment" || resolution.status === "not-ready") {
      return { commandId, result: "wait", reason: resolution.status };
    }
    if (resolution.status === "stale") {
      // 旧代际不得继续投递；也不能谎称已送达（02 §2 不变量 3、§6.3）。
      const marked = await storage.inputs.markDelivery({
        taskId: run.taskId,
        commandId,
        to: "uncertain",
        lastError: "stale-attachment",
        now: clock.now(),
      });
      return {
        commandId,
        result: "uncertain",
        reason: marked ? "stale-attachment" : "stale-mark-failed",
      };
    }

    const first = isFirstInput(input, run.firstInputCommandId);
    const runtimeSessionId = await resolveRuntimeSession(deps, run);
    if (!first && !runtimeSessionId) {
      // 首命令的 createSession 尚未 ACK：没有 runtime sessionId 就不能发明一条 sendText（02 §6.2）。
      return { commandId, result: "wait", reason: "awaiting-runtime-session" };
    }
    // 投递只读持久正文，不读调用方内存（02 §6.1、03 §6.4 附件/正文持久化）。
    const payload = await storage.payloads.readInputPayload({ taskId: run.taskId, commandId });
    if (!payload) return { commandId, result: "wait", reason: "payload-missing" };

    const envelope = buildCloudCommandEnvelope({
      taskId: run.taskId,
      commandId,
      kind: first ? "createSession" : "sendText",
      prompt: payload.prompt,
      workspaceIdentity: `cloud-task:${run.taskId}`,
      runtimeSessionId,
      config: input.resolvedExecutionConfig ?? input.requestedConfig,
      now: clock.now(),
    });
    if (!envelope.ok) {
      // 确定未投递：按 03 §6.2 收口为 rejected（不是 uncertain）。
      const marked = await storage.inputs.markDelivery({
        taskId: run.taskId,
        commandId,
        to: "rejected",
        lastError: "environment-preparation-failed",
        now: clock.now(),
      });
      cloudCoreLogger.error(undefined, "cloud input envelope build failed", {
        taskId: run.taskId,
        reason: envelope.reason,
      });
      return {
        commandId,
        result: marked ? "skipped" : "uncertain",
        reason: "environment-preparation-failed",
      };
    }

    const sendResult = await attachments.sendCommand({
      taskId: run.taskId,
      commandId,
      envelope: envelope.envelope,
      expectation: {
        runGeneration: run.runGeneration,
        connectionEpoch: resolution.session.connectionEpoch,
        requireReady: true,
      },
    });

    if (sendResult.status === "sent") {
      // 传输已接受：落 delivering，等待 runtime ACK 或 ACK 丢失对账（02 §6.1/§6.3）。
      // 只在仍是 accepted 时推进：更快的 runtime ACK（已落 admitted/rejected）不得被回退覆盖。
      const latest = await storage.inputs.get(run.taskId, commandId);
      if (latest?.deliveryStatus === "accepted") {
        await storage.inputs.markDelivery({
          taskId: run.taskId,
          commandId,
          to: "delivering",
          runId: run.runId,
          now: clock.now(),
        });
      }
      cloudCoreLogger.debug(undefined, "cloud input delivered", {
        taskId: run.taskId,
        runId: run.runId,
        commandId,
        first,
      });
      return { commandId, result: "sent" };
    }

    if (sendResult.reason === "no-attachment" || sendResult.reason === "not-ready") {
      // 连接态问题不是输入失败：保持 accepted，下一轮再投（02 §6.3）。
      return { commandId, result: "wait", reason: sendResult.reason };
    }

    // stale / closed：投递结论不明，置 uncertain 并对账，不报 rejected（03 §6.2）。
    await storage.inputs.markDelivery({
      taskId: run.taskId,
      commandId,
      to: "uncertain",
      lastError: sendResult.reason,
      now: clock.now(),
    });
    return { commandId, result: "uncertain", reason: sendResult.reason };
  }

  return {
    dispatchTask,

    async dispatchOnce() {
      const runs = await storage.runs.listNonTerminal();
      const taskIds = [...new Set(runs.map((run) => run.taskId))];
      const reports: DispatchReport[] = [];
      for (const taskId of taskIds) {
        reports.push(await dispatchTask(taskId));
      }
      return reports;
    },
  };
}

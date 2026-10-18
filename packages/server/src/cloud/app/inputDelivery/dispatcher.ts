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
import { mapCommandAck, sessionIdFromAck } from "./deliveryControl.js";
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
  const { storage, attachments, runtimeCommands, clock } = deps;

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

  async function reconcileInFlight(
    run: CloudRunRecord,
    commandId: string,
  ): Promise<DispatchOutcome> {
    const runtimeSessionId = await resolveRuntimeSession(deps, run);
    const query = await runtimeCommands.queryCommand({
      taskId: run.taskId,
      runId: run.runId,
      runGeneration: run.runGeneration,
      commandId,
      ...(runtimeSessionId ? { runtimeSessionId } : {}),
    });
    if (query.status === "found") {
      // 复用既有 ACK 落地语义（02 §6.2）：落 receipt 与 run↔session 映射，不重发。
      const mapped = mapCommandAck(query.ack);
      const sessionId = sessionIdFromAck(query.ack);
      if (sessionId) {
        // 与 deliveryControl 的 ACK 收口同口径：按 runGeneration CAS，重连不重造会话。
        await storage.runs.setRunRuntimeSessionId({
          runId: run.runId,
          runGeneration: run.runGeneration,
          runtimeSessionId: sessionId,
          now: clock.now(),
        });
      }
      const landed = await storage.inputs.markDelivery({
        taskId: run.taskId,
        commandId,
        to: mapped.deliveryStatus,
        runtimeAck: query.ack,
        runId: run.runId,
        runtimeSessionId: sessionId,
        lastError: mapped.lastError,
        now: clock.now(),
      });
      return landed
        ? { commandId, result: "skipped", reason: "reconciled-runtime-ack" }
        : { commandId, result: "wait", reason: "reconcile-ack-not-landed" };
    }
    if (query.status === "unavailable") {
      // 运行时不可达：保持 delivering/uncertain 原状，不把「未确认」当「未送达」重投。
      return { commandId, result: "wait", reason: "runtime-unavailable" };
    }
    // runtime 明确没有该命令事实：只有当前 ready attachment 确认同 run/代际可安全去重，
    // 才退回 accepted 并用同一 commandId 重走发送路径（02 §6.3）。
    const resolution = registry.resolve({
      runId: run.runId,
      runGeneration: run.runGeneration,
      requireReady: true,
    });
    if (resolution.status !== "ok") {
      return { commandId, result: "wait", reason: `reconcile-${resolution.status}` };
    }
    const requeued = await storage.inputs.markDelivery({
      taskId: run.taskId,
      commandId,
      to: "accepted",
      runId: run.runId,
      lastError: "requeued-after-reconcile",
      now: clock.now(),
    });
    if (!requeued) {
      // 状态已被并发推进（例如 ACK 先到）：本轮不发送，下一拍按最新事实处理。
      return { commandId, result: "wait", reason: "reconcile-requeue-failed" };
    }
    return dispatchOne(run, requeued);
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
      // ready 门控（02 §5.3 第 7 条）：控制面 CAS 写 ready 后才允许发 createSession/首个 prompt。
      // paused（2026-10-09 生命周期 v2）落在本分支：reason=run-paused，输入保持 accepted，
      // 由控制面自驱 resume（lifecycle pauseResume 拍）→ ready 后本门自然放行（03 §6 修订）。
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

    // 修复依据（2026-10-17 R2，spec 15 §3、02 §6.3「命令发送超时先查询 commandId」）：
    // 旧实现对 delivering/uncertain 输入直接重发——可能把结果未知的已执行命令再投一次，
    // 也可能把 delivering 当 uncertain 重投。这里先按同一 commandId 查询 runtime 事实：
    // - found：落地 ACK（同一条 ACK 收口路径），不再发送；
    // - unavailable：保持原状态（不确认也不重投），等待运行时可查询；
    // - unknown：只有当前 ready attachment 可安全去重时，把状态 CAS 回 accepted，随后
    //   用**同一 commandId** 走本函数既有的发送路径（V4 以 commandId 幂等）。
    if (input.deliveryStatus === "delivering" || input.deliveryStatus === "uncertain") {
      return reconcileInFlight(run, commandId);
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
      // 可信路径事实只来自当前 ready attachment 的地址（与 commandChannel.resolveContext
      // 同一取法）；用户输入正文不能决定执行目录（02 §2）。缺失时 envelope 构造
      // fail-closed（missing-workspace-path），不降级发送无路径 createSession。
      workspacePath: resolution.session.address.workspacePath,
      runtimeSessionId,
      config: input.resolvedExecutionConfig ?? input.requestedConfig,
      now: clock.now(),
    });
    if (!envelope.ok) {
      // 确定未投递：按 03 §6.2 收口为 rejected（不是 uncertain）。
      // missing-workspace-path 是可信事实缺失（attachment 未带路径），按同一拒绝
      // 路径收口；保留具体原因便于诊断「为什么首个 createSession 没能发出」。
      const failureReason =
        envelope.reason === "missing-workspace-path"
          ? "missing-workspace-path"
          : "environment-preparation-failed";
      const marked = await storage.inputs.markDelivery({
        taskId: run.taskId,
        commandId,
        to: "rejected",
        lastError: failureReason,
        now: clock.now(),
      });
      cloudCoreLogger.error(undefined, "cloud input envelope build failed", {
        taskId: run.taskId,
        reason: envelope.reason,
      });
      return {
        commandId,
        result: marked ? "skipped" : "uncertain",
        reason: failureReason,
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
      // 投递即业务活动（08 §7 事实源收窄补充）：命令送达就是新的 runtime 工作事实。
      // 不推进的话，resume 后的窗口内 lastBusinessActivityAt 仍是暂停前旧值，idle 拍
      // 会把带在途回合的 run 当空闲再次暂停（实测：resume 后 33s 被二次 idle-pause）。
      await storage.runs.touchBusinessActivity({ runId: run.runId, at: clock.now() });
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

/**
 * 入站帧路由（specs/cloud-agent 02 §4 帧表与方向、§7.2 写入与确认顺序、§8 故障表）。
 *
 * 每个帧只做一件事，且都不改 runtime 队列语义：
 * ready → 发布 ready（bootstrap.config 已下发的门控在 app 层）；heartbeat → 连接心跳；
 * phase/fault → 记录；drain → 走同一 drain 入口；projection.batch → ingest 后回 ack；
 * checkpoint.result → 落保存事实。
 */
import type { CloudBridgeControlFrame } from "@zcode/shared";
import {
  nextRuntimeDeadStreak,
  runtimeExitConfirmed,
  RUNTIME_EXIT_DEAD_STREAK_LIMIT,
} from "../../domain/runtimeExit.js";
import { bridgeLogger, sendFrame, type CloudBridgeContext, type LiveConnection } from "./types.js";

export async function routeInboundFrame(
  context: CloudBridgeContext,
  connection: LiveConnection,
  frame: CloudBridgeControlFrame,
): Promise<void> {
  const { registry, storage, clock } = context;
  const logger = bridgeLogger(context);
  const run = await storage.runs.get(connection.runId);
  if (!run) return;
  switch (frame.type) {
    case "bridge.ready": {
      if (frame.connectionEpoch !== connection.connectionEpoch) return;
      const ready = await context.services().runs.markReady({
        taskId: run.taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
        connectionEpoch: connection.connectionEpoch,
        runtimeIncarnation: frame.runtimeIncarnation,
      });
      if (!ready.ok) {
        logger.warn(undefined, "cloud bridge ready rejected", {
          runId: run.runId,
          reason: ready.reason,
        });
        sendFrame(connection, {
          protocolVersion: 1,
          type: "bridge.fault",
          faultCode: ready.code,
          message: `ready rejected: ${ready.reason}`,
          retryable: false,
          connectionEpoch: connection.connectionEpoch,
        });
        return;
      }
      registry.markReady({
        runId: run.runId,
        runGeneration: run.runGeneration,
        connectionEpoch: connection.connectionEpoch,
        runtimeIncarnation: frame.runtimeIncarnation,
        at: clock.now(),
      });
      return;
    }
    case "bridge.heartbeat": {
      registry.heartbeat({
        runId: run.runId,
        runGeneration: connection.runGeneration,
        connectionEpoch: frame.connectionEpoch,
        at: clock.now(),
        activitySummary: frame.activitySummary,
      });
      // D4-2 中间步（02 §3/§8）：消费 runtime 进程退出事实。v1 协议不加新帧（02 定稿），
      // 显式退出帧不存在——心跳的 `processAlive=false` 是唯一事实通道（bridgeHeartbeat
      // 按 runtime pid 判定，02 §4）。连续两拍死亡即确认事实并告警；run 上的持久标注
      // （lastDisconnectReason 语义，落 run.endReason）在该连接最终关闭时由 bridgeChannel
      // 按 runtime-exit 写入，把「断网」与「runtime 死了」区分开。本步只落事实：
      // 控制面不对 runtime-exit 自动重建 supervisor（那是第 2 批之后的恢复阶梯）。
      // epoch 围栏（02 §2 不变量 3）：旧 epoch 的心跳不得毒化当前连接的死亡计数。
      if (frame.connectionEpoch === connection.connectionEpoch) {
        const streak = nextRuntimeDeadStreak({
          processAlive: frame.processAlive,
          currentStreak: connection.runtimeDeadStreak ?? 0,
        });
        connection.runtimeDeadStreak = streak;
        if (runtimeExitConfirmed(streak) && connection.runtimeExitConfirmed !== true) {
          connection.runtimeExitConfirmed = true;
          logger.warn(undefined, "cloud bridge runtime exit reported", {
            runId: run.runId,
            runGeneration: run.runGeneration,
            connectionEpoch: connection.connectionEpoch,
            consecutiveDeadHeartbeats: streak,
            streakLimit: RUNTIME_EXIT_DEAD_STREAK_LIMIT,
          });
        }
      }
      return;
    }
    case "bridge.phase":
      logger.debug(undefined, "cloud bridge phase", {
        runId: run.runId,
        phase: frame.phase,
        errorCode: frame.errorCode,
      });
      return;
    case "bridge.fault":
      await context.services().projections.ingest.reportRunFault({
        taskId: run.taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
        errorCode: frame.faultCode,
        message: frame.message,
        retryable: frame.retryable,
      });
      return;
    case "bridge.drain":
      // 沙箱侧请求受控回收：走同一 drain 入口（幂等 operationId）。
      await context.services().lifecycle.drain.beginDrain({
        taskId: run.taskId,
        runId: run.runId,
        reason: frame.reason,
        operationId: frame.operationId,
      });
      return;
    case "projection.batch": {
      // 帧级代际围栏（02 §2 不变量 3）：批次携带的 attachment epoch 必须与本 socket
      // 绑定的 connectionEpoch 一致。不匹配即丢弃——不 ingest、不回 ack（旧代际批次的
      // 记录仍留在执行节点 WAL，由接管后的 snapshot/续传恢复，02 §7.1）。
      // 修复依据（2026-10-07 review P0）：ingest 服务层的围栏依赖 registry session 存在，
      // 无认证 attachment 时会被旁路；帧级校验保证旧代际/未绑定批次在任何情况下都进不了库。
      if (frame.connectionEpoch !== connection.connectionEpoch) {
        logger.warn(undefined, "stale projection batch frame", {
          runId: connection.runId,
          frameEpoch: frame.connectionEpoch,
          connectionEpoch: connection.connectionEpoch,
        });
        return;
      }
      const result = await context.services().projections.ingest.ingestProjectionBatch(frame);
      // 只有事务提交成功才回 ack；只覆盖连续持久水位，不跳缺口（02 §7.2）。
      for (const cursor of result.cursors) {
        sendFrame(connection, {
          protocolVersion: 1,
          type: "projection.ack",
          connectionEpoch: connection.connectionEpoch,
          topic: cursor.topic,
          logEpoch: cursor.logEpoch,
          lastContiguousSourceSeq: cursor.sourceSeq,
          ingestCursor: `${cursor.topic}:${cursor.logEpoch}:${cursor.sourceSeq}`,
        });
      }
      return;
    }
    case "checkpoint.result":
      await context.services().lifecycle.checkpoints.handleCheckpointResult({
        taskId: run.taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
        frame,
      });
      return;
    default:
      // 出站帧入站即整帧拒绝（方向校验，02 §4 尾段）。
      connection.socket.close(1008, "unexpected-frame-direction");
      return;
  }
}

/**
 * 投影 durable ingest（02 §7.1 导出位置与格式、§7.2 写入与确认顺序、§8 背压与故障、
 * 03 §9「runtime 结构化投影持久 ingest 后才 ACK」）。
 *
 * 顺序不可颠倒：
 *   1) 校验 Run/generation/current epoch 与 schema；
 *   2) DB 事务追加投影并更新水位；
 *   3) **事务提交成功**才回 projection.ack（只覆盖连续持久水位，不跳缺口）；
 *   4) 提交失败 → 无 durable ACK，记录错误并保留缺口（记录仍留在执行节点 WAL）。
 *
 * 本文件实现 W0 冻结的 `AttachmentIngestPort`（attachment → 控制面），三个方法分别：
 * 投影批次、run fault、runtime ACK。runtime ACK 的语义在 inputDelivery 侧（02 §6.2）。
 */
import type { ProjectionBatchFrame, CloudStreamCursor } from "@zcode/shared";
import type { AttachmentIngestPort, ProjectionIngestResult } from "../ports/attachmentPort.js";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import type { AttachmentRegistry } from "../attachments/registry.js";
import type { InputDeliveryControl } from "../inputDelivery/deliveryControl.js";
import type { CloudGitGrantService } from "../gitGrants.js";

/** 控制面侧实现 W0 的 attachment ingest 端口（投影批次 / run fault / runtime ACK）。 */
export type ProjectionIngestService = AttachmentIngestPort;

export function createProjectionIngestService(
  deps: CloudCoreDeps,
  registry: AttachmentRegistry,
  deliveryControl: InputDeliveryControl,
  gitGrants: CloudGitGrantService,
): ProjectionIngestService {
  const { storage, clock } = deps;

  return {
    async ingestProjectionBatch(frame: ProjectionBatchFrame): Promise<ProjectionIngestResult> {
      const empty: ProjectionIngestResult = { accepted: 0, cursors: [], conflicts: [] };
      const first = frame.records[0];
      if (!first) return empty;
      const session = registry.current(first.runId);
      if (session && frame.connectionEpoch !== session.connectionEpoch) {
        // 旧代际批次拒绝：不落库、不回 ACK，执行节点 WAL 保留记录（02 §2 不变量 3、§7.1）。
        cloudCoreLogger.warn(undefined, "stale projection batch rejected", {
          runId: first.runId,
          batchEpoch: frame.connectionEpoch,
          currentEpoch: session.connectionEpoch,
        });
        return empty;
      }

      const appended = await storage.projections.appendBatch(frame.records);
      if (appended.conflicts.length > 0) {
        // 同键不同 contentHash 是一致性 fault：告警而不是覆盖（02 §7.1）。
        cloudCoreLogger.error(undefined, "projection consistency conflict", {
          runId: first.runId,
          conflicts: appended.conflicts.length,
        });
      }

      // 只有事务提交成功才有 ACK；此处 touch 业务活动（runtime/工具执行属业务活动，08 §7）。
      const runIds = [...new Set(frame.records.map((record) => record.runId))];
      for (const runId of runIds) {
        await storage.runs.touchBusinessActivity({ runId, at: clock.now() });
      }

      const result: ProjectionIngestResult = {
        accepted: appended.appended,
        cursors: appended.cursors,
        conflicts: appended.conflicts,
      };
      const gap = findGap(frame, appended.cursors);
      if (gap) {
        // 有缺口：返回期望 sourceSeq 而不跳跃确认（02 §7.1）。
        return { ...result, expectedSourceSeq: gap };
      }
      return result;
    },

    async reportRunFault(request) {
      // 不回滚已持久事实，只记录错误与恢复入口（02 §8 故障表）。
      const run = await storage.runs.get(request.runId);
      if (run && run.runGeneration !== request.runGeneration) {
        cloudCoreLogger.warn(undefined, "stale run fault rejected", { runId: request.runId });
        return;
      }
      if (request.retryable) {
        cloudCoreLogger.warn(undefined, "cloud run fault reported", {
          taskId: request.taskId,
          runId: request.runId,
          errorCode: request.errorCode,
          message: request.message,
        });
      } else {
        cloudCoreLogger.error(undefined, "cloud run fault reported", {
          taskId: request.taskId,
          runId: request.runId,
          errorCode: request.errorCode,
          message: request.message,
        });
      }

      // 自举失败必须**重新武装** clone grant（01 §7.2 单次兑换 + 整轮重试）：supervisor 失败后
      // 执行节点会整轮重试（hello → welcome → bootstrap.config → clone），而 clone grant 是
      // 单次兑换、上一次已消费，控制面不补签就会让每个后续重试都拿到 403 `already-redeemed`
      // ——"一次瞬时失败 = 永久失败"，直到 provisioning 超时销毁沙箱（真实链路 15:30 现场）。
      // 幂等由 `issueForRun` 负责（只复用 status=issued 且未过期的记录），此处不自行判重；
      // 失败只记日志，故障处理路径不抛错、不回滚已持久事实（02 §8）。
      if (request.errorCode === "bootstrap_failed" && run && run.status === "provisioning") {
        if (run.stopRequested) {
          // 停止通路已受理：不再补签写/读凭据（08 §8.1 停止屏障），保存写由 drain 自己的签发点负责。
          cloudCoreLogger.info(undefined, "clone grant not re-armed: stop requested", {
            runId: request.runId,
          });
        } else {
          try {
            const rearmed = await gitGrants.issueForRun({
              runId: request.runId,
              purpose: "clone",
            });
            if (rearmed.ok) {
              cloudCoreLogger.info(undefined, "clone grant re-armed after bootstrap failure", {
                runId: request.runId,
                grantId: rearmed.grantId,
                expiresAt: rearmed.expiresAt,
              });
            } else {
              cloudCoreLogger.warn(undefined, "clone grant re-arm failed", {
                runId: request.runId,
                code: rearmed.code,
                reason: rearmed.reason,
              });
            }
          } catch (error) {
            cloudCoreLogger.warn(undefined, "clone grant re-arm threw", {
              runId: request.runId,
              message: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    },

    async recordRuntimeAck(input) {
      await deliveryControl.recordRuntimeAck(input);
    },
  };
}

/** 批次内最大 sourceSeq 超过「已连续持久水位」即存在缺口。 */
function findGap(
  frame: ProjectionBatchFrame,
  cursors: readonly CloudStreamCursor[],
): ProjectionIngestResult["expectedSourceSeq"] {
  const watermarks = new Map(
    cursors.map((cursor) => [`${cursor.topic}\u0000${cursor.logEpoch}`, cursor]),
  );
  for (const record of frame.records) {
    const key = `${record.topic}\u0000${record.logEpoch}`;
    const watermark = watermarks.get(key);
    const expected = (watermark?.sourceSeq ?? -1) + 1;
    if (record.sourceSeq > expected) {
      return { topic: record.topic, logEpoch: record.logEpoch, expectedSourceSeq: expected };
    }
  }
  return undefined;
}

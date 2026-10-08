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
import { projectionCoveredInterval } from "../../domain/projectionSequence.js";

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
      // 修复依据（2026-10-07 review P0-2，02 §2 不变量 3 fail-closed、02 §7.1）：
      // 此前 `session && ...` 的写法在 registry 无该 run 的 session（如未认证 attachment、
      // 摘除后的空窗）时把整个代际围栏旁路，批次直接落库。无 session 本身就是异常
      // 投影来源——合法批次只能来自已完成 hello 的 attachment，其 session 必然在册。
      // 因此无 session 即拒绝：不落库、不回 ACK（执行节点 WAL 保留记录等待恢复）。
      if (!session || frame.connectionEpoch !== session.connectionEpoch) {
        cloudCoreLogger.warn(undefined, "stale projection batch rejected", {
          runId: first.runId,
          batchEpoch: frame.connectionEpoch,
          currentEpoch: session?.connectionEpoch,
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

      // 修复依据（2026-10-09 终验缺陷 B，08 §7 业务活动事实源收窄）：此前对每个批次的
      // 全部 runId 无条件 touch——执行节点 WAL 因源流缺口每 30s 重投同批记录（同键去重、
      // appended=0），checkpoint 失败循环期间 lastBusinessActivityAt 被持续刷新，空闲
      // pause 永不触发。业务活动 = 新的 runtime/工具执行事实（新增投影），WAL 重投/补发
      // 是恢复面流量；因此只 touch 本批次实际新增记录所属的 run。
      for (const runId of appended.appendedRunIds) {
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

/**
 * 批次内出现「持久水位之前的断层」即存在缺口（02 §7.1 缺口不跳跃确认）。
 *
 * 修复依据（2026-10-07 复核缺陷 2）：导出记录的 sourceSeq 取交付帧 toSeq，区间覆盖
 * 记在 payload 的 fromSeq/toSeq（snapshot 合并 0..N 时第一条记录 sourceSeq=N）——按
 * 「sourceSeq 必须逐条 +1」判定会把 snapshot 领头的正常批次误报成缺口。连续性按
 * domain/projectionSequence.ts 的区间链口径判定（与 ingest 水位同一算法定义）。
 */
function findGap(
  frame: ProjectionBatchFrame,
  cursors: readonly CloudStreamCursor[],
): ProjectionIngestResult["expectedSourceSeq"] {
  const watermarks = new Map<string, CloudStreamCursor>(
    cursors.map((cursor) => [`${cursor.topic}\u0000${cursor.logEpoch}`, cursor] as const),
  );
  // 同一流多条记录按到达序推进期望位（cursors 是本批次提交后的水位，作为各流起点）。
  const advanced = new Map<string, number>();
  for (const record of frame.records) {
    const key = `${record.topic}\u0000${record.logEpoch}`;
    const through = advanced.get(key) ?? watermarks.get(key)?.sourceSeq ?? -1;
    const expected = through + 1;
    const { from, to } = projectionCoveredInterval(record.payload, record.sourceSeq);
    if (from > expected) {
      return { topic: record.topic, logEpoch: record.logEpoch, expectedSourceSeq: expected };
    }
    advanced.set(key, Math.max(through, to));
  }
  return undefined;
}

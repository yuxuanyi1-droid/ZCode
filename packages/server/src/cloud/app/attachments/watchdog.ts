/**
 * 心跳看门狗（02 §8 故障表：网络断/heartbeat 缺失 → Run=disconnected，保留 Run/outbox，
 * 健康属性待对账；heartbeat 不是轮次/权限裁决（02 §4 帧表）；08 §7：heartbeat 不代表业务活跃）。
 *
 * 判据：
 * - 只把 Run 推进到 `disconnected`，**不写 expired/failed**（终态必须有 provider 终止确认，
 *   02 §2 不变量 4、08 §3.2）；
 * - 阈值取 02 §8 的心跳周期 30s 与退避上限 60s 之上的余量（配置默认 90s），
 *   避免把一次正常退避误判为断线；
 * - 断连只影响投递（dispatcher 会等待），不影响 metadata/历史读取。
 */
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import type { AttachmentRegistry } from "./registry.js";
import type { RunOrchestrator } from "../runOrchestrator.js";

export interface HeartbeatSweepReport {
  expired: number;
  disconnected: number;
}

export interface HeartbeatWatchdog {
  sweep(now?: number): Promise<HeartbeatSweepReport>;
}

export function createHeartbeatWatchdog(
  deps: CloudCoreDeps,
  registry: AttachmentRegistry,
  orchestrator: RunOrchestrator,
): HeartbeatWatchdog {
  const { clock, config } = deps;

  return {
    async sweep(now = clock.now()) {
      const report: HeartbeatSweepReport = { expired: 0, disconnected: 0 };
      const stale = registry.listHeartbeatExpired(now, config.heartbeatTimeoutMs);
      for (const session of stale) {
        registry.detach({ runId: session.runId, at: now, reason: "heartbeat-timeout" });
        report.expired += 1;
        const result = await orchestrator.markDisconnected({
          runId: session.runId,
          runGeneration: session.runGeneration,
          connectionEpoch: session.connectionEpoch,
          reason: "heartbeat-timeout",
        });
        if (result.ok) {
          report.disconnected += 1;
        } else {
          cloudCoreLogger.warn(undefined, "heartbeat watchdog could not mark disconnected", {
            runId: session.runId,
            reason: result.reason,
          });
        }
      }
      return report;
    },
  };
}

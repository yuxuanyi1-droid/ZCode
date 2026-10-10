/**
 * 空闲 pause 拍的编排（决策文档 D3、specs/cloud-agent/08 §7 修订 2026-10-09，第 3 批）。
 *
 * 分工：裁决在纯模块 `idlePolicy.ts`（决策与 IO 分离，测试不打桩）；本文件只做
 * 「取事实 → 问决策 → 调既有 `pauseRun` 助手」的编排。lifecycleTick 中位于 drain.sweep
 * 之前——同一拍内 pause 成功的 run 已离开 ready，天然不被 idle drain 重复处理（单轨
 * F-3 的第一道互斥；第二道是 drain.sweep 对 memory 级 provider 的守卫）。
 *
 * 连接事实源（2026-10-07 复核缺陷 1）：「有无浏览器观看」经注入的
 * `BrowserWatchPort`（任务通道观看流，关即清）判定；**不是** `AttachmentRegistry`——
 * 那张表只登记 bridge ws（沙箱监管 socket），bridge 在线不等于有人在看。
 */
import type { CloudRunRecord } from "@zcode/shared";
import type { CloudCoreDeps } from "../deps.js";
import { cloudCoreLogger } from "../logger.js";
import type { CloudAppResult } from "../result.js";
import { hasCheckpointInFlight } from "../../domain/checkpointPolicy.js";
import { occupiesWorkspaceByInput } from "../../domain/deliveryStatus.js";
import { decideIdlePause } from "./idlePolicy.js";

/** 空闲 pause 的持久 endReason（run 详情/诊断可读；与 idle drain 的 reason=idle 区分）。 */
export const IDLE_PAUSE_END_REASON = "idle-pause";

/** pause 转换助手的结构切片（`PauseResumeControl.pauseRun` 同一实现，不持第二份）。 */
export type PauseRunFn = (input: {
  taskId: string;
  runId: string;
  reason: string;
  /** 可选前置 checkpoint（boot 失败路径绝不成为恢复点）。 */
  checkpoint?: () => Promise<void>;
}) => Promise<CloudAppResult<CloudRunRecord>>;

export interface IdlePauseSweepReport {
  /** 本拍检查过的 ready run 数。 */
  examined: number;
  /** 空闲 pause 成功（ready→paused CAS 落地）的 run 数。 */
  paused: number;
  /** 决策 skip 的 run 数（禁用/门禁/有连接/未达阈值等，见 idlePolicy 的 skip 原因）。 */
  skipped: number;
  /** 决策 pause 但 pauseRun 失败（provider 未确认等）的 run 数；下一拍重评。 */
  failed: number;
}

export type IdlePauseSweep = (now?: number) => Promise<IdlePauseSweepReport>;

export function createIdlePauseSweep(deps: CloudCoreDeps, pauseRun: PauseRunFn): IdlePauseSweep {
  const { storage, drivers, clock, config } = deps;
  return async function idleSweep(now = clock.now()) {
    const report: IdlePauseSweepReport = { examined: 0, paused: 0, skipped: 0, failed: 0 };
    // 部署禁用（阈值 0）：整条路径休眠，连存储扫描都不做（08 §7 修订：可配，0=禁用）。
    if (config.idlePauseMs === 0) return report;
    const runs = await storage.runs.listNonTerminal();
    for (const run of runs) {
      if (run.status !== "ready") continue;
      report.examined += 1;
      try {
        // A-7 能力门禁：读生效能力声明（未实测 provider 一律 none → 决策恒 skip，
        // 整条空闲 pause 路径对门禁关闭的 provider 天然休眠）。
        const driver = run.provider ? await drivers.resolve(run.provider) : null;
        const capabilities = driver ? await driver.describeCapabilities() : null;
        // 08 §7 修订的闲置条件（保守口径，与 drain.sweep 的 idle 判定同源）：
        // 无 pending 输入、无保存中的 checkpoint、有持久业务活动事实且已达到阈值。
        const pendingInputs = await storage.inputs.listDeliverable(run.taskId);
        // pending 输入事实含 uncertain（08 §7 修订 2026-10-09 审计第一批，domain 唯一谓词）：
        // 与 resume 触发/idle drain 同口径，漏计会让 run 被暂停且无法自驱恢复。
        const pendingInputCount = pendingInputs.filter((input) =>
          occupiesWorkspaceByInput(input.deliveryStatus),
        ).length;
        const checkpoints = await storage.projections.listCheckpoints(run.taskId);
        const decision = decideIdlePause({
          runStatus: run.status,
          stopRequested: run.stopRequested === true,
          pauseResume: capabilities?.pauseResume ?? "none",
          ...(run.lastBusinessActivityAt !== undefined
            ? { lastBusinessActivityAt: run.lastBusinessActivityAt }
            : {}),
          // v1 简化（D3）：有浏览器观看连接（任务通道 rpc 流，关闭即清）就不算空闲；
          // 无「即将暂停」广播面，就先不暂停有人看着的 run。
          // 修复依据（2026-10-07 复核缺陷 1）：事实源是注入的 BrowserWatchPort（浏览器
          // 侧观看流），不是 AttachmentRegistry——后者只登记 bridge ws（沙箱监管
          // socket），沙箱存活期间恒在线，错接曾使空闲 pause 永不触发。
          hasBrowserWatcher: deps.browserWatch?.hasWatcher(run.runId) ?? false,
          pendingInputCount,
          // 08 §7 修订（2026-10-09 终验缺陷 B）：在途占用有界窗口——超窗无更新的
          // saving/pending 是僵尸事实，不永久阻塞 pause；风险由 run.dataAtRisk 承载
          // （「上次周期保存已 failed」按事实暂停，不虚报已保存）。
          checkpointInFlight: hasCheckpointInFlight({ records: checkpoints, now }),
          now,
          thresholdMs: config.idlePauseMs,
        });
        if (decision.action !== "pause") {
          report.skipped += 1;
          continue;
        }
        // 既有 pauseRun 助手（B-4 顺序冻结）：provider 确认 → detach → ready→paused CAS。
        // v1 不传前置 checkpoint：quiesce v1 无可等待的保存面（savePolicy.QUIESCE_BOUNDARY，
        // 不得 sleep 冒充同步），决策已排除「checkpoint 在途」；memory 级 pause 保留进程态，
        // 未落盘变更随 pause 存活，「boot 失败成为恢复点」的风险窗口由周期保存（5 分钟档）
        // 收敛。checkpoint 抛错即整体失败的前置语义保留在 pauseRun 签名上，留给后续批次。
        // 08 §7 修订（2026-10-09 终验缺陷 B）：「上次周期保存已 failed」不得永久阻塞
        // pause——本路径不传前置，failed 的风险已由 handleCheckpointResult 如实标进
        // run.dataAtRisk，按事实暂停，不虚报已保存。
        const paused = await pauseRun({
          taskId: run.taskId,
          runId: run.runId,
          reason: IDLE_PAUSE_END_REASON,
        });
        if (paused.ok) {
          report.paused += 1;
        } else {
          // provider 未确认等：run 保持 ready，下一拍重评（不重试风暴——阈值未变）。
          report.failed += 1;
          cloudCoreLogger.warn(undefined, "cloud idle pause rejected", {
            taskId: run.taskId,
            runId: run.runId,
            code: paused.code,
            reason: paused.reason,
          });
        }
      } catch (error) {
        // 单 run 异常只属于该 run（D4-9 sweep 隔离），不得穿透整轮 idle sweep。
        report.failed += 1;
        cloudCoreLogger.warn(undefined, "cloud idle pause sweep run failed", {
          runId: run.runId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return report;
  };
}

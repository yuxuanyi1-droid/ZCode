/**
 * Task 能力投影（specs/cloud-agent 04 §3.3「可操作 actions 来自控制面投影」、03 §6 生命周期端点、
 * 08 §3.1/§3.2/§8.2/§9）。
 *
 * 纯函数：只用已持久事实推导**服务端裁决的期望动作集**，与生命周期端点一一对应。
 * 三条纪律：
 * 1. **不是授权凭据**：客户端只用于按钮可点/置灰；每次写操作服务端仍独立校验同一状态表；
 * 2. **无事实不猜**：能力/产物未知（provider 是否支持 extend、PR 是否 merged）时不留该动作，
 *    与「不用控制面猜 idle」同一口径；
 * 3. 枚举取 shared 冻结的 `CloudTaskAction`，不在此自造字符串。
 *
 * 推导规则与各命令的准入条件保持一致（两端同表，避免投影与执行分叉）：
 * - `send-input`：draft 且已有完整 draftStartConfig（start）；或 active 且有 ready run 且无停止意图（append）。
 * - `cancel-input`：存在未收口输入（accepted/delivering/uncertain）。
 * - `stop`：存在未终态 run 且未受理停止。
 * - `force-stop`：存在未终态 run（显式丢失确认是用户选择，含已受理停止的 run）。
 * - `reopen`：active/failed、无有效写 run、基线已冻结。
 * - `extend`：未终态 run、有 provider handle、且 provider 明确支持续期。
 * - `complete`：active（必要时先 drain，进行中显示进度；08 §9）。
 * - `archive`：未归档且无活动写 run。
 * - `reactivate`：completed、无活动 run、PR 未 merged（PR 事实不可得时不投影）。
 * - `restore`：archived 且有 archivedFromStatus。
 */
import {
  CLOUD_TASK_ACTIONS,
  type CloudRunRecord,
  type CloudTaskAction,
  type CloudTaskArtifactRecord,
  type CloudTaskRecord,
  type PrPublicationStatus,
} from "@zcode/shared";
import { isTerminalRunStatus } from "./taskRunState.js";

export interface TaskActionFacts {
  task: CloudTaskRecord;
  /** 当前有效 run（未终态）；无则 null。 */
  activeRun: CloudRunRecord | null;
  /** 未收口输入数（accepted/delivering/uncertain），来自 `InputRepo.listDeliverable`。 */
  unsettledInputCount: number;
  /** 产物投影（PR 状态来源）；未接线时为 null（"无事实"）。 */
  artifact: CloudTaskArtifactRecord | null;
  /**
   * provider 是否明确支持续期（`SandboxDriverCapabilities.canExtendDeadline`）。
   * 未知（未接线/无 handle）时为 undefined → 不投影 `extend`。
   */
  providerCanExtend?: boolean;
}

/** 未终态 run 才算「活动写 run」（与 domain/taskRunState 同一判定）。 */
function liveRun(run: CloudRunRecord | null): CloudRunRecord | null {
  return run && !isTerminalRunStatus(run.status) ? run : null;
}

export function deriveTaskActions(facts: TaskActionFacts): CloudTaskAction[] {
  const { task } = facts;
  const run = liveRun(facts.activeRun);
  const stopping = run?.stopRequested === true;
  const actions: CloudTaskAction[] = [];

  // 输入：draft 首发需要已保存的完整启动配置；active 追加需要 ready/paused run 且未受理
  // 停止（paused 的 append 按 03 §6 修订 2026-10-09 接受——202 持久接收 + 控制面自驱
  // resume，同 run 同 generation；UI 明示「发送消息即可恢复」，04 §3.3 修订行）。
  const canStart =
    task.status === "draft" &&
    task.draftStartConfig !== undefined &&
    task.draftStartConfig !== null;
  const canAppend =
    task.status === "active" && (run?.status === "ready" || run?.status === "paused") && !stopping;
  if (canStart || canAppend) actions.push("send-input");

  // 撤销：只对尚未进入 runtime 判定的输入开放（已 admitted 的取消需要独立 runtime 命令）。
  if (facts.unsettledInputCount > 0 && !stopping) actions.push("cancel-input");

  // 停止：存在未终态 run 且尚未受理停止（停止意图受理后不再重复开放）。
  if (run && !stopping) actions.push("stop");
  // force-stop：显式丢失确认，is a user choice；已受理停止的 run 也允许强制收口。
  if (run) actions.push("force-stop");

  // 重开：无有效写 run、基线已冻结（与 gateway/reopen 预检同一条件）。
  const baselineFrozen = task.baseSha !== undefined && task.taskBranch !== undefined;
  if ((task.status === "active" || task.status === "failed") && !run && baselineFrozen) {
    actions.push("reopen");
  }

  // 续期：只有 provider 明确支持且有 handle 时才算可用；能力未知即不投影（无事实不猜）。
  if (run && run.providerHandle !== undefined && facts.providerCanExtend === true) {
    actions.push("extend");
  }

  // 验收：active 即可（控制面在需要时先 drain，进行中显示验收/停止进度，08 §9）。
  // 例外（03 §6 修订 2026-10-09 行为表）：paused 的 complete = 拒绝（须先 resume 或
  // 完成 stop 终态收口）——投影与执行同表，paused 时不给 complete 入口。
  if (task.status === "active" && run?.status !== "paused") actions.push("complete");

  // 归档：无活动写 run 且未归档。
  if (task.status !== "archived" && !run) actions.push("archive");

  // 重新激活：completed、无活动 run，且 PR 未 merged（PR 事实不可得时不投影）。
  if (task.status === "completed" && !run && reactivateAllowed(task, facts.artifact)) {
    actions.push("reactivate");
  }

  // 恢复：archived 且有原前置状态。
  if (task.status === "archived" && task.archivedFromStatus !== undefined) actions.push("restore");

  // 规范化顺序：按 shared 冻结枚举的顺序输出，保持跨版本稳定（不依赖 push 顺序）。
  const available = new Set(actions);
  return CLOUD_TASK_ACTIONS.filter((action) => available.has(action));
}

function reactivateAllowed(
  task: CloudTaskRecord,
  artifact: CloudTaskArtifactRecord | null,
): boolean {
  const merged: PrPublicationStatus = "merged";
  if (artifact) return artifact.prStatus !== merged;
  // 无产物投影：只有「本来就没有 PR 记录」时才可用（有 prRef 但读不到产物 → 无法判定 merged）。
  return task.prRef === undefined;
}

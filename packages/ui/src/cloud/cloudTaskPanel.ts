/**
 * 云任务运行面板投影（specs/cloud-agent/04 §3.3 状态矩阵、08 §9 重开）。
 *
 * 背景（2026-10-08 实测缺陷）：run 因 E2B 拒绝等原因进入 `failed` 时，UI 没有任何
 * 失败呈现，用户只觉得「没反应」。规则抽成纯投影（node:test 直接覆盖）：
 *
 * - **事实只来自详情投影**：run 状态、`lastError`/`endReason`（shared 契约字段，
 *   非 `last_error` 蛇形命名）、checkpoint 状态、服务端 actions 投影。
 *   这里不按 Task 状态猜 Run 结论（04 §3.3「Task.active ≠ attachment ready」）。
 * - **重开可用性来自服务端 `actions` 投影**（`reopen` 成员），UI 不自行推导。
 * - **resume 选择按持久事实自动选**（08 §9：有确认 checkpoint → checkpoint；
 *   没有 → restart-from-base），并在 UI 说明依据，不提供与服务端事实冲突的二选一。
 * - provisioning 只呈现「进行中」，不渲染重开/失败文案。
 */
import type { CloudRunStatus } from "@zcode/shared";

/** 面板最小详情形状（测试可直接构造）。 */
export interface CloudTaskPanelDetail {
  readonly task: {
    readonly status: string;
    readonly revision: number;
    readonly draftStartConfig?: { readonly provider?: string | undefined } | undefined;
  };
  readonly activeRun?:
    | {
        readonly status: string;
        readonly lastError?: string | undefined;
        readonly endReason?: string | undefined;
        readonly provider?: string | undefined;
      }
    | undefined;
  readonly latestCheckpoint?: { readonly state: string } | undefined;
  readonly actions?: readonly string[] | undefined;
}

export type CloudTaskRunPanelView =
  /** 没有需要面板呈现的运行状态（draft/archived/ready 等）。 */
  | { readonly kind: "hidden" }
  /** task active 但 run 还没出现在投影里（202 后的事务窗口）。 */
  | { readonly kind: "waiting-for-run" }
  /** run 正在创建沙箱/clone/warm-up（04 §3.3 provisioning 行）。 */
  | { readonly kind: "provisioning" }
  /**
   * run 正在受控停止（2026-10-08 巡检修订 P1：stop 端点受理后 run 进入 draining，
   * 此前面板对 draining 一律 hidden，用户只看到永远「Working for Ns」）。
   * 呈现「正在停止」，并提供 force-stop 入口（08 §8.2，actions 投影含 force-stop）。
   */
  | { readonly kind: "draining" }
  /** run 已终止：failed 强调失败原因；stopped/expired 呈现中性说明。 */
  | {
      readonly kind: "ended";
      readonly runStatus: CloudRunStatus;
      readonly lastError: string | null;
      readonly endReason: string | null;
    };

const ENDED_RUN_STATUSES: readonly string[] = ["failed", "stopped", "expired"];

/** 面板主投影：只依据 run 状态分流，draft/archived 一律 hidden。 */
export function projectCloudTaskRunPanel(
  detail: CloudTaskPanelDetail | null,
): CloudTaskRunPanelView {
  const taskStatus = detail?.task.status;
  if (!detail || taskStatus === "draft" || taskStatus === "archived") {
    return { kind: "hidden" };
  }
  const run = detail.activeRun;
  if (!run) {
    // active 但投影里还没有 run：首发 202 后的窗口，呈现等待而不是空白。
    return { kind: "waiting-for-run" };
  }
  if (run.status === "provisioning") {
    return { kind: "provisioning" };
  }
  if (run.status === "draining") {
    return { kind: "draining" };
  }
  if (ENDED_RUN_STATUSES.includes(run.status)) {
    return {
      kind: "ended",
      runStatus: run.status as CloudRunStatus,
      lastError: run.lastError?.trim() ? run.lastError : null,
      endReason: run.endReason?.trim() ? run.endReason : null,
    };
  }
  // ready/disconnected：工作区/attachment 语义，面板不重复呈现。
  return { kind: "hidden" };
}

export interface CloudReopenPlan {
  /** 重开是否可用：只信服务端 actions 投影里的 `reopen` 成员（04 §3.3）。 */
  readonly available: boolean;
  /** resume 按持久事实自动选择（08 §9），UI 据此说明依据。 */
  readonly resume: { readonly mode: "checkpoint" | "restart-from-base" };
  /** 是否存在已确认的 checkpoint（`state === "saved"` 才可恢复）。 */
  readonly hasSavedCheckpoint: boolean;
  /** 重开请求需要的 provider：run 事实优先，回落已保存的 draftStartConfig。 */
  readonly provider: string | null;
  /** 服务端 actions 投影原样透传（缺省为空集合）。 */
  readonly actions: readonly string[];
}

/**
 * 组装重开参数依据。checkpoint 侧只认 `state === "saved"`（08 §8.2：saved 必须有
 * 远端 SHA 证据；pending/saving/failed 都不是可恢复事实）。
 */
export function resolveCloudReopenPlan(detail: CloudTaskPanelDetail | null): CloudReopenPlan {
  const actions = detail?.actions ?? [];
  const hasSavedCheckpoint = detail?.latestCheckpoint?.state === "saved";
  const provider =
    detail?.activeRun?.provider?.trim() || detail?.task.draftStartConfig?.provider?.trim() || null;
  return {
    available: actions.includes("reopen"),
    resume: { mode: hasSavedCheckpoint ? "checkpoint" : "restart-from-base" },
    hasSavedCheckpoint,
    provider,
    actions,
  };
}

/** 归档入口可用性：服务端 actions 投影说了算（04 §3.3，UI 不按状态猜）。 */
export function isCloudTaskArchiveActionAvailable(
  detail: Pick<CloudTaskPanelDetail, "actions"> | null,
): boolean {
  return (detail?.actions ?? []).includes("archive");
}

/**
 * force-stop 入口可用性（2026-10-08 巡检修订 P1、08 §8.2）：只认服务端 actions 投影里的
 * `force-stop` 成员（存在未终态 run 时服务端才提供，含已受理停止的 run）。UI 不按 run
 * 状态推导，普通 stop 失败也不自动升级（force-stop 必须是显式丢失确认的用户选择）。
 */
export function isCloudTaskForceStopActionAvailable(
  detail: Pick<CloudTaskPanelDetail, "actions"> | null,
): boolean {
  return (detail?.actions ?? []).includes("force-stop");
}

/**
 * 恢复入口可用性（04 §3 2026-10-08 巡检修订）：与归档同款——只认服务端 actions
 * 投影里的 `restore` 成员，UI 不按「status === archived」猜（03 §6：restore 对
 * active 任务返回 task-not-restorable，服务端裁决）。
 */
export function isCloudTaskRestoreActionAvailable(
  detail: Pick<CloudTaskPanelDetail, "actions"> | null,
): boolean {
  return (detail?.actions ?? []).includes("restore");
}

/**
 * 工作区 Header 任务标题解析（04 §3 2026-10-08 巡检修订）。
 *
 * 背景（实测缺陷）：云任务不在本机 CLI 任务索引里，`resolvedActiveTaskMeta` 恒为空，
 * Header 一直显示「新任务」占位（v4 session title 同样为空）。云任务标题来自控制面
 * 投影（详情/列表），本地 meta 优先、云标题兜底、占位最后。
 */
export function resolveCloudTaskHeaderTitle(params: {
  /** 本地任务索引解析出的标题（远程/本地任务仍是唯一来源）。 */
  readonly localTitle: string | null | undefined;
  /** 控制面投影里的云任务标题。 */
  readonly cloudTitle: string | null | undefined;
  /** 既有占位文案（新任务 / forkedUntitled）。 */
  readonly fallbackTitle: string;
}): string {
  const localTitle = params.localTitle?.trim();
  if (localTitle) {
    return localTitle;
  }
  const cloudTitle = params.cloudTitle?.trim();
  if (cloudTitle) {
    return cloudTitle;
  }
  return params.fallbackTitle;
}

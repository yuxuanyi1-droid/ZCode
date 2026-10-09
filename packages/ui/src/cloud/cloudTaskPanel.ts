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
import type { CloudExecutionConfig, CloudRunStatus, ModelSelection } from "@zcode/shared";
import type { SubmissionMode } from "@zcode/shared/zcode-protocol-v4";

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
  /**
   * task active/failed 且投影里没有 run、服务端 actions 给出 `reopen`
   * （2026-10-08 终态 run 发送行为修订）：上一个 run 已终态并被服务端收回
   * （详情投影只携带非终态 run，终态 run 事实以 reopen 能力到达）。
   * 优先于 waiting 呈现——后者只属于 202 后 run 尚未出现的窗口。
   */
  | { readonly kind: "reopenable" }
  /** run 正在创建沙箱/clone/warm-up（04 §3.3 provisioning 行）。 */
  | { readonly kind: "provisioning" }
  /**
   * run 暂停保留中（2026-10-09 生命周期 v2，04 §3.3 修订行）：分级能力 provider 的
   * 暂停保留期；呈现「已暂停——发送消息即可恢复」（composer 可用，append 由服务端
   * 按 03 §6 修订语义接受并由控制面自驱 resume）。能力位 none 的 provider 不出现
   * paused 投影（fail-closed：服务端本就不会报 paused）。
   */
  | { readonly kind: "paused" }
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
    // 2026-10-08 终态 run 发送行为修订：服务端详情投影只返回非终态 run，终态后
    // `activeRun` 消失。此时「reopen 能力已由服务端 actions 给出」= 上一个 run 已
    // 终态的事实到达 UI，呈现重开视图而不是永久假等待；仅当 reopen 不可用
    // （真正的 202 事务窗口 / recovery 等）才保留等待呈现。
    if (detail.actions?.includes("reopen")) {
      return { kind: "reopenable" };
    }
    // active 但投影里还没有 run：首发 202 后的窗口，呈现等待而不是空白。
    return { kind: "waiting-for-run" };
  }
  if (run.status === "provisioning") {
    return { kind: "provisioning" };
  }
  if (run.status === "paused") {
    return { kind: "paused" };
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

// ── composer 发送路由（2026-10-08 终态 run 发送行为修订，04 §3.3、03 §6、08 §5）──
//
// 规则抽成纯函数（node:test 直接覆盖），hook 只做绑定：用户显式发送的路由决定
// 与执行（HTTP 调用）分离，草稿恢复/对账/重试等自动路径不消费这里的 reopen 分支。

/** reopen 请求的恢复选择（shared `cloudReopenResumeChoiceSchema` 的判别联合形状）。 */
export type CloudComposerReopenResume =
  | { readonly mode: "checkpoint" }
  | { readonly mode: "restart-from-base" };

/** composer 无法提交的本地前置原因（无结构化错误，供调用方决定是否给占位提示）。 */
export type CloudComposerBlockedHint = "no-task" | "no-start-config" | "reopen-unavailable";

export type CloudComposerSendPlan =
  /** 没有任务投影：不猜状态，blocked（blockedHint=no-task）。 */
  | { readonly kind: "missing-task"; readonly blockedHint: "no-task" }
  /** draft 未保存完整启动配置：不允许首发（03 §6 start 行）。 */
  | { readonly kind: "missing-start-config"; readonly blockedHint: "no-start-config" }
  /** draft 首发。 */
  | { readonly kind: "start"; readonly expectedTaskRevision: number }
  /** run 在投影里（ready/disconnected/...）：普通 append（原语义）。 */
  | { readonly kind: "append"; readonly expectedRunGeneration: number }
  /**
   * 无有效 run 且用户显式发送：自动重开（消息即新工作要求，resume 按持久事实自动选，
   * 服务端按 08 §9 独立核验）。
   */
  | {
      readonly kind: "reopen";
      readonly provider: string;
      readonly resume: CloudComposerReopenResume;
      readonly expectedTaskRevision: number;
    }
  /** 无有效 run 但重开不可用（actions 无 reopen / provider 未知）：blocked + 提示。 */
  | { readonly kind: "reopen-unavailable"; readonly blockedHint: "reopen-unavailable" }
  /** 非选中工作区且无 run：保持原行为（提交 scope 属于选中任务，不能借道建 run）。 */
  | { readonly kind: "out-of-scope-blocked" };

export interface CloudComposerSendFacts {
  readonly task: {
    readonly status: string;
    readonly revision: number;
    readonly draftStartConfig?: { readonly provider?: string | undefined } | undefined;
  } | null;
  readonly activeRun?:
    | { readonly runGeneration: number; readonly provider?: string | undefined }
    | undefined;
  readonly latestCheckpoint?: { readonly state: string } | undefined;
  readonly actions?: readonly string[] | undefined;
  /** 提交 scope（draft store / reopen hook）绑定选中任务；非选中工作区不自动重开。 */
  readonly isSelectedTask: boolean;
}

/** composer 发送路由：hook 把每个分支翻译成一次 durable port 调用或本地 blocked。 */
export function resolveCloudComposerSendPlan(facts: CloudComposerSendFacts): CloudComposerSendPlan {
  const { task } = facts;
  if (!task) {
    return { kind: "missing-task", blockedHint: "no-task" };
  }
  if (task.status === "draft") {
    if (!task.draftStartConfig) {
      return { kind: "missing-start-config", blockedHint: "no-start-config" };
    }
    return { kind: "start", expectedTaskRevision: task.revision };
  }
  if (facts.activeRun) {
    return { kind: "append", expectedRunGeneration: facts.activeRun.runGeneration };
  }
  if (!facts.isSelectedTask) {
    return { kind: "out-of-scope-blocked" };
  }
  // 无有效 run（服务端详情投影只携带非终态 run）：actions 给出 `reopen` 才自动重开；
  // provider 是重开请求的必填事实，run 已被收回时回落已保存的 draftStartConfig。
  if (!(facts.actions ?? []).includes("reopen")) {
    return { kind: "reopen-unavailable", blockedHint: "reopen-unavailable" };
  }
  const provider = task.draftStartConfig?.provider?.trim() || null;
  if (provider === null) {
    return { kind: "reopen-unavailable", blockedHint: "reopen-unavailable" };
  }
  return {
    kind: "reopen",
    provider,
    resume: reopenResumeByFact(facts.latestCheckpoint),
    expectedTaskRevision: task.revision,
  };
}

/** 409 no-active-run 竞态重试的 reopen 参数：详情陈旧（仍显示活 run）时的持久事实。 */
export interface CloudReopenRetryPlan {
  readonly provider: string;
  readonly resume: CloudComposerReopenResume;
  readonly expectedTaskRevision: number;
}

/** composer 冻结 Submission 的结构最小形状（createComposerSubmissionConfig 的返回值）。 */
export interface CloudComposerSubmissionLike {
  readonly modelSelection: ModelSelection;
  readonly mode: SubmissionMode;
  readonly planEnabled: boolean;
}

/**
 * composer 冻结 Submission → 云输入 requestedConfig（2026-10-09 实测缺陷修复：
 * 「云任务运行中在界面切换模型不生效」）。
 *
 * Bug 原因：云发送适配层只把 prompt 交给控制面，composer 在发送点击时冻结的
 * 执行配置整包被丢弃——input record 的 `requestedConfig`/`resolvedExecutionConfig`
 * 落空，控制面投递的 sendText/createSession 信封不带 modelSelection，沙箱 runtime
 * admission（resolveSubmittedExecutionState）只能回落当前 Session Selection，而首发
 * 同样未携带（`firstCommandConfig` 落空），会话永远停留在沙箱缺省模型。
 *
 * 修复依据（取证结论「模型随消息参数走」）：V4 `sendText`/`createSession` 协议本就
 * 携带 modelSelection（02 §6.2 保留既有语义），云输入协议 `requestedConfig`
 * （CloudExecutionConfig）与控制面投递信封（inputDelivery/envelope.ts）逐层透传；
 * 唯一断点是 UI 适配层。把完整 Selection 原样映射进既有参数通路即可，不改冻结协议
 * （02）、不动 provisioning 代际机制。submission 为 null（选择未完成）时省略
 * requestedConfig，保持「runtime Session Selection」回落，不阻断发送。
 */
export function buildCloudRequestedConfig(
  submission: CloudComposerSubmissionLike | null | undefined,
): CloudExecutionConfig | undefined {
  if (!submission) {
    return undefined;
  }
  return {
    modelSelection: submission.modelSelection,
    mode: submission.mode,
    planEnabled: submission.planEnabled,
  };
}

/**
 * 409 `not_ready/no-active-run` 竞态重试计划（04 §3.3 修订）：此刻 actions 里不会有
 * `reopen`（详情仍显示活 run），不能走 `resolveCloudComposerSendPlan` 的 plan 门控；
 * 直接用详情里的持久事实组装，revision CAS 交由服务端裁决（stale 就报错，不二次重试）。
 * provider 无事实（run 无 provider 且未保存 draftStartConfig）时返回 null，回落归一错误。
 */
export function resolveCloudReopenRetryPlan(
  detail: CloudTaskPanelDetail | null,
): CloudReopenRetryPlan | null {
  if (!detail) {
    return null;
  }
  const provider =
    detail.activeRun?.provider?.trim() || detail.task.draftStartConfig?.provider?.trim() || null;
  if (provider === null) {
    return null;
  }
  return {
    provider,
    resume: reopenResumeByFact(detail.latestCheckpoint),
    expectedTaskRevision: detail.task.revision,
  };
}

/** resume 按持久事实自动选择（08 §9 修订：显式声明，依据是确认 checkpoint）。 */
function reopenResumeByFact(
  latestCheckpoint: { readonly state: string } | undefined,
): CloudComposerReopenResume {
  return latestCheckpoint?.state === "saved"
    ? { mode: "checkpoint" }
    : { mode: "restart-from-base" };
}

/** 归档入口可用性：服务端 actions 投影说了算（04 §3.3，UI 不按状态猜）。 */
export function isCloudTaskArchiveActionAvailable(
  detail: Pick<CloudTaskPanelDetail, "actions"> | null,
): boolean {
  return (detail?.actions ?? []).includes("archive");
}

/**
 * 归档点击的准入裁决（2026-10-07 终验缺陷 E）。
 *
 * 背景：侧栏行不拉详情（autoLoad=false，避免整列 GET /tasks/:id），无缓存详情时
 * 归档入口保持可点、由服务端裁决；但活动 run 未终态时服务端必然 409
 * `not_ready/task-has-active-run`，旧文案还误导用户「稍后再试」。规则：
 *
 * - 有缓存详情 → 直接按投影裁决（不发请求）；
 * - 无缓存详情 → 点击时拉一次详情，再按投影裁决（投影不含 archive = 存在活动
 *   run，先停止再归档）；这是唯一能在不发整列请求的前提下对齐服务端裁决的时机；
 * - 详情拉不到（网络/未接线）→ `unknown`：回落服务端裁决（旧行为），错误由
 *   `describeCloudTaskActionError` 归一呈现，不用本地猜测替代服务端事实。
 */
export type CloudArchiveAdmission =
  | { readonly kind: "allowed" }
  | { readonly kind: "blocked-active-run" }
  | { readonly kind: "unknown" };

export async function resolveCloudTaskArchiveAdmission(params: {
  /** 缓存详情（可为 null：该行从未打开过）。 */
  readonly cachedDetail: Pick<CloudTaskPanelDetail, "actions"> | null;
  /** 无缓存详情时按需拉取；拉不到返回 null（不得抛出）。 */
  readonly loadDetail: () => Promise<Pick<CloudTaskPanelDetail, "actions"> | null>;
}): Promise<CloudArchiveAdmission> {
  const detail = params.cachedDetail ?? (await params.loadDetail());
  if (detail === null) {
    return { kind: "unknown" };
  }
  return isCloudTaskArchiveActionAvailable(detail)
    ? { kind: "allowed" }
    : { kind: "blocked-active-run" };
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

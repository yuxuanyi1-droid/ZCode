/**
 * 云任务面板「同步用户资源」入口的纯逻辑（specs/cloud-agent/14 §4.6/§9.5；W11 §13D）。
 *
 * 规则（14 §4.6「触发与门控」，2026-10-11 简化定调）：
 * - **显示门控**：入口只在 Run 连接态（bridge ready）且非终态时渲染——未连接**不显示**
 *   （不是禁用态）；服务端对直接调用同样拒绝（409），UI 不是权限边界；
 * - **结果摘要**：手动同步响应是逐条结果（`{runId, profileVersion, trigger, results[]}`），
 *   UI 只做计数与有限条数的失败列举，不改写、不推断条目状态；
 * - **错误文案**：409 `not_ready` 按 reason 细分（`run-not-connected` = 沙箱未连接、
 *   `run-terminal` = 运行已结束），其余码沿既有任务动作文案表（04 §6：UI 不解析异常文字）。
 *
 * 本模块不依赖 React、不持状态、不做 IO：node:test 直接覆盖（本包测试布局）。
 */
import type { CloudUserProfileSyncResponse, CloudUserProfileSyncResultItem } from "@zcode/shared";
import { readCloudErrorCode, readCloudErrorReason } from "./cloudApiErrorLike.js";
import { cloudInputRejectionMessageKey } from "./cloudTaskErrorText.js";
import { describeCloudSubmissionError } from "./cloudTaskSubmission.js";

/**
 * 终态 Run 状态（08 §3.2；`cloudTaskPanel` 的 `ENDED_RUN_STATUSES` 是同一集合的另一处
 * 呈现用定义，两处各自服务本模块判定，取值以 shared `cloudRunStatusSchema` 为准）。
 */
export const CLOUD_TERMINAL_RUN_STATUSES = ["stopped", "expired", "failed"] as const;

/**
 * 入口不可见的原因（测试与排障用；UI 一律「未连接/终态 → 不渲染」，不呈现禁用态）。
 */
export type CloudUserProfileSyncHiddenReason =
  /** 非云任务工作区（本地 / SSH / 配对远控）：调用方零渲染。 */
  | "not-cloud-task"
  /** 当前 Run 的连接未建立（无 attachment / 非 ready）：14 §4.6 未连接不显示入口。 */
  | "not-connected"
  /** Run 已终态（stopped/expired/failed）：没有可同步的运行环境。 */
  | "terminal"
  /** 投影里还没有 run（provisioning 前的事务窗口）或没有 detail：不显示。 */
  | "no-run";

export type CloudUserProfileSyncEntryView =
  | { readonly visible: true; readonly hiddenReason: null }
  | { readonly visible: false; readonly hiddenReason: CloudUserProfileSyncHiddenReason };

export interface ResolveCloudUserProfileSyncEntryInput {
  /** `resolveCloudTaskIdFromWorkspaceIdentity(workspaceIdentity)` 的结果；非云为 null。 */
  readonly cloudTaskId: string | null;
  /**
   * 当前 Run attachment 是否就绪且归属该任务
   * （`selectCloudAttachmentForTask(attachment, cloudTaskId) !== null`）：
   * 这是「attachment 在线」的唯一判据（04 §3.3「Task.active ≠ attachment ready」）。
   */
  readonly attachmentReady: boolean;
  /** 详情投影 `activeRun.status`（与状态横幅/Git 面板同源的唯一事实）。 */
  readonly activeRunStatus: string | null;
}

/**
 * 入口显示判定。
 *
 * 「连接态」取 `activeRun.status === "ready"`：14 §4.6 的门控是 **bridge ready**，
 * 而 `disconnected` / `draining` 虽然仍保持 attachment（04 §3.3：重连/保存窗口），
 * 但服务端 registry 不会把同步放行（disconnected 未 ready；draining 命中 stopRequested
 * 屏障）——显示一个必然 409 的入口就是"可点但无意义"，故这里要求 ready。
 * 该判定只是双保险：服务端前置校验是权威（14 §4.6「门控双保险」）。
 */
export function resolveCloudUserProfileSyncEntry(
  input: ResolveCloudUserProfileSyncEntryInput,
): CloudUserProfileSyncEntryView {
  if (input.cloudTaskId === null) {
    return { visible: false, hiddenReason: "not-cloud-task" };
  }
  if (input.activeRunStatus === null) {
    return { visible: false, hiddenReason: "no-run" };
  }
  if ((CLOUD_TERMINAL_RUN_STATUSES as readonly string[]).includes(input.activeRunStatus)) {
    return { visible: false, hiddenReason: "terminal" };
  }
  if (input.activeRunStatus !== "ready" || !input.attachmentReady) {
    return { visible: false, hiddenReason: "not-connected" };
  }
  return { visible: true, hiddenReason: null };
}

// ── 结果摘要（14 §4.6「结论可见性」：手动同步的逐条结论在响应里返回）──

export interface CloudUserProfileSyncFailure {
  readonly category: string;
  readonly entryId: string;
  /** 服务端有界诊断文本（已脱敏、不含正文，14 §5）；缺失时为 null。 */
  readonly error: string | null;
}

export interface CloudUserProfileSyncSummary {
  readonly total: number;
  readonly synced: number;
  readonly skipped: number;
  readonly failed: number;
  /** 失败条目简列（最多 `maxFailures` 条，按响应次序）。 */
  readonly failures: readonly CloudUserProfileSyncFailure[];
  /** 被截断的失败条数（0 = 全部列出）。 */
  readonly hiddenFailures: number;
  /** 承载本次结果的同步来源；`automatic` = 手动请求 join 了在飞的自动同步（14 §4.6 单飞）。 */
  readonly trigger: CloudUserProfileSyncResponse["trigger"];
  readonly profileVersion: number;
  readonly runId: string;
}

/** 失败简列的默认上限：面板是一行摘要，不把 256 条结果全铺出来。 */
export const CLOUD_USER_PROFILE_SYNC_MAX_LISTED_FAILURES = 5;

/**
 * 逐条结果 → 面板摘要。只统计与截断，不解释条目语义、不重排（保持响应次序）。
 */
export function summarizeCloudUserProfileSync(
  response: CloudUserProfileSyncResponse,
  options?: { readonly maxFailures?: number },
): CloudUserProfileSyncSummary {
  const maxFailures = options?.maxFailures ?? CLOUD_USER_PROFILE_SYNC_MAX_LISTED_FAILURES;
  const failures = response.results.filter((item) => item.status === "failed");
  return {
    total: response.results.length,
    synced: countStatus(response.results, "synced"),
    skipped: countStatus(response.results, "skipped"),
    failed: failures.length,
    failures: failures.slice(0, maxFailures).map((item) => ({
      category: item.category,
      entryId: item.entryId,
      error: item.error ?? null,
    })),
    hiddenFailures: Math.max(0, failures.length - maxFailures),
    trigger: response.trigger,
    profileVersion: response.profileVersion,
    runId: response.runId,
  };
}

function countStatus(
  results: readonly CloudUserProfileSyncResultItem[],
  status: CloudUserProfileSyncResultItem["status"],
): number {
  return results.filter((item) => item.status === status).length;
}

// ── 错误文案（409 按 reason 细分；其余码沿既有任务动作文案表）──

/**
 * 同步专属的 `not_ready` reason → i18n key（服务端 `profileSyncService.resolveTarget`
 * 的稳定标签）。未列出的 reason 回落既有输入拒绝表（含 `stop-requested`），
 * 再回落 `not_ready` 通用文案（04 §6、09 §8：不猜语义）。
 */
const SYNC_NOT_READY_REASON_MESSAGE_KEYS: Readonly<Partial<Record<string, string>>> = {
  "run-not-connected": "cloud.userProfileSync.error.notConnected",
  "run-terminal": "cloud.userProfileSync.error.runEnded",
  "run-not-found": "cloud.userProfileSync.error.runEnded",
};

/**
 * 手动同步失败 → i18n key；无映射返回 null（调用方回落 `describeCloudSubmissionError`
 * 的原始结果，与既有任务动作错误呈现同一口径）。
 */
export function cloudUserProfileSyncErrorMessageKey(
  code: string | null,
  reason: string | null,
): string | null {
  if (code === null) {
    return null;
  }
  if (code === "not_ready") {
    const syncKey = reason !== null ? SYNC_NOT_READY_REASON_MESSAGE_KEYS[reason] : undefined;
    if (syncKey !== undefined) return syncKey;
  }
  if (code === "not_configured") {
    // 部署未装配用户资源存储：与设置页同一文案（不伪装成功、不发明第二条解释）。
    return "settings.cloudUserResources.error.notConfigured";
  }
  return cloudInputRejectionMessageKey(code, reason);
}

/** 归一手动同步失败文案：命中映射取 i18n 文案，否则回落原始错误信息（04 §6）。 */
export function describeCloudUserProfileSyncError(
  error: unknown,
  translate: (id: string) => string,
): string {
  const key = cloudUserProfileSyncErrorMessageKey(
    readCloudErrorCode(error),
    readCloudErrorReason(error),
  );
  return key === null ? describeCloudSubmissionError(error) : translate(key);
}

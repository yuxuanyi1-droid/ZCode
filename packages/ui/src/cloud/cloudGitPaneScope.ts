/**
 * 审查（Git）侧栏面板的云工作区作用域与空态文案判定
 * （specs/cloud-agent/04 §3.3、W8 §3、§3.3「2026-10-10 修订」）。
 *
 * 回归背景（2026-10-10 用户实测缺陷）：Git 面板的取数门控沿用
 * `shouldEnableWorkspaceRpc`（要求 remote 目标已注册 remote session），而云任务
 * 工作区（identity = `cloud-task:<taskId>`）没有、也不会有 remote session 登记，
 * 于是面板永远停在空摘要态（`isGitAvailable=false`），ready run 也呈现
 * 「当前环境没有可用的 Git——请先安装 Git」，从未真正发起 Git 查询。
 *
 * 与会话面板同一接缝（`resolveV4PaneConversationServices`）：云身份不看通用解析，
 * 只看当前 Run attachment 的真实状态；paused 等无 attachment 场景呈现环境引导，
 * 不呈现 install 文案。「install Git」文案只留给环境 ready 后的真实结论。
 *
 * 纯函数：不持有状态、不做 IO、不依赖 `@/` 别名，node:test 可直接覆盖。
 */

/** Git 面板执行环境呈现态。 */
export type CloudGitPaneEnvironment = "ready" | "paused" | "unavailable";

export interface ResolveCloudGitPaneScopeParams {
  /** `resolveCloudTaskIdFromWorkspaceIdentity(identity)` 的结果；非云身份为 null。 */
  readonly cloudTaskId: string | null;
  /**
   * 当前 Run attachment 是否就绪且归属该任务
   * （即 `selectCloudAttachmentForTask(attachment, cloudTaskId) !== null`）。
   */
  readonly attachmentReady: boolean;
  /** 详情投影 `activeRun.status`；paused 判定的唯一事实源（与状态横幅同源）。 */
  readonly activeRunStatus: string | null;
  /** 通用 RPC 门控结果（`shouldEnableWorkspaceRpc`）；仅非云链路使用。 */
  readonly genericWorkspaceRpcEnabled: boolean;
}

export interface CloudGitPaneScope {
  /** Git 面板是否允许发起 Git RPC（数据面唯一开关）。 */
  readonly workspaceRpcEnabled: boolean;
  /** 执行环境呈现态：ready 正常取数；paused/unavailable 呈现环境引导。 */
  readonly environment: CloudGitPaneEnvironment;
}

/**
 * Git 面板作用域判定（04 §3.3「Task.active ≠ attachment ready」）。
 *
 * - 非云工作区：完全沿用既有链路（本地 / SSH / 已配对远控），environment 恒 ready，
 *   `environment` 不参与呈现分支。
 * - 云工作区：数据面开关只由 attachment 真实状态决定；`paused` 是唯一有专用引导
 *   文案的环境态（复用状态横幅语义），其余无 attachment 场景（provisioning /
 *   终态 / 非选中任务）按「运行环境当前不可用」呈现。
 */
export function resolveCloudGitPaneScope(
  params: ResolveCloudGitPaneScopeParams,
): CloudGitPaneScope {
  if (params.cloudTaskId === null) {
    return {
      workspaceRpcEnabled: params.genericWorkspaceRpcEnabled,
      environment: "ready",
    };
  }
  if (params.attachmentReady) {
    return { workspaceRpcEnabled: true, environment: "ready" };
  }
  return {
    workspaceRpcEnabled: false,
    environment: params.activeRunStatus === "paused" ? "paused" : "unavailable",
  };
}

export interface GitPaneEmptyStateCopy {
  readonly titleMessageId: string;
  readonly descriptionMessageId: string;
}

export interface ResolveGitPaneEmptyStateCopyParams {
  /** 当前来源是否是「上一轮更改」（既有最高优先级空态）。 */
  readonly isLastTurnSource: boolean;
  readonly loading: boolean;
  readonly error: string | null;
  /** `useGitRepository` 投影出的执行环境态（非云恒为 ready）。 */
  readonly cloudEnvironment: CloudGitPaneEnvironment;
  readonly isGitAvailable: boolean;
  readonly isRepository: boolean;
}

/**
 * Git 面板空态文案选择（04 §3.3「2026-10-10 修订」）。
 *
 * 顺序即优先级：last-turn → loading → error → 云环境感知态 → gitUnavailable →
 * notRepository → 普通空态。云环境感知态必须先于 gitUnavailable 判定：沙箱暂停 /
 * 未就绪时 Git 不可达是环境事实，不能渲染成「本机没装 Git」的 install 引导。
 */
export function resolveGitPaneEmptyStateCopy(
  params: ResolveGitPaneEmptyStateCopyParams,
): GitPaneEmptyStateCopy {
  if (params.isLastTurnSource) {
    return {
      titleMessageId: "git.empty.lastTurnTitle",
      descriptionMessageId: "git.empty.lastTurnDescription",
    };
  }
  if (params.loading) {
    return { titleMessageId: "common.loading", descriptionMessageId: "git.loading.description" };
  }
  if (params.error) {
    return { titleMessageId: "git.error.title", descriptionMessageId: "git.error.description" };
  }
  if (params.cloudEnvironment === "paused") {
    // 复用状态横幅（CloudTaskRunStatusBanner）的 paused 标题语义；描述补 Git 视角的恢复引导。
    return {
      titleMessageId: "cloud.run.statusPaused",
      descriptionMessageId: "git.cloud.pausedDescription",
    };
  }
  if (params.cloudEnvironment === "unavailable") {
    return {
      titleMessageId: "git.cloud.environmentUnavailableTitle",
      descriptionMessageId: "git.cloud.environmentUnavailableDescription",
    };
  }
  if (!params.isGitAvailable) {
    return {
      titleMessageId: "git.empty.gitUnavailableTitle",
      descriptionMessageId: "git.empty.gitUnavailableDescription",
    };
  }
  if (!params.isRepository) {
    return {
      titleMessageId: "git.empty.notRepositoryTitle",
      descriptionMessageId: "git.empty.notRepositoryDescription",
    };
  }
  return { titleMessageId: "git.empty.title", descriptionMessageId: "git.empty.description" };
}

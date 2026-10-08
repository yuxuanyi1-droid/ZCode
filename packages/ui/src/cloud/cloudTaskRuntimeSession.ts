/**
 * 云任务工作区的 runtime 会话解析规则（specs/cloud-agent/W8 §3、04 §3.3、08 §4.1，
 * 02 §2 不变量 1 的 2026-10-08 巡检修订见 `runWorkspacePath` 注释）。
 *
 * 为什么需要独立规则：v4 主区 pane 的会话绑定在本地语义下 `sessionId ≡ taskId`
 * （`WorkspaceShellLayout` 的既有注释），云任务**不满足**这条等式——runtime 的真实会话 id
 * 是首输入 ack 落地的 `activeRun.runtimeSessionId`（`sess_…`，也是投影 topic
 * `conversation/sess_…` 的后缀）。把 taskId 当会话 id 去订阅会得到
 * `fault.subscribe.sessionNotFound`（实测：pane 用 taskId `4d090058-…` 订阅被拒，
 * runtime 会话实为 `sess_78e9975e-…`），右侧只剩这条 fault。
 *
 * 规则是纯函数（不依赖 React 与 `@/` 别名，node:test 可直接加载），与
 * `selectCloudAttachmentForTask` 的 fail-closed 语义一致：
 * - identity 不是 `cloud-task:<taskId>` → 非云任务工作区，调用方沿用本地解析；
 * - 是云任务身份，但控制面详情不是**同一个任务**（未加载 / 侧栏另一个任务）→ 无会话，
 *   不借别的任务的会话，也不拿 taskId / workspaceIdentity 顶替；
 * - 同一任务 → 取 `activeRun.runtimeSessionId`；run 未 ready / 首输入未 ack 时该字段缺失，
 *   按「无会话」返回 null（pane 渲染空态），run 换代后随 activeRun 换成新的 sess_…。
 *
 * 2026-10-08 巡检修订（P1）：**runtimeSessionId 与 run 的 checkout 路径必须同时落定**才
 * 绑定会话。实测缺陷：首条消息 attach 时 `runtimeSessionId` 先于
 * `activeRun.workspacePath` 出现在详情投影里，pane 立即用 pane scope 的空串
 * `workspacePath` 发起 `subscribeConversationV4`，runtime 侧 zod 校验以
 * `path: ["workspace","workspacePath"]` 的 too_small 拒绝，右侧渲染出原始 zod issues
 * JSON（错误呈现与事实相反——服务端 run 实际成功，刷新 replay 完整）。spec 02 §2 不变量 1
 * 要求身份与路径**同时传递**、禁止空串/伪路径，因此这里选择「等 workspacePath 落定再
 * ready」而不是把协议字段 optional 化：路径未落定时按「无会话」返回（pane 停在等待态，
 * 不发订阅），调用方（控制器）负责把落定后的路径同步进 pane scope。
 */
import { resolveCloudTaskIdFromWorkspaceIdentity } from "./cloudUiBootstrap.js";

export interface CloudTaskRuntimeSessionResolution {
  /** 当前工作区是否是云任务工作区（identity = `cloud-task:<taskId>`）。 */
  readonly isCloudTaskWorkspace: boolean;
  /** runtime 会话 id（`sess_…`）；run 未 ready / 首输入未 ack / 路径未落定时为 null。 */
  readonly runtimeSessionId: string | null;
  /**
   * 当前 run 的 checkout 路径（详情投影事实）；未落定 / 非绝对路径时为 null。
   * 控制器用它同步云任务 tab 的 `workspacePath`，保证 pane scope 发出的
   * workspace 描述永远带非空路径（spec 02 §2「两者同时传递」）。
   */
  readonly runWorkspacePath: string | null;
}

/** 详情投影里 pane 绑定需要的最小形状（测试可直接构造，不依赖完整 schema）。 */
export interface CloudTaskRuntimeSessionDetail {
  readonly task: { readonly taskId: string };
  readonly activeRun?:
    | {
        readonly runtimeSessionId?: string | undefined;
        readonly workspacePath?: string | undefined;
      }
    | undefined;
}

/** run 的 checkout 路径是否已落定：绝对 POSIX 路径（沙箱内 checkout，08 §4.1）。 */
export function isCloudRunWorkspacePathSettled(
  workspacePath: string | null | undefined,
): workspacePath is string {
  return typeof workspacePath === "string" && workspacePath.startsWith("/");
}

export function resolveCloudTaskRuntimeSession(params: {
  readonly workspaceIdentity?: string | null;
  readonly taskDetail: CloudTaskRuntimeSessionDetail | null;
}): CloudTaskRuntimeSessionResolution {
  const cloudTaskId = resolveCloudTaskIdFromWorkspaceIdentity(params.workspaceIdentity);
  if (cloudTaskId === null) {
    // 非 cloud-task 身份：本地 / SSH / 已配对远控，会话来源仍走原解析（activeTaskId）。
    return { isCloudTaskWorkspace: false, runtimeSessionId: null, runWorkspacePath: null };
  }

  const detail = params.taskDetail;
  if (!detail || detail.task.taskId !== cloudTaskId) {
    // 详情未加载 / 是另一个任务：云工作区但无会话可绑定（fail-closed，不借不造）。
    return { isCloudTaskWorkspace: true, runtimeSessionId: null, runWorkspacePath: null };
  }

  const runWorkspacePath = isCloudRunWorkspacePathSettled(detail.activeRun?.workspacePath)
    ? detail.activeRun.workspacePath
    : null;
  const runtimeSessionId = detail.activeRun?.runtimeSessionId?.trim();
  return {
    isCloudTaskWorkspace: true,
    // 路径未落定时即使 runtimeSessionId 已出现也不绑定：避免 pane 拿空串路径发订阅
    // （P1 巡检缺陷，见文件头注释）。pane 停在等待态，路径落定后随详情刷新绑定。
    runtimeSessionId: runtimeSessionId && runWorkspacePath !== null ? runtimeSessionId : null,
    runWorkspacePath,
  };
}

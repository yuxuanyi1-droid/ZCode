/**
 * 云任务工作区的 runtime 会话解析规则（specs/cloud-agent/W8 §3、04 §3.3、08 §4.1）。
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
 */
import { resolveCloudTaskIdFromWorkspaceIdentity } from "./cloudUiBootstrap.js";

export interface CloudTaskRuntimeSessionResolution {
  /** 当前工作区是否是云任务工作区（identity = `cloud-task:<taskId>`）。 */
  readonly isCloudTaskWorkspace: boolean;
  /** runtime 会话 id（`sess_…`）；run 未 ready / 首输入未 ack 时为 null。 */
  readonly runtimeSessionId: string | null;
}

/** 详情投影里 pane 绑定需要的最小形状（测试可直接构造，不依赖完整 schema）。 */
export interface CloudTaskRuntimeSessionDetail {
  readonly task: { readonly taskId: string };
  readonly activeRun?: { readonly runtimeSessionId?: string | undefined } | undefined;
}

export function resolveCloudTaskRuntimeSession(params: {
  readonly workspaceIdentity?: string | null;
  readonly taskDetail: CloudTaskRuntimeSessionDetail | null;
}): CloudTaskRuntimeSessionResolution {
  const cloudTaskId = resolveCloudTaskIdFromWorkspaceIdentity(params.workspaceIdentity);
  if (cloudTaskId === null) {
    // 非 cloud-task 身份：本地 / SSH / 已配对远控，会话来源仍走原解析（activeTaskId）。
    return { isCloudTaskWorkspace: false, runtimeSessionId: null };
  }

  const detail = params.taskDetail;
  if (!detail || detail.task.taskId !== cloudTaskId) {
    // 详情未加载 / 是另一个任务：云工作区但无会话可绑定（fail-closed，不借不造）。
    return { isCloudTaskWorkspace: true, runtimeSessionId: null };
  }

  const runtimeSessionId = detail.activeRun?.runtimeSessionId?.trim();
  return {
    isCloudTaskWorkspace: true,
    runtimeSessionId: runtimeSessionId ? runtimeSessionId : null,
  };
}

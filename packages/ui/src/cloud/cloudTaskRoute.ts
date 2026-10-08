/**
 * 云任务主路由失败判定（specs/cloud-agent/04 §5 主路由、2026-10-08 巡检修订）。
 *
 * 背景（实测缺陷）：`?task=<合法但不存在的 UUID>` 通过了入口的 id 校验
 * （`cloudTaskIdSchema`），进入云壳后 `GET /tasks/:id` 404，UI 却**静默回落欢迎页**
 * （URL 仍带 `?task=`，无任何提示），且多个订阅方各自重发 404 请求。
 *
 * 规则（纯函数，node:test 直接覆盖）：
 * - 只有**主路由指向的任务**（入口深链 `?task=` / popstate 同步后的 selection）
 *   的详情加载失败才升级为错误屏；用户在应用内导航选中其他任务时由侧栏/打开路径
 *   自己提示，不替换整页；
 * - 只认 `not_found`（跨主体资源统一 404，03 §3）：网络类失败仍交给页面内错误态，
 *   不把「暂时不可达」误报成「任务不存在」；
 * - 其余状态（idle/loading/ready）一律不触发。
 */
export type CloudTaskRouteFailureReason = "task-not-found";

export interface CloudTaskRouteFailureInput {
  /** 入口深链（bootstrap）携带的 taskId；没有 `?task=` 时为 undefined。 */
  readonly bootstrappedTaskId: string | undefined;
  /** 控制面当前选中的 taskId（主路由同步后的值）。 */
  readonly selectionTaskId: string | null;
  /** 详情投影加载状态（控制器唯一 owner）。 */
  readonly taskDetailStatus: "idle" | "loading" | "ready" | "error";
  /** 详情加载失败的结构化错误码（not_found 等）；无结构化码时为 null。 */
  readonly taskDetailErrorCode: string | null;
}

export interface CloudTaskRouteFailure {
  readonly reason: CloudTaskRouteFailureReason;
}

/**
 * 主路由任务是否应升级为整页错误屏（task-not-found）。
 * 返回 null 表示不需要——调用方继续渲染原工作区壳。
 */
export function resolveCloudTaskRouteFailure(
  input: CloudTaskRouteFailureInput,
): CloudTaskRouteFailure | null {
  if (
    input.bootstrappedTaskId === undefined ||
    input.selectionTaskId !== input.bootstrappedTaskId ||
    input.taskDetailStatus !== "error" ||
    input.taskDetailErrorCode !== "not_found"
  ) {
    return null;
  }
  return { reason: "task-not-found" };
}

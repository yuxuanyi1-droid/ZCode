/**
 * Cloud Task 工作区 tab 的身份与取值规则（specs/cloud-agent 04 §3.0/§5、08 §4.1、W8 §3）。
 *
 * 这些是「云任务 tab」的全部判定规则，抽成不依赖 `@/` 别名与 React 的纯函数：
 * `tabStore.openCloudTaskTab`、`useCloudTaskTabOpener` 与用例共用同一份实现，
 * 不会出现「组件里一套、store 里另一套」。
 *
 * 三条规则：
 * 1. **匹配键是 taskId**：Run 换代后 checkout 路径会变，按路径匹配会开出第二个 tab。
 * 2. `workspaceIdentity` 固定为 `cloud-task:<taskId>`：跨 provider/run/path 稳定（08 §4.1），
 *    服务作用域与 IO 路由都按它判定。
 * 3. `workspacePath` 只能是 Run 的真实 checkout 路径；run ready 前为空串，
 *    既不用伪造路径诱发 IO，也不把 `workspaceIdentity` 当路径用（04 §3.0/§3.4.1）。
 */
import { buildCloudTaskWorkspaceIdentity } from "@zcode/shared";

export interface CloudTaskTabTarget {
  readonly cloudTaskId: string;
  readonly workspaceIdentity: string;
  /**
   * Run 的 checkout 路径；空串表示「当前没有可用的文件系统路径」。
   * 路径缺失不是错误——draft 期本来就没有沙箱。
   */
  readonly workspacePath: string;
  readonly label: string;
}

/** 只依赖匹配所需字段的 tab 投影（避免让纯函数依赖 tabStore 的完整类型）。 */
export interface CloudTaskTabIdentity {
  readonly cloudTaskId?: string;
}

export function buildCloudTaskTabTarget(input: {
  readonly taskId: string;
  readonly taskTitle: string;
  /** `activeRun.workspacePath`；缺失或非绝对路径一律按「暂无路径」处理。 */
  readonly runWorkspacePath?: string | undefined;
}): CloudTaskTabTarget {
  const runPath = input.runWorkspacePath?.trim() ?? "";
  return {
    cloudTaskId: input.taskId,
    workspaceIdentity: buildCloudTaskWorkspaceIdentity(input.taskId),
    // 只接受绝对值路径：run 元数据里的相对路径/空值都不能当成 IO 目标。
    workspacePath: runPath.startsWith("/") ? runPath : "",
    label: input.taskTitle,
  };
}

/**
 * 在现有 tab 列表里按 taskId 找云任务 tab。
 *
 * 返回 -1 表示「还没有这个任务的工作区」；绝不按 `workspacePath` 兜底匹配，
 * 否则 run 换代后会开出第二个 tab。
 */
export function findCloudTaskTabIndex(
  tabs: readonly CloudTaskTabIdentity[],
  taskId: string,
): number {
  return tabs.findIndex((tab) => tab.cloudTaskId !== undefined && tab.cloudTaskId === taskId);
}

/** 该 tab 是否是云任务工作区（身份或 taskId 任一命中）。 */
export function isCloudTaskTab(tab: CloudTaskTabIdentity): boolean {
  return tab.cloudTaskId !== undefined && tab.cloudTaskId.trim().length > 0;
}

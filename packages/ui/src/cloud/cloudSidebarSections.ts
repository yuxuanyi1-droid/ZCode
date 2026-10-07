/**
 * 云模式侧栏分区规则（specs/cloud-agent 04 §3.0/§3.0.1/§3.1）。
 *
 * 规范要求的是**改造原项目区**，不是并列新增一套云导航：
 * > 04 §3.0.1：原 sidebar 项目区域消费 Project → Task 投影，添加仓库使用原 Dialog。
 * > 04 §3.0：原侧栏增加 Project → Task 数据与管理动作，不替换成项目卡片首页或另一套 Cloud 导航。
 *
 * 因此云模式下侧栏只保留**项目区**（容器、分组头、标题、行样式与本地模式完全同一套），
 * 由它承载云 Project → Task 投影；本地的任务区与三种本地任务视图（分组/时间线/归档）
 * 不再并列渲染——它们在云模式里只会是「本地 CLI 的空任务区」，正是 04 §3.0.1 要避免的
 * 重复导航。
 *
 * 判据是**是否云入口**（`CloudWorkspaceContext` 是否存在），不是路径真值：
 * 云任务在 run ready 前没有 checkout 路径，用路径判断会把 draft 误判成本地。
 *
 * 规则抽在这里是为了能被用例直接覆盖（侧栏组件本身依赖 `@/` 别名，node:test 加载不到）。
 */

/** 侧栏 purpose 分组（与既有侧栏词汇一致）。 */
export type SidebarPurposeSectionId = "projects" | "conversations";

/** 侧栏任务视图模式（既有 `SidebarTaskViewMode` 的取值集合）。 */
export type SidebarTaskViewMode = "grouped" | "workspace" | "timeline" | "archived";

export interface CloudSidebarSectionPlan {
  /** 实际渲染的分组顺序。 */
  readonly purposeSectionOrder: readonly SidebarPurposeSectionId[];
  /** 实际生效的任务视图模式。 */
  readonly taskViewMode: SidebarTaskViewMode;
  /** 是否渲染本地任务视图工具条（分组/时间线/归档/批量展开）。 */
  readonly showsLocalTaskViewToolbar: boolean;
  /** 项目区是否由云 Project → Task 投影承载。 */
  readonly projectsAreaRendersCloudProjection: boolean;
}

export function resolveCloudSidebarSectionPlan(params: {
  readonly isCloudMode: boolean;
  /** 用户偏好里的分组顺序。 */
  readonly purposeSectionOrder: readonly SidebarPurposeSectionId[];
  /** 由 `showArchivedTasks` / `taskOrganizeBy` 推导出的本地视图模式。 */
  readonly taskViewMode: SidebarTaskViewMode;
}): CloudSidebarSectionPlan {
  if (!params.isCloudMode) {
    // 本地 / SSH / 已配对远控：逐项原样返回，一个分支都不加。
    return {
      purposeSectionOrder: params.purposeSectionOrder,
      taskViewMode: params.taskViewMode,
      showsLocalTaskViewToolbar: true,
      projectsAreaRendersCloudProjection: false,
    };
  }

  const projectsOnly = params.purposeSectionOrder.filter((sectionId) => sectionId === "projects");
  return {
    // 只保留项目区；用户偏好里万一没有 projects 也补上，保证云项目区始终可见。
    purposeSectionOrder: projectsOnly.length > 0 ? projectsOnly : ["projects"],
    // 强制 workspace 视图：其余视图渲染的都是本地任务区。
    taskViewMode: "workspace",
    // 工具条只驱动本地视图，云模式下显示出来是点不动的死控件。
    showsLocalTaskViewToolbar: false,
    projectsAreaRendersCloudProjection: true,
  };
}

// ── 侧栏顶部「新建任务」入口的去向（03 §2 边界、04 §3.0）──
//
// 云入口里**不能**留指向本机执行域的入口：`NewTaskButtonGroup` 原先直接调用本机
// `onCreateTask`，在云模式下就是一条本机执行路径（03 §2 不变量 7）。
// 但也不隐藏它——04 §3.0 要求首页保留原有入口位置，新建任务本身就是云模式的正常动作。

export type CloudNewTaskAction =
  /** 本地 / SSH / 已配对远控：调用原有 `onCreateTask`。 */
  | { readonly kind: "local-create-task" }
  /** 云模式且还没有任何项目：先引导「添加仓库」（原 Dialog）。 */
  | { readonly kind: "request-add-repository" }
  /** 云模式且已有项目：打开云任务草稿 Dialog。 */
  | { readonly kind: "open-cloud-draft"; readonly projectId: string };

export function resolveCloudNewTaskAction(params: {
  readonly isCloudMode: boolean;
  /** 控制面 Project 投影（云模式下才有内容）。 */
  readonly projects: readonly { readonly projectId: string }[];
  /** 当前选中的项目；缺省时取第一个项目。 */
  readonly selectedProjectId: string | null;
}): CloudNewTaskAction {
  if (!params.isCloudMode) {
    return { kind: "local-create-task" };
  }
  if (params.projects.length === 0) {
    return { kind: "request-add-repository" };
  }
  const selected =
    params.selectedProjectId === null
      ? undefined
      : params.projects.find((project) => project.projectId === params.selectedProjectId);
  const target = selected ?? params.projects[0];
  // projects 非空时 target 必然存在（selected 命中或取首个）。
  return { kind: "open-cloud-draft", projectId: target?.projectId ?? "" };
}

export interface CloudNewTaskHandlers {
  /** 原回调：**只在 `local-create-task` 分支被调用**。 */
  readonly onCreateTask: () => void;
  readonly onRequestAddRepository: () => void;
  readonly onOpenCloudDraft: (projectId: string) => void;
}

/**
 * 按去向分派。抽成纯函数是为了能用 spy 直接断言「云模式下 `onCreateTask` 一次都没有被调用」，
 * 而不需要渲染整棵侧栏（侧栏依赖 `@/` 别名，node:test 加载不到）。
 */
export function dispatchCloudNewTaskAction(
  action: CloudNewTaskAction,
  handlers: CloudNewTaskHandlers,
): void {
  switch (action.kind) {
    case "local-create-task":
      handlers.onCreateTask();
      return;
    case "request-add-repository":
      handlers.onRequestAddRepository();
      return;
    case "open-cloud-draft":
      handlers.onOpenCloudDraft(action.projectId);
      return;
    default:
      return;
  }
}

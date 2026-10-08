/**
 * 工作区 drag region 规则（specs/cloud-agent/04 §3 2026-10-08 巡检修订）。
 *
 * 背景（2026-10-08 无头巡检实测缺陷）：云 Web 构建复用了桌面标题栏 drag region
 * （侧栏顶部的 `div.h-12 [app-region:drag]` 与 WorkspaceHeader 的 `[app-region:drag]`
 * 容器），而云 Web 没有原生窗口可拖动——这些层在浏览器里只是普通 div：
 * - `app-region` 属性在浏览器中是 no-op，不会带来任何收益；
 * - 它们作为实体层悬在顶部交互区（顶栏浮层按钮槽位）之上，命中测试
 *   （elementFromPoint）落在 drag 层而不是按钮，顶栏「New task」入口表现为
 *   「点了没反应」（P1）。
 *
 * 规则（纯函数，node:test 直接覆盖）：
 * - **drag region 只在桌面端渲染**：`[app-region:drag]` 仅对 Electron 窗口有意义；
 *   Web / 云 Web 一律不渲染 drag region（保留占位高度，布局不变）。
 * - **云入口的顶栏 New task 按钮始终可见**：桌面端依赖「侧栏可见 → 侧栏内入口」
 *   的互斥规则在云 Web 依然成立，但云 Web 的侧栏在窄视口会被自动收起且
 *   （修复前）没有抽屉入口，顶栏按钮成了唯一新建入口，不能沿用
 *   「侧栏可见即隐藏」的桌面规则。
 */
/** 桌面标题栏 drag region 的样式类；调用方按平台拼进 className。 */
export const WORKSPACE_DRAG_REGION_CLASS = "[app-region:drag]" as const;

/** 是否渲染 drag region：只有桌面端（Electron 窗口）需要可拖动标题栏。 */
export function shouldRenderWorkspaceDragRegion(isDesktop: boolean | undefined): boolean {
  return isDesktop === true;
}

/**
 * 顶栏浮层「New task」按钮可见性。
 *
 * - 桌面 / 本地 Web：沿用原规则（侧栏收起或文件树打开时露出）；
 * - 云入口：始终露出（04 §3 巡检修订——窄视口侧栏自动收起时它是唯一新建入口，
 *   按钮本身已由浮层交互容器 `pointer-events-auto + [app-region:no-drag]` 正确包裹）。
 */
export function resolveTopOverlayNewTaskVisibility(params: {
  readonly isCloudEntry: boolean;
  readonly isSidebarVisible: boolean;
  readonly isSidebarFileTreeOpen: boolean;
}): boolean {
  if (params.isCloudEntry) {
    return true;
  }
  return !params.isSidebarVisible || params.isSidebarFileTreeOpen;
}

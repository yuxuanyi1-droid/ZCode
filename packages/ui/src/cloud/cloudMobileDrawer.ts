/**
 * 云入口移动端侧栏抽屉规则（specs/cloud-agent/04 §3/§7 2026-10-08 巡检修订）。
 *
 * 背景（实测缺陷，375px 视口）：conversation 自动收起策略（360px 阈值）会把左侧栏
 * 收起，但收起后**没有任何再打开的入口**——桌面端靠 Windows/Linux 标题栏的 logo
 * 悬停按钮或 macOS 的侧栏按钮，云 Web 都没有，任务列表/新建入口在窄视口完全失联。
 *
 * 规则（纯函数，node:test 直接覆盖；只作用于**云入口**，桌面与本地 Web 布局语义不变）：
 * - 抽屉触发器（汉堡按钮）：云入口 && 侧栏处于收起态时渲染；宽视口（≥md）由 CSS
 *   （`md:hidden`）隐藏，不影响桌面布局；
 * - 抽屉打开：把**原侧栏面板**以浮层抽屉形态呈现（fixed + 顶部层级），不复制第二份
 *   侧栏组件与订阅；
 * - 侧栏可见（宽视口停靠态）时不提供触发器——侧栏本身可达，抽屉只会造成双入口；
 * - 跨回宽屏（≥md）时恢复停靠侧栏（`resolveCloudMobileSidebarDockedRestorePlan`）：
 *   云 Web 宽视口没有任何再展开入口，收起态跨回宽屏若不恢复即 0 宽死锁。
 */

/** 云入口抽屉面板宽度（CSS 值）：窄屏可用宽度的 85%，上限 20rem。 */
export const CLOUD_MOBILE_SIDEBAR_DRAWER_WIDTH = "min(85vw, 20rem)" as const;

export interface CloudMobileSidebarDrawerPlan {
  /** 是否渲染汉堡触发器（配合 `md:hidden` 使用）。 */
  readonly showsTrigger: boolean;
  /** 是否渲染遮罩（抽屉打开期间）。 */
  readonly showsBackdrop: boolean;
  /** 抽屉打开：原侧栏面板切换为浮层抽屉形态。 */
  readonly sidebarPanelOverlay: boolean;
  /** 抽屉形态下面板使用的宽度 CSS 值（覆盖 `--workspace-sidebar-panel-width`）。 */
  readonly sidebarPanelWidth: string | null;
}

export function resolveCloudMobileSidebarDrawerPlan(params: {
  /** 是否云入口（CloudWorkspaceProvider 是否挂载）。 */
  readonly isCloudEntry: boolean;
  /** 侧栏当前停靠可见性（收起态才需要触发器）。 */
  readonly isSidebarVisible: boolean;
  /** 抽屉开关状态。 */
  readonly open: boolean;
}): CloudMobileSidebarDrawerPlan {
  const showsTrigger = params.isCloudEntry && !params.isSidebarVisible;
  const sidebarPanelOverlay = params.isCloudEntry && params.open;
  return {
    showsTrigger,
    showsBackdrop: sidebarPanelOverlay,
    sidebarPanelOverlay,
    sidebarPanelWidth: sidebarPanelOverlay ? CLOUD_MOBILE_SIDEBAR_DRAWER_WIDTH : null,
  };
}

export type CloudMobileSidebarDockedRestorePlan =
  /** 不恢复：非云入口 / 窄视口 / 侧栏可见。 */
  | { readonly restoresDockedSidebar: false; readonly dockedSidebarWidthPx: null }
  /** 恢复停靠：宽度为记忆值或默认宽，永不为 0。 */
  | { readonly restoresDockedSidebar: true; readonly dockedSidebarWidthPx: number };

/**
 * 宽屏停靠恢复规则（2026-10-08 复检修订，P2）。
 *
 * 背景（实测缺陷）：云 Web 窄视口 conversation 自动收起侧栏后跨回宽屏（≥md），抽屉
 * 触发器随 `md:hidden` 消失、桌面标题栏的展开按钮在云 Web 不存在，侧栏停留在收起态
 * （`--workspace-sidebar-panel-width` 恒 0px）且没有任何再展开入口，只能刷新解锁。
 *
 * 规则（纯函数，node:test 直接覆盖；只作用于云入口）：
 * - 云入口 + 宽视口 + 侧栏收起 → 恢复停靠可见；
 * - 恢复宽度取收起前的记忆值（>0 有限数），无效/缺失回退默认宽，**永不为 0**
 *   （0 宽即上述死锁本身）；
 * - 非云入口 / 窄视口 / 侧栏可见 → 不恢复（桌面与本地 Web 布局语义不变）。
 */
export function resolveCloudMobileSidebarDockedRestorePlan(params: {
  /** 是否云入口。 */
  readonly isCloudEntry: boolean;
  /** 侧栏当前停靠可见性。 */
  readonly isSidebarVisible: boolean;
  /** 是否宽视口（≥md 断点，云 Web 该档位必须停靠可达）。 */
  readonly isWideViewport: boolean;
  /** 收起前记忆的停靠宽度（px）；缺失/非法时回退默认宽。 */
  readonly rememberedSidebarWidthPx: number | null;
  /** 调用方默认停靠宽度（px），作为记忆值无效时的回退。 */
  readonly fallbackSidebarWidthPx: number;
}): CloudMobileSidebarDockedRestorePlan {
  if (!params.isCloudEntry || params.isSidebarVisible || !params.isWideViewport) {
    return { restoresDockedSidebar: false, dockedSidebarWidthPx: null };
  }
  const remembered = params.rememberedSidebarWidthPx;
  const dockedSidebarWidthPx =
    typeof remembered === "number" && Number.isFinite(remembered) && remembered > 0
      ? remembered
      : // 兜底也防御性保证 > 0：0 宽恢复等于没修（见背景死锁）。
        Math.max(1, params.fallbackSidebarWidthPx);
  return { restoresDockedSidebar: true, dockedSidebarWidthPx };
}

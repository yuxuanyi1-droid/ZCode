/**
 * 云入口移动端侧栏抽屉规则用例（specs/cloud-agent/04 §7、2026-10-08 巡检修订）。
 *
 * 巡检缺陷（375px 视口）：conversation 自动收起侧栏后没有任何再打开入口
 * （桌面端靠 Windows/Linux/macOS 标题栏按钮，云 Web 都没有），任务列表失联。
 * 修复语义（resolveCloudMobileSidebarDrawerPlan，DOM 结构由组件按 plan 渲染）：
 * - 触发器只在云入口 + 侧栏收起态渲染（宽视口停靠态侧栏本身可达）；
 * - 抽屉打开时遮罩出现、侧栏面板切换为浮层形态并使用抽屉宽度；
 * - 非云入口（桌面 / 本地 Web）plan 全关，布局语义不变。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_MOBILE_SIDEBAR_DRAWER_WIDTH,
  resolveCloudMobileSidebarDockedRestorePlan,
  resolveCloudMobileSidebarDrawerPlan,
} from "../src/cloud/cloudMobileDrawer.js";

test("cloud entry with a collapsed sidebar exposes the drawer trigger", () => {
  const plan = resolveCloudMobileSidebarDrawerPlan({
    isCloudEntry: true,
    isSidebarVisible: false,
    open: false,
  });
  assert.equal(plan.showsTrigger, true);
  assert.equal(plan.showsBackdrop, false);
  assert.equal(plan.sidebarPanelOverlay, false);
  assert.equal(plan.sidebarPanelWidth, null);
});

test("cloud entry with a docked sidebar hides the trigger", () => {
  const plan = resolveCloudMobileSidebarDrawerPlan({
    isCloudEntry: true,
    isSidebarVisible: true,
    open: false,
  });
  assert.equal(plan.showsTrigger, false);
  assert.equal(plan.sidebarPanelOverlay, false);
});

test("open drawer repositions the existing sidebar panel as an overlay", () => {
  const plan = resolveCloudMobileSidebarDrawerPlan({
    isCloudEntry: true,
    isSidebarVisible: false,
    open: true,
  });
  assert.equal(plan.showsTrigger, true);
  assert.equal(plan.showsBackdrop, true);
  assert.equal(plan.sidebarPanelOverlay, true);
  assert.equal(plan.sidebarPanelWidth, CLOUD_MOBILE_SIDEBAR_DRAWER_WIDTH);
  assert.match(CLOUD_MOBILE_SIDEBAR_DRAWER_WIDTH, /^min\(85vw, 20rem\)$/);
});

test("non-cloud entries never get a drawer regardless of state", () => {
  for (const isSidebarVisible of [true, false]) {
    for (const open of [true, false]) {
      const plan = resolveCloudMobileSidebarDrawerPlan({
        isCloudEntry: false,
        isSidebarVisible,
        open,
      });
      assert.equal(plan.showsTrigger, false);
      assert.equal(plan.showsBackdrop, false);
      assert.equal(plan.sidebarPanelOverlay, false);
      assert.equal(plan.sidebarPanelWidth, null);
    }
  }
});

// 宽屏停靠恢复（2026-10-08 复检修订，P2）：云 Web 宽视口没有任何再展开侧栏的入口，
// 窄视口自动收起后跨回宽屏若不恢复停靠，--workspace-sidebar-panel-width 恒为 0px。
test("docked restore plan reopens a collapsed cloud sidebar on wide viewports with a non-zero width", () => {
  const plan = resolveCloudMobileSidebarDockedRestorePlan({
    isCloudEntry: true,
    isSidebarVisible: false,
    isWideViewport: true,
    rememberedSidebarWidthPx: 312,
    fallbackSidebarWidthPx: 264,
  });
  assert.equal(plan.restoresDockedSidebar, true);
  assert.equal(plan.dockedSidebarWidthPx, 312);
  assert.notEqual(plan.dockedSidebarWidthPx, 0);
});

test("docked restore plan falls back to the default width when the remembered width is missing or degenerate", () => {
  for (const rememberedSidebarWidthPx of [null, 0, -8, Number.NaN]) {
    const plan = resolveCloudMobileSidebarDockedRestorePlan({
      isCloudEntry: true,
      isSidebarVisible: false,
      isWideViewport: true,
      rememberedSidebarWidthPx,
      fallbackSidebarWidthPx: 264,
    });
    assert.equal(plan.restoresDockedSidebar, true);
    assert.equal(plan.dockedSidebarWidthPx, 264);
    assert.notEqual(plan.dockedSidebarWidthPx, 0);
  }
});

test("docked restore plan never restores outside the cloud entry, narrow viewports, or a visible sidebar", () => {
  const restoreSkipCases = [
    { isCloudEntry: false, isSidebarVisible: false, isWideViewport: true },
    { isCloudEntry: true, isSidebarVisible: false, isWideViewport: false },
    { isCloudEntry: true, isSidebarVisible: true, isWideViewport: true },
  ];
  for (const params of restoreSkipCases) {
    const plan = resolveCloudMobileSidebarDockedRestorePlan({
      ...params,
      rememberedSidebarWidthPx: 312,
      fallbackSidebarWidthPx: 264,
    });
    assert.equal(plan.restoresDockedSidebar, false);
    assert.equal(plan.dockedSidebarWidthPx, null);
  }
});

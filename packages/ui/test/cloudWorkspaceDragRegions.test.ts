/**
 * 工作区 drag region 与顶栏 New task 可见性规则用例
 * （specs/cloud-agent/04 §3 2026-10-08 巡检修订）。
 *
 * 巡检缺陷：云 Web 复用桌面 drag region（侧栏顶部 `h-12 [app-region:drag]` 与
 * WorkspaceHeader drag 容器），在浏览器里这些层悬在顶栏交互区之上，命中测试落在
 * drag 层而不是按钮——顶栏「New task」点击无响应。
 *
 * DOM 结构断言（elementFromPoint 语义的静态等价）：drag region 只在桌面端出现，
 * 因此任何非桌面渲染中，可交互元素之上不存在 drag 实体层；顶栏按钮由浮层的
 * `pointer-events-auto + [app-region:no-drag]` 容器包裹（DesktopTopOverlay 既有形态，
 * 返回/前进按钮即正确示例）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  shouldRenderWorkspaceDragRegion,
  resolveTopOverlayNewTaskVisibility,
  WORKSPACE_DRAG_REGION_CLASS,
} from "../src/app-shell/workspaceDragRegions.js";

test("drag regions render only on desktop", () => {
  assert.equal(shouldRenderWorkspaceDragRegion(true), true);
  assert.equal(shouldRenderWorkspaceDragRegion(false), false);
  assert.equal(shouldRenderWorkspaceDragRegion(undefined), false);
  // 侧栏/头部拼接用的类名保持单一来源，防止各处再手写字面量。
  assert.equal(WORKSPACE_DRAG_REGION_CLASS, "[app-region:drag]");
});

test("cloud entry always shows the top overlay new-task button", () => {
  // 窄视口侧栏会被 conversation 自动收起，顶栏按钮不能沿用「侧栏可见即隐藏」。
  assert.equal(
    resolveTopOverlayNewTaskVisibility({
      isCloudEntry: true,
      isSidebarVisible: true,
      isSidebarFileTreeOpen: false,
    }),
    true,
  );
  assert.equal(
    resolveTopOverlayNewTaskVisibility({
      isCloudEntry: true,
      isSidebarVisible: false,
      isSidebarFileTreeOpen: false,
    }),
    true,
  );
});

test("non-cloud entries keep the original desktop visibility rule", () => {
  assert.equal(
    resolveTopOverlayNewTaskVisibility({
      isCloudEntry: false,
      isSidebarVisible: true,
      isSidebarFileTreeOpen: false,
    }),
    false,
  );
  assert.equal(
    resolveTopOverlayNewTaskVisibility({
      isCloudEntry: false,
      isSidebarVisible: false,
      isSidebarFileTreeOpen: false,
    }),
    true,
  );
  assert.equal(
    resolveTopOverlayNewTaskVisibility({
      isCloudEntry: false,
      isSidebarVisible: true,
      isSidebarFileTreeOpen: true,
    }),
    true,
  );
});

/**
 * W8 云模式侧栏分区用例（specs/cloud-agent 04 §3.0/§3.0.1/§3.1）。
 *
 * 规范要的是**改造原项目区**，不是并列新增一套云导航：
 * - 云模式：侧栏只保留项目区，由它承载 Project → Task 投影；本地的任务区与
 *   分组/时间线/归档三种本地任务视图不再渲染（它们只会是「本地 CLI 的空任务区」）；
 * - 本地 / SSH / 已配对远控：分组顺序、视图模式、工具条逐项原样不变。
 *
 * 规则本体在 `cloudSidebarSections.ts`：侧栏组件依赖 `@/` 别名，`node --import tsx`
 * 从仓库根加载不到，因此判定逻辑抽成纯函数以便在此直接覆盖。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  dispatchCloudNewTaskAction,
  resolveCloudNewTaskAction,
  resolveCloudSidebarSectionPlan,
  type SidebarPurposeSectionId,
  type SidebarTaskViewMode,
} from "../src/cloud/cloudSidebarSections.js";

const BOTH_SECTIONS: readonly SidebarPurposeSectionId[] = ["projects", "conversations"];

test("cloud mode renders one projects area and no local task section", () => {
  const plan = resolveCloudSidebarSectionPlan({
    isCloudMode: true,
    purposeSectionOrder: BOTH_SECTIONS,
    taskViewMode: "workspace",
  });

  // 只保留项目区：本地的 "Tasks / No tasks yet" 区块不再并列渲染（04 §3.0.1）。
  assert.deepEqual(plan.purposeSectionOrder, ["projects"]);
  assert.equal(plan.purposeSectionOrder.includes("conversations"), false);
  // 项目区由云 Project → Task 投影承载（04 §3.0.1「原 sidebar 项目区域消费 Project → Task 投影」）。
  assert.equal(plan.projectsAreaRendersCloudProjection, true);
  // 工具条只驱动本地任务视图，云模式下不渲染（否则是点不动的死控件）。
  assert.equal(plan.showsLocalTaskViewToolbar, false);
});

test("cloud mode never falls back to a local task view", () => {
  const localModes: readonly SidebarTaskViewMode[] = ["grouped", "timeline", "archived"];
  for (const taskViewMode of localModes) {
    const plan = resolveCloudSidebarSectionPlan({
      isCloudMode: true,
      purposeSectionOrder: BOTH_SECTIONS,
      taskViewMode,
    });
    // 三种本地视图渲染的都是本地 CLI 任务区（空列表），云模式一律落到 workspace 视图。
    assert.equal(plan.taskViewMode, "workspace");
    assert.deepEqual(plan.purposeSectionOrder, ["projects"]);
  }
});

test("cloud mode keeps the projects area even if preferences dropped it", () => {
  const plan = resolveCloudSidebarSectionPlan({
    isCloudMode: true,
    purposeSectionOrder: ["conversations"],
    taskViewMode: "workspace",
  });
  // 云项目区是侧栏的主入口，偏好里缺失也要补上，否则用户看不到任何云项目。
  assert.deepEqual(plan.purposeSectionOrder, ["projects"]);
});

test("local mode is unchanged item by item", () => {
  for (const taskViewMode of ["grouped", "workspace", "timeline", "archived"] as const) {
    const plan = resolveCloudSidebarSectionPlan({
      isCloudMode: false,
      purposeSectionOrder: BOTH_SECTIONS,
      taskViewMode,
    });
    // 本地 / SSH / 已配对远控：分组顺序与视图模式原样透传，云分支一个都不加。
    assert.deepEqual(plan.purposeSectionOrder, BOTH_SECTIONS);
    assert.equal(plan.taskViewMode, taskViewMode);
    assert.equal(plan.showsLocalTaskViewToolbar, true);
    assert.equal(plan.projectsAreaRendersCloudProjection, false);
  }

  // 用户自定义顺序也原样保留（云分支不会重排本地模式）。
  const reordered: readonly SidebarPurposeSectionId[] = ["conversations", "projects"];
  const plan = resolveCloudSidebarSectionPlan({
    isCloudMode: false,
    purposeSectionOrder: reordered,
    taskViewMode: "workspace",
  });
  assert.deepEqual(plan.purposeSectionOrder, reordered);
});

// ── 顶部「新建任务」入口（03 §2 边界、04 §3.0）──
//
// 侧栏组件依赖 `@/` 别名、node:test 加载不到，因此用**分派器 + spy** 断言：
// 云模式下本机 `onCreateTask` 一次都不能被调用（那就是指向本机执行域的入口），
// 本地模式仍必须调用原回调。

function createSpyHandlers() {
  const calls = { local: 0, addRepository: 0, drafts: [] as string[] };
  return {
    calls,
    handlers: {
      onCreateTask: () => {
        calls.local += 1;
      },
      onRequestAddRepository: () => {
        calls.addRepository += 1;
      },
      onOpenCloudDraft: (projectId: string) => {
        calls.drafts.push(projectId);
      },
    },
  };
}

test("cloud mode never reaches the local onCreateTask, and drafts into the selected project", () => {
  const { calls, handlers } = createSpyHandlers();
  const action = resolveCloudNewTaskAction({
    isCloudMode: true,
    projects: [{ projectId: "p-1" }, { projectId: "p-2" }],
    selectedProjectId: "p-2",
  });
  dispatchCloudNewTaskAction(action, handlers);

  assert.equal(action.kind, "open-cloud-draft");
  assert.equal(calls.local, 0);
  assert.equal(calls.addRepository, 0);
  assert.deepEqual(calls.drafts, ["p-2"]);
});

test("cloud mode without any project guides to adding a repository first", () => {
  const { calls, handlers } = createSpyHandlers();
  dispatchCloudNewTaskAction(
    resolveCloudNewTaskAction({ isCloudMode: true, projects: [], selectedProjectId: null }),
    handlers,
  );

  assert.equal(calls.local, 0);
  assert.equal(calls.addRepository, 1);
  assert.deepEqual(calls.drafts, []);
});

test("cloud mode falls back to the first project when nothing is selected", () => {
  const { calls, handlers } = createSpyHandlers();
  dispatchCloudNewTaskAction(
    resolveCloudNewTaskAction({
      isCloudMode: true,
      projects: [{ projectId: "p-1" }, { projectId: "p-2" }],
      selectedProjectId: null,
    }),
    handlers,
  );
  assert.deepEqual(calls.drafts, ["p-1"]);
  assert.equal(calls.local, 0);
});

test("local mode still calls the original onCreateTask and nothing else", () => {
  const { calls, handlers } = createSpyHandlers();
  const action = resolveCloudNewTaskAction({
    isCloudMode: false,
    projects: [],
    selectedProjectId: null,
  });
  dispatchCloudNewTaskAction(action, handlers);

  assert.equal(action.kind, "local-create-task");
  // 本机回调必须被调用；云的两个去向一次都不能触发。
  assert.equal(calls.local, 1);
  assert.equal(calls.addRepository, 0);
  assert.deepEqual(calls.drafts, []);
});

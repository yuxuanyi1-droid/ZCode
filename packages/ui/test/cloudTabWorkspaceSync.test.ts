/**
 * 云任务 tab 的 checkout 路径同步用例（2026-10-08 巡检修订，P1）。
 *
 * 回归背景：run 的 `workspacePath` 在首发/重开后由控制面异步落定，tab 建立时持有
 * 空串路径且没有任何通道刷新它；pane scope 用空串路径发起 v4 订阅被 runtime zod 以
 * `workspace.workspacePath` too_small 拒绝（右侧渲染原始 issues JSON）。控制器在详情
 * 投影刷新时调用 `syncCloudTaskTabWorkspacePath`：按 `cloudTaskId` 匹配、只同步真实
 * 路径与标签、不抢激活。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createTabStore } from "../src/store/tabStore.js";

const TASK_ID = "4d090058-54c0-43a9-a470-b5b058a95808";
const IDENTITY = `cloud-task:${TASK_ID}`;

function createCloudTabStore(options?: { switchAway?: boolean }) {
  const store = createTabStore(null);
  const tabId = store.getState().openCloudTaskTab({
    cloudTaskId: TASK_ID,
    workspaceIdentity: IDENTITY,
    workspacePath: "",
    label: "draft title",
  });
  if (options?.switchAway) {
    // 切到另一个 workspace tab，模拟用户离开了云任务工作区。
    const otherId = store.getState().addTab("/home/user/other");
    store.getState().activateTab(otherId);
  }
  return { store, tabId };
}

test("syncs the settled run path into the existing cloud task tab", () => {
  const { store, tabId } = createCloudTabStore();
  store.getState().syncCloudTaskTabWorkspacePath({
    cloudTaskId: TASK_ID,
    workspacePath: "/workspace/repo",
    label: "run title",
  });

  const tab = store.getState().tabs.find((entry) => entry.id === tabId);
  assert.ok(tab && tab.kind === "workspace");
  assert.equal(tab.workspacePath, "/workspace/repo");
  assert.equal(tab.label, "run title");
  // 同步的是当前激活 tab：activeWorkspacePath 跟随（Root 据此下发 pane scope）。
  assert.equal(store.getState().activeWorkspacePath, "/workspace/repo");
});

test("does not steal activation when the cloud tab is not active", () => {
  const { store } = createCloudTabStore({ switchAway: true });
  store
    .getState()
    .syncCloudTaskTabWorkspacePath({ cloudTaskId: TASK_ID, workspacePath: "/workspace/repo" });

  const state = store.getState();
  const cloudTab = state.tabs.find(
    (entry) => entry.kind === "workspace" && entry.cloudTaskId === TASK_ID,
  );
  assert.ok(cloudTab);
  assert.equal(cloudTab.workspacePath, "/workspace/repo");
  // 激活态保持在本机 workspace：同步路径不是导航（openCloudTaskTab 才有激活语义）。
  assert.equal(state.activeWorkspacePath, "/home/user/other");
});

test("ignores empty paths and unknown tasks", () => {
  const { store, tabId } = createCloudTabStore();
  // 空串/空白路径不得把 tab 建立时的占位路径改写成「已落定」语义之外的值，
  // 也不得把已落定的路径改回空串（run 落定的路径不会撤销）。
  store.getState().syncCloudTaskTabWorkspacePath({ cloudTaskId: TASK_ID, workspacePath: "" });
  store.getState().syncCloudTaskTabWorkspacePath({ cloudTaskId: TASK_ID, workspacePath: "  " });

  const tab = store.getState().tabs.find((entry) => entry.id === tabId);
  assert.ok(tab && tab.kind === "workspace");
  assert.equal(tab.workspacePath, "");

  // 没有 tab 的任务（用户从未打开过工作区）：留给 openCloudTaskTab，不造 tab。
  const otherTaskId = "00000000-0000-4000-8000-000000000000";
  store
    .getState()
    .syncCloudTaskTabWorkspacePath({ cloudTaskId: otherTaskId, workspacePath: "/workspace/other" });
  assert.equal(
    store
      .getState()
      .tabs.some((entry) => entry.kind === "workspace" && entry.cloudTaskId === otherTaskId),
    false,
  );
});

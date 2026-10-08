/**
 * 云侧栏任务列表投影用例（specs/cloud-agent/04 §3.0/§3.0.1；2026-10-08 巡检修订）。
 *
 * 覆盖归档入口接线后的列表行为：
 * - 归档成功的任务从活动列表移出，进入独立的「已归档」分区投影（默认收起），
 *   归档不再是死胡同；
 * - 既有排序语义保持：草稿在前、其余按更新时间降序。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudTaskRecord } from "@zcode/shared";
import {
  projectCloudTasksForArchivedSection,
  projectCloudTasksForSidebar,
  sortCloudTasksForSidebar,
} from "../src/cloud/cloudSidebarTaskList.js";

function task(input: {
  taskId: string;
  status: CloudTaskRecord["status"];
  updatedAt?: number;
}): CloudTaskRecord {
  return {
    taskId: input.taskId,
    projectId: "p-1",
    status: input.status,
    title: input.taskId,
    workspaceIdentity: `cloud-task:${input.taskId}`,
    revision: 1,
    createdAt: 0,
    updatedAt: input.updatedAt ?? 0,
  };
}

test("archived tasks leave the active sidebar list", () => {
  const projected = projectCloudTasksForSidebar([
    task({ taskId: "draft-1", status: "draft" }),
    task({ taskId: "active-1", status: "active", updatedAt: 30 }),
    task({ taskId: "archived-1", status: "archived", updatedAt: 20 }),
    task({ taskId: "failed-1", status: "failed", updatedAt: 10 }),
  ]);
  assert.deepEqual(
    projected.map((item) => item.taskId),
    ["draft-1", "active-1", "failed-1"],
  );
});

test("draft first and newest first ordering is preserved", () => {
  const sorted = sortCloudTasksForSidebar([
    task({ taskId: "older-active", status: "active", updatedAt: 10 }),
    task({ taskId: "newer-active", status: "active", updatedAt: 40 }),
    task({ taskId: "draft-2", status: "draft", updatedAt: 5 }),
    task({ taskId: "draft-1", status: "draft", updatedAt: 50 }),
  ]);
  assert.deepEqual(
    sorted.map((item) => item.taskId),
    ["draft-1", "draft-2", "newer-active", "older-active"],
  );
});

test("projection keeps working states and tolerates an empty list", () => {
  assert.deepEqual(projectCloudTasksForSidebar([]), []);
  const projected = projectCloudTasksForSidebar([
    task({ taskId: "completed-1", status: "completed", updatedAt: 15 }),
    task({ taskId: "failed-1", status: "failed", updatedAt: 25 }),
  ]);
  assert.deepEqual(
    projected.map((item) => item.taskId),
    ["failed-1", "completed-1"],
  );
});

test("archived section projection holds only archived tasks, newest first", () => {
  // 巡检缺陷：API 同时返回 active + archived，但活动投影把 archived 全部滤掉且无归档
  // 视图——归档后任务在侧栏彻底不可见。归档分区投影必须完整接收这些行。
  const archived = projectCloudTasksForArchivedSection([
    task({ taskId: "active-1", status: "active", updatedAt: 40 }),
    task({ taskId: "archived-newer", status: "archived", updatedAt: 30 }),
    task({ taskId: "archived-older", status: "archived", updatedAt: 20 }),
    task({ taskId: "draft-1", status: "draft" }),
  ]);
  assert.deepEqual(
    archived.map((item) => item.taskId),
    ["archived-newer", "archived-older"],
  );
});

test("archived section projection is empty when nothing is archived", () => {
  assert.deepEqual(
    projectCloudTasksForArchivedSection([
      task({ taskId: "active-1", status: "active" }),
      task({ taskId: "draft-1", status: "draft" }),
    ]),
    [],
  );
  assert.deepEqual(projectCloudTasksForArchivedSection([]), []);
});

test("restore moves a task between the two sidebar projections", () => {
  // 恢复端点响应 detail 会合并回项目列表（revision 单调）：投影层表现为
  // 「archived 行离开归档分区、回到活动列表」——这是恢复成功的可见判据。
  const before = [task({ taskId: "t-1", status: "archived", updatedAt: 20 })];
  const after = [task({ taskId: "t-1", status: "active", updatedAt: 21 })];
  assert.equal(projectCloudTasksForArchivedSection(before).length, 1);
  assert.equal(projectCloudTasksForArchivedSection(after).length, 0);
  assert.deepEqual(
    projectCloudTasksForSidebar(after).map((item) => item.taskId),
    ["t-1"],
  );
});

/**
 * 云侧栏任务列表投影（specs/cloud-agent/04 §3.0/§3.0.1；2026-10-08 巡检修订）。
 *
 * 从 `CloudProjectTaskSection.tsx` 抽出的纯规则（原实现依赖 `@/` 别名，node:test
 * 加载不到，排序/过滤行为无法被用例覆盖）：
 * - 排序：草稿在前、其余按更新时间降序（沿用任务列表习惯）；
 * - 过滤：归档任务**不进活动列表**，而是进入独立的「已归档」分区
 *   （`projectCloudTasksForArchivedSection`，默认收起、行内可恢复）——此前归档任务
 *   被直接滤掉且没有任何归档视图，归档即死胡同（巡检实测缺陷）。
 */
import type { CloudTaskRecord } from "@zcode/shared";

/** 供测试与调用方复用的排序：草稿在前、其余按更新时间降序（沿用任务列表习惯）。 */
export function sortCloudTasksForSidebar(
  tasks: readonly CloudTaskRecord[],
): readonly CloudTaskRecord[] {
  return [...tasks].sort((a, b) => {
    if (a.status === "draft" && b.status !== "draft") {
      return -1;
    }
    if (b.status === "draft" && a.status !== "draft") {
      return 1;
    }
    return b.updatedAt - a.updatedAt;
  });
}

/** 侧栏活动列表投影：过滤已归档任务后按侧栏规则排序。 */
export function projectCloudTasksForSidebar(
  tasks: readonly CloudTaskRecord[],
): readonly CloudTaskRecord[] {
  return sortCloudTasksForSidebar(tasks.filter((task) => task.status !== "archived"));
}

/**
 * 侧栏「已归档」分区投影（04 §3 2026-10-08 巡检修订）。
 *
 * 背景（实测缺陷）：控制面列表同时返回 active + archived，但活动投影把 archived
 * 全部滤掉且没有归档视图——归档即死胡同，任务无法恢复。归档任务单独成分区
 * （默认收起，头部显示数量），行内提供恢复入口。
 * 排序按更新时间降序（归档没有 draft 语义）。
 */
export function projectCloudTasksForArchivedSection(
  tasks: readonly CloudTaskRecord[],
): readonly CloudTaskRecord[] {
  return tasks
    .filter((task) => task.status === "archived")
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * 云任务主路由失败判定用例（specs/cloud-agent/04 §5、2026-10-08 巡检修订）。
 *
 * 巡检缺陷：`?task=<合法但不存在的 UUID>` 通过入口 id 校验后，详情 GET 404，
 * UI 静默回落欢迎页（URL 仍带 ?task=，无提示），且多个订阅方各自重发 404 请求。
 * 修复语义（resolveCloudTaskRouteFailure）：
 * - 主路由指向的任务 not_found → task-not-found（入口渲染整页错误屏）；
 * - 应用内导航选中其他任务、加载中/成功、非 not_found 错误 → 不升级（null）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolveCloudTaskRouteFailure } from "../src/cloud/cloudTaskRoute.js";

const TASK_ID = "4d090058-1111-4222-8333-444455556666";

test("routed task failing with not_found escalates to the error screen", () => {
  assert.deepEqual(
    resolveCloudTaskRouteFailure({
      bootstrappedTaskId: TASK_ID,
      selectionTaskId: TASK_ID,
      taskDetailStatus: "error",
      taskDetailErrorCode: "not_found",
    }),
    { reason: "task-not-found" },
  );
});

test("non-routed selections never escalate", () => {
  // 应用内导航选中其他任务时由打开路径自己提示，不替换整页。
  assert.equal(
    resolveCloudTaskRouteFailure({
      bootstrappedTaskId: undefined,
      selectionTaskId: TASK_ID,
      taskDetailStatus: "error",
      taskDetailErrorCode: "not_found",
    }),
    null,
  );
  assert.equal(
    resolveCloudTaskRouteFailure({
      bootstrappedTaskId: TASK_ID,
      selectionTaskId: "other-task-id",
      taskDetailStatus: "error",
      taskDetailErrorCode: "not_found",
    }),
    null,
  );
});

test("loading, ready and missing-detail states never escalate", () => {
  for (const status of ["idle", "loading", "ready"] as const) {
    assert.equal(
      resolveCloudTaskRouteFailure({
        bootstrappedTaskId: TASK_ID,
        selectionTaskId: TASK_ID,
        taskDetailStatus: status,
        taskDetailErrorCode: null,
      }),
      null,
    );
  }
  // 错误态但详情还没给出结论（无结构化码）：等待，不猜成 not_found。
  assert.equal(
    resolveCloudTaskRouteFailure({
      bootstrappedTaskId: TASK_ID,
      selectionTaskId: TASK_ID,
      taskDetailStatus: "error",
      taskDetailErrorCode: null,
    }),
    null,
  );
});

test("only not_found escalates: transport failures stay in-page", () => {
  // 网络类失败（backend-unreachable 等）不是「任务不存在」的证据，
  // 交给页面内错误态，不把暂时不可达误报成 not-found 错误屏。
  assert.equal(
    resolveCloudTaskRouteFailure({
      bootstrappedTaskId: TASK_ID,
      selectionTaskId: TASK_ID,
      taskDetailStatus: "error",
      taskDetailErrorCode: "network_unknown",
    }),
    null,
  );
});

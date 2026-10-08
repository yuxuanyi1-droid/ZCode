/**
 * 云任务生命周期动作分派用例（specs/cloud-agent/04 §6、03 §6）。
 *
 * 覆盖 2026-10-08 实测缺陷「归档按钮不工作」的核心接线语义：
 * - 归档必须打到独立端点 `port.archiveTask(taskId)`，绝不走 `patchTask`（04 §6：
 *   归档不走 PATCH status）；
 * - 服务端错误信封原样抛回，`describeCloudSubmissionError` 能把 code/message 归一成
 *   UI 可呈现的文案——之前 Header 链路 `.then` 无 `.catch`，失败被整体吞掉；
 * - stop/complete/restore 各自路由到对应端点（与归档同一条分派路径）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskDetailResponse } from "@zcode/shared";
import {
  runCloudTaskLifecycleAction,
  type CloudTaskLifecycleAction,
  type CloudTaskLifecyclePort,
} from "../src/cloud/cloudTaskLifecycle.js";
import { describeCloudSubmissionError } from "../src/cloud/cloudTaskSubmission.js";

const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";

function detailResponse(): TaskDetailResponse {
  return {
    task: {
      taskId: TASK_ID,
      projectId: "p-1",
      status: "archived",
      title: "示例任务",
      workspaceIdentity: `cloud-task:${TASK_ID}`,
      archivedFromStatus: "active",
      revision: 4,
      createdAt: 0,
      updatedAt: 0,
    },
    actions: [],
  };
}

interface RecordedPort {
  readonly port: CloudTaskLifecyclePort;
  readonly calls: string[];
}

function createRecordingPort(): RecordedPort {
  const calls: string[] = [];
  const port = {
    stopTask: async (taskId: string) => {
      calls.push(`stop:${taskId}`);
      return detailResponse();
    },
    completeTask: async (taskId: string) => {
      calls.push(`complete:${taskId}`);
      return detailResponse();
    },
    archiveTask: async (taskId: string) => {
      calls.push(`archive:${taskId}`);
      return detailResponse();
    },
    restoreTask: async (taskId: string) => {
      calls.push(`restore:${taskId}`);
      return detailResponse();
    },
  };
  return { port, calls };
}

test("archive dispatches to the dedicated archive endpoint and never to patchTask", async () => {
  const { port, calls } = createRecordingPort();
  const detail = await runCloudTaskLifecycleAction(port, TASK_ID, "archive");
  assert.deepEqual(calls, [`archive:${TASK_ID}`]);
  // 响应即归档后的权威详情：调用方直接写回唯一投影（useCloudTask.applyDetail）。
  assert.equal(detail.task.status, "archived");
});

test("stop, complete and restore route to their own endpoints", async () => {
  const actions: readonly CloudTaskLifecycleAction[] = ["stop", "complete", "restore"];
  const { port, calls } = createRecordingPort();
  for (const action of actions) {
    await runCloudTaskLifecycleAction(port, TASK_ID, action);
  }
  assert.deepEqual(calls, [`stop:${TASK_ID}`, `complete:${TASK_ID}`, `restore:${TASK_ID}`]);
});

test("archive rejection propagates the server error envelope for UI feedback", async () => {
  // 形状对齐 SDK 的 CloudApiError（code + retryable + message）：服务端对
  // active + 运行中 run 的归档请求返回 invalid_state 类 4xx。
  const rejection = Object.assign(new Error("task has a running run"), {
    code: "validation_failed",
    retryable: false,
    httpStatus: 409,
  });
  const port = {
    ...createRecordingPort().port,
    archiveTask: async () => {
      throw rejection;
    },
  };
  await assert.rejects(
    runCloudTaskLifecycleAction(port, TASK_ID, "archive"),
    (error: unknown) => error === rejection,
  );
  // 归一后的文案可被 toast/banner 直接呈现，不再被静默吞掉。
  assert.equal(describeCloudSubmissionError(rejection), "validation_failed");
});

test("non-envelope failures still normalize to a readable message", async () => {
  const port = {
    ...createRecordingPort().port,
    archiveTask: async () => {
      throw new Error("socket hang up");
    },
  };
  await assert.rejects(runCloudTaskLifecycleAction(port, TASK_ID, "archive"));
  assert.equal(describeCloudSubmissionError(new Error("socket hang up")), "socket hang up");
});

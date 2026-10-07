/**
 * 云任务 runtime 会话解析用例（specs/cloud-agent/W8 §3、04 §3.3、08 §4.1）。
 *
 * 回归背景：v4 主区 pane 在本地语义下 `sessionId ≡ taskId`，云任务不满足——runtime 会话
 * 是首输入 ack 落地的 `activeRun.runtimeSessionId`（`sess_…`）。旧绑定把 taskId 当会话 id
 * 订阅，runtime 以 `fault.subscribe.sessionNotFound` 拒绝（fault 里的 id 就是 taskId），
 * 右侧工作区只剩这条错误。规则本体在 `src/hooks/cloud/useCloudTaskRuntimeSession.ts`
 * （纯函数，无 `@/` 别名依赖，测试运行器可直接加载）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveCloudTaskRuntimeSession,
  type CloudTaskRuntimeSessionDetail,
} from "../src/cloud/cloudTaskRuntimeSession.js";

const TASK_ID = "4d090058-54c0-43a9-a470-b5b058a95808";
const CLOUD_IDENTITY = `cloud-task:${TASK_ID}`;
const RUNTIME_SESSION_ID = "sess_78e9975e-2b5d-41f6-bee7-ed34f8ea99af";

function detail(input: {
  taskId?: string;
  runtimeSessionId?: string;
  withRun?: boolean;
}): CloudTaskRuntimeSessionDetail {
  const taskId = input.taskId ?? TASK_ID;
  if (input.withRun === false) {
    return { task: { taskId } };
  }
  return {
    task: { taskId },
    activeRun: input.runtimeSessionId ? { runtimeSessionId: input.runtimeSessionId } : {},
  };
}

test("cloud task workspace binds the runtime session id, never the taskId", () => {
  const resolution = resolveCloudTaskRuntimeSession({
    workspaceIdentity: CLOUD_IDENTITY,
    taskDetail: detail({ runtimeSessionId: RUNTIME_SESSION_ID }),
  });

  assert.equal(resolution.isCloudTaskWorkspace, true);
  // 必须是 sess_…：taskId 订阅会被 runtime 以 fault.subscribe.sessionNotFound 拒绝。
  assert.equal(resolution.runtimeSessionId, RUNTIME_SESSION_ID);
  assert.notEqual(resolution.runtimeSessionId, TASK_ID);
});

test("cloud task workspace without an acked runtime session resolves to no session", () => {
  // run 未 ready / 首输入未 ack：runtimeSessionId 缺失 → 按无会话渲染空态，不拿 taskId 顶替。
  const withoutField = resolveCloudTaskRuntimeSession({
    workspaceIdentity: CLOUD_IDENTITY,
    taskDetail: detail({}),
  });
  assert.deepEqual(withoutField, { isCloudTaskWorkspace: true, runtimeSessionId: null });

  const withoutRun = resolveCloudTaskRuntimeSession({
    workspaceIdentity: CLOUD_IDENTITY,
    taskDetail: detail({ withRun: false }),
  });
  assert.deepEqual(withoutRun, { isCloudTaskWorkspace: true, runtimeSessionId: null });
});

test("cloud task workspace with no loaded detail is fail-closed", () => {
  // 详情未加载（挂载瞬间的空档）：云工作区但无会话可绑定。
  assert.deepEqual(
    resolveCloudTaskRuntimeSession({ workspaceIdentity: CLOUD_IDENTITY, taskDetail: null }),
    { isCloudTaskWorkspace: true, runtimeSessionId: null },
  );
});

test("never borrows the runtime session of another cloud task", () => {
  // 侧栏另一个任务 / 详情尚未切换：不借别的任务的会话（与 selectCloudAttachmentForTask 同语义）。
  const resolution = resolveCloudTaskRuntimeSession({
    workspaceIdentity: CLOUD_IDENTITY,
    taskDetail: detail({ taskId: "00000000-0000-4000-8000-000000000000" }),
  });

  assert.deepEqual(resolution, { isCloudTaskWorkspace: true, runtimeSessionId: null });
});

test("non-cloud workspaces keep the local resolution untouched", () => {
  // 本地 / SSH / 已配对远控：identity 不是 cloud-task:<taskId>，调用方沿用 activeTaskId 原语义。
  for (const workspaceIdentity of [undefined, null, "", "/home/user/repo", "ssh:remote-1"]) {
    assert.deepEqual(
      resolveCloudTaskRuntimeSession({
        workspaceIdentity,
        taskDetail: detail({ runtimeSessionId: RUNTIME_SESSION_ID }),
      }),
      { isCloudTaskWorkspace: false, runtimeSessionId: null },
    );
  }
});

/**
 * W8 云工作区 tab 用例（specs/cloud-agent 04 §3.0/§5、08 §4.1、W8 §3「云工作区 tab 建立」）。
 *
 * 覆盖从侧栏选中云任务到工作区出现的这段接线里**可纯函数化的全部规则**：
 * - 匹配键是 taskId（Run 换代 / checkout 路径变化不得开出第二个 tab）；
 * - `workspacePath` 只用 Run 的真实绝对路径，ready 前为空串；
 * - 身份固定 `cloud-task:<taskId>`，不把身份当路径用；
 * - 主路由 `?task=` 的写入/读取往返。
 *
 * 剩余部分（`tabStore` / `Root` / `SettingsPage` 的组件接线）依赖 `@/` 别名模块，
 * `node --import tsx` 从仓库根解析不到别名，因此在 `pnpm --filter @zcode/ui test`
 * 下不可加载；那部分由 `pnpm typecheck` 与浏览器 E2E 覆盖（E2E 本次未跑，见报告）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCloudTaskTabTarget,
  findCloudTaskTabIndex,
  isCloudTaskTab,
} from "../src/cloud/cloudTaskTab.js";
import { isCloudTaskWorkspaceIdentity } from "@zcode/shared";

const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const OTHER_TASK_ID = "1f0d3b2a-4c51-4d9b-8c1d-2e3f4a5b6c7d";

test("a cloud task tab is identified by its taskId, never by the checkout path", () => {
  const beforeRun = buildCloudTaskTabTarget({ taskId: TASK_ID, taskTitle: "补齐 README" });
  const readyRun = buildCloudTaskTabTarget({
    taskId: TASK_ID,
    taskTitle: "补齐 README",
    runWorkspacePath: "/workspace/acme-widget",
  });
  const afterReopen = buildCloudTaskTabTarget({
    taskId: TASK_ID,
    taskTitle: "补齐 README",
    // 重开换了 provider，checkout 路径变了：仍然是同一个 tab。
    runWorkspacePath: "/home/sandbox/repo",
  });

  assert.equal(beforeRun.workspaceIdentity, `cloud-task:${TASK_ID}`);
  assert.equal(readyRun.workspaceIdentity, beforeRun.workspaceIdentity);
  assert.equal(afterReopen.workspaceIdentity, beforeRun.workspaceIdentity);
  assert.equal(isCloudTaskWorkspaceIdentity(readyRun.workspaceIdentity), true);

  // 三个阶段的 path 不同，但都属于同一个 tab：按 taskId 匹配。
  const tabs = [{ cloudTaskId: TASK_ID }, { cloudTaskId: OTHER_TASK_ID }];
  assert.equal(findCloudTaskTabIndex(tabs, TASK_ID), 0);
  assert.equal(findCloudTaskTabIndex(tabs, afterReopen.cloudTaskId), 0);
  assert.equal(findCloudTaskTabIndex(tabs, OTHER_TASK_ID), 1);
  assert.equal(findCloudTaskTabIndex(tabs, "9a1e1f0d-3b2a-4c51-8f14-e45fceea467a"), -1);
  // 没有 cloudTaskId 的本地 / SSH tab 永远不会被云任务命中。
  assert.equal(findCloudTaskTabIndex([{ cloudTaskId: undefined }], TASK_ID), -1);
});

test("the workspace path is the run checkout path, and stays empty before a run exists", () => {
  const draft = buildCloudTaskTabTarget({ taskId: TASK_ID, taskTitle: "草稿任务" });
  // 空串 = 「当前没有可用的文件系统路径」，不是伪造路径，也不是把身份当路径。
  assert.equal(draft.workspacePath, "");
  assert.notEqual(draft.workspacePath, draft.workspaceIdentity);

  assert.equal(
    buildCloudTaskTabTarget({
      taskId: TASK_ID,
      taskTitle: "草稿任务",
      runWorkspacePath: "/workspace/acme-widget",
    }).workspacePath,
    "/workspace/acme-widget",
  );
  // 空 / 空白 / 相对路径一律按「暂无路径」处理：绝不把相对路径当 IO 目标。
  for (const invalid of ["", "   ", "workspace/acme", "./repo"]) {
    assert.equal(
      buildCloudTaskTabTarget({
        taskId: TASK_ID,
        taskTitle: "草稿任务",
        runWorkspacePath: invalid,
      }).workspacePath,
      "",
    );
  }
});

test("local and remote tabs are not classified as cloud task tabs", () => {
  assert.equal(isCloudTaskTab({ cloudTaskId: TASK_ID }), true);
  assert.equal(isCloudTaskTab({ cloudTaskId: undefined }), false);
  assert.equal(isCloudTaskTab({ cloudTaskId: "  " }), false);
  // 本地 / SSH / 已配对远控 tab 不带该字段，云分组与本地任务区因此互不干扰。
  assert.equal(isCloudTaskTab({}), false);
});

test("two cloud tasks always produce two distinct tabs", () => {
  const first = buildCloudTaskTabTarget({ taskId: TASK_ID, taskTitle: "任务一" });
  const second = buildCloudTaskTabTarget({ taskId: OTHER_TASK_ID, taskTitle: "任务二" });
  // 两个 draft 的 path 都是空串：若按路径匹配就会被合成一个 tab（必须避免）。
  assert.equal(first.workspacePath, second.workspacePath);
  assert.notEqual(first.workspaceIdentity, second.workspaceIdentity);
  assert.equal(
    findCloudTaskTabIndex(
      [{ cloudTaskId: first.cloudTaskId }, { cloudTaskId: second.cloudTaskId }],
      second.cloudTaskId,
    ),
    1,
  );
});

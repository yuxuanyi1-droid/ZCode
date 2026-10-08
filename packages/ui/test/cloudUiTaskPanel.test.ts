/**
 * 云任务运行面板投影用例（specs/cloud-agent/04 §3.3、08 §9；2026-10-08 巡检修订）。
 *
 * 覆盖 2026-10-08 实测缺陷「run 失败 UI 无呈现」的修复语义：
 * - failed run → ended 视图携带 lastError（shared 契约驼峰字段）/endReason；
 * - provisioning / 无 run 的 active → 进行中提示视图；draft/archived/ready → hidden；
 * - 重开 resume 模式按持久事实自动选择：saved checkpoint → checkpoint，否则
 *   restart-from-base；可用性只认服务端 actions 投影；
 * - 归档/恢复入口可用性同样只认 actions 投影（04 §3.3：缺省 = 无动作）；
 * - 巡检修订：云任务 Header 标题回落控制面投影（本地 meta 恒为空）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isCloudTaskArchiveActionAvailable,
  isCloudTaskForceStopActionAvailable,
  isCloudTaskRestoreActionAvailable,
  projectCloudTaskRunPanel,
  resolveCloudReopenPlan,
  resolveCloudTaskHeaderTitle,
  type CloudTaskPanelDetail,
} from "../src/cloud/cloudTaskPanel.js";

function detail(input: {
  taskStatus?: string;
  runStatus?: string;
  lastError?: string;
  endReason?: string;
  checkpointState?: string;
  actions?: readonly string[];
  provider?: string;
}): CloudTaskPanelDetail {
  return {
    task: {
      status: input.taskStatus ?? "active",
      revision: 7,
      ...(input.provider === undefined && input.runStatus === undefined
        ? {}
        : {
            draftStartConfig:
              input.provider === undefined ? undefined : { provider: input.provider },
          }),
    },
    ...(input.runStatus === undefined
      ? {}
      : {
          activeRun: {
            status: input.runStatus,
            ...(input.lastError === undefined ? {} : { lastError: input.lastError }),
            ...(input.endReason === undefined ? {} : { endReason: input.endReason }),
            ...(input.provider === undefined ? {} : { provider: input.provider }),
          },
        }),
    ...(input.checkpointState === undefined
      ? {}
      : { latestCheckpoint: { state: input.checkpointState } }),
    ...(input.actions === undefined ? {} : { actions: input.actions }),
  };
}

test("failed run projects an ended view carrying the failure reason", () => {
  const view = projectCloudTaskRunPanel(
    detail({
      runStatus: "failed",
      lastError: "e2b sandbox rejected: no capacity in region",
      endReason: "provider_error",
    }),
  );
  assert.equal(view.kind, "ended");
  if (view.kind !== "ended") {
    return;
  }
  assert.equal(view.runStatus, "failed");
  assert.equal(view.lastError, "e2b sandbox rejected: no capacity in region");
  assert.equal(view.endReason, "provider_error");
});

test("failed run without lastError still surfaces the end reason", () => {
  const view = projectCloudTaskRunPanel(
    detail({ runStatus: "failed", endReason: "provider_error" }),
  );
  assert.equal(view.kind, "ended");
  if (view.kind !== "ended") {
    return;
  }
  assert.equal(view.lastError, null);
  assert.equal(view.endReason, "provider_error");
});

test("stopped and expired runs project the ended view; provisioning shows progress", () => {
  const stopped = projectCloudTaskRunPanel(detail({ runStatus: "stopped" }));
  assert.equal(stopped.kind, "ended");
  const expired = projectCloudTaskRunPanel(detail({ runStatus: "expired" }));
  assert.equal(expired.kind, "ended");

  const provisioning = projectCloudTaskRunPanel(detail({ runStatus: "provisioning" }));
  assert.deepEqual(provisioning, { kind: "provisioning" });

  // active 但投影里还没有 run：202 后的事务窗口，呈现等待而不是空白。
  const waiting = projectCloudTaskRunPanel(detail({}));
  assert.deepEqual(waiting, { kind: "waiting-for-run" });
});

test("draft, archived and working run states stay hidden", () => {
  assert.deepEqual(projectCloudTaskRunPanel(detail({ taskStatus: "draft" })), { kind: "hidden" });
  assert.deepEqual(projectCloudTaskRunPanel(detail({ taskStatus: "archived" })), {
    kind: "hidden",
  });
  assert.deepEqual(projectCloudTaskRunPanel(detail({ taskStatus: "active", runStatus: "ready" })), {
    kind: "hidden",
  });
  assert.deepEqual(
    projectCloudTaskRunPanel(detail({ taskStatus: "active", runStatus: "disconnected" })),
    {
      kind: "hidden",
    },
  );
  assert.deepEqual(projectCloudTaskRunPanel(null), { kind: "hidden" });
});

test("draining run projects the stopping view (2026-10-08 巡检修订 P1)", () => {
  // stop 端点受理后 run 进入 draining：此前面板对 draining 一律 hidden，用户只看到
  // composer 永远「Working for Ns」。现在呈现「正在停止」视图，供横幅接线。
  assert.deepEqual(projectCloudTaskRunPanel(detail({ runStatus: "draining" })), {
    kind: "draining",
  });
  // draft/archived 仍然隐藏（无 run 语义）。
  assert.deepEqual(
    projectCloudTaskRunPanel(detail({ taskStatus: "draft", runStatus: "draining" })),
    { kind: "hidden" },
  );
});

test("force-stop availability comes only from the server actions projection", () => {
  // actions 未给出 / 不含 force-stop：入口不可用（08 §8.2：普通 stop 失败也不自动升级）。
  assert.equal(isCloudTaskForceStopActionAvailable(null), false);
  assert.equal(isCloudTaskForceStopActionAvailable(detail({ runStatus: "draining" })), false);
  assert.equal(
    isCloudTaskForceStopActionAvailable(
      detail({ runStatus: "draining", actions: ["send-input", "archive"] }),
    ),
    false,
  );
  // 服务端给出 force-stop（存在未终态 run 时）：入口可用。
  assert.equal(
    isCloudTaskForceStopActionAvailable(detail({ runStatus: "draining", actions: ["force-stop"] })),
    true,
  );
});

test("reopen resume mode follows the persisted checkpoint fact", () => {
  // saved checkpoint（必须有远端 SHA 证据）→ checkpoint 恢复。
  const withCheckpoint = resolveCloudReopenPlan(
    detail({ runStatus: "failed", checkpointState: "saved", actions: ["reopen"] }),
  );
  assert.deepEqual(withCheckpoint.resume, { mode: "checkpoint" });
  assert.equal(withCheckpoint.hasSavedCheckpoint, true);

  // pending/saving/failed/none 都不是可恢复事实 → restart-from-base。
  for (const state of ["none", "pending", "saving", "failed"]) {
    const plan = resolveCloudReopenPlan(detail({ runStatus: "failed", checkpointState: state }));
    assert.deepEqual(plan.resume, { mode: "restart-from-base" }, state);
    assert.equal(plan.hasSavedCheckpoint, false);
  }
  // 完全没有 checkpoint 记录同样 restart-from-base。
  assert.deepEqual(resolveCloudReopenPlan(detail({ runStatus: "failed" })).resume, {
    mode: "restart-from-base",
  });
});

test("reopen availability comes only from the server actions projection", () => {
  // actions 未给出（缺省空集合）：无动作可用，不按状态猜（04 §3.3）。
  assert.equal(resolveCloudReopenPlan(detail({ runStatus: "failed" })).available, false);
  assert.equal(
    resolveCloudReopenPlan(detail({ runStatus: "failed", actions: ["send-input"] })).available,
    false,
  );
  assert.equal(
    resolveCloudReopenPlan(detail({ runStatus: "failed", actions: ["reopen", "archive"] }))
      .available,
    true,
  );
});

test("reopen provider prefers the run fact and falls back to the saved draft config", () => {
  const fromRun = resolveCloudReopenPlan(
    detail({ runStatus: "failed", provider: "e2b", actions: ["reopen"] }),
  );
  assert.equal(fromRun.provider, "e2b");
  const fromDraft = resolveCloudReopenPlan(
    detail({ runStatus: "stopped", provider: "modal", actions: ["reopen"] }),
  );
  assert.equal(fromDraft.provider, "modal");
  assert.equal(
    resolveCloudReopenPlan(detail({ runStatus: "stopped", actions: ["reopen"] })).provider,
    null,
  );
});

test("archive availability comes only from the server actions projection", () => {
  assert.equal(isCloudTaskArchiveActionAvailable(null), false);
  assert.equal(isCloudTaskArchiveActionAvailable({ actions: [] }), false);
  // active + 终态 run 可归档、draft/completed/failed 可归档都由服务端投影表达，
  // UI 侧不自行按状态开洞。
  assert.equal(isCloudTaskArchiveActionAvailable({ actions: ["stop", "archive"] }), true);
});

test("restore availability comes only from the server actions projection", () => {
  // 巡检修订：恢复入口与归档对称（03 §6：restore 对 active 返回
  // task-not-restorable，服务端裁决），不按「status === archived」本地猜。
  assert.equal(isCloudTaskRestoreActionAvailable(null), false);
  assert.equal(isCloudTaskRestoreActionAvailable({ actions: [] }), false);
  assert.equal(isCloudTaskRestoreActionAvailable({ actions: ["archive"] }), false);
  assert.equal(isCloudTaskRestoreActionAvailable({ actions: ["restore"] }), true);
});

test("workspace header title prefers local meta and falls back to the cloud projection", () => {
  // 巡检缺陷：云任务不在本机 CLI 任务索引，本地 meta 恒为空，Header 一直显示
  // 「新任务」占位。修复语义：本地标题优先 → 云标题 → 占位。
  assert.equal(
    resolveCloudTaskHeaderTitle({
      localTitle: "本地标题",
      cloudTitle: "云标题",
      fallbackTitle: "占位",
    }),
    "本地标题",
  );
  assert.equal(
    resolveCloudTaskHeaderTitle({
      localTitle: "  ",
      cloudTitle: "云任务标题",
      fallbackTitle: "占位",
    }),
    "云任务标题",
  );
  assert.equal(
    resolveCloudTaskHeaderTitle({ localTitle: null, cloudTitle: null, fallbackTitle: "占位" }),
    "占位",
  );
});

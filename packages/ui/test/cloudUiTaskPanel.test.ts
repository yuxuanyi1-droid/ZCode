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
  resolveCloudComposerSendPlan,
  resolveCloudReopenPlan,
  resolveCloudReopenRetryPlan,
  resolveCloudTaskArchiveAdmission,
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

test("paused run projects the paused view (2026-10-09 生命周期 v2)", () => {
  // 暂停保留中：独立视图（横幅「发送消息即可恢复」+ composer 可用），不是终态、
  // 不呈现重开；能力位 none 的 provider 后端本就不会报 paused（fail-closed 无投影）。
  assert.deepEqual(projectCloudTaskRunPanel(detail({ runStatus: "paused" })), { kind: "paused" });
  // draft/archived 仍然隐藏（无 run 语义）。
  assert.deepEqual(projectCloudTaskRunPanel(detail({ taskStatus: "draft", runStatus: "paused" })), {
    kind: "hidden",
  });
  // composer 发送路由：paused 的 run 是有效 append 目标（服务端按 03 §6 修订接受）。
  const plan = resolveCloudComposerSendPlan({
    task: { status: "active", revision: 4, draftStartConfig: undefined },
    activeRun: { runGeneration: 1 },
    isSelectedTask: true,
  });
  assert.deepEqual(plan, { kind: "append", expectedRunGeneration: 1 });
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

// 2026-10-07 终验缺陷 E：无缓存详情的侧栏行点击归档后必被服务端 409
// `not_ready/task-has-active-run` 拒绝。准入预检：有缓存详情按缓存裁决；
// 无缓存详情点击时拉一次详情再裁决；详情拉不到回落服务端裁决（unknown）。
test("archive admission judges from cached detail without an extra fetch", async () => {
  let fetches = 0;
  const admission = await resolveCloudTaskArchiveAdmission({
    cachedDetail: { actions: ["stop"] },
    loadDetail: () => {
      fetches += 1;
      return Promise.resolve({ actions: ["stop"] });
    },
  });
  assert.deepEqual(admission, { kind: "blocked-active-run" });
  assert.equal(fetches, 0);
});

test("archive admission fetches detail once when the row has no cache", async () => {
  // 投影不含 archive（服务端对活动 run 的唯一非归档裁决）：拦截请求并引导先停止。
  const blocked = await resolveCloudTaskArchiveAdmission({
    cachedDetail: null,
    loadDetail: () => Promise.resolve({ actions: ["stop", "force-stop"] }),
  });
  assert.deepEqual(blocked, { kind: "blocked-active-run" });
  // 投影含 archive：放行归档请求。
  const allowed = await resolveCloudTaskArchiveAdmission({
    cachedDetail: null,
    loadDetail: () => Promise.resolve({ actions: ["archive"] }),
  });
  assert.deepEqual(allowed, { kind: "allowed" });
});

test("archive admission falls back to server adjudication when detail is unavailable", async () => {
  // 详情拉不到（网络/未接线）：unknown，调用方继续发归档请求、由服务端裁决。
  const unknown = await resolveCloudTaskArchiveAdmission({
    cachedDetail: null,
    loadDetail: () => Promise.resolve(null),
  });
  assert.deepEqual(unknown, { kind: "unknown" });
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

// ── 终态 run 发送行为（2026-10-08 真实环境复现修订，04 §3.3、03 §6、08 §5/§9）──
//
// 实测缺陷链：run 终态后服务端详情投影不再返回 activeRun（只投影非终态 run），
// 「active + 无 run」被投影成 waiting-for-run——假「已提交，等待环境」横幅永久挂起，
// ended 视图（含重开）永远不可达。修订语义：服务端 actions 投影给出 `reopen`
// （无有效写 run 的裁决事实）时，ended/重开呈现优先于 waiting。

test("active task with no run and reopen action projects reopenable, not waiting", () => {
  // 终态 run 已被服务端收回：actions.reopen 是「上一个 run 已结束」的到达事实。
  const view = projectCloudTaskRunPanel(detail({ actions: ["reopen", "archive"] }));
  assert.deepEqual(view, { kind: "reopenable" });
  // task failed 同样适用（actions 投影对 active/failed 都给 reopen）。
  assert.deepEqual(
    projectCloudTaskRunPanel(detail({ taskStatus: "failed", actions: ["reopen"] })),
    { kind: "reopenable" },
  );
});

test("waiting-for-run stays only for the genuine post-202 transaction window", () => {
  // actions 未给出 reopen（run 其实在服务端存在、投影未刷新）：保留等待呈现。
  assert.deepEqual(projectCloudTaskRunPanel(detail({})), { kind: "waiting-for-run" });
  assert.deepEqual(projectCloudTaskRunPanel(detail({ actions: ["send-input"] })), {
    kind: "waiting-for-run",
  });
});

test("composer send routes user-initiated sends; terminal run reopens instead of appending", () => {
  const base = { isSelectedTask: true };

  // draft 首发 / 缺配置。
  assert.deepEqual(
    resolveCloudComposerSendPlan({
      ...base,
      task: { status: "draft", revision: 3, draftStartConfig: { provider: "e2b" } },
    }),
    { kind: "start", expectedTaskRevision: 3 },
  );
  assert.deepEqual(
    resolveCloudComposerSendPlan({ ...base, task: { status: "draft", revision: 3 } }),
    { kind: "missing-start-config", blockedHint: "no-start-config" },
  );
  // 没有任务投影。
  assert.deepEqual(resolveCloudComposerSendPlan({ ...base, task: null }), {
    kind: "missing-task",
    blockedHint: "no-task",
  });

  // run 在投影里（ready 等）：普通 append，原语义不变。
  assert.deepEqual(
    resolveCloudComposerSendPlan({
      ...base,
      task: { status: "active", revision: 5 },
      activeRun: { runGeneration: 2, provider: "e2b" },
      actions: ["send-input", "stop"],
    }),
    { kind: "append", expectedRunGeneration: 2 },
  );

  // 终态 run 已被收回（无 activeRun）+ actions.reopen：自动重开——不发注定 409 的
  // append；resume 按持久事实自动选（saved checkpoint → checkpoint）。
  assert.deepEqual(
    resolveCloudComposerSendPlan({
      ...base,
      task: { status: "active", revision: 9, draftStartConfig: { provider: "e2b" } },
      latestCheckpoint: { state: "saved" },
      actions: ["reopen", "archive"],
    }),
    {
      kind: "reopen",
      provider: "e2b",
      resume: { mode: "checkpoint" },
      expectedTaskRevision: 9,
    },
  );
  assert.deepEqual(
    resolveCloudComposerSendPlan({
      ...base,
      task: { status: "active", revision: 9, draftStartConfig: { provider: "modal" } },
      actions: ["reopen", "archive"],
    }),
    {
      kind: "reopen",
      provider: "modal",
      resume: { mode: "restart-from-base" },
      expectedTaskRevision: 9,
    },
  );

  // actions 不给 reopen（recovery_required 等）或 provider 不可解析：不自动重开。
  assert.deepEqual(
    resolveCloudComposerSendPlan({
      ...base,
      task: { status: "active", revision: 9, draftStartConfig: { provider: "e2b" } },
      actions: ["archive"],
    }),
    { kind: "reopen-unavailable", blockedHint: "reopen-unavailable" },
  );
  assert.deepEqual(
    resolveCloudComposerSendPlan({
      ...base,
      task: { status: "active", revision: 9 },
      actions: ["reopen"],
    }),
    { kind: "reopen-unavailable", blockedHint: "reopen-unavailable" },
  );

  // 非选中工作区且无 run：保持原 blocked 行为（提交 scope 属于选中任务）。
  assert.deepEqual(
    resolveCloudComposerSendPlan({
      isSelectedTask: false,
      task: { status: "active", revision: 9, draftStartConfig: { provider: "e2b" } },
      actions: ["reopen"],
    }),
    { kind: "out-of-scope-blocked" },
  );
});

test("409 race retry plan assembles reopen from stale-detail facts", () => {
  // 竞态：详情仍显示活 run（provider 事实在 run 上）→ append 409 no-active-run。
  const retry = resolveCloudReopenRetryPlan(
    detail({
      runStatus: "ready",
      provider: "e2b",
      checkpointState: "saved",
      actions: ["send-input"],
    }),
  );
  assert.deepEqual(retry, {
    provider: "e2b",
    resume: { mode: "checkpoint" },
    expectedTaskRevision: 7,
  });
  // run 无 provider 时回落已保存 draftStartConfig；无 checkpoint → restart-from-base。
  const fromDraft = resolveCloudReopenRetryPlan(detail({ runStatus: "ready", provider: "modal" }));
  assert.deepEqual(fromDraft, {
    provider: "modal",
    resume: { mode: "restart-from-base" },
    expectedTaskRevision: 7,
  });
  // provider 无事实（run 无 provider 且未保存配置）：无法组装重开，回落归一错误。
  assert.equal(resolveCloudReopenRetryPlan(detail({ runStatus: "ready" })), null);
  assert.equal(resolveCloudReopenRetryPlan(null), null);
});

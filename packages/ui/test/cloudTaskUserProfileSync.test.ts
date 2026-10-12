/**
 * 云任务面板「同步用户资源」入口用例（specs/cloud-agent 14 §4.6/§9.5；W11 §13D）。
 *
 * 覆盖范围与理由（本包测试布局是 `node --test` 纯逻辑 + 结构冒烟，无 DOM renderer）：
 * - 显示门控纯逻辑：连接态（attachment 在线 + activeRun ready）显示、未连接/终态隐藏
 *   ——这是"未连接不显示入口"验收项的落点；
 * - 结果摘要映射：逐条结果 → 计数 + 失败简列（截断与 join 自动同步的真实 trigger）；
 * - 409 `not_ready`（reason `run-not-connected`）→「沙箱未连接」文案 key；
 * - 结构冒烟：门控命中时入口渲染出按钮、未命中渲染为空（Provider/intl/hook 装配不炸）。
 * - **未覆盖**：真实点击与网络路径（需要 DOM renderer / 控制面），属 E2E（W11 §13D 验收）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudUserProfileSyncResponse } from "@zcode/shared";
import {
  CLOUD_TERMINAL_RUN_STATUSES,
  CLOUD_USER_PROFILE_SYNC_MAX_LISTED_FAILURES,
  cloudUserProfileSyncErrorMessageKey,
  describeCloudUserProfileSyncError,
  resolveCloudUserProfileSyncEntry,
  summarizeCloudUserProfileSync,
} from "../src/cloud/cloudTaskUserProfileSync.js";

const TASK_ID = "0f9c4c28-8a1f-4c58-9a3f-27f0a6c3e001";
const RUN_ID = "6d0d0d2a-1b2c-4d5e-8f90-1234567890ab";

function gate(input: {
  cloudTaskId?: string | null;
  attachmentReady?: boolean;
  activeRunStatus?: string | null;
}) {
  return resolveCloudUserProfileSyncEntry({
    cloudTaskId: input.cloudTaskId === undefined ? TASK_ID : input.cloudTaskId,
    attachmentReady: input.attachmentReady ?? true,
    activeRunStatus: input.activeRunStatus === undefined ? "ready" : input.activeRunStatus,
  });
}

// ── 门控：连接态显示 / 未连接与终态隐藏 ──

test("入口门控：只有 attachment 在线且 Run ready（非终态）时可见", () => {
  assert.deepEqual(gate({ activeRunStatus: "ready", attachmentReady: true }), {
    visible: true,
    hiddenReason: null,
  });
});

test("入口门控：非云任务工作区零渲染（本地 / SSH / 配对远控语义不变）", () => {
  assert.deepEqual(gate({ cloudTaskId: null }), {
    visible: false,
    hiddenReason: "not-cloud-task",
  });
});

test("入口门控：未连接一律隐藏（attachment 不在线或 Run 非 ready）", () => {
  // 无 run（provisioning 前的事务窗口）：不显示。
  assert.deepEqual(gate({ activeRunStatus: null }), { visible: false, hiddenReason: "no-run" });
  // provisioning：attachment 尚未建立。
  assert.deepEqual(gate({ activeRunStatus: "provisioning", attachmentReady: false }), {
    visible: false,
    hiddenReason: "not-connected",
  });
  // ready 投影但 attachment 未在线（例如非选中任务的工作区）：不显示（fail-closed）。
  assert.deepEqual(gate({ activeRunStatus: "ready", attachmentReady: false }), {
    visible: false,
    hiddenReason: "not-connected",
  });
  // paused：执行域已被 detach（04 §3.3 生命周期 v2）。
  assert.deepEqual(gate({ activeRunStatus: "paused", attachmentReady: false }), {
    visible: false,
    hiddenReason: "not-connected",
  });
  // disconnected / draining：attachment 可能仍在，但 bridge 未 ready 或命中 stop 屏障
  // （服务端必然 409），显示"可点但无意义"的入口不是正确呈现（14 §4.6）。
  assert.deepEqual(gate({ activeRunStatus: "disconnected", attachmentReady: true }), {
    visible: false,
    hiddenReason: "not-connected",
  });
  assert.deepEqual(gate({ activeRunStatus: "draining", attachmentReady: true }), {
    visible: false,
    hiddenReason: "not-connected",
  });
});

test("入口门控：终态 Run（stopped/expired/failed）隐藏，与共享终态集合同口径", () => {
  assert.deepEqual([...CLOUD_TERMINAL_RUN_STATUSES].sort(), ["expired", "failed", "stopped"]);
  for (const status of CLOUD_TERMINAL_RUN_STATUSES) {
    assert.deepEqual(
      gate({ activeRunStatus: status, attachmentReady: false }),
      { visible: false, hiddenReason: "terminal" },
      `${status} 必须隐藏入口`,
    );
    // 终态判定优先于连接判定：即使投影里残留 attachment 也不显示。
    assert.equal(gate({ activeRunStatus: status, attachmentReady: true }).visible, false);
  }
});

// ── 结果摘要映射 ──

function responseFixture(
  results: CloudUserProfileSyncResponse["results"],
  overrides: Partial<CloudUserProfileSyncResponse> = {},
): CloudUserProfileSyncResponse {
  return {
    runId: RUN_ID,
    profileVersion: 7,
    trigger: "manual",
    results,
    ...overrides,
  };
}

test("结果摘要：计数逐状态统计，失败列出 category/entryId 与有界 error", () => {
  const summary = summarizeCloudUserProfileSync(
    responseFixture([
      { category: "mcp", entryId: "primary", status: "synced" },
      { category: "skills", entryId: "kit", status: "skipped" },
      { category: "commands", entryId: "review.md", status: "synced" },
      {
        category: "subagents",
        entryId: "planner.md",
        status: "failed",
        error: "write failed: permission denied",
      },
      { category: "agents-md", entryId: "user-agents", status: "failed" },
    ]),
  );
  assert.equal(summary.total, 5);
  assert.equal(summary.synced, 2);
  assert.equal(summary.skipped, 1);
  assert.equal(summary.failed, 2);
  assert.equal(summary.profileVersion, 7);
  assert.equal(summary.runId, RUN_ID);
  assert.equal(summary.trigger, "manual");
  assert.deepEqual(summary.failures, [
    {
      category: "subagents",
      entryId: "planner.md",
      error: "write failed: permission denied",
    },
    { category: "agents-md", entryId: "user-agents", error: null },
  ]);
  assert.equal(summary.hiddenFailures, 0);
});

test("结果摘要：失败简列有界（默认 5 条 + 截断计数），全成功时无失败项", () => {
  const results: CloudUserProfileSyncResponse["results"] = [];
  for (let index = 0; index < 8; index += 1) {
    results.push({
      category: "mcp",
      entryId: `srv-${index}`,
      status: "failed",
      error: `e${index}`,
    });
  }
  const summary = summarizeCloudUserProfileSync(responseFixture(results));
  assert.equal(summary.failed, 8);
  assert.equal(summary.failures.length, CLOUD_USER_PROFILE_SYNC_MAX_LISTED_FAILURES);
  assert.equal(summary.hiddenFailures, 3);
  assert.equal(summary.failures[0]?.entryId, "srv-0", "保持响应次序");
  // maxFailures 可调（自定义面板密度/测试）。
  const compact = summarizeCloudUserProfileSync(responseFixture(results), { maxFailures: 2 });
  assert.equal(compact.failures.length, 2);
  assert.equal(compact.hiddenFailures, 6);

  const allSynced = summarizeCloudUserProfileSync(
    responseFixture([{ category: "mcp", entryId: "primary", status: "synced" }]),
  );
  assert.equal(allSynced.failed, 0);
  assert.deepEqual(allSynced.failures, []);
  assert.equal(allSynced.hiddenFailures, 0);
});

test("结果摘要：join 在飞的自动同步时保留真实 trigger（不伪写 manual，14 §4.6 单飞）", () => {
  const summary = summarizeCloudUserProfileSync(
    responseFixture([{ category: "mcp", entryId: "primary", status: "synced" }], {
      trigger: "automatic",
    }),
  );
  assert.equal(summary.trigger, "automatic");
});

// ── 错误文案（409 not_ready 按 reason 细分）──

test("同步错误文案：409 not_ready/run-not-connected 落到「沙箱未连接」", () => {
  assert.equal(
    cloudUserProfileSyncErrorMessageKey("not_ready", "run-not-connected"),
    "cloud.userProfileSync.error.notConnected",
  );
  assert.equal(
    cloudUserProfileSyncErrorMessageKey("not_ready", "run-terminal"),
    "cloud.userProfileSync.error.runEnded",
  );
  assert.equal(
    cloudUserProfileSyncErrorMessageKey("not_ready", "run-not-found"),
    "cloud.userProfileSync.error.runEnded",
  );
  // stop 屏障沿既有输入拒绝表（同一条 stopRequested 语义，不造第二份文案）。
  assert.equal(
    cloudUserProfileSyncErrorMessageKey("not_ready", "stop-requested"),
    "cloud.errors.not_ready.stop_requested",
  );
  // 未列出的 reason 回落 not_ready 通用文案（不猜语义）。
  assert.equal(
    cloudUserProfileSyncErrorMessageKey("not_ready", "some-new-reason"),
    "cloud.errors.not_ready",
  );
  // 部署未装配：与设置页同一文案。
  assert.equal(
    cloudUserProfileSyncErrorMessageKey("not_configured", "user-profile-store-missing"),
    "settings.cloudUserResources.error.notConfigured",
  );
  // 其余码沿任务动作文案表；未收录的码返回 null（调用方回落原始码）。
  assert.equal(
    cloudUserProfileSyncErrorMessageKey("unauthorized", null),
    "cloud.errors.unauthorized",
  );
  assert.equal(cloudUserProfileSyncErrorMessageKey("some_unknown_code", null), null);
  assert.equal(cloudUserProfileSyncErrorMessageKey(null, null), null);
});

test("同步错误归一：结构化错误按映射翻译，非结构化回落原始信息（不解析文案）", () => {
  const translate = (id: string) => `t:${id}`;
  assert.equal(
    describeCloudUserProfileSyncError(
      {
        code: "not_ready",
        retryable: false,
        details: { reason: "run-not-connected" },
        message: "raw server text",
      },
      translate,
    ),
    "t:cloud.userProfileSync.error.notConnected",
  );
  // 无结构：回落 describeCloudSubmissionError（错误码本身 / message），不猜语义。
  assert.equal(describeCloudUserProfileSyncError(null, translate), "null");
});

// ── 结构冒烟：门控命中渲染按钮、未命中渲染为空 ──

test("入口渲染冒烟：连接态渲染同步按钮，非云工作区渲染为空", async (t) => {
  let renderToStaticMarkup: (element: unknown) => string;
  let createElement: typeof import("react").createElement;
  try {
    ({ renderToStaticMarkup } = await import("react-dom/server"));
    ({ createElement } = await import("react"));
  } catch {
    t.skip("react-dom/server 不可用");
    return;
  }
  const [
    { ZCodeIntlProvider },
    { CloudWorkspaceContextProvider },
    { CloudTaskUserProfileSyncRow },
  ] = await Promise.all([
    import("../src/i18n/IntlProvider.js"),
    import("../src/cloud/cloudWorkspaceContext.js"),
    import("../src/cloud/CloudTaskUserProfileSyncRow.js"),
  ]);

  const attachment = { taskId: TASK_ID, channelClient: {} };
  const cloudValue = (overrides: {
    attachment?: unknown;
    activeRunStatus?: string | undefined;
  }) => ({
    selection: {
      principalId: "principal-1",
      controlPlaneOrigin: "https://cloud.example.test",
      projectId: null,
      taskId: TASK_ID,
      draftScope: null,
    },
    controlPlane: null,
    hostAccessor: null,
    attachment: overrides.attachment ?? null,
    capabilities: null,
    capabilitiesStatus: "idle" as const,
    capabilitiesError: null,
    taskDetail:
      overrides.activeRunStatus === undefined
        ? null
        : { task: { taskId: TASK_ID }, activeRun: { status: overrides.activeRunStatus } },
    taskDetailStatus: "idle" as const,
    taskDetailError: null,
    taskDetailErrorCode: null,
    selectProject() {},
    selectTask() {},
    async reloadCapabilities() {},
    async reloadTask() {},
    beginTaskRunWatch() {},
  });

  const render = (value: unknown, identity: string | null) =>
    renderToStaticMarkup(
      createElement(
        ZCodeIntlProvider,
        { initialLocale: "zh-CN" },
        createElement(
          CloudWorkspaceContextProvider,
          { value: value as never },
          createElement(CloudTaskUserProfileSyncRow, { workspaceIdentity: identity }),
        ),
      ),
    );

  const identity = `cloud-task:${TASK_ID}`;
  // 连接态（attachment 在线 + ready）：渲染按钮与说明。
  const connected = render(cloudValue({ attachment, activeRunStatus: "ready" }), identity);
  assert.ok(connected.includes("同步用户资源"), "连接态渲染同步入口");
  assert.ok(connected.includes('data-testid="cloud-task-user-profile-sync"'));

  // 未连接（无 attachment）：不渲染（隐藏而不是禁用态）。
  assert.equal(render(cloudValue({ activeRunStatus: "ready" }), identity), "");
  // 终态：不渲染。
  assert.equal(render(cloudValue({ attachment, activeRunStatus: "stopped" }), identity), "");
  // 非云任务工作区：不渲染。
  assert.equal(render(cloudValue({ attachment, activeRunStatus: "ready" }), null), "");
});

/**
 * W8 投影缓存与对话折叠用例（specs/cloud-agent 04 §3.1/§3.3/§5、08 §3、03 §9、
 * 验收 W-01/W-02/W-06/W-08/W-15）。
 *
 * 覆盖：
 * - Project/Task 投影只做缓存：主体围栏 + revision 单调，迟到响应不回灌；
 * - Task 状态与 Run 状态、执行活动分开，不互相推导；
 * - 历史折叠去重、排序、缺口判定与 epoch 换代，越界必须 resync。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type {
  CloudHistoryItem,
  CloudProjectRecord,
  CloudRunRecord,
  CloudTaskRecord,
  TaskDetailResponse,
} from "@zcode/shared";
import { readCloudTaskActions } from "../src/cloud/cloudTaskActionsProjection.js";
import { useCloudProjectsStore } from "../src/store/cloud/cloudProjectsStore.js";
import { useCloudTasksStore } from "../src/store/cloud/cloudTasksStore.js";
import { useCloudTaskHistoryStore } from "../src/store/cloud/cloudTaskHistoryStore.js";
import {
  canApplyCloudConversationSnapshot,
  createEmptyCloudConversationFold,
  foldCloudConversationItems,
} from "../src/store/cloud/cloudConversationFold.js";

const PRINCIPAL = "3c8a6d2b-0e4f-4a9b-8c1d-2e3f4a5b6c7d";
const OTHER_PRINCIPAL = "4d9b7e3c-1f5a-4b0c-9d2e-3f4a5b6c7d8e";
const PROJECT_ID = "4d9b7e3c-1f5a-4b0c-9d2e-3f4a5b6c7d8e";
const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";

function createProject(overrides: Partial<CloudProjectRecord> = {}): CloudProjectRecord {
  return {
    projectId: PROJECT_ID,
    ownerPrincipalId: PRINCIPAL,
    kind: "github-repo",
    repositoryId: 42,
    repoOwner: "acme",
    repoName: "widget",
    defaultBranch: "main",
    revision: 1,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    ...overrides,
  };
}

function createTask(overrides: Partial<CloudTaskRecord> = {}): CloudTaskRecord {
  return {
    taskId: TASK_ID,
    ownerPrincipalId: PRINCIPAL,
    projectId: PROJECT_ID,
    title: "补齐 README",
    status: "draft",
    creationKey: "creation-1",
    workspaceIdentity: `cloud-task:${TASK_ID}`,
    nextRunGeneration: 1,
    revision: 1,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    ...overrides,
  };
}

function createRun(overrides: Partial<CloudRunRecord> = {}): CloudRunRecord {
  return {
    runId: "1f0d3b2a-4c51-4d9b-8c1d-2e3f4a5b6c7d",
    taskId: TASK_ID,
    runGeneration: 1,
    executionKind: "sandbox",
    provider: "e2b",
    status: "ready",
    connectionEpoch: 1,
    dataAtRisk: false,
    createdAt: 1_760_000_000_000,
    updatedAt: 1_760_000_000_000,
    ...overrides,
  };
}

test("project projection is fenced by principal and monotonic in revision", () => {
  const store = useCloudProjectsStore.getState();
  store.reset();
  useCloudProjectsStore.getState().setPrincipal(PRINCIPAL);
  useCloudProjectsStore.getState().applyPage(PRINCIPAL, { items: [createProject()] });
  assert.equal(useCloudProjectsStore.getState().items.length, 1);

  // 迟到响应来自上一个主体：必须被丢弃，不能把别的账号的项目灌回来。
  useCloudProjectsStore.getState().applyPage(OTHER_PRINCIPAL, {
    items: [createProject({ projectId: "deadbeef-0000-4000-8000-000000000000" })],
  });
  assert.equal(useCloudProjectsStore.getState().items.length, 1);

  // revision 只增不减：旧 revision 的迟到响应不得把新状态盖回去。
  useCloudProjectsStore
    .getState()
    .upsert(PRINCIPAL, createProject({ revision: 3, displayName: "新名字" }));
  useCloudProjectsStore
    .getState()
    .upsert(PRINCIPAL, createProject({ revision: 2, displayName: "旧名字" }));
  assert.equal(useCloudProjectsStore.getState().items[0]?.displayName, "新名字");

  // 多端重复添加同一仓库：同一个 projectId 只留一条（W-01）。
  useCloudProjectsStore.getState().applyPage(PRINCIPAL, {
    items: [createProject({ revision: 3, displayName: "新名字" }), createProject({ revision: 3 })],
  });
  assert.equal(useCloudProjectsStore.getState().items.length, 1);

  // 登出清投影。
  useCloudProjectsStore.getState().setPrincipal(null);
  assert.deepEqual(useCloudProjectsStore.getState().items, []);
});

test("task detail keeps Task status, Run status and execution activity separate", () => {
  useCloudTasksStore.getState().reset();
  useCloudTasksStore.getState().setPrincipal(PRINCIPAL);

  const detail: TaskDetailResponse = {
    task: createTask({ status: "active" }),
    // Task.active ≠ attachment ready：run 处于 provisioning 时两者并不一致（04 §3.3）。
    activeRun: createRun({ status: "provisioning" }),
    execution: { status: "unknown", observedAt: 1_760_000_010_000 },
    // 可用动作来自控制面投影（04 §3.3）；本用例只关心状态分离，不关心动作集合。
    actions: [],
  };
  useCloudTasksStore.getState().applyTaskDetail(PRINCIPAL, detail, Date.now());

  const cached = useCloudTasksStore.getState().detailByTask[TASK_ID];
  assert.equal(cached?.detail.task.status, "active");
  assert.equal(cached?.detail.activeRun?.status, "provisioning");
  // 缺可靠 runtime 事实时保留 unknown，不猜 idle（08 §3.3）。
  assert.equal(cached?.detail.execution?.status, "unknown");

  // 详情里的 Task 同时回填到项目列表，两处不会互相矛盾。
  assert.equal(useCloudTasksStore.getState().itemsByProject[PROJECT_ID]?.length, 1);

  // 换主体清投影。
  useCloudTasksStore.getState().setPrincipal(OTHER_PRINCIPAL);
  assert.deepEqual(useCloudTasksStore.getState().detailByTask, {});
});

test("the presented action set is exactly what the server projected", () => {
  // 04 §3.3：可操作 actions 来自控制面投影。UI 只透传，不按状态推导、不裁剪、不排序。
  const detail: TaskDetailResponse = {
    task: createTask({ status: "active" }),
    activeRun: createRun({ status: "ready" }),
    actions: ["send-input", "stop", "complete", "archive"],
  };

  const presented = readCloudTaskActions(detail);
  assert.deepEqual(presented, detail.actions);
  // 顺序也原样保留：服务端给的就是呈现顺序。
  assert.deepEqual([...presented], ["send-input", "stop", "complete", "archive"]);
});

test("an empty server action set means nothing is clickable, with no local fallback", () => {
  // 服务端返回空数组：呈现为「无动作可点」，绝不回落客户端按 Task/Run 状态推导的动作表。
  const detail: TaskDetailResponse = {
    task: createTask({ status: "active" }),
    // 即便 run 处于 ready、Task 处于 active，客户端也**不得**据此补出 stop/complete 等动作。
    activeRun: createRun({ status: "ready" }),
    actions: [],
  };
  assert.deepEqual(readCloudTaskActions(detail), []);
  assert.equal(readCloudTaskActions(detail).length, 0);
});

test("a missing detail projection yields an empty action set instead of a guess", () => {
  // 还没有详情投影（未加载 / 未选中任务）：没有动作可点，不猜状态。
  assert.deepEqual(readCloudTaskActions(null), []);
  assert.equal(Object.isFrozen(readCloudTaskActions(null)), true);
});

test("conversation fold dedupes, orders and flags gaps without filling them", () => {
  let fold = createEmptyCloudConversationFold();
  const item = (seq: number, logEpoch = "epoch-1"): CloudHistoryItem => ({
    topic: "conversation",
    logEpoch,
    seq,
    kind: "delta",
    payload: { seq },
    ts: 1_760_000_000_000 + seq,
  });

  fold = foldCloudConversationItems(fold, [item(1), item(2)], "replace");
  assert.deepEqual(
    fold.items.map((entry) => entry.seq),
    [1, 2],
  );
  assert.equal(fold.gap, false);

  // 重复帧不是新内容。
  fold = foldCloudConversationItems(fold, [item(2)], "append");
  assert.deepEqual(
    fold.items.map((entry) => entry.seq),
    [1, 2],
  );

  // 乱序到达也要排好。
  fold = foldCloudConversationItems(fold, [item(4), item(3)], "append");
  assert.deepEqual(
    fold.items.map((entry) => entry.seq),
    [1, 2, 3, 4],
  );

  // 缺口（跳过 5）不补齐、不重排，只标 gap 要求 resync（03 §9）。
  fold = foldCloudConversationItems(fold, [item(6)], "append");
  assert.equal(fold.gap, true);
  assert.deepEqual(
    fold.items.map((entry) => entry.seq),
    [1, 2, 3, 4, 6],
  );

  // epoch 换代：旧 epoch 的内容全部作废，不冒充连续流（02 §7.3）。
  fold = foldCloudConversationItems(fold, [item(1, "epoch-2")], "append");
  assert.equal(fold.logEpoch, "epoch-2");
  assert.deepEqual(
    fold.items.map((entry) => entry.seq),
    [1],
  );
  assert.equal(fold.gap, false);

  // 同一批里出现两个 epoch：无法判定先后，交给 resync。
  const mixed = foldCloudConversationItems(
    createEmptyCloudConversationFold(),
    [item(1), item(2, "epoch-9")],
    "replace",
  );
  assert.equal(mixed.gap, true);
});

test("history store marks resync on retention overflow instead of restarting from zero", () => {
  useCloudTaskHistoryStore.getState().reset();
  useCloudTaskHistoryStore.getState().setPrincipal(PRINCIPAL);
  useCloudTaskHistoryStore.getState().applyHistoryPage(PRINCIPAL, TASK_ID, {
    items: [
      { topic: "conversation", logEpoch: "epoch-1", seq: 1, kind: "delta", payload: null, ts: 1 },
    ],
  });
  assert.equal(useCloudTaskHistoryStore.getState().byTask[TASK_ID]?.requiresResync, false);

  // 服务端显式声明越界：清掉折叠并要求重读快照。
  useCloudTaskHistoryStore.getState().applyHistoryPage(PRINCIPAL, TASK_ID, {
    items: [],
    resyncRequired: true,
  });
  const entry = useCloudTaskHistoryStore.getState().byTask[TASK_ID];
  assert.equal(entry?.requiresResync, true);
  assert.deepEqual(entry?.fold.items, []);

  // 已知不连续时不再缝增量：等快照重建基线。
  useCloudTaskHistoryStore
    .getState()
    .applyHistoryDelta(PRINCIPAL, TASK_ID, [
      { topic: "conversation", logEpoch: "epoch-1", seq: 9, kind: "delta", payload: null, ts: 9 },
    ]);
  assert.deepEqual(useCloudTaskHistoryStore.getState().byTask[TASK_ID]?.fold.items, []);
});

test("a stale snapshot is not stitched onto a newer local stream", () => {
  const fold = foldCloudConversationItems(
    createEmptyCloudConversationFold(),
    [
      { topic: "conversation", logEpoch: "epoch-1", seq: 1, kind: "delta", payload: null, ts: 1 },
      { topic: "conversation", logEpoch: "epoch-1", seq: 2, kind: "delta", payload: null, ts: 2 },
    ],
    "replace",
  );
  // 覆盖范围落后于本地水位：正确动作是再读一次，而不是把两者缝起来。
  assert.equal(
    canApplyCloudConversationSnapshot(fold, {
      topic: "conversation",
      logEpoch: "epoch-1",
      coveredSourceSeq: 1,
    }),
    false,
  );
  assert.equal(
    canApplyCloudConversationSnapshot(fold, {
      topic: "conversation",
      logEpoch: "epoch-1",
      coveredSourceSeq: 2,
    }),
    true,
  );
  // 换代快照是新的权威基线，可以应用。
  assert.equal(
    canApplyCloudConversationSnapshot(fold, {
      topic: "conversation",
      logEpoch: "epoch-2",
      coveredSourceSeq: 0,
    }),
    true,
  );
  // 别的 topic 不混进对话序列。
  assert.equal(
    canApplyCloudConversationSnapshot(fold, {
      topic: "other",
      logEpoch: "epoch-1",
      coveredSourceSeq: 99,
    }),
    false,
  );
});

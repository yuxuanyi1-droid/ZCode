/**
 * 云任务 run 观察轮询用例（specs/cloud-agent/04 §3.2.4、03 §6.2）。
 *
 * 覆盖 2026-10-08 实测缺陷「首条输入 202 后同页无反馈」的修复语义：
 * - 首发 202 后启动有界轮询，每轮刷新详情（唯一投影），run 可见且非 provisioning 即停；
 * - provisioning 期间继续；无 run（事务窗口）继续；
 * - 60s 上限兜底；切换任务/卸载（cancel）立即停止并放弃未决定时器；
 * - 单轮刷新失败不中断，等待下一轮。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { TaskDetailResponse } from "@zcode/shared";
import {
  CLOUD_TASK_RUN_WATCH_INTERVAL_MS,
  CLOUD_TASK_RUN_WATCH_TIMEOUT_MS,
  shouldContinueCloudTaskRunWatch,
  startCloudTaskRunWatch,
} from "../src/cloud/cloudTaskRunWatch.js";

function runWithStatus(status: string) {
  return {
    runId: "run-1",
    taskId: "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51",
    runGeneration: 1,
    executionKind: "sandbox" as const,
    provider: "e2b",
    status,
    connectionEpoch: 1,
    dataAtRisk: false,
    createdAt: 0,
    updatedAt: 0,
  };
}

function detailWithRun(
  status: string | undefined,
  actions: readonly string[] = [],
): TaskDetailResponse {
  return {
    task: {
      taskId: "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51",
      projectId: "p-1",
      status: "active",
      title: "示例任务",
      workspaceIdentity: "cloud-task:8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51",
      revision: 3,
      createdAt: 0,
      updatedAt: 0,
    },
    ...(status === undefined ? {} : { activeRun: runWithStatus(status) }),
    actions: [...actions],
  };
}

test("watch continues while the run is not yet visible or provisioning", () => {
  // run 还没出现在投影里（draft → start 事务窗口）：继续等。
  assert.equal(shouldContinueCloudTaskRunWatch(detailWithRun(undefined)), true);
  // provisioning：面板展示进行中，继续轮询直到离开。
  assert.equal(shouldContinueCloudTaskRunWatch(detailWithRun("provisioning")), true);
  assert.equal(shouldContinueCloudTaskRunWatch(null), true);
});

test("watch stops at ready and terminal run states", () => {
  for (const status of ["ready", "failed", "stopped", "expired", "disconnected", "draining"]) {
    assert.equal(
      shouldContinueCloudTaskRunWatch(detailWithRun(status)),
      false,
      `${status} should stop the watch`,
    );
  }
});

// 2026-10-08 终态 run 发送行为修订：服务端详情投影只携带非终态 run，run 从
// provisioning → 终态的迁移在投影里表现为 activeRun 消失；此时 actions 给出
// `reopen`（无有效写 run 的裁决事实）。停止条件必须包含它——否则该迁移会被
// 误判成「run 尚未出现」而轮询到 60s 超时，假「等待」横幅永久挂起。
test("watch stops when the detail shows no run but the reopen action", () => {
  assert.equal(
    shouldContinueCloudTaskRunWatch(detailWithRun(undefined, ["reopen", "archive"])),
    false,
  );
  // 非 reopen 的 actions 不构成停止依据（genuine 202 事务窗口仍继续）。
  assert.equal(shouldContinueCloudTaskRunWatch(detailWithRun(undefined, ["archive"])), true);
});

test("provisioning-to-terminal transition stops the watch via the reopen action", async () => {
  const clock = createManualClock();
  const responses: TaskDetailResponse[] = [
    detailWithRun("provisioning"), // 第一轮：环境准备中，继续
    // 第二轮：run 已终态并被服务端收回（activeRun 消失），reopen 能力到达。
    detailWithRun(undefined, ["reopen", "archive"]),
  ];
  let refreshCount = 0;
  const handle = startCloudTaskRunWatch({
    refresh: async () => responses[Math.min(refreshCount++, responses.length - 1)],
    now: clock.now,
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
  });
  await flushMicrotasks();
  assert.equal(refreshCount, 1);
  await clock.advance(CLOUD_TASK_RUN_WATCH_INTERVAL_MS);
  assert.equal(refreshCount, 2);
  // reopen 事实已到达：不再有第三轮（不会拖到 60s 超时）。
  await clock.advance(CLOUD_TASK_RUN_WATCH_INTERVAL_MS * 3);
  assert.equal(refreshCount, 2);
  handle.cancel();
});

/**
 * 手动时钟：advance 在触发每个到期定时器后冲刷微任务，让轮询的 async 回调
 * 恢复执行并安排下一轮，再继续推进时间——与真实事件循环的交错顺序一致。
 */
interface ManualClock {
  now(): number;
  advance(ms: number): Promise<void>;
  schedule(cb: () => void, delayMs: number): { id: number };
  cancelScheduled(timer: { id: number }): void;
}

function createManualClock(): ManualClock {
  let current = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; cb: () => void }>();
  return {
    now: () => current,
    async advance(ms: number) {
      const target = current + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) {
          break;
        }
        timers.delete(due[0]);
        current = due[1].at;
        due[1].cb();
        await flushMicrotasks();
      }
      current = target;
    },
    schedule(cb, delayMs) {
      const id = nextId++;
      timers.set(id, { at: current + delayMs, cb });
      return { id };
    },
    cancelScheduled(timer) {
      timers.delete(timer.id);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  // 一层给 async tick 的首个 await 恢复，再一层给级联的 promise 链兜底。
  await Promise.resolve();
  await Promise.resolve();
}

test("first input triggers polling that refreshes the detail until the run is ready", async () => {
  const clock = createManualClock();
  const responses: TaskDetailResponse[] = [
    detailWithRun(undefined), // 第一轮：事务窗口，run 还没出现
    detailWithRun("provisioning"), // 第二轮：环境准备中
    detailWithRun("ready"), // 第三轮：ready，交给 attachment
  ];
  let refreshCount = 0;
  const handle = startCloudTaskRunWatch({
    refresh: async () => responses[Math.min(refreshCount++, responses.length - 1)],
    now: clock.now,
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
  });

  // 立即刷一次（202 后尽快把「等待环境」翻出来），随后按间隔推进。
  await flushMicrotasks();
  assert.equal(refreshCount, 1);
  await clock.advance(CLOUD_TASK_RUN_WATCH_INTERVAL_MS);
  assert.equal(refreshCount, 2);
  await clock.advance(CLOUD_TASK_RUN_WATCH_INTERVAL_MS);
  assert.equal(refreshCount, 3);
  // ready 即停：再推进也不得有第四轮。
  await clock.advance(CLOUD_TASK_RUN_WATCH_INTERVAL_MS * 3);
  assert.equal(refreshCount, 3);
  handle.cancel();
});

test("terminal failed run stops the watch on the first tick", async () => {
  const clock = createManualClock();
  let refreshCount = 0;
  const handle = startCloudTaskRunWatch({
    refresh: async () => {
      refreshCount += 1;
      return detailWithRun("failed");
    },
    now: clock.now,
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
  });
  await flushMicrotasks();
  assert.equal(refreshCount, 1);
  await clock.advance(CLOUD_TASK_RUN_WATCH_INTERVAL_MS * 5);
  assert.equal(refreshCount, 1);
  handle.cancel();
});

test("the watch is bounded by the 60s budget even while provisioning", async () => {
  const clock = createManualClock();
  let refreshCount = 0;
  const handle = startCloudTaskRunWatch({
    refresh: async () => {
      refreshCount += 1;
      return detailWithRun("provisioning");
    },
    now: clock.now,
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
  });
  // 一直停在 provisioning：上限到达后必须自己停下来（首轮 + 每间隔一轮）。
  await flushMicrotasks();
  await clock.advance(CLOUD_TASK_RUN_WATCH_TIMEOUT_MS + CLOUD_TASK_RUN_WATCH_INTERVAL_MS);
  assert.equal(
    refreshCount,
    Math.floor(CLOUD_TASK_RUN_WATCH_TIMEOUT_MS / CLOUD_TASK_RUN_WATCH_INTERVAL_MS) + 1,
  );
  const settled = refreshCount;
  await clock.advance(CLOUD_TASK_RUN_WATCH_TIMEOUT_MS);
  assert.equal(refreshCount, settled);
  handle.cancel();
});

test("cancel drops the pending timer so switching tasks stops the watch", async () => {
  const clock = createManualClock();
  let refreshCount = 0;
  const handle = startCloudTaskRunWatch({
    refresh: async () => {
      refreshCount += 1;
      return detailWithRun(undefined);
    },
    now: clock.now,
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
  });
  await flushMicrotasks();
  assert.equal(refreshCount, 1);
  handle.cancel();
  await clock.advance(CLOUD_TASK_RUN_WATCH_INTERVAL_MS * 10);
  assert.equal(refreshCount, 1);
});

test("a failed refresh round does not abort the watch", async () => {
  const clock = createManualClock();
  const results: Array<TaskDetailResponse | null> = [null, detailWithRun("ready")];
  let refreshCount = 0;
  const handle = startCloudTaskRunWatch({
    refresh: async () => {
      const next = results[Math.min(refreshCount++, results.length - 1)];
      if (next === null) {
        throw new Error("socket hang up");
      }
      return next;
    },
    now: clock.now,
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
  });
  await flushMicrotasks();
  assert.equal(refreshCount, 1);
  await clock.advance(CLOUD_TASK_RUN_WATCH_INTERVAL_MS);
  assert.equal(refreshCount, 2);
  await clock.advance(CLOUD_TASK_RUN_WATCH_INTERVAL_MS);
  assert.equal(refreshCount, 2);
  handle.cancel();
});

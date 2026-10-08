/**
 * 云模式 first-run 引导的账号事实与触发判定用例（2026-10-07 终验缺陷 F）。
 *
 * 缺陷 F：已有任务/项目的账号 reload 后 first-run 向导仍弹出且 Close 不持久。
 * 根因：原短路只读 cloudTasksStore 缓存，而向导可见时 children（侧栏）不渲染，
 * 缓存永远没机会被写入——短路永不命中。修复语义（本文件锁定）：
 * - 账号事实探测（listProjects → 逐项目 listProjectTasks 首页）：任一项目有任务即
 *   true；全部为空/无项目为 false；失败向上抛出由调用方回落 record 判定（不猜）；
 * - 触发判定决策步：会话关闭标记 > 账号事实 true > pending 等待 > record/settings；
 * - Close 会话级标记：持久化写入失败时至少当次会话不再弹。
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { CloudControlPlanePort } from "../src/cloud/cloudPorts.js";
import {
  CLOUD_ACTIVITY_PROBE_MAX_ATTEMPTS,
  probeCloudAccountHasActivity,
  probeCloudAccountHasActivityWithRetry,
} from "../src/onboarding/useCloudOnboardingFacts.js";
import {
  isOnboardingAutoShownThisSession,
  isOnboardingDismissedThisSession,
  markOnboardingAutoShownThisSession,
  markOnboardingDismissedThisSession,
  resolveOnboardingDecisionStep,
} from "../src/onboarding/useOnboardingTrigger.js";

/** 最小控制面 fake：记录调用序列；项目分页按 pages 逐页返回。 */
function fakePort(input: {
  /** 项目分页序列：每个元素是一页项目（items + 可选 nextCursor）。 */
  readonly pages: readonly {
    readonly items: readonly { readonly projectId: string }[];
    readonly nextCursor?: string;
  }[];
  readonly tasksByProject: ReadonlyMap<string, readonly string[]>;
  readonly calls?: string[];
}): CloudControlPlanePort {
  const calls = input.calls;
  let page = 0;
  return {
    listProjects: (() => {
      const current = input.pages[Math.min(page, input.pages.length - 1)] ?? { items: [] };
      if (calls) calls.push(`listProjects:${page}`);
      page += 1;
      return Promise.resolve(
        "nextCursor" in current && current.nextCursor !== undefined
          ? { items: current.items, nextCursor: current.nextCursor }
          : { items: current.items },
      );
    }) as unknown as CloudControlPlanePort["listProjects"],
    listProjectTasks: ((projectId: string) => {
      if (calls) calls.push(`listProjectTasks:${projectId}`);
      const items = input.tasksByProject.get(projectId) ?? [];
      return Promise.resolve({ items });
    }) as unknown as CloudControlPlanePort["listProjectTasks"],
  } as unknown as CloudControlPlanePort;
}

test("account activity probe is true when any project has tasks", async () => {
  const port = fakePort({
    pages: [{ items: [{ projectId: "p-empty" }, { projectId: "p-active" }] }],
    tasksByProject: new Map([
      ["p-empty", []],
      ["p-active", ["t-1"]],
    ]),
  });
  assert.equal(await probeCloudAccountHasActivity(port), true);
});

test("account activity probe is false when every project is empty or there are none", async () => {
  const allEmpty = fakePort({
    pages: [{ items: [{ projectId: "p-1" }, { projectId: "p-2" }] }],
    tasksByProject: new Map([
      ["p-1", []],
      ["p-2", []],
    ]),
  });
  assert.equal(await probeCloudAccountHasActivity(allEmpty), false);
  const noProjects = fakePort({ pages: [{ items: [] }], tasksByProject: new Map() });
  assert.equal(await probeCloudAccountHasActivity(noProjects), false);
});

test("account activity probe follows the project cursor when the first page is empty", async () => {
  const port = fakePort({
    pages: [
      { items: [{ projectId: "p-1" }], nextCursor: "cursor-2" },
      { items: [{ projectId: "p-2" }] },
    ],
    tasksByProject: new Map([["p-2", ["t-9"]]]),
  });
  assert.equal(await probeCloudAccountHasActivity(port), true);
});

test("account activity probe stops at the first project with tasks", async () => {
  const calls: string[] = [];
  const port = fakePort({
    pages: [{ items: [{ projectId: "p-1" }, { projectId: "p-2" }] }],
    tasksByProject: new Map([["p-1", ["t-1"]]]),
    calls,
  });
  assert.equal(await probeCloudAccountHasActivity(port), true);
  // 短路：第一个项目命中后不再发后续请求（探测只回答「有没有」）。
  assert.deepEqual(calls, ["listProjects:0", "listProjectTasks:p-1"]);
});

test("account activity probe surfaces failures for the caller to fall back", async () => {
  const failing = {
    listProjects: () => Promise.reject(new Error("control plane unreachable")),
  } as unknown as CloudControlPlanePort;
  await assert.rejects(probeCloudAccountHasActivity(failing), /control plane unreachable/);
});

test("onboarding decision: settled facts short-circuit before the record path", () => {
  // 账号已有事实（任务/项目）：不是 first-run，不进入 record RPC 等待窗口。
  assert.deepEqual(
    resolveOnboardingDecisionStep({
      cloudAccountHasActivity: true,
      sessionDismissed: false,
      recordServiceAvailable: true,
      hasStoredOccupation: false,
    }),
    { kind: "settled", needsOnboarding: false },
  );
  // 服务不可用（web 无 record channel 等）：退回 settings 判定（既有行为）。
  assert.deepEqual(
    resolveOnboardingDecisionStep({
      cloudAccountHasActivity: null,
      sessionDismissed: false,
      recordServiceAvailable: false,
      hasStoredOccupation: true,
    }),
    { kind: "settled", needsOnboarding: false },
  );
  assert.deepEqual(
    resolveOnboardingDecisionStep({
      cloudAccountHasActivity: null,
      sessionDismissed: false,
      recordServiceAvailable: false,
      hasStoredOccupation: false,
    }),
    { kind: "settled", needsOnboarding: true },
  );
  // 正常路径：交给 record RPC 判定。
  assert.deepEqual(
    resolveOnboardingDecisionStep({
      cloudAccountHasActivity: false,
      sessionDismissed: false,
      recordServiceAvailable: true,
      hasStoredOccupation: false,
    }),
    { kind: "record-path" },
  );
});

test("onboarding decision waits while cloud account facts are pending", () => {
  // 缺陷 F 核心：事实未定（探测进行中）时保持判定中，不得提前定为「需要引导」
  // ——否则已有任务的账号会在探测完成前闪弹（实测复发 3 次）。
  assert.deepEqual(
    resolveOnboardingDecisionStep({
      cloudAccountHasActivity: "pending",
      sessionDismissed: false,
      recordServiceAvailable: true,
      hasStoredOccupation: false,
    }),
    { kind: "wait" },
  );
});

test("onboarding decision: session dismissal wins over every other signal", () => {
  // Close 持久化可能失败（record/settings 写不进去）：至少当次会话不再弹。
  assert.deepEqual(
    resolveOnboardingDecisionStep({
      cloudAccountHasActivity: false,
      sessionDismissed: true,
      recordServiceAvailable: true,
      hasStoredOccupation: false,
    }),
    { kind: "settled", needsOnboarding: false },
  );
});

// 会话级标记的写读配对（模块级状态；放在文件末尾避免影响其他用例的判定输入）。
test("markOnboardingDismissedThisSession flips the session flag", () => {
  assert.equal(isOnboardingDismissedThisSession(), false);
  markOnboardingDismissedThisSession();
  assert.equal(isOnboardingDismissedThisSession(), true);
});

// 复核缺陷 3：同一页面偶发弹 2 次的最后防线——自动弹出过的会话不再二次自动弹。
test("markOnboardingAutoShownThisSession flips the session flag", () => {
  assert.equal(isOnboardingAutoShownThisSession(), false);
  markOnboardingAutoShownThisSession();
  assert.equal(isOnboardingAutoShownThisSession(), true);
});

// 复核缺陷 3：页面加载早期控制面通道可能未就绪，单次探测失败按 1s 重试（至多 3 次），
// 重试期间保持 pending（不渲染向导）；只有全部失败才回落 record 判定。
test("probe retry succeeds after transient channel failures without over-retrying", async () => {
  let attempts = 0;
  const flaky = {
    listProjects: () => {
      attempts += 1;
      if (attempts < 3) return Promise.reject(new Error("channel not ready"));
      return Promise.resolve({ items: [{ projectId: "p-1" }] });
    },
    listProjectTasks: () => Promise.resolve({ items: ["t-1"] }),
  } as unknown as CloudControlPlanePort;
  const sleeps: number[] = [];
  const result = await probeCloudAccountHasActivityWithRetry(flaky, {
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  assert.equal(result, true);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [1_000, 1_000]);
});

test("probe retry gives up after the configured attempts and surfaces the cause", async () => {
  let attempts = 0;
  const failing = {
    listProjects: () => {
      attempts += 1;
      return Promise.reject(new Error("control plane unreachable"));
    },
  } as unknown as CloudControlPlanePort;
  await assert.rejects(
    probeCloudAccountHasActivityWithRetry(failing, {
      sleep: async () => undefined,
    }),
    /control plane unreachable/,
  );
  assert.equal(attempts, CLOUD_ACTIVITY_PROBE_MAX_ATTEMPTS);
});

test("probe retry does not sleep when the first attempt succeeds", async () => {
  let attempts = 0;
  const healthy = {
    listProjects: () => {
      attempts += 1;
      return Promise.resolve({ items: [] });
    },
  } as unknown as CloudControlPlanePort;
  let slept = false;
  const result = await probeCloudAccountHasActivityWithRetry(healthy, {
    sleep: async () => {
      slept = true;
    },
  });
  assert.equal(result, false);
  assert.equal(attempts, 1);
  assert.equal(slept, false);
});

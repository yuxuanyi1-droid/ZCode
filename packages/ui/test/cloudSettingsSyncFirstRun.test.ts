/**
 * 云模式首启「欢迎使用 ZCode」迁移向导（OnboardingDialog / useSettingsSync）的
 * 自动弹出与关闭持久化用例（2026-10-09 用户实测复发）。
 *
 * 实测缺陷：云模式（settings-sync 频道不在 host /ws 暴露面）下每次刷新都弹完整版
 * 欢迎向导且 X /「开始使用 ZCode」关闭后刷新复现——server.log 实证每轮刷新两条
 * `Unknown channel: settings-sync`（getFirstRunPromptState 读 + markFirstRunPromptHandled
 * 写都失败）。此前三轮修复都改在 OccupationOnboarding 链路，未覆盖本向导。
 * 修复语义（本文件锁定）：
 * - 挂载引导 fail-closed：首启状态读取失败收敛为「不弹」，绝不按「未处理」自动弹
 *   （读不到的键在关闭路径上同样写不进，fail-open 即死循环）；
 * - 账号事实短路：云模式账号已有任务/项目挂载即不弹；事实 pending 期间等待不闪弹；
 * - 关闭持久化读写同键：settings-sync RPC 失败回落 settingService 直写
 *   `settingsSyncFirstRunPromptHandled`——与读取端判定的是同一个 AppSettings 字段。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  FIRST_RUN_PROMPT_HANDLED_SETTING_PATCH,
  persistSettingsSyncFirstRunHandled,
  resolveSettingsSyncFirstRunDecision,
  runSettingsSyncFirstRunPromptBootstrap,
} from "../src/hooks/useSettingsSync.js";

test("first-run decision skips handled prompts regardless of account facts", () => {
  assert.deepEqual(
    resolveSettingsSyncFirstRunDecision({ promptHandled: true, cloudAccountHasActivity: null }),
    { kind: "skip", reason: "handled" },
  );
  // 已处理时不必等待账号事实（省一轮探测等待窗口）。
  assert.deepEqual(
    resolveSettingsSyncFirstRunDecision({
      promptHandled: true,
      cloudAccountHasActivity: "pending",
    }),
    { kind: "skip", reason: "handled" },
  );
});

test("first-run decision skips when the cloud account already has tasks or projects", () => {
  // 账号已有使用事实：不是 first-run，即使提示尚未消费也不弹。
  assert.deepEqual(
    resolveSettingsSyncFirstRunDecision({ promptHandled: false, cloudAccountHasActivity: true }),
    { kind: "skip", reason: "account-active" },
  );
});

test("first-run decision waits while cloud account facts are pending", () => {
  // 事实未定（探测进行中）：保持关闭等待，不得提前定为「要弹」——
  // 否则已有任务的账号会在探测完成前闪弹（与 OccupationOnboarding 缺陷 F 同型）。
  assert.deepEqual(
    resolveSettingsSyncFirstRunDecision({
      promptHandled: false,
      cloudAccountHasActivity: "pending",
    }),
    { kind: "wait" },
  );
});

test("first-run decision proceeds to detect when unhandled and there is no contrary fact", () => {
  // 云模式探测定论「无账号事实」。
  assert.deepEqual(
    resolveSettingsSyncFirstRunDecision({ promptHandled: false, cloudAccountHasActivity: false }),
    { kind: "detect" },
  );
  // 非云模式（null）：判定不变。
  assert.deepEqual(
    resolveSettingsSyncFirstRunDecision({ promptHandled: false, cloudAccountHasActivity: null }),
    { kind: "detect" },
  );
});

function bootstrapInput(overrides?: {
  readonly cloudAccountHasActivity?: boolean | null | "pending";
  readonly getFirstRunPromptState?: () => Promise<{ readonly handled: boolean }>;
  readonly loadDiscovery?: () => Promise<void>;
}) {
  const calls = { settleClosed: 0, loadDiscovery: 0, logUnavailable: 0 };
  return {
    calls,
    input: {
      cloudAccountHasActivity: overrides?.cloudAccountHasActivity ?? null,
      getFirstRunPromptState:
        overrides?.getFirstRunPromptState ?? (() => Promise.resolve({ handled: false })),
      loadDiscovery:
        overrides?.loadDiscovery ??
        (() => {
          calls.loadDiscovery += 1;
          return Promise.resolve();
        }),
      settleClosed: () => {
        calls.settleClosed += 1;
      },
      logUnavailable: () => {
        calls.logUnavailable += 1;
      },
    },
  };
}

test("bootstrap: an account with tasks never opens the wizard on mount", async () => {
  // 有任务/项目的账号：即使提示未消费也挂载即不弹（回归：此前探测只接
  // OccupationOnboarding 触发器，本向导挂载时机上短路不生效）。
  const { calls, input } = bootstrapInput({ cloudAccountHasActivity: true });
  await runSettingsSyncFirstRunPromptBootstrap(input);
  assert.equal(calls.settleClosed, 1);
  assert.equal(calls.loadDiscovery, 0);
});

test("bootstrap: unhandled prompt without account activity goes to discovery once", async () => {
  // 无任务首访：走 detect / 展示链（「首访弹一次」的触发半边；关闭持久化见下方用例）。
  const { calls, input } = bootstrapInput({ cloudAccountHasActivity: false });
  await runSettingsSyncFirstRunPromptBootstrap(input);
  assert.equal(calls.settleClosed, 0);
  assert.equal(calls.loadDiscovery, 1);

  const desktop = bootstrapInput({ cloudAccountHasActivity: null });
  await runSettingsSyncFirstRunPromptBootstrap(desktop.input);
  assert.equal(desktop.calls.loadDiscovery, 1);
});

test("bootstrap: pending account facts hold the wizard closed instead of flashing it", async () => {
  const { calls, input } = bootstrapInput({ cloudAccountHasActivity: "pending" });
  await runSettingsSyncFirstRunPromptBootstrap(input);
  assert.equal(calls.settleClosed, 0);
  assert.equal(calls.loadDiscovery, 0);
});

test("bootstrap: unreadable prompt state fails closed instead of auto-opening", async () => {
  // 回归核心：云模式 settings-sync 频道缺失（读取被 Unknown channel 拒绝）时，
  // 旧实现把读取失败当「未处理」自动弹向导且关闭写不进 → 每次刷新必弹。
  // 修复后：记录诊断并收敛到关闭态，绝不自动弹。
  const { calls, input } = bootstrapInput({
    getFirstRunPromptState: () => Promise.reject(new Error("Unknown channel: settings-sync")),
  });
  await runSettingsSyncFirstRunPromptBootstrap(input);
  assert.equal(calls.logUnavailable, 1);
  assert.equal(calls.settleClosed, 1);
  assert.equal(calls.loadDiscovery, 0);
});

test("bootstrap: loadDiscovery failures propagate to the caller's guard", async () => {
  const { input } = bootstrapInput({
    loadDiscovery: () => Promise.reject(new Error("detect exploded")),
  });
  await assert.rejects(runSettingsSyncFirstRunPromptBootstrap(input), /detect exploded/);
});

test("close persistence prefers the settings-sync RPC and skips the fallback on success", async () => {
  let fallbackWrites = 0;
  const outcome = await persistSettingsSyncFirstRunHandled({
    markHandledViaRpc: () => Promise.resolve(),
    writeSettingFallback: () => {
      fallbackWrites += 1;
      return Promise.resolve();
    },
  });
  assert.equal(outcome, "rpc");
  assert.equal(fallbackWrites, 0);
});

test("close persistence falls back to the settings write when the RPC channel is missing", async () => {
  // 云模式：markFirstRunPromptHandled 走 Unknown channel 超时拒绝，回落 settingService
  // 直写（在云 host 暴露面内），关闭才能跨刷新持久。
  let fallbackWrites = 0;
  const outcome = await persistSettingsSyncFirstRunHandled({
    markHandledViaRpc: () => Promise.reject(new Error("Unknown channel: settings-sync")),
    writeSettingFallback: () => {
      fallbackWrites += 1;
      return Promise.resolve();
    },
  });
  assert.equal(outcome, "fallback");
  assert.equal(fallbackWrites, 1);
});

test("close persistence surfaces the failure when both the RPC and the fallback fail", async () => {
  await assert.rejects(
    persistSettingsSyncFirstRunHandled({
      markHandledViaRpc: () => Promise.reject(new Error("rpc down")),
      writeSettingFallback: () => Promise.reject(new Error("settings down")),
    }),
    /settings down/,
  );
});

test("close persistence writes the exact key the read side judges (read key = write key)", () => {
  // 读写同键契约：读取端 settingsSyncService.getFirstRunPromptState 判定
  // `settings.settingsSyncFirstRunPromptHandled === true`；回落写入必须是同一字段，
  // 否则关闭永远无法阻止下一次自动弹（本缺陷「修复未生效」的共同根因形态）。
  assert.deepEqual(FIRST_RUN_PROMPT_HANDLED_SETTING_PATCH, {
    settingsSyncFirstRunPromptHandled: true,
  });
  assert.deepEqual(Object.keys(FIRST_RUN_PROMPT_HANDLED_SETTING_PATCH), [
    "settingsSyncFirstRunPromptHandled",
  ]);
});

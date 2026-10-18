/**
 * 云任务模型选择恢复门控用例（2026-10-17 真机缺陷：切换模型后选择器仍显示原模型）。
 *
 * 缺陷链：云任务视图的 workspace configOptions 水合失败 → `configOptionsError` 为真；
 * 选择器的自定义 provider 命中原「桌面恢复通路」（apiKey access + 提供了恢复 handler），
 * 分支直接进入 `onRecoverCustomModelSelection`，而恢复依赖的 `zcode-task` 频道在云模式
 * 不存在（restartWorkspaceProcess 被拒），Promise 拒绝后分支 return，正常 `onSelectModel`
 * 从未调用——用户的显式选择被吞掉，选择器停留原模型。
 *
 * 修复语义（specs/cloud-agent/04 §3.2 2026-10-17 修订）：
 * - 恢复通路是桌面本地专用；云工作区不提供恢复 handler（SessionPane 门控），
 *   任何 configOptions 错误都不得劫持云任务视图的模型点击；
 * - 纯判定只有四者全真才尝试恢复，本函数不感知云概念，门控由调用方完成。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { shouldAttemptCustomModelRecovery } from "../src/v4/composer/modelSelectRecovery.js";

const RECOVERY_INPUT = {
  configOptionsError: true,
  decodedProviderId: "bigmodel-api",
  recoveryHandlerAvailable: true,
  providerApiKeyAccess: true,
} as const;

test("all four facts true attempts custom provider recovery", () => {
  assert.equal(shouldAttemptCustomModelRecovery(RECOVERY_INPUT), true);
});

test("a cloud workspace without the recovery handler never enters the desktop path", () => {
  // 云工作区一律不传恢复 handler（SessionPane 按 isCloudWorkspace 门控）：
  // 即使 configOptions 错误、provider 是 apiKey access，也必须走正常 onSelectModel。
  assert.equal(
    shouldAttemptCustomModelRecovery({ ...RECOVERY_INPUT, recoveryHandlerAvailable: false }),
    false,
  );
});

test("no configOptions error selects normally", () => {
  assert.equal(
    shouldAttemptCustomModelRecovery({ ...RECOVERY_INPUT, configOptionsError: false }),
    false,
  );
});

test("a non api-key provider selects normally", () => {
  assert.equal(
    shouldAttemptCustomModelRecovery({ ...RECOVERY_INPUT, providerApiKeyAccess: false }),
    false,
  );
});

test("a missing decoded provider id selects normally", () => {
  for (const decodedProviderId of [null, ""]) {
    assert.equal(shouldAttemptCustomModelRecovery({ ...RECOVERY_INPUT, decodedProviderId }), false);
  }
});

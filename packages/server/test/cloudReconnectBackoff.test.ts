/**
 * 执行节点重连退避上限（2026-10-18 恢复慢修复）：
 * provider pause/resume 会冻结进程，恢复时不应再等 60s 档；上限降到 10s（+25% jitter）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_RECONNECT_DELAY_MS,
  nextReconnectDelayMs,
} from "../src/cloud/execution/domain/supervision.js";

test("重连退避上限 10s：高 attempt 不再放大到 60s", () => {
  assert.equal(MAX_RECONNECT_DELAY_MS, 10_000);
  assert.equal(nextReconnectDelayMs(0, 0), 1_000);
  assert.equal(nextReconnectDelayMs(1, 0), 2_000);
  assert.equal(nextReconnectDelayMs(2, 0), 4_000);
  assert.equal(nextReconnectDelayMs(3, 0), 8_000);
  assert.equal(nextReconnectDelayMs(4, 0), 10_000);
  assert.equal(nextReconnectDelayMs(10, 0), 10_000);
  // jitter 最多再放大 25%，仍有界。
  assert.equal(nextReconnectDelayMs(10, 0.999), 12_498);
});

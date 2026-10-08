/**
 * composer 发送/停止控制簇用例（2026-10-08 复检修订，P3）。
 *
 * 巡检缺陷（云 Web）：运行中 composer 有草稿时发送位切换成「Queue message」，旧状态机
 * （streaming + 空草稿 → Stop；有草稿 → 发送键）让 Stop 完全不可达——手机端没有 Esc
 * 键，用户写下一段提示后无法停止任务。修复语义（resolveComposerSubmitControls）：
 * - 运行中 + 空草稿：Stop 独占发送位（旧语义保持，桌面布局零变化）；
 * - 运行中 + 有草稿：发送（入队）保留，且发送旁并置 Stop（data-testid=v4-stop 复用）；
 * - 空闲：只呈现发送按钮。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { resolveComposerSubmitControls } from "../src/v4/composer/composerSubmitControls.js";

test("running with an empty draft keeps the legacy exclusive stop control", () => {
  const plan = resolveComposerSubmitControls({ canStop: true, hasDraftToSubmit: false });
  assert.equal(plan.showsStopControl, true);
  assert.equal(plan.showsSendControl, false);
  assert.equal(plan.showsStopAlongsideSend, false);
});

test("running with a draft keeps both the queue send and an alongside stop", () => {
  // 这是本缺陷的核心场景：有草稿 ≠ 失去停止入口。
  const plan = resolveComposerSubmitControls({ canStop: true, hasDraftToSubmit: true });
  assert.equal(plan.showsStopControl, false);
  assert.equal(plan.showsSendControl, true);
  assert.equal(plan.showsStopAlongsideSend, true);
});

test("idle sessions only expose the send control", () => {
  for (const hasDraftToSubmit of [true, false]) {
    const plan = resolveComposerSubmitControls({ canStop: false, hasDraftToSubmit });
    assert.equal(plan.showsStopControl, false);
    assert.equal(plan.showsSendControl, hasDraftToSubmit);
    assert.equal(plan.showsStopAlongsideSend, false);
  }
});

/**
 * 云任务发送后新 session 首批行到达的贴底收口（纯逻辑）。
 *
 * 回归背景：会话切换时 rows 尚未到达，session effect 的空布局 scrollToBottom 会写入
 * scrollTop=0，其下一帧 rAF 也可能在内容渲染后再次写 0；后续 rows 到达时没有可靠的
 * “新会话首次有行 → 贴底”收口。ConversationTimeline 用
 * `shouldStickToBottomOnSessionRowsArrived` 决定是否收口：只有 sessionKey 确实变化、
 * 行已到达且滚动权仍在 follow 时才贴底；离底 scroll memory 恢复的 following=false
 * 必须保留阅读位置。
 *
 * 该模块依赖 bundler 资源（.svg/.png/.css），Node 测试只加载纯函数，所以先注册一个
 * 资源降级 loader，再动态导入组件模块。
 */
import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register(
  `data:text/javascript,${encodeURIComponent(`
const ASSET_RE = /\\.(svg|png|jpe?g|gif|webp|avif|woff2?|ttf|otf|mp3|mp4|wav|webm|css)$/;
export async function resolve(specifier, context, nextResolve) {
  if (ASSET_RE.test(specifier)) {
    return { url: new URL(specifier, context.parentURL).href, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
export async function load(url, context, nextLoad) {
  if (ASSET_RE.test(url)) {
    return { format: "module", source: "export default '';", shortCircuit: true };
  }
  return nextLoad(url, context);
}
`)}`,
);

const { shouldStickToBottomOnSessionRowsArrived, shouldCenterEmptyStateWithDock } =
  await import("../src/v4/ConversationTimeline.js");

test("draft → session：首批行到达且仍跟随时收口贴底", () => {
  assert.equal(
    shouldStickToBottomOnSessionRowsArrived({
      previousSessionKey: "draft",
      currentSessionKey: "session-1",
      rowCount: 3,
      following: true,
    }),
    true,
  );
});

test("session → session：首批行到达且仍跟随时收口贴底", () => {
  assert.equal(
    shouldStickToBottomOnSessionRowsArrived({
      previousSessionKey: "session-1",
      currentSessionKey: "session-2",
      rowCount: 12,
      following: true,
    }),
    true,
  );
});

test("sessionKey 未变化时不在普通行更新上收口", () => {
  assert.equal(
    shouldStickToBottomOnSessionRowsArrived({
      previousSessionKey: "session-1",
      currentSessionKey: "session-1",
      rowCount: 12,
      following: true,
    }),
    false,
  );
});

test("目标 session 尚无行时等待，不写空布局", () => {
  assert.equal(
    shouldStickToBottomOnSessionRowsArrived({
      previousSessionKey: "draft",
      currentSessionKey: "session-1",
      rowCount: 0,
      following: true,
    }),
    false,
  );
});

test("scroll memory 已恢复离底位置时不得抢回滚动权", () => {
  assert.equal(
    shouldStickToBottomOnSessionRowsArrived({
      previousSessionKey: "session-1",
      currentSessionKey: "session-2",
      rowCount: 12,
      following: false,
    }),
    false,
  );
});

// ── 云任务未绑定会话（paused / 投影未落定）的滚动复位回归 ──
// 实测缺陷：跨 run 历史在 headerSlot、时间线自身无行，pane 仍按草稿态传
// centerEmptyStateWithDock=true。若把这种状态当作「空态居中」，scrollToBottom 会写
// scrollTop=0，表现为一进会话在顶部、输入任意字符又跳回顶部。

test("真正的空草稿（无 header、无行）才使用居中空态", () => {
  assert.equal(
    shouldCenterEmptyStateWithDock({
      centerEmptyStateWithDock: true,
      renderUnitCount: 0,
      hasHeaderSlot: false,
    }),
    true,
  );
});

test("headerSlot 有跨 run 历史时不使用居中空态（必须按内容流吸底）", () => {
  assert.equal(
    shouldCenterEmptyStateWithDock({
      centerEmptyStateWithDock: true,
      renderUnitCount: 0,
      hasHeaderSlot: true,
    }),
    false,
  );
});

test("已有渲染行时不使用居中空态", () => {
  assert.equal(
    shouldCenterEmptyStateWithDock({
      centerEmptyStateWithDock: true,
      renderUnitCount: 3,
      hasHeaderSlot: false,
    }),
    false,
  );
});

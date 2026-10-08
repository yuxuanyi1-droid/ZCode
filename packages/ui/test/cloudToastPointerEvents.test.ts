/**
 * Toast 覆盖层 pointer-events 契约用例（2026-10-07 终验缺陷 G）。
 *
 * 缺陷 G：窗格顶部横幅（v4 重连条 / 云任务状态横幅）上的「View technical details /
 * Reconnect」按钮点击被拦截、无头验证需要 force click。排查结论：仓库内的跑马灯
 * （TaskTitleOverflowText）被根节点 overflow-hidden 裁剪、BorderBeam 装饰层自带
 * pointer-events:none，都不拦截；真正未设防的**固定定位文本覆盖层**是 toast 栈——
 * `fixed top-16 left-1/2 z-[9999]` 恰好压在窗格顶部横幅区，归档失败/连接提示等
 * toast 展示期间整个矩形拦截点击（durationMs:0 的持续 toast 会无限期拦截）。
 *
 * 修复契约（DOM 类断言，react-dom/server 渲染、无需浏览器环境）：
 * - 栈容器（纯布局装饰层）一律 `pointer-events-none`：toast 存在期间不拦截下方按钮；
 * - toast 卡片自身 `pointer-events-auto`：action/关闭按钮与 hover 保持可用。
 */
import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToString } from "react-dom/server";
import {
  resolveToastStackClassName,
  ToastMessageView,
  type ToastItem,
} from "../src/components/ui/toast.js";

test("toast stack containers are pointer-events-none at every position", () => {
  // 栈容器是 fixed z-[9999] 的覆盖层：必须整体放行点击，不拦截下方横幅按钮。
  for (const position of ["top-center", "top-right", "bottom-center", "bottom-left"] as const) {
    const className = resolveToastStackClassName(position);
    assert.ok(
      className.includes("pointer-events-none"),
      `stack ${position} must include pointer-events-none, got: ${className}`,
    );
    assert.ok(className.includes("fixed"), `stack ${position} stays fixed, got: ${className}`);
  }
});

function renderToastCard(item: Partial<ToastItem>): string {
  return renderToString(
    React.createElement(ToastMessageView, {
      item: {
        id: 1,
        message: "存在进行中的运行，先停止任务后再归档。",
        durationMs: 3000,
        position: "top-center",
        ...item,
      },
      visible: true,
      title: "存在进行中的运行，先停止任务后再归档。",
      body: "",
      onAction: () => {},
      onDismiss: () => {},
    }),
  );
}

test("toast cards re-enable pointer events for their own controls", () => {
  // 缺省卡片：pointer-events-auto 恢复交互（栈容器是 none，卡片不恢复则 toast
  // 自身的 action/关闭按钮也点不到）。
  const plain = renderToastCard({});
  assert.ok(plain.includes("pointer-events-auto"), `card must include pointer-events-auto`);
  assert.ok(plain.includes("存在进行中的运行"));
});

test("anchored notices and action toasts keep interactive controls clickable", () => {
  // 带 action 的通知卡（warning/info 变体）：pointer-events-auto + action 按钮可定位。
  const notice = renderToastCard({
    variant: "warning",
    actionLabel: "停止任务",
    dismissible: true,
    dismissLabel: "Close",
  });
  assert.ok(notice.includes("pointer-events-auto"));
  assert.ok(notice.includes("停止任务"));
  assert.ok(notice.includes("Close"));
});

/**
 * 订阅错误呈现分类用例（2026-10-08 巡检修订，P1）。
 *
 * 回归背景：云任务首条消息 attach 用空串 `workspace.workspacePath` 订阅被 runtime
 * zod 拒绝，`SessionSubscriptionErrorPanel` 把 `state.lastError`（issues 数组 JSON）
 * 当对话正文渲染，右侧出现原始协议调试信息。分类规则保证：
 * - zod issues JSON / `Invalid params — [...]` → structured-validation（专门文案）；
 * - 其它错误保持 generic（原文降级为次要细节，不进正文）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  classifySubscribeError,
  isStructuredValidationIssuesText,
} from "../src/v4/subscribeErrorPresentation.js";

const ZOD_ISSUES_JSON = JSON.stringify([
  {
    origin: "string",
    code: "too_small",
    minimum: 1,
    input: "",
    path: ["workspace", "workspacePath"],
    message: "Too small: expected string to have >=1 characters",
  },
]);

test("zod issues JSON is classified as structured validation", () => {
  assert.equal(isStructuredValidationIssuesText(ZOD_ISSUES_JSON), true);
  const presentation = classifySubscribeError(ZOD_ISSUES_JSON);
  assert.equal(presentation.kind, "structured-validation");
  assert.equal(presentation.detail, ZOD_ISSUES_JSON);
});

test("Invalid params with an embedded issues array is structured validation", () => {
  const message = `Invalid params — ${ZOD_ISSUES_JSON}`;
  const presentation = classifySubscribeError(message);
  assert.equal(presentation.kind, "structured-validation");
  assert.equal(presentation.detail, message);
});

test("plain fault strings stay generic and keep the original detail", () => {
  for (const raw of ["fault.subscribe.sessionNotFound", "ZCode agent transport closed", "  ", ""]) {
    const presentation = classifySubscribeError(raw);
    assert.equal(presentation.kind, "generic", raw);
    assert.equal(presentation.detail, raw.trim() === "" ? null : raw.trim());
  }
});

test("non-issue JSON arrays are not mistaken for structured validation", () => {
  assert.equal(isStructuredValidationIssuesText(JSON.stringify([1, 2, 3])), false);
  assert.equal(isStructuredValidationIssuesText(JSON.stringify([{ foo: "bar" }])), false);
  assert.equal(isStructuredValidationIssuesText("not json"), false);
  assert.equal(classifySubscribeError(JSON.stringify([{ foo: "bar" }])).kind, "generic");
});

test("null/undefined errors resolve to a generic presentation without detail", () => {
  assert.deepEqual(classifySubscribeError(null), { kind: "generic", detail: null });
  assert.deepEqual(classifySubscribeError(undefined), { kind: "generic", detail: null });
});

// 2026-10-09 paused 呈现修订：云执行域「无 ready attachment」的结构化拒绝不是
// 「与代理的连接已断开」——按状态归一成专门标题，裸 reason 只进技术细节区。
test("cloud attachment-unavailable rejections are classified as cloud-unavailable", () => {
  const withTaskId = "cloud task 1a03688c-d2f9-4abd-b682-37532f69e8ec has no ready run attachment";
  const presentation = classifySubscribeError(withTaskId);
  assert.equal(presentation.kind, "cloud-unavailable");
  assert.deepEqual(presentation.kind === "cloud-unavailable" ? presentation.detail : null, withTaskId);

  const defaultReason = "cloud task has no ready run attachment";
  assert.equal(classifySubscribeError(defaultReason).kind, "cloud-unavailable");

  // 断连等其它错误不被误分类，仍走 generic（重连文案）。
  assert.equal(classifySubscribeError("transport closed before handshake").kind, "generic");
});

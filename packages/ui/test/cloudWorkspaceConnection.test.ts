/**
 * W8 连接 / 错误归一用例（specs/cloud-agent 04 §6、03 §7.1、07 §5、
 * 验收 W-08/W-11/W-18）。
 *
 * 覆盖：断连与未 ready 一律走 `attachment_unavailable` 的显式不可用面；
 * UI 只按 frozen 错误码分支，不解析异常文案（09 §8 归一要求）。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  isCloudApiErrorLike,
  isCloudApiErrorRetryable,
  isCloudResyncRequiredError,
  readCloudErrorCode,
} from "../src/cloud/cloudApiErrorLike.js";
import {
  CloudServiceUnavailableError,
  CLOUD_ATTACHMENT_UNAVAILABLE_CODE,
  createUnavailableServiceAccessor,
  getCloudAttachmentUnavailableServices,
  isCloudServiceUnavailableError,
  resetCloudUnavailableServiceAccessorForTests,
} from "../src/cloud/unavailableServiceAccessor.js";
import { describeCloudSubmissionError } from "../src/cloud/cloudTaskSubmission.js";
import { CLOUD_ERROR_RETRYABLE } from "@zcode/shared";

test("the unavailable accessor rejects commands and yields empty event subscriptions", async () => {
  const accessor = createUnavailableServiceAccessor({
    code: CLOUD_ATTACHMENT_UNAVAILABLE_CODE,
    reason: "cloud task has no ready run attachment",
  });

  await assert.rejects(
    async () =>
      (
        accessor.terminalService as unknown as { createTerminal(): Promise<unknown> }
      ).createTerminal(),
    (error: unknown) => {
      assert.ok(isCloudServiceUnavailableError(error));
      assert.equal(error.code, "attachment_unavailable");
      // retryable 只表示 attachment 恢复后可重试同一操作，不代表可以回落本机（07 §5）。
      assert.equal(CLOUD_ERROR_RETRYABLE.attachment_unavailable, true);
      return true;
    },
  );

  // 事件监听返回空订阅而不是 Promise：避免被误当成 RPC 方法而二次崩溃。
  const subscription = (
    accessor.zcodeSessionService as unknown as { onDidChange: () => { dispose(): void } }
  ).onDidChange();
  assert.equal(typeof subscription.dispose, "function");
});

test("the shared unavailable accessor is stable across calls", () => {
  resetCloudUnavailableServiceAccessorForTests();
  const first = getCloudAttachmentUnavailableServices();
  const second = getCloudAttachmentUnavailableServices();
  // 同一份实例：避免每次渲染都新建代理对象而让下游 memo 失效。
  assert.equal(first, second);
  resetCloudUnavailableServiceAccessorForTests();
  assert.notEqual(getCloudAttachmentUnavailableServices(), first);
});

test("the unavailable error carries the frozen code rather than prose", () => {
  const error = new CloudServiceUnavailableError(CLOUD_ATTACHMENT_UNAVAILABLE_CODE);
  assert.equal(error.code, "attachment_unavailable");
  assert.equal(error.name, "CloudServiceUnavailableError");
});

test("structured cloud errors are classified by code, never by message text", () => {
  // SDK 抛出的 CloudApiError 形状（UI 不 import SDK，只按形状识别）。
  const apiError = Object.assign(new Error("upstream exploded"), {
    code: "stale",
    retryable: false,
    source: "envelope",
    httpStatus: 409,
  });
  assert.equal(isCloudApiErrorLike(apiError), true);
  assert.equal(readCloudErrorCode(apiError), "stale");
  assert.equal(isCloudApiErrorRetryable(apiError), false);
  assert.equal(describeCloudSubmissionError(apiError), "stale");

  // 非结构化错误不能靠文案猜语义：返回原文由调用方按「结果未知」处理。
  assert.equal(readCloudErrorCode(new Error("socket hang up")), null);
  assert.equal(isCloudApiErrorRetryable(new Error("socket hang up")), false);
  assert.equal(describeCloudSubmissionError(new Error("socket hang up")), "socket hang up");

  // 未知 code 不采信（目录外的东西不能进语义分支）。
  assert.equal(readCloudErrorCode({ code: "totally-made-up" }), null);
});

test("resync is recognized as a control signal, not as a delivery failure", () => {
  const resync = Object.assign(new Error("cursor out of retention window"), {
    name: "CloudResyncRequiredError",
    reason: "retention-window",
  });
  assert.equal(isCloudResyncRequiredError(resync), true);
  // 归一文案固定：调用方据此改读快照，不把它显示成发送失败（03 §9）。
  assert.equal(describeCloudSubmissionError(resync), "cloud input receipt requires resync");
  assert.equal(isCloudResyncRequiredError(new Error("other")), false);
});

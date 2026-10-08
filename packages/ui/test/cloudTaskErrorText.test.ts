/**
 * 云任务动作错误文案归一用例（specs/cloud-agent/04 §6、2026-10-08 巡检修订）。
 *
 * 巡检缺陷：归档被拒时 toast 显示原始错误码（`validation_failed`），用户无法行动。
 * 修复语义：
 * - 结构化错误码映射成 `cloud.errors.*` i18n key，由调用方取文案；
 * - 未映射的码回落原始码（不猜语义，09 §8）；
 * - 非结构化错误维持 `describeCloudSubmissionError` 的既有结果。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  cloudTaskErrorCodeMessageKey,
  describeCloudTaskActionError,
} from "../src/cloud/cloudTaskErrorText.js";

function structuredError(code: string): unknown {
  return { code, retryable: false, source: "server" };
}

test("structured action error codes map to user-readable i18n keys", () => {
  assert.equal(cloudTaskErrorCodeMessageKey("validation_failed"), "cloud.errors.validation_failed");
  assert.equal(cloudTaskErrorCodeMessageKey("not_found"), "cloud.errors.not_found");
  assert.equal(cloudTaskErrorCodeMessageKey("stale"), "cloud.errors.stale");
  assert.equal(cloudTaskErrorCodeMessageKey("rate_limited"), "cloud.errors.rate_limited");
});

test("unmapped codes fall back to the raw code instead of guessing", () => {
  // 目录里存在但没有用户动作语义映射的码（如 checkpoint_failed）：返回 null，
  // 由调用方展示原始码，不造一条可能误导的文案。
  assert.equal(cloudTaskErrorCodeMessageKey("checkpoint_failed"), null);
  assert.equal(cloudTaskErrorCodeMessageKey("definitely-not-a-code"), null);
});

test("describeCloudTaskActionError translates mapped codes and keeps raw codes otherwise", () => {
  const translate = (id: string) => `[${id}]`;
  assert.equal(
    describeCloudTaskActionError(structuredError("validation_failed"), translate),
    "[cloud.errors.validation_failed]",
  );
  assert.equal(
    describeCloudTaskActionError(structuredError("checkpoint_failed"), translate),
    "checkpoint_failed",
  );
  // 非结构化错误：维持既有归一（Error.message / String）。
  assert.equal(describeCloudTaskActionError(new Error("boom"), translate), "boom");
});

// draining 中归档静默失败（2026-10-08 复检修订，P3）：服务端对 run draining 中的
// 归档请求返回 400 `validation_failed` / detail `task-has-active-run`（语义正确），
// 但确认框关闭后必须 toast 归一后的理由——侧栏行与 Header 两处入口共用
// `cloud.tasks.archiveFailed` + describeCloudTaskActionError 这条接线（04 §6）。
// 这里锁定「结构化拒绝 → 可读 reason → toast 文案非空且不含原始码」的完整链路。
test("draining archive rejection composes a readable archiveFailed toast reason", () => {
  // 形状对齐 SDK CloudApiError.fromEnvelope（服务端 taskLifecycle.ts 的
  // fail("validation_failed", "task-has-active-run") 信封）。
  const drainingRejection = Object.assign(new Error("task has an active run"), {
    code: "validation_failed",
    retryable: false,
    source: "server",
    httpStatus: 400,
    details: { reason: "task-has-active-run" },
  });
  const translate = (id: string) => `#${id}`;
  const reason = describeCloudTaskActionError(drainingRejection, translate);
  // reason 是归一后的 i18n 文案（不再是原始错误码本身），toast 不空、可行动。
  assert.equal(reason, "#cloud.errors.validation_failed");
  const toastMessage = `归档任务失败：${reason}`;
  assert.ok(toastMessage.includes("#cloud.errors.validation_failed"));
  assert.ok(toastMessage.trim().length > "归档任务失败：".length);
});

test("unmapped draining rejections still surface the raw code instead of an empty toast", () => {
  const unknownRejection = Object.assign(new Error("weird state"), {
    code: "not_a_known_code",
    retryable: false,
  });
  // readCloudErrorCode 只认 shared 目录里的码，未知码按非结构化 Error 处理。
  const reason = describeCloudTaskActionError(unknownRejection, (id) => `#${id}`);
  assert.equal(reason, "weird state");
  assert.ok(reason.trim().length > 0);
});

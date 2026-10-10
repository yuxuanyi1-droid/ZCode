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
  cloudInputRejectionMessageKey,
  cloudTaskErrorCodeMessageKey,
  describeCloudComposerRejection,
  describeCloudInputRejection,
  describeCloudTaskActionError,
} from "../src/cloud/cloudTaskErrorText.js";
import { readCloudErrorReason } from "../src/cloud/cloudApiErrorLike.js";

function structuredError(code: string): unknown {
  return { code, retryable: false, source: "server" };
}

test("structured action error codes map to user-readable i18n keys", () => {
  assert.equal(cloudTaskErrorCodeMessageKey("validation_failed"), "cloud.errors.validation_failed");
  assert.equal(cloudTaskErrorCodeMessageKey("not_found"), "cloud.errors.not_found");
  assert.equal(cloudTaskErrorCodeMessageKey("stale"), "cloud.errors.stale");
  assert.equal(cloudTaskErrorCodeMessageKey("rate_limited"), "cloud.errors.rate_limited");
});

// 实测缺陷回归（2026-10-09，历史时间线）：history wire 校验失败时 SDK 归一为
// protocol_incompatible，CloudTaskHistoryTimeline 旧实现把 store 里的原始错误码
// 直接当文案渲染（用户看到 protocolIncompatible 不可行动）。修复后按既有约定
// 走 cloudTaskErrorCodeMessageKey 文案表归一为「版本不兼容」可读提示。
test("history timeline raw error code normalizes through the message key table", () => {
  // store.error 存的是 describeCloudSubmissionError 的结果：结构化错误即原始码字符串。
  assert.equal(
    cloudTaskErrorCodeMessageKey("protocol_incompatible"),
    "cloud.errors.protocol_incompatible",
  );
  // 未映射码 / 非结构化消息：返回 null，组件回落原始串或通用 loadFailed 文案。
  assert.equal(cloudTaskErrorCodeMessageKey("checkpoint_failed"), null);
  assert.equal(cloudTaskErrorCodeMessageKey("fetch failed"), null);
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
  // 形状对齐 SDK CloudApiError.fromEnvelope（2026-10-09 生命周期 v2 后 taskLifecycle.ts
  // 对活动 run 的归档返回 fail("not_ready", "task-has-active-run") 信封）。
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

// 2026-10-07 终验缺陷 E：活动 run 未终态时归档被拒（409 not_ready/task-has-active-run），
// 旧文案是通用「运行环境尚未就绪，稍后再试」——与真实条件（需先停止）不符且误导重试。
// 修订：任务动作的 not_ready 与输入同表按 details.reason 细分，
// task-has-active-run → 「存在进行中的运行，先停止任务后再归档」。
test("archive not_ready rejection with an active run guides to stop first", () => {
  const translate = (id: string) => `#${id}`;
  const activeRunRejection = Object.assign(new Error("task-has-active-run"), {
    code: "not_ready",
    retryable: false,
    source: "server",
    httpStatus: 409,
    details: { reason: "task-has-active-run" },
  });
  assert.equal(
    describeCloudTaskActionError(activeRunRejection, translate),
    "#cloud.errors.not_ready.task_has_active_run",
  );
  // complete/stop 等动作的未知 reason 维持通用 not_ready 文案，不猜语义。
  const unmappedReason = Object.assign(new Error("completion-drain-in-progress"), {
    code: "not_ready",
    retryable: false,
    details: { reason: "completion-drain-in-progress" },
  });
  assert.equal(describeCloudTaskActionError(unmappedReason, translate), "#cloud.errors.not_ready");
  // 缺失 reason 同样回落通用文案（与修订前任务动作行为一致）。
  const reasonless = Object.assign(new Error("not ready"), {
    code: "not_ready",
    retryable: false,
  });
  assert.equal(describeCloudTaskActionError(reasonless, translate), "#cloud.errors.not_ready");
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

// ── 输入提交失败的 reason 细分（2026-10-08 终态 run 发送行为修订）──
//
// 实测缺陷：run 终态（沙箱已回收）后 composer 发消息，服务端正确返回 409
// `not_ready/no-active-run`，但 UI 只显示原始码「not_ready」。修订语义：
// not_ready 按 `details.reason`（服务端稳定标签，respondFailure 放进信封 details）
// 细分文案；未知/缺失 reason 回落通用 not_ready 文案，不猜语义（09 §8）。

test("not_ready rejections are subdivided by the server reason label", () => {
  assert.equal(
    cloudInputRejectionMessageKey("not_ready", "no-active-run"),
    "cloud.errors.not_ready.no_active_run",
  );
  assert.equal(
    cloudInputRejectionMessageKey("not_ready", "stop-requested"),
    "cloud.errors.not_ready.stop_requested",
  );
  assert.equal(
    cloudInputRejectionMessageKey("not_ready", "run-not-ready"),
    "cloud.errors.not_ready.run_not_ready",
  );
  // 未知 reason 与缺失 reason 都回落通用文案，不猜语义。
  assert.equal(
    cloudInputRejectionMessageKey("not_ready", "some-future-reason"),
    "cloud.errors.not_ready",
  );
  assert.equal(cloudInputRejectionMessageKey("not_ready", null), "cloud.errors.not_ready");
});

test("non-not_ready input rejections reuse the shared action error table", () => {
  assert.equal(
    cloudInputRejectionMessageKey("quota_exceeded", null),
    "cloud.errors.quota_exceeded",
  );
  assert.equal(
    cloudInputRejectionMessageKey("stale", "run-generation-mismatch"),
    "cloud.errors.stale",
  );
  assert.equal(cloudInputRejectionMessageKey("checkpoint_failed", null), null);
});

test("readCloudErrorReason extracts details.reason and rejects malformed shapes", () => {
  assert.equal(readCloudErrorReason({ details: { reason: "no-active-run" } }), "no-active-run");
  assert.equal(readCloudErrorReason({ details: { reason: "  " } }), null);
  assert.equal(readCloudErrorReason({ details: { other: 1 } }), null);
  assert.equal(readCloudErrorReason({ details: "not-an-object" }), null);
  assert.equal(readCloudErrorReason({}), null);
  assert.equal(readCloudErrorReason("boom"), null);
  assert.equal(readCloudErrorReason(null), null);
});

test("describeCloudInputRejection maps the 409 no-active-run envelope to readable text", () => {
  // 形状对齐 SDK CloudApiError.fromEnvelope：服务端 precheckAppend 的
  // fail("not_ready", "no-active-run") 信封（message 与 details.reason 同为 reason）。
  const rejection = Object.assign(new Error("no-active-run"), {
    code: "not_ready",
    retryable: false,
    details: { reason: "no-active-run" },
  });
  assert.equal(
    describeCloudInputRejection(rejection, (id) => `#${id}`),
    "#cloud.errors.not_ready.no_active_run",
  );
  // reason 未知：回落通用 not_ready 文案而不是原始码。
  const otherReason = Object.assign(new Error("whatever"), {
    code: "not_ready",
    retryable: false,
    details: { reason: "unmapped" },
  });
  assert.equal(
    describeCloudInputRejection(otherReason, (id) => `#${id}`),
    "#cloud.errors.not_ready",
  );
});

test("describeCloudComposerRejection prefers the key table and falls back to the raw detail", () => {
  const translate = (id: string) => `#${id}`;
  assert.equal(
    describeCloudComposerRejection(
      { code: "not_ready", reason: "no-active-run", detail: "not_ready" },
      translate,
    ),
    "#cloud.errors.not_ready.no_active_run",
  );
  // 未映射码：回落原始 detail（错误码本身），不造文案。
  assert.equal(
    describeCloudComposerRejection(
      { code: "checkpoint_failed", reason: null, detail: "checkpoint_failed" },
      translate,
    ),
    "checkpoint_failed",
  );
  // 无结构化信息（本地前置失败）：返回 null，由调用方决定提示。
  assert.equal(
    describeCloudComposerRejection({ code: null, reason: null, detail: null }, translate),
    null,
  );
});

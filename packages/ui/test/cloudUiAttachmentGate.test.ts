/**
 * W8 云附件门控断言（specs/cloud-agent 04 §3.0.2/§3.4.1、11 §9、03 §2、W8 报告 CR③ 裁决）。
 *
 * 三条要证明的事实：
 * 1. 云模式 **draft 期**：`capabilities.taskOwnedAttachments === false` 时附件入口
 *    **不可用且带明确原因**——不静默停在 waitingSession、不伪造空附件；
 * 2. 云模式 **ready 期**：附件走 session-bound 上传，且**不会**进入「读本地路径」分支；
 * 3. 结论依据可复核：浏览器无本地文件系统（web 平台能力表）+ 服务不在 attachment 白名单。
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_ATTACHMENT_MESSAGE_IDS,
  describeCloudLocalPathStaging,
  resolveCloudAttachmentGate,
} from "../src/cloud/cloudAttachmentGate.js";

test("draft without task-owned upload support is explicitly unavailable, with a reason", () => {
  const gate = resolveCloudAttachmentGate({
    executionScope: "unavailable",
    taskOwnedAttachments: false,
    taskStatus: "draft",
    hasRuntimeSession: false,
  });

  assert.equal(gate.enabled, false);
  assert.equal(gate.reason, "task-owned-upload-unavailable");
  // 必须解释原因：既有 waitingSession 是「等会话」，会把「这个部署根本不支持」显示成
  // 「再等等」，用户永远等不到。
  assert.equal(gate.disabledMessageId, CLOUD_ATTACHMENT_MESSAGE_IDS.taskOwnedUploadUnavailable);
  assert.equal(gate.uploadChannel, "none");
  // 不伪造空附件：不可用时通道是 none，而不是「上传成功但列表为空」。
  assert.notEqual(gate.uploadChannel, "session");
  assert.notEqual(gate.uploadChannel, "task-owned");
});

test("draft with task-owned upload support routes to the control-plane upload", () => {
  const gate = resolveCloudAttachmentGate({
    executionScope: "unavailable",
    taskOwnedAttachments: true,
    taskStatus: "draft",
    hasRuntimeSession: false,
  });
  assert.equal(gate.enabled, true);
  assert.equal(gate.reason, "task-owned-upload");
  // draft 期没有沙箱，附件只能落在控制面 task-owned 存储（POST /api/cloud/attachments）。
  assert.equal(gate.uploadChannel, "task-owned");
  assert.equal(gate.disabledMessageId, null);
});

test("ready runs upload through the session, never through local-path staging", () => {
  const gate = resolveCloudAttachmentGate({
    executionScope: "attachment-ready",
    taskOwnedAttachments: false,
    taskStatus: "active",
    hasRuntimeSession: true,
  });
  assert.equal(gate.enabled, true);
  assert.equal(gate.reason, "session-upload");
  // session-bound：经当前 Run attachment 落到沙箱（04 §3.0.2）。
  assert.equal(gate.uploadChannel, "session");
  assert.equal(gate.localPathStaging, false);
});

test("a disconnected attachment is unavailable rather than queued or rerouted", () => {
  const gate = resolveCloudAttachmentGate({
    executionScope: "unavailable",
    taskOwnedAttachments: true,
    taskStatus: "active",
    hasRuntimeSession: true,
  });
  assert.equal(gate.enabled, false);
  assert.equal(gate.reason, "attachment-unavailable");
  assert.equal(gate.disabledMessageId, CLOUD_ATTACHMENT_MESSAGE_IDS.attachmentUnavailable);
  // 不排队（没有第二条投递路径）、不回落本机执行域（03 §2 不变量 7）。
  assert.equal(gate.uploadChannel, "none");
});

test("a run that has not reached a session waits for the environment", () => {
  const gate = resolveCloudAttachmentGate({
    executionScope: "unavailable",
    taskOwnedAttachments: false,
    taskStatus: "active",
    hasRuntimeSession: false,
  });
  assert.equal(gate.enabled, false);
  assert.equal(gate.reason, "session-pending");
  assert.equal(gate.disabledMessageId, CLOUD_ATTACHMENT_MESSAGE_IDS.waitingEnvironment);
});

test("local-path staging is unavailable in cloud mode, and the blocking facts are named", () => {
  // 云入口的 IPlatformService（packages/web/src/webPlatform.ts:45-50）：
  // canSelectFilePath=false、selectFile→null、selectFiles→[]。
  // 因此 `item.localPath && isRemoteAttachmentTarget(target)`（:315）永远拿不到 localPath。
  // 注意：云任务 identity 恒非空，isRemoteAttachmentTarget 本身会返回 true ——
  // 真正的拦截点是平台能力与白名单，不是 identity。
  const blockedByPlatform = describeCloudLocalPathStaging({ platformCanSelectFilePath: false });
  assert.equal(blockedByPlatform.available, false);
  assert.deepEqual(blockedByPlatform.blockedBy, ["platform", "allowlist"]);

  // 即便换成一个能返回本地路径的宿主，白名单仍拦住它：PromptAttachmentTransfer 不在
  // CLOUD_ATTACHMENT_SERVICE_ALLOWLIST，且按 CR③ 裁决不加入。
  const blockedByAllowlist = describeCloudLocalPathStaging({ platformCanSelectFilePath: true });
  assert.equal(blockedByAllowlist.available, false);
  assert.deepEqual(blockedByAllowlist.blockedBy, ["allowlist"]);
});

test("every cloud attachment channel reports local-path staging as unavailable", () => {
  const taskStatuses = ["draft", "active", "completed", "failed", "archived"] as const;
  for (const taskStatus of taskStatuses) {
    for (const hasRuntimeSession of [true, false]) {
      for (const executionScope of ["attachment-ready", "unavailable"] as const) {
        for (const taskOwnedAttachments of [true, false]) {
          const gate = resolveCloudAttachmentGate({
            executionScope,
            taskOwnedAttachments,
            taskStatus,
            hasRuntimeSession,
          });
          assert.equal(
            gate.localPathStaging,
            false,
            `local-path staging must stay unavailable for ${taskStatus}/${executionScope}`,
          );
          // 不可用一定带原因，绝不允许「不可用但不说为什么」。
          if (!gate.enabled) {
            assert.ok(
              gate.disabledMessageId !== null,
              `disabled gate for ${taskStatus}/${executionScope} must explain itself`,
            );
            assert.equal(gate.uploadChannel, "none");
          }
        }
      }
    }
  }
});

/**
 * R6 云附件门控断言（specs/cloud-agent/15 §2/§3 R6、04 §3.0.2/§3.4.1、11 §9）。
 *
 * 本轮结论（fail-closed）：durable input 不承载附件引用，云模式任何阶段都不提供
 * 附件入口——draft、有无 runtime session、各 task/run 状态、部署是否声明
 * task-owned 上传，全部恒 disabled，且必须给出明确原因。
 *
 * 同时证明：
 * - 非云模式 `useCloudAttachmentGate` 返回 null，既有本地 / SSH / 远控附件路径不变；
 * - 「本地路径暂存」在云模式恒不可用（浏览器无本地文件系统 + 服务不在白名单）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  CLOUD_ATTACHMENT_MESSAGE_IDS,
  describeCloudLocalPathStaging,
  resolveCloudAttachmentGate,
} from "../src/cloud/cloudAttachmentGate.js";

const TASK_STATUSES = ["draft", "active", "completed", "failed", "archived"] as const;
const EXECUTION_SCOPES = ["attachment-ready", "unavailable"] as const;

test("every cloud draft/ready/run state is disabled for the durable-input reason", () => {
  for (const taskStatus of TASK_STATUSES) {
    for (const hasRuntimeSession of [true, false]) {
      for (const executionScope of EXECUTION_SCOPES) {
        for (const taskOwnedAttachments of [true, false]) {
          const gate = resolveCloudAttachmentGate({
            executionScope,
            taskOwnedAttachments,
            taskStatus,
            hasRuntimeSession,
          });
          const scenario = `${taskStatus}/session=${hasRuntimeSession}/${executionScope}/taskOwned=${taskOwnedAttachments}`;

          // R6 决策：不再存在 session-upload / task-owned-upload 的可用分支。
          assert.equal(gate.enabled, false, `cloud gate must stay disabled for ${scenario}`);
          assert.equal(
            gate.reason,
            "durable-input-unsupported",
            `cloud gate must report the durable-input reason for ${scenario}`,
          );
          assert.equal(
            gate.disabledMessageId,
            CLOUD_ATTACHMENT_MESSAGE_IDS.durableInputUnsupported,
            `disabled gate must explain itself for ${scenario}`,
          );
          // 不伪造通道：不可用时既没有 session 上传，也没有 task-owned 上传。
          assert.equal(gate.uploadChannel, "none", `no upload channel for ${scenario}`);
          assert.equal(gate.localPathStaging, false, `no local-path staging for ${scenario}`);
        }
      }
    }
  }
});

test("the durable-input reason has both zh-CN and en-US copy", () => {
  for (const locale of ["zh-CN", "en-US"] as const) {
    const text = readFileSync(new URL(`../src/i18n/locales/${locale}.ts`, import.meta.url), "utf8");
    // 漏键运行时只会显示 id；中英必须成对新增。
    assert.ok(
      text.includes(`"${CLOUD_ATTACHMENT_MESSAGE_IDS.durableInputUnsupported}"`),
      `${locale} is missing ${CLOUD_ATTACHMENT_MESSAGE_IDS.durableInputUnsupported}`,
    );
  }
});

test("non-cloud workspaces keep the existing attachment path: the hook returns null", async (t) => {
  let createElement: typeof import("react").createElement;
  let renderToStaticMarkup: (element: unknown) => string;
  try {
    ({ createElement } = await import("react"));
    ({ renderToStaticMarkup } = await import("react-dom/server"));
  } catch {
    t.skip("react-dom/server 不可用");
    return;
  }

  const module = await import("../src/hooks/cloud/useCloudAttachmentGate.js");

  function Probe() {
    const gate = module.useCloudAttachmentGate();
    return createElement("span", null, gate === null ? "no-cloud-gate" : gate.reason);
  }

  // 没有 CloudWorkspaceProvider / CloudServicesProvider 时 context 为 null：
  // hook 必须返回 null，让 composer 沿用既有本地 / SSH / 远控附件分支。
  assert.equal(renderToStaticMarkup(createElement(Probe)), "<span>no-cloud-gate</span>");
});

test("local-path staging is unavailable in cloud mode, and the blocking facts are named", () => {
  // 云入口的 IPlatformService（packages/web/src/webPlatform.ts）：canSelectFilePath=false、
  // selectFile→null、selectFiles→[]，因此拿不到 localPath。
  const blockedByPlatform = describeCloudLocalPathStaging({ platformCanSelectFilePath: false });
  assert.equal(blockedByPlatform.available, false);
  assert.deepEqual(blockedByPlatform.blockedBy, ["platform", "allowlist"]);

  // 即便换成一个能返回本地路径的宿主，白名单仍拦住它：PromptAttachmentTransfer 不在
  // CLOUD_ATTACHMENT_SERVICE_ALLOWLIST，且按 spec 不加入。
  const blockedByAllowlist = describeCloudLocalPathStaging({ platformCanSelectFilePath: true });
  assert.equal(blockedByAllowlist.available, false);
  assert.deepEqual(blockedByAllowlist.blockedBy, ["allowlist"]);
});

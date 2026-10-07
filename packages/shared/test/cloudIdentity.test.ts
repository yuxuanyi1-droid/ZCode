// Cloud 身份契约用例（specs/cloud-agent/00 §5、02 §2 不变量 1、08 §4.1）：
// round-trip、非法输入拒绝、非 cloud 身份不冒充。
import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOUD_TASK_IDENTITY_PREFIX,
  buildCloudTaskWorkspaceIdentity,
  isCloudTaskWorkspaceIdentity,
  parseCloudTaskWorkspaceIdentity,
  resolveWorkspaceIdentityKey,
} from "../src/index.js";
import { TASK_ID } from "./cloudFixtures.js";

test("identity round-trip: build → parse", () => {
  const identity = buildCloudTaskWorkspaceIdentity(TASK_ID);
  assert.equal(identity, `${CLOUD_TASK_IDENTITY_PREFIX}${TASK_ID}`);
  assert.deepEqual(parseCloudTaskWorkspaceIdentity(identity), {
    kind: "cloud-task",
    taskId: TASK_ID,
  });
  assert.equal(isCloudTaskWorkspaceIdentity(identity), true);
});

test("identity rejects malformed taskId instead of coercing", () => {
  assert.throws(() => buildCloudTaskWorkspaceIdentity("not-a-uuid"));
  assert.equal(parseCloudTaskWorkspaceIdentity("cloud-task:not-a-uuid"), null);
  assert.equal(parseCloudTaskWorkspaceIdentity(`cloud-task:${TASK_ID.toUpperCase()}`), null);
});

test("identity does not accept other workspace identity kinds", () => {
  // 本机/SSH 身份必须以 null 返回，由调用方按各自规则处理，不得回落本机 cwd。
  assert.equal(parseCloudTaskWorkspaceIdentity("remote:ssh:example"), null);
  assert.equal(parseCloudTaskWorkspaceIdentity(""), null);
});

test("identity key falls back to workspacePath only when identity is blank", () => {
  assert.equal(
    resolveWorkspaceIdentityKey({ workspaceIdentity: ` ${TASK_ID}`, workspacePath: "/tmp/ws" }),
    TASK_ID,
  );
  assert.equal(
    resolveWorkspaceIdentityKey({ workspaceIdentity: "   ", workspacePath: "/tmp/ws" }),
    "/tmp/ws",
  );
  assert.equal(resolveWorkspaceIdentityKey({ workspacePath: "/tmp/ws" }), "/tmp/ws");
});

// createSession 可信 workspacePath 回归（specs/cloud-agent/02 §2、06 §4）：
// - cloud-task:<taskId> 是不透明身份，缺显式 workspacePath 必须 fail-closed，
//   不得落入本地路径 fallback（2026-10-13 V4r 真机：cwd 被污染成 <cwd>/cloud-task:<id>）；
// - 携带可信路径时 identity 保留、workingDirectory 用可信值；
// - 本地路径/remote 身份行为不变；v4 handler 必须把 payload.workspacePath 透传给
//   createSessionRecord。
import assert from "node:assert/strict";
import test from "node:test";
import type { CommandEnvelope } from "@zcode/shared/zcode-protocol-v4";
import {
  resolveWorkspaceRefFromCreateSession,
  resolveWorkspaceRefFromId,
} from "../src/zcode-protocol/workspace.js";
import { NATIVE_HANDLERS } from "../src/zcode-protocol-v4/commands/handlers/index.js";
import type { V4CommandCoreHost } from "../src/zcode-protocol-v4/commands/types.js";

const CLOUD_TASK_ID = "00000000-0000-4000-8000-0000000000b1";
const CLOUD_TASK_IDENTITY = `cloud-task:${CLOUD_TASK_ID}`;

test("cloud-task 身份无 workspacePath：resolveWorkspaceRefFromId fail-closed，不当本地目录", () => {
  assert.throws(
    () => resolveWorkspaceRefFromId(CLOUD_TASK_IDENTITY),
    /requires an explicit workspacePath/,
  );
  // 经 createSession 入口缺省同样拒绝（不能回落）。
  assert.throws(
    () => resolveWorkspaceRefFromCreateSession({ workspaceId: CLOUD_TASK_IDENTITY }),
    /requires an explicit workspacePath/,
  );
  // 非法 cloud-task（前缀存在但 taskId 不可解析）也不得回落本地路径。
  assert.throws(
    () => resolveWorkspaceRefFromId("cloud-task:task-1"),
    /Invalid cloud-task workspace identity/,
  );
});

test("cloud-task 身份携带可信 workspacePath：identity 保留、路径用可信值", () => {
  assert.deepEqual(
    resolveWorkspaceRefFromCreateSession({
      workspaceId: CLOUD_TASK_IDENTITY,
      workspacePath: "/workspace/demo",
    }),
    {
      workspaceIdentity: CLOUD_TASK_IDENTITY,
      workspaceKey: CLOUD_TASK_IDENTITY,
      workspacePath: "/workspace/demo",
    },
  );
});

test("本地路径与 remote 身份语义不变（workspacePath 缺省回落）", () => {
  assert.deepEqual(
    resolveWorkspaceRefFromCreateSession({ workspaceId: "/home/me/project" }),
    {
      workspaceIdentity: undefined,
      workspaceKey: "/home/me/project",
      workspacePath: "/home/me/project",
    },
  );
  assert.deepEqual(
    resolveWorkspaceRefFromCreateSession({
      workspaceId: "remote:ssh:host.example:22:deploy:/srv/app",
    }),
    {
      workspaceIdentity: "remote:ssh:host.example:22:deploy:/srv/app",
      workspaceKey: "remote:ssh:host.example:22:deploy:/srv/app",
      workspacePath: "/srv/app",
    },
  );
});

test("v4 createSession payload 带 workspacePath 时 handler 透传给 createSessionRecord", async () => {
  const captured: Array<{ workspaceId: string; workspacePath?: string }> = [];
  const host = {
    getRecord: () => undefined,
    async createSessionRecord(params: { workspaceId: string; workspacePath?: string }) {
      captured.push(params);
      return { sessionId: "session-created" };
    },
  } as unknown as V4CommandCoreHost;
  const envelope = {
    commandId: "00000000-0000-4000-8000-0000000000b2",
    clientId: `cloud-task:${CLOUD_TASK_ID}`,
    sessionId: null,
    type: "createSession",
    payload: { workspaceId: CLOUD_TASK_IDENTITY, workspacePath: "/workspace/demo" },
    issuedAt: 1_700_000_000_000,
  } as CommandEnvelope;

  const result = await NATIVE_HANDLERS.createSession(host, envelope);
  assert.deepEqual(result, { type: "createSession", sessionId: "session-created" });
  assert.equal(captured.length, 1);
  assert.equal(captured[0]?.workspaceId, CLOUD_TASK_IDENTITY);
  assert.equal(captured[0]?.workspacePath, "/workspace/demo", "可信路径必须透传到 record 建立");
});

test("v4 createSession payload 缺 workspacePath 时 handler 不发明路径", async () => {
  const captured: Array<Record<string, unknown>> = [];
  const host = {
    getRecord: () => undefined,
    async createSessionRecord(params: Record<string, unknown>) {
      captured.push(params);
      return { sessionId: "session-created" };
    },
  } as unknown as V4CommandCoreHost;
  const envelope = {
    commandId: "00000000-0000-4000-8000-0000000000b3",
    clientId: `cloud-task:${CLOUD_TASK_ID}`,
    sessionId: null,
    type: "createSession",
    payload: { workspaceId: CLOUD_TASK_IDENTITY },
    issuedAt: 1_700_000_000_000,
  } as CommandEnvelope;

  await NATIVE_HANDLERS.createSession(host, envelope);
  assert.equal(captured.length, 1);
  assert.equal("workspacePath" in (captured[0] ?? {}), false);
});

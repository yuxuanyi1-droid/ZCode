// createSession.workspacePath 契约用例（specs/cloud-agent/02 §2、§6.2）：
// 控制面/可信发送端携带真实绝对路径；旧发送端缺省（additive）；相对路径拒绝。
import assert from "node:assert/strict";
import test from "node:test";
import { parseCommandEnvelope } from "../src/zcode-protocol-v4/index.js";

const CLOUD_TASK_ID = "00000000-0000-4000-8000-0000000000a1";

function createSessionEnvelope(payload: Record<string, unknown>) {
  return {
    commandId: "00000000-0000-4000-8000-0000000000a2",
    clientId: `cloud-task:${CLOUD_TASK_ID}`,
    sessionId: null,
    type: "createSession",
    payload: {
      workspaceId: `cloud-task:${CLOUD_TASK_ID}`,
      ...payload,
    },
    issuedAt: 1_700_000_000_000,
  };
}

test("createSession.workspacePath round-trip：可信绝对路径原样进入 payload", () => {
  const parsed = parseCommandEnvelope(
    createSessionEnvelope({ workspacePath: "/workspace/demo", firstInput: { text: "go" } }),
  );
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const payload = parsed.envelope.payload as { workspaceId: string; workspacePath?: string };
  assert.equal(payload.workspaceId, `cloud-task:${CLOUD_TASK_ID}`);
  assert.equal(payload.workspacePath, "/workspace/demo");
  // JSON round-trip 保持（additive 字段可经帧/持久层原样传递）。
  const cloned = JSON.parse(JSON.stringify(parsed.envelope)) as typeof parsed.envelope;
  assert.deepEqual(parseCommandEnvelope(cloned), parsed);
});

test("createSession.workspacePath 可选：缺省保持 additive 兼容（旧发送端）", () => {
  const parsed = parseCommandEnvelope(createSessionEnvelope({ firstInput: { text: "go" } }));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal("workspacePath" in (parsed.envelope.payload as object), false);
});

test("createSession.workspacePath 拒绝非 POSIX 绝对路径", () => {
  for (const workspacePath of ["workspace/demo", "./demo", "", "C:\\workspace\\demo"]) {
    const parsed = parseCommandEnvelope(createSessionEnvelope({ workspacePath }));
    assert.equal(parsed.ok, false, `workspacePath=${JSON.stringify(workspacePath)} 必须被拒绝`);
  }
});

test("非 createSession 命令不接受 workspacePath 语义（schema 不声明该键）", () => {
  const parsed = parseCommandEnvelope({
    commandId: "00000000-0000-4000-8000-0000000000a3",
    clientId: `cloud-task:${CLOUD_TASK_ID}`,
    sessionId: "session-1",
    type: "sendText",
    payload: { text: "next", workspacePath: "/workspace/demo" },
    issuedAt: 1_700_000_000_000,
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  // z.object 非 strict：未知键被静默丢弃，不会把路径误当 sendText 字段。
  assert.equal("workspacePath" in (parsed.envelope.payload as Record<string, unknown>), false);
});

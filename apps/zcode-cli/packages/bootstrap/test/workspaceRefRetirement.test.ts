// CLI 侧 workspace ref 解析回归（specs/cloud-agent/06 §4/§5）：
// 退役远端身份必须 fail-closed，不能被还原成本地 workspacePath 继续执行。
import assert from "node:assert/strict";
import test from "node:test";
import {
  buildWorkspaceRef,
  resolveWorkspaceRefFromId,
} from "../src/zcode-protocol/workspace.js";

test("R-05: 退役 identity 拒绝执行，不回落成本地路径", () => {
  for (const identity of [
    "remote:wsl:Ubuntu:dev:/home/dev/app",
    "remote:wsl:Ubuntu:/home/dev/app",
    "remote:docker:zcode-dev:/workspace",
  ]) {
    assert.throws(() => resolveWorkspaceRefFromId(identity), /Remote target retired/);
  }
});

test("R-06: 非法 remote identity 保持拒绝语义", () => {
  for (const identity of ["remote:", "remote:unknown:x:/p", "remote:ssh:::/p"]) {
    assert.throws(() => resolveWorkspaceRefFromId(identity), /Invalid remote workspace identity/);
  }
});

test("SSH identity 仍还原真实 workspacePath，本地路径保留 fallback", () => {
  const sshRef = resolveWorkspaceRefFromId("remote:ssh:host.example:22:deploy:/srv/app");
  assert.deepEqual(sshRef, {
    workspaceIdentity: "remote:ssh:host.example:22:deploy:/srv/app",
    workspaceKey: "remote:ssh:host.example:22:deploy:/srv/app",
    workspacePath: "/srv/app",
  });

  assert.deepEqual(resolveWorkspaceRefFromId("/home/me/project"), {
    workspaceIdentity: undefined,
    workspaceKey: "/home/me/project",
    workspacePath: "/home/me/project",
  });

  assert.deepEqual(buildWorkspaceRef({ workspacePath: "/x" }).workspaceKey, "/x");
});

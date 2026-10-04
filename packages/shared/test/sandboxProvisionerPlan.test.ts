import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SANDBOX_WORKSPACE_ROOT,
  resolveSandboxTimeoutSeconds,
  resolveSandboxWorkspacePath,
} from "../src/sandboxProvisioner.js";

test("workspace path defaults to /workspace/<repo name>", () => {
  assert.equal(
    resolveSandboxWorkspacePath({ repository: { owner: "octocat", name: "ZCode" } }),
    `${SANDBOX_WORKSPACE_ROOT}/ZCode`,
  );
});

test("workspace path accepts an explicit path under /workspace", () => {
  assert.equal(
    resolveSandboxWorkspacePath({
      repository: { owner: "octocat", name: "ZCode" },
      workspacePath: "/workspace/custom/",
    }),
    "/workspace/custom",
  );
});

test("workspace path refuses to equal or escape the workspace root", () => {
  // 这两种值都会让 provisioner 的 rm -rf 落在 /workspace 本身或更外层。
  for (const workspacePath of ["/workspace", "/workspace/", "/etc", "/workspace/../etc", "/"]) {
    assert.throws(
      () =>
        resolveSandboxWorkspacePath({
          repository: { owner: "octocat", name: "ZCode" },
          workspacePath,
        }),
      `expected ${workspacePath} to be rejected`,
    );
  }
});

test("workspace path ignores a blank override", () => {
  assert.equal(
    resolveSandboxWorkspacePath({
      repository: { owner: "octocat", name: "ZCode" },
      workspacePath: "   ",
    }),
    `${SANDBOX_WORKSPACE_ROOT}/ZCode`,
  );
});

test("timeout defaults to the shared default, capped by the provider limit", () => {
  assert.equal(
    resolveSandboxTimeoutSeconds({}, DEFAULT_SANDBOX_TIMEOUT_SECONDS + 1000),
    DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  );
  assert.equal(resolveSandboxTimeoutSeconds({}, 60), 60);
});

test("timeout can only be lowered by the provider, never raised", () => {
  assert.equal(resolveSandboxTimeoutSeconds({ timeoutSeconds: 30 }, 3600), 30);
  // 请求 24 小时但 provider 只给 1 小时：必须收敛，否则 expiresAt 是在撒谎。
  assert.equal(resolveSandboxTimeoutSeconds({ timeoutSeconds: 86_400 }, 3_600), 3_600);
});

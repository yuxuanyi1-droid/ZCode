import assert from "node:assert/strict";
import test from "node:test";
import { buildSandboxProvisionRequest } from "../src/lib/remoteConnectionWizard.js";

// 这里只验证「哪个分支被命中」，不验证文案本身，所以直接回显 message id。
const intl = { formatMessage: ({ id }: { id: string }) => id };

function build(overrides: Partial<Parameters<typeof buildSandboxProvisionRequest>[1]> = {}) {
  return buildSandboxProvisionRequest(intl, {
    sandboxProvider: "modal",
    sandboxRepoOwner: "octocat",
    sandboxRepoName: "hello-world",
    sandboxBranch: "main",
    ...overrides,
  });
}

test("sandbox provision request trims input and keeps a nested owner intact", () => {
  const { request, errorMessage } = build({
    sandboxRepoOwner: " group/subgroup ",
    sandboxRepoName: " hello-world ",
    sandboxBranch: " main ",
  });

  assert.equal(errorMessage, undefined);
  assert.deepEqual(request, {
    provider: "modal",
    repository: { owner: "group/subgroup", name: "hello-world" },
    branch: "main",
  });
});

for (const missing of ["sandboxRepoOwner", "sandboxRepoName", "sandboxBranch"] as const) {
  test(`sandbox provision request requires ${missing}`, () => {
    const { request, errorMessage } = build({ [missing]: "   " });
    assert.equal(request, undefined);
    assert.equal(errorMessage, "sandbox.validation.required");
  });
}

test("sandbox provision request rejects separators in the repository name", () => {
  // repo_name 是 /workspace 下的单段目录名，owner 才是可以带 / 的那一侧。
  for (const name of ["group/repo", "C:repo"]) {
    const { request, errorMessage } = build({ sandboxRepoName: name });
    assert.equal(request, undefined);
    assert.equal(errorMessage, "sandbox.validation.repoNameInvalid");
  }
});

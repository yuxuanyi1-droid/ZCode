import assert from "node:assert/strict";
import test from "node:test";
import {
  assertSafeGitRef,
  assertSafeOwner,
  assertSafeRepositoryName,
  resolveRepositoryCheckout,
} from "../src/gitRef.js";
import { ProvisionerError } from "../src/errors.js";

test("resolveRepositoryCheckout builds a clone URL from the configured base", () => {
  const checkout = resolveRepositoryCheckout(
    "https://gitlab.example.com/",
    { owner: "group/subgroup", name: "repo" },
    "main",
  );

  assert.deepEqual(checkout, {
    cloneUrl: "https://gitlab.example.com/group/subgroup/repo.git",
    checkoutRef: "main",
    detached: false,
  });
});

test("resolveRepositoryCheckout checks out a ref detached when one is given", () => {
  const checkout = resolveRepositoryCheckout(
    "https://github.com",
    { owner: "octocat", name: "ZCode" },
    "main",
    "v1.2.3",
  );

  assert.equal(checkout.checkoutRef, "v1.2.3");
  assert.equal(checkout.detached, true);
});

test("owner and repository name reject shell metacharacters", () => {
  // 这些值会被拼进 provisioner 在沙箱里执行的 shell 命令。
  for (const owner of ["a; rm -rf /", "$(id)", "owner/../../etc", "owner//repo", ""]) {
    assert.throws(() => assertSafeOwner(owner), ProvisionerError, `owner ${owner}`);
  }
  for (const name of ["a;b", "a/b", "..", "", "a b"]) {
    assert.throws(() => assertSafeRepositoryName(name), ProvisionerError, `name ${name}`);
  }
});

test("owner allows a nested GitLab-style namespace", () => {
  assert.equal(assertSafeOwner(" group/subgroup "), "group/subgroup");
});

test("git refs reject option-looking and traversal values", () => {
  for (const ref of ["-b other", "--upload-pack=evil", "a..b", "a b", "", "refs/../../etc"]) {
    assert.throws(() => assertSafeGitRef(ref, "Branch"), ProvisionerError, ref);
  }
  assert.equal(assertSafeGitRef("release/1.0", "Branch"), "release/1.0");
});

test("resolveRepositoryCheckout rejects an empty git base URL", () => {
  assert.throws(
    () => resolveRepositoryCheckout("   ", { owner: "octocat", name: "ZCode" }, "main"),
    ProvisionerError,
  );
});

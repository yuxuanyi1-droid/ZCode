import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_DAYTONA_IMAGE,
  DEFAULT_GIT_BASE_URL,
  DEFAULT_MODAL_APP_NAME,
  DEFAULT_PROVISIONER_HOST,
  DEFAULT_PROVISIONER_PORT,
  loadProvisionerConfig,
} from "../src/config.js";

test("config falls back to loopback defaults for a local deployment", () => {
  const config = loadProvisionerConfig({});

  assert.equal(config.host, DEFAULT_PROVISIONER_HOST);
  assert.equal(config.port, DEFAULT_PROVISIONER_PORT);
  assert.equal(config.gitBaseUrl, DEFAULT_GIT_BASE_URL);
  assert.equal(config.token, undefined);
  // 默认是"未预装"：stock 镜像要 bootstrap 自己装 git/sshd。
  assert.equal(config.packagesPreinstalled, false);
  assert.equal(config.modal.appName, DEFAULT_MODAL_APP_NAME);
  assert.equal(config.daytona.image, DEFAULT_DAYTONA_IMAGE);
});

test("config reads the same token env key the client writes", () => {
  // 两端各读各的变量名会在部署时对不齐——这里锁死它们共享同一个键。
  const config = loadProvisionerConfig({ ZCODE_SANDBOX_PROVISIONER_TOKEN: "abc" });

  assert.equal(config.token, "abc");
});

test("config omits credentials that are unset rather than passing empty strings", () => {
  const config = loadProvisionerConfig({ DAYTONA_API_KEY: "   " });

  // 空串会被 SDK 当成"提供了但无效的凭据"，驱动就不会走 isConfigured() 的缺省分支。
  assert.equal("apiKey" in config.daytona, false);
});

test("config treats blank values as unset", () => {
  const config = loadProvisionerConfig({ SANDBOX_GIT_BASE_URL: "  ", E2B_TEMPLATE: "" });

  assert.equal(config.gitBaseUrl, DEFAULT_GIT_BASE_URL);
  assert.equal(config.e2b.template, "base");
});

test("config rejects an out-of-range port instead of coercing it", () => {
  for (const value of ["0", "-1", "70000", "not-a-number"]) {
    assert.throws(
      () => loadProvisionerConfig({ SANDBOX_PROVISIONER_PORT: value }),
      /valid TCP port/,
      value,
    );
  }
});

test("config accepts the documented truthy spellings for booleans", () => {
  for (const value of ["1", "true", "YES"]) {
    assert.equal(
      loadProvisionerConfig({ SANDBOX_PACKAGES_PREINSTALLED: value }).packagesPreinstalled,
      true,
      value,
    );
  }
  assert.equal(
    loadProvisionerConfig({ SANDBOX_PACKAGES_PREINSTALLED: "0" }).packagesPreinstalled,
    false,
  );
});

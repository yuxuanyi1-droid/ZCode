/**
 * 部署秘密加载用例（specs/cloud-agent 01 §7.1 秘密边界、§7.3、03 §6 not_configured、
 * W4 §6「秘密加载 fail-closed（缺文件/权限不对）」）。
 *
 * 全部在临时目录里做真实文件与权限检查：不读也不写真实 ~/.zcode 或任何用户数据。
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  DeploySecretError,
  loadDeploySecrets,
  type DeploySecretsConfig,
} from "../src/cloud/adapters/secret/deploySecrets.js";
import { createCapturingLogger, testAppKeys } from "./cloudGithubTestSupport.js";

const AUTH_TOKEN = "cloud-auth-token-0123456789abcdef";

async function withTempDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "zcode-cloud-secrets-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeSecret(dir: string, name: string, content: string, mode = 0o600) {
  const path = join(dir, name);
  await writeFile(path, content, { mode });
  await chmod(path, mode);
  return path;
}

function config(overrides: Partial<DeploySecretsConfig> = {}): DeploySecretsConfig {
  return {
    principalId: "principal-1",
    authTokenFile: overrides.authTokenFile ?? "/nonexistent/auth-token",
    ...overrides,
  };
}

test("a valid deployment loads auth token and app key with 0600 files", async () => {
  await withTempDir(async (dir) => {
    const authTokenFile = await writeSecret(dir, "auth-token", `${AUTH_TOKEN}\n`);
    const privateKeyFile = await writeSecret(dir, "app.pem", testAppKeys().privateKey);
    const capture = createCapturingLogger();
    const secrets = await loadDeploySecrets(
      config({
        authTokenFile,
        github: {
          appId: 987654,
          privateKeyFile,
          allowedInstallationIds: [4242],
          allowedRepositoryIds: [777],
        },
      }),
      { logger: capture.logger },
    );

    assert.equal(secrets.authToken, AUTH_TOKEN, "trailing newline is trimmed");
    assert.equal(secrets.github?.appId, 987654);
    assert.ok(secrets.github?.privateKeyPem.includes("BEGIN RSA PRIVATE KEY"));
    assert.deepEqual(secrets.github?.allowedInstallationIds, [4242]);
    assert.deepEqual(secrets.github?.allowedRepositoryIds, [777]);
    assert.equal(secrets.github?.apiBaseUrl, "https://api.github.com");

    const description = secrets.describe();
    assert.equal(description.authTokenRef, authTokenFile);
    assert.equal(description.github?.privateKeyRef, privateKeyFile);
    for (const line of capture.lines) {
      assert.ok(!line.includes(AUTH_TOKEN), `log leaked the auth token: ${line}`);
      assert.ok(!line.includes("PRIVATE KEY"), `log leaked key material: ${line}`);
    }
    assert.ok(!JSON.stringify(description).includes(AUTH_TOKEN));
  });
});

test("a missing secret file fails closed with not_configured", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => loadDeploySecrets(config({ authTokenFile: join(dir, "absent") })),
      (error: unknown) =>
        error instanceof DeploySecretError &&
        error.code === "not_configured" &&
        error.problem === "missing",
    );
  });
});

test("group or world readable secret files are rejected", async () => {
  await withTempDir(async (dir) => {
    const authTokenFile = await writeSecret(dir, "auth-token", AUTH_TOKEN, 0o644);
    await assert.rejects(
      () => loadDeploySecrets(config({ authTokenFile })),
      (error: unknown) =>
        error instanceof DeploySecretError &&
        error.code === "not_configured" &&
        error.problem === "mode-not-0600",
    );
  });
});

test("a symlinked secret file is rejected even when the target is 0600", async () => {
  await withTempDir(async (dir) => {
    const real = await writeSecret(dir, "real-token", AUTH_TOKEN);
    const link = join(dir, "auth-token-link");
    await symlink(real, link);
    await assert.rejects(
      () => loadDeploySecrets(config({ authTokenFile: link })),
      (error: unknown) => error instanceof DeploySecretError && error.problem === "symlink",
    );
  });
});

test("a directory, an empty file or a token with whitespace is rejected", async () => {
  await withTempDir(async (dir) => {
    const subdir = join(dir, "as-dir");
    await mkdir(subdir);
    await assert.rejects(
      () => loadDeploySecrets(config({ authTokenFile: subdir })),
      (error: unknown) => error instanceof DeploySecretError && error.problem === "not-a-file",
    );

    const empty = await writeSecret(dir, "empty", "   \n");
    await assert.rejects(
      () => loadDeploySecrets(config({ authTokenFile: empty })),
      (error: unknown) => error instanceof DeploySecretError && error.problem === "empty",
    );

    const spaced = await writeSecret(dir, "spaced", "token with whitespace");
    await assert.rejects(
      () => loadDeploySecrets(config({ authTokenFile: spaced })),
      (error: unknown) => error instanceof DeploySecretError && error.problem === "malformed",
    );
  });
});

test("a file owned by another uid is rejected when a uid is supplied", async () => {
  await withTempDir(async (dir) => {
    const authTokenFile = await writeSecret(dir, "auth-token", AUTH_TOKEN);
    await assert.rejects(
      () => loadDeploySecrets(config({ authTokenFile }), { uid: 999_999 }),
      (error: unknown) => error instanceof DeploySecretError && error.problem === "owner-mismatch",
    );
  });
});

test("non-RSA or unparsable app private keys are rejected without echoing material", async () => {
  await withTempDir(async (dir) => {
    const authTokenFile = await writeSecret(dir, "auth-token", AUTH_TOKEN);
    const ecKey = generateKeyPairSync("ec", { namedCurve: "prime256v1" })
      .privateKey.export({ type: "pkcs8", format: "pem" })
      .toString();
    const ecFile = await writeSecret(dir, "ec.pem", ecKey);
    await assert.rejects(
      () =>
        loadDeploySecrets(
          config({
            authTokenFile,
            github: { appId: 1, privateKeyFile: ecFile, allowedInstallationIds: [1] },
          }),
        ),
      (error: unknown) =>
        error instanceof DeploySecretError &&
        error.problem === "malformed" &&
        !error.message.includes("PRIVATE KEY"),
    );

    const junkFile = await writeSecret(dir, "junk.pem", "-----BEGIN RSA PRIVATE KEY-----\nno\n");
    await assert.rejects(
      () =>
        loadDeploySecrets(
          config({
            authTokenFile,
            github: { appId: 1, privateKeyFile: junkFile, allowedInstallationIds: [1] },
          }),
        ),
      (error: unknown) => error instanceof DeploySecretError && error.problem === "malformed",
    );
  });
});

test("missing GitHub configuration is not an error: the endpoint reports not_configured later", async () => {
  await withTempDir(async (dir) => {
    const authTokenFile = await writeSecret(dir, "auth-token", AUTH_TOKEN);
    const secrets = await loadDeploySecrets(config({ authTokenFile }));
    assert.equal(secrets.github, undefined);
    assert.equal(secrets.describe().github, undefined);
  });
});

test("a declared but incomplete GitHub configuration fails hard", async () => {
  await withTempDir(async (dir) => {
    const authTokenFile = await writeSecret(dir, "auth-token", AUTH_TOKEN);
    await assert.rejects(
      () =>
        loadDeploySecrets(
          config({
            authTokenFile,
            github: {
              appId: 1,
              privateKeyFile: join(dir, "absent.pem"),
              allowedInstallationIds: [1],
            },
          }),
        ),
      (error: unknown) => error instanceof DeploySecretError && error.problem === "missing",
    );

    const privateKeyFile = await writeSecret(dir, "app.pem", testAppKeys().privateKey);
    await assert.rejects(
      () =>
        loadDeploySecrets(
          config({
            authTokenFile,
            github: { appId: 1, privateKeyFile, allowedInstallationIds: [] },
          }),
        ),
      (error: unknown) => error instanceof DeploySecretError && error.problem === "invalid-config",
    );

    await assert.rejects(
      () =>
        loadDeploySecrets(
          config({
            authTokenFile,
            github: { appId: 0, privateKeyFile, allowedInstallationIds: [1] },
          }),
        ),
      (error: unknown) => error instanceof DeploySecretError && error.problem === "invalid-config",
    );
  });
});

test("the webhook secret is optional and only loaded when declared", async () => {
  await withTempDir(async (dir) => {
    const authTokenFile = await writeSecret(dir, "auth-token", AUTH_TOKEN);
    const privateKeyFile = await writeSecret(dir, "app.pem", testAppKeys().privateKey);
    const webhookSecretFile = await writeSecret(dir, "webhook-secret", "hook-secret-value");

    const withoutHook = await loadDeploySecrets(
      config({
        authTokenFile,
        github: { appId: 1, privateKeyFile, allowedInstallationIds: [1] },
      }),
    );
    assert.equal(withoutHook.github?.webhookSecret, undefined);
    assert.equal(withoutHook.describe().github?.webhookSecretRef, undefined);

    const withHook = await loadDeploySecrets(
      config({
        authTokenFile,
        github: { appId: 1, privateKeyFile, webhookSecretFile, allowedInstallationIds: [1] },
      }),
    );
    assert.equal(withHook.github?.webhookSecret, "hook-secret-value");
    assert.equal(withHook.describe().github?.webhookSecretRef, webhookSecretFile);
  });
});

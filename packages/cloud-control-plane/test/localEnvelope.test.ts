import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildLocalProvisioningEnvelope } from "../src/adapters/provisioning/localEnvelope.js";

const SECRET = "unit-test-credential-secret";

function encryptWithSecret(value: string, secret: string): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return `enc:v1:${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ciphertext.toString("base64url")}`;
}

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

async function createHome(): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), "cloud-envelope-"));
  tempDirs.push(home);
  const v2 = join(home, "v2");
  await mkdir(v2, { recursive: true });
  await writeFile(
    join(v2, "provider_config.json"),
    JSON.stringify({
      schemaVersion: 1,
      config: {
        providerOrder: ["personal"],
        providerConfigRules: { providerRules: [{ providerId: "personal" }] },
        modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
      },
    }),
  );
  await writeFile(
    join(v2, "setting.json"),
    JSON.stringify({
      providerFamilyDomain: "bigmodel",
      providerFamilyConnectionSelections: { bigmodel: { kind: "individual-coding-plan" } },
    }),
  );
  await writeFile(
    join(v2, "credentials.json"),
    JSON.stringify({
      "oauth:bigmodel:access_token": encryptWithSecret("access-token", SECRET),
      "unrelated:key": encryptWithSecret("ignored", SECRET),
    }),
  );
  return home;
}

describe("local provisioning envelope", () => {
  it("builds a v2 envelope with personal config, settings and OAuth credentials", async () => {
    const home = await createHome();
    const envelope = await buildLocalProvisioningEnvelope({
      zcodeHome: home,
      credentialSecret: SECRET,
    });
    expect(envelope?.schemaVersion).toBe(2);
    expect(envelope?.personalConfig.providerOrder).toEqual(["personal"]);
    expect(envelope?.accountSettings.providerFamilyDomain).toBe("bigmodel");
    expect(envelope?.credentials).toEqual([
      {
        scope: "oauth-session",
        key: "oauth:bigmodel:access_token",
        value: "access-token",
      },
    ]);
  });

  it("skips undecryptable credentials instead of failing the envelope", async () => {
    const home = await createHome();
    const envelope = await buildLocalProvisioningEnvelope({
      zcodeHome: home,
      credentialSecret: "wrong-secret",
    });
    expect(envelope?.credentials).toEqual([]);
  });

  it("returns null without a personal provider config", async () => {
    const home = await mkdtemp(join(tmpdir(), "cloud-envelope-empty-"));
    tempDirs.push(home);
    await expect(
      buildLocalProvisioningEnvelope({ zcodeHome: home, credentialSecret: SECRET }),
    ).resolves.toBeNull();
  });
});

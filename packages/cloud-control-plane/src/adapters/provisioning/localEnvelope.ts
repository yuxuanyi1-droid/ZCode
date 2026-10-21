import { createDecipheriv, createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  providerProvisioningEnvelopeSchema,
  type ProviderProvisioningEnvelope,
} from "@zcode/shared";

const ENCRYPTED_PREFIX = "enc:v1:";

/** 与 host 的 credentialCipherProvider 保持一致（同一 ZCODE_CREDENTIAL_SECRET 口径）。 */
const PROVISIONABLE_OAUTH_KEYS = new Set([
  "oauth:active_provider",
  "oauth:zai:access_token",
  "oauth:zai:refresh_token",
  "oauth:zai:user_info",
  "oauth:bigmodel:access_token",
  "oauth:bigmodel:refresh_token",
  "oauth:bigmodel:user_info",
  "zcodejwttoken",
]);

function decryptCredential(value: string, secret: string): string {
  if (!value.startsWith(ENCRYPTED_PREFIX)) {
    return value;
  }
  const [ivRaw, tagRaw, cipherRaw] = value.slice(ENCRYPTED_PREFIX.length).split(".");
  if (!ivRaw || !tagRaw || cipherRaw === undefined) {
    throw new Error("invalid credential envelope");
  }
  const key = createHash("sha256").update(secret).digest();
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivRaw, "base64url"));
  decipher.setAuthTag(Buffer.from(tagRaw, "base64url"));
  return Buffer.concat([
    decipher.update(Buffer.from(cipherRaw, "base64url")),
    decipher.final(),
  ]).toString("utf8");
}

async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch {
    return null;
  }
}

export interface LocalProvisioningOptions {
  readonly zcodeHome: string;
  readonly credentialSecret: string | null;
}

/**
 * 从本机 ZCode 账号域构造 provider provisioning 信封：
 * 个人 provider 配置（含个人 API Key）+ 账号设置 + OAuth 凭据（仅 oauth-session）。
 */
export async function buildLocalProvisioningEnvelope(
  options: LocalProvisioningOptions,
): Promise<ProviderProvisioningEnvelope | null> {
  const providerConfig = (await readJson(join(options.zcodeHome, "v2/provider_config.json"))) as {
    config?: unknown;
  } | null;
  if (!providerConfig?.config) {
    return null;
  }
  const settings = (await readJson(join(options.zcodeHome, "v2/setting.json"))) as {
    providerFamilyDomain?: unknown;
    providerFamilyConnectionSelections?: unknown;
  } | null;
  const domain = settings?.providerFamilyDomain;
  const selections = settings?.providerFamilyConnectionSelections;

  const credentials: Array<{ scope: "oauth-session"; key: string; value: string }> = [];
  if (options.credentialSecret) {
    const rawCredentials = (await readJson(
      join(options.zcodeHome, "v2/credentials.json"),
    )) as Record<string, unknown> | null;
    for (const [key, value] of Object.entries(rawCredentials ?? {})) {
      if (!PROVISIONABLE_OAUTH_KEYS.has(key) || typeof value !== "string") {
        continue;
      }
      try {
        credentials.push({
          scope: "oauth-session",
          key,
          value: decryptCredential(value, options.credentialSecret),
        });
      } catch {
        // 无法解密的条目跳过，不让单个凭据阻塞整份信封。
      }
    }
  }

  return providerProvisioningEnvelopeSchema.parse({
    schemaVersion: 2,
    syncId: `local-${randomUUID()}`,
    personalConfig: providerConfig.config,
    accountSettings: {
      providerFamilyDomain: domain === "zai" || domain === "bigmodel" ? domain : null,
      providerFamilyConnectionSelections: selections ?? {},
    },
    credentials,
  });
}

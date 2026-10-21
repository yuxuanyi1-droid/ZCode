import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { GitHubAppConfig } from "./adapters/github/githubApp.js";

export interface CloudConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  readonly accessToken: string;
  readonly publicUrl: string;
  readonly webDistDir: string | null;
  readonly providers: string[];
  readonly defaultProvider: string;
  readonly serverBin: string | null;
  readonly sandboxRoot: string;
  readonly accountDaemonEnabled: boolean;
  readonly accountDaemonBin: string | null;
  readonly accountDaemonRoot: string;
  readonly accountDaemonDataDir: string;
  readonly publicHttpOrigin: string;
  readonly e2bApiKey: string | null;
  readonly sandboxTemplateRef: string;
  readonly sandboxMaxLifetimeSeconds: number;
  readonly sandboxIdlePauseSeconds: number | null;
  readonly bridgeBundlePath: string;
  readonly serverReleaseTarball: string | null;
  readonly credentialSecret: string | null;
  readonly zcodeHome: string;
  readonly githubApp: GitHubAppConfig | null;
  readonly keepFailedSandboxes: boolean;
}

const DEFAULT_PORT = 4040;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function parseMaxLifetime(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }
  const [, seconds] = value.includes(":") ? value.split(":") : [undefined, value];
  const parsed = Number(seconds);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`invalid sandbox max lifetime: ${value}`);
  }
  return parsed;
}

function loadGitHubApp(env: NodeJS.ProcessEnv): GitHubAppConfig | null {
  const appId = Number(readTrimmed(env.ZCODE_CLOUD_GITHUB_APP_ID));
  const keyFile = readTrimmed(env.ZCODE_CLOUD_GITHUB_APP_PRIVATE_KEY_FILE);
  if (!Number.isInteger(appId) || appId <= 0 || !keyFile) {
    return null;
  }
  const installations = (readTrimmed(env.ZCODE_CLOUD_GITHUB_ALLOWED_INSTALLATIONS) ?? "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item > 0);
  let privateKeyPem: string;
  try {
    privateKeyPem = readFileSync(keyFile, "utf8");
  } catch {
    return null;
  }
  return { appId, privateKeyPem, allowedInstallationIds: installations };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): CloudConfig {
  const dataDir = resolve(readTrimmed(env.CLOUD_DATA_DIR) ?? "./.cloud-data");
  const port = Number(readTrimmed(env.PORT) ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error("PORT must be a positive integer");
  }
  const host = readTrimmed(env.CLOUD_HOST) ?? "127.0.0.1";
  const serverBin = readTrimmed(env.ZCODE_SERVER_BIN) ?? null;
  const providers = (readTrimmed(env.CLOUD_PROVIDERS) ?? "fake")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  const defaultProvider = readTrimmed(env.CLOUD_DEFAULT_PROVIDER) ?? providers[0] ?? "fake";
  if (!providers.includes(defaultProvider)) {
    throw new Error(
      `CLOUD_DEFAULT_PROVIDER (${defaultProvider}) must be listed in CLOUD_PROVIDERS`,
    );
  }
  const idlePauseRaw = readTrimmed(env.ZCODE_CLOUD_SANDBOX_IDLE_PAUSE_SECONDS);
  const idlePauseSeconds = idlePauseRaw ? Number(idlePauseRaw) : null;
  return {
    host,
    port,
    dataDir,
    accessToken: readTrimmed(env.CLOUD_ACCESS_TOKEN) ?? "dev-token",
    publicUrl: readTrimmed(env.CLOUD_PUBLIC_URL) ?? `ws://${host}:${port}/api/cloud/bridge/attach`,
    webDistDir: readTrimmed(env.CLOUD_WEB_DIST_DIR) ?? resolve(REPO_ROOT, "packages/web/dist"),
    providers,
    defaultProvider,
    serverBin,
    sandboxRoot: resolve(readTrimmed(env.CLOUD_SANDBOX_ROOT) ?? resolve(dataDir, "sandboxes")),
    accountDaemonEnabled: (readTrimmed(env.CLOUD_ACCOUNT_DAEMON) ?? "off") === "on",
    accountDaemonBin: readTrimmed(env.ZCODE_SERVER_ACCOUNT_BIN) ?? serverBin,
    accountDaemonRoot:
      readTrimmed(env.ZCODE_SERVER_ACCOUNT_ROOT) ?? resolve(dataDir, "account-server"),
    accountDaemonDataDir:
      readTrimmed(env.CLOUD_ACCOUNT_DATA_DIR) ?? resolve(dataDir, "account-data"),
    publicHttpOrigin:
      readTrimmed(env.CLOUD_PUBLIC_ORIGIN) ??
      readTrimmed(env.ZCODE_CLOUD_PUBLIC_ORIGIN) ??
      `http://${host}:${port}`,
    e2bApiKey: readTrimmed(env.E2B_API_KEY) ?? null,
    sandboxTemplateRef:
      readTrimmed(env.ZCODE_CLOUD_SANDBOX_TEMPLATE_REF) ?? "e2b:zcode-sandbox-template",
    sandboxMaxLifetimeSeconds: parseMaxLifetime(
      readTrimmed(env.ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS),
      3_300,
    ),
    sandboxIdlePauseSeconds:
      idlePauseSeconds !== null && Number.isInteger(idlePauseSeconds) && idlePauseSeconds > 0
        ? idlePauseSeconds
        : null,
    bridgeBundlePath:
      readTrimmed(env.CLOUD_BRIDGE_BUNDLE) ??
      resolve(REPO_ROOT, "packages/cloud-bridge/dist/bridge.mjs"),
    serverReleaseTarball: readTrimmed(env.CLOUD_SERVER_RELEASE_TARBALL) ?? null,
    credentialSecret: readTrimmed(env.ZCODE_CREDENTIAL_SECRET) ?? null,
    zcodeHome: readTrimmed(env.ZCODE_HOME) ?? resolve(homedir(), ".zcode"),
    githubApp: loadGitHubApp(env),
    keepFailedSandboxes: (readTrimmed(env.CLOUD_KEEP_FAILED_SANDBOXES) ?? "off") === "on",
  };
}

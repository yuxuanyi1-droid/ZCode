import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
}

const DEFAULT_PORT = 4040;
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function readTrimmed(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
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
  };
}

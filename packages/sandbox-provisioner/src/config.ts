import { ZCODE_SANDBOX_PROVISIONER_TOKEN_ENV_KEY } from "@zcode/shared";
import type { DaytonaDriverConfig } from "./providers/daytona.js";
import { DEFAULT_DAYTONA_SSH_HOST } from "./providers/daytona.js";
import { DEFAULT_E2B_RELAY_PORT } from "./providers/e2b.js";
import { DEFAULT_WEBSOCAT_ARCH, DEFAULT_WEBSOCAT_VERSION } from "./sandboxBootstrap.js";

export const DEFAULT_PROVISIONER_PORT = 8788;
export const DEFAULT_PROVISIONER_HOST = "127.0.0.1";

/** 默认 clone 源；自建 GitLab / GHE 部署要覆盖。 */
export const DEFAULT_GIT_BASE_URL = "https://github.com";

export const MODAL_APP_NAME_ENV_KEY = "MODAL_APP_NAME";
export const MODAL_BASE_IMAGE_ENV_KEY = "MODAL_BASE_IMAGE";
export const SANDBOX_GIT_BASE_URL_ENV_KEY = "SANDBOX_GIT_BASE_URL";
export const SANDBOX_PACKAGES_PREINSTALLED_ENV_KEY = "SANDBOX_PACKAGES_PREINSTALLED";
export const SANDBOX_PROVISIONER_HOST_ENV_KEY = "SANDBOX_PROVISIONER_HOST";
export const SANDBOX_PROVISIONER_PORT_ENV_KEY = "SANDBOX_PROVISIONER_PORT";
export const DAYTONA_IMAGE_ENV_KEY = "DAYTONA_IMAGE";
export const DAYTONA_SSH_HOST_ENV_KEY = "DAYTONA_SSH_HOST";
export const E2B_TEMPLATE_ENV_KEY = "E2B_TEMPLATE";
export const E2B_RELAY_PORT_ENV_KEY = "E2B_RELAY_PORT";
export const E2B_WEBSOCAT_VERSION_ENV_KEY = "E2B_WEBSOCAT_VERSION";

export const DEFAULT_MODAL_APP_NAME = "zcode-sandboxes";
export const DEFAULT_MODAL_BASE_IMAGE = "debian:12";
export const DEFAULT_E2B_TEMPLATE = "base";
export const DEFAULT_DAYTONA_IMAGE = "debian:12";

export interface ProvisionerConfig {
  host: string;
  port: number;
  /** 共享 bearer token；未配置时不校验（仅适用于本地回环部署）。 */
  token?: string;
  gitBaseUrl: string;
  packagesPreinstalled: boolean;
  websocatVersion: string;
  websocatArch: string;
  modal: { appName: string; baseImage: string };
  daytona: DaytonaDriverConfig;
  e2b: { template: string; relayPort: number };
}

export type EnvRecord = Record<string, string | undefined>;

function readString(env: EnvRecord, key: string, fallback: string): string {
  const value = env[key]?.trim();
  return value ? value : fallback;
}

function readOptionalString(env: EnvRecord, key: string): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

function readBoolean(env: EnvRecord, key: string): boolean {
  const value = env[key]?.trim().toLowerCase();
  return value === "1" || value === "true" || value === "yes";
}

function readPort(env: EnvRecord, key: string, fallback: number): number {
  const raw = env[key]?.trim();
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new Error(`${key} must be a valid TCP port, got ${raw}`);
  }
  return parsed;
}

export function loadProvisionerConfig(env: EnvRecord = process.env): ProvisionerConfig {
  return {
    host: readString(env, SANDBOX_PROVISIONER_HOST_ENV_KEY, DEFAULT_PROVISIONER_HOST),
    port: readPort(env, SANDBOX_PROVISIONER_PORT_ENV_KEY, DEFAULT_PROVISIONER_PORT),
    // 与客户端读的是同一个变量名：一份 secret 两端各读各的，避免部署时对不齐。
    ...(readOptionalString(env, ZCODE_SANDBOX_PROVISIONER_TOKEN_ENV_KEY)
      ? { token: readOptionalString(env, ZCODE_SANDBOX_PROVISIONER_TOKEN_ENV_KEY) }
      : {}),
    gitBaseUrl: readString(env, SANDBOX_GIT_BASE_URL_ENV_KEY, DEFAULT_GIT_BASE_URL),
    packagesPreinstalled: readBoolean(env, SANDBOX_PACKAGES_PREINSTALLED_ENV_KEY),
    websocatVersion: readString(env, E2B_WEBSOCAT_VERSION_ENV_KEY, DEFAULT_WEBSOCAT_VERSION),
    websocatArch: DEFAULT_WEBSOCAT_ARCH,
    modal: {
      appName: readString(env, MODAL_APP_NAME_ENV_KEY, DEFAULT_MODAL_APP_NAME),
      baseImage: readString(env, MODAL_BASE_IMAGE_ENV_KEY, DEFAULT_MODAL_BASE_IMAGE),
    },
    daytona: {
      ...(readOptionalString(env, "DAYTONA_API_KEY")
        ? { apiKey: readOptionalString(env, "DAYTONA_API_KEY") }
        : {}),
      ...(readOptionalString(env, "DAYTONA_API_URL")
        ? { apiUrl: readOptionalString(env, "DAYTONA_API_URL") }
        : {}),
      ...(readOptionalString(env, "DAYTONA_TARGET")
        ? { target: readOptionalString(env, "DAYTONA_TARGET") }
        : {}),
      image: readString(env, DAYTONA_IMAGE_ENV_KEY, DEFAULT_DAYTONA_IMAGE),
      sshHost: readString(env, DAYTONA_SSH_HOST_ENV_KEY, DEFAULT_DAYTONA_SSH_HOST),
      packagesPreinstalled: readBoolean(env, SANDBOX_PACKAGES_PREINSTALLED_ENV_KEY),
    },
    e2b: {
      template: readString(env, E2B_TEMPLATE_ENV_KEY, DEFAULT_E2B_TEMPLATE),
      relayPort: readPort(env, E2B_RELAY_PORT_ENV_KEY, DEFAULT_E2B_RELAY_PORT),
    },
  };
}

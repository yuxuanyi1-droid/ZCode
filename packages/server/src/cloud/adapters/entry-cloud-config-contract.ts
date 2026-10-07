/**
 * 云入口配置的**公开键登记**与值解析（specs/cloud-agent/03 §2/§8、W5 §3/§4）。
 *
 * 与 `entry-cloud-config.ts` 的分工：本文件只有「键名 + 纯解析 + 结构化启动错误」，
 * 不含 IO 顺序与装配职责；`readCloudEntryConfig`（含跨字段校验与就绪顺序）在那里，
 * 并把本文件的键常量与错误类型原样 re-export，外部只要继续 import `entry-cloud-config.js`。
 */
import { stat } from "node:fs/promises";
import type { CloudErrorCode } from "@zcode/shared";
import { isSandboxProviderId } from "./sandbox/capabilities.js";

export type ZCodeServerMode = "local" | "cloud";

export interface CloudStaticModelFallback {
  readonly provider: string;
  readonly model: string;
}

/** 秘密的**引用**（值不在本文件出现；由 `entry-cloud-secrets.ts` 交给 W4 的 loader 读取）。 */
export interface CloudSecretRefs {
  readonly principalId?: string;
  readonly authTokenFile?: string;
  readonly githubAppId?: string;
  readonly githubAppPrivateKeyFile?: string;
  readonly githubWebhookSecretFile?: string;
  readonly githubAllowedInstallationIds?: readonly number[];
  readonly credentialSecretEnv?: string;
}

export interface CloudEntryConfig {
  readonly mode: "cloud";
  readonly publicOrigin: string;
  readonly listenHost?: string;
  readonly listenPort: number;
  readonly dataDir: string;
  readonly webDir?: string;
  readonly providers: readonly string[];
  readonly allowUnverifiedProviders: readonly string[];
  readonly maxConcurrentRuns: number;
  /** 静态 fallback；未配置表示「无账号态时不给 envelope」，不伪造默认模型。 */
  readonly staticModelFallback?: CloudStaticModelFallback;
  /** storage worker 入口覆盖；缺省由入口按构建形态解析（dist 同目录 / 源码同目录）。 */
  readonly storageWorkerEntryPath?: string;
  /**
   * provider → 模板/镜像引用（非秘密）。未配置的 provider 不提供默认模板：
   * resolver 返回 null，调用方按 `unsupported_template` 明确失败（01 §5.1）。
   */
  readonly sandboxTemplateRefs?: Readonly<Record<string, string>>;
  /**
   * provider → 已核实的可用期上限（秒）。未配置的 provider 保持「未核实」，
   * driver 不上报上限；可用期由控制面按部署预算与之取较小值（01 §4.3）。
   */
  readonly sandboxMaxLifetimeSeconds?: Readonly<Record<string, number>>;
  readonly secrets: CloudSecretRefs;
}

export interface LocalEntryConfig {
  readonly mode: "local";
}

export type CloudEntryConfigIssueCode =
  | "mode_invalid"
  | "principal_id_required"
  | "auth_required"
  | "data_dir_required"
  | "public_origin_required"
  | "public_origin_invalid"
  | "listen_port_invalid"
  | "providers_required"
  | "web_dir_invalid"
  | "model_invalid"
  | "max_concurrent_runs_invalid"
  | "sandbox_template_invalid"
  | "sandbox_lifetime_invalid";

export interface CloudEntryConfigIssue {
  readonly code: CloudEntryConfigIssueCode;
  readonly field: string;
  readonly message: string;
}

export type CloudEntryConfigResult =
  | { readonly ok: true; readonly config: CloudEntryConfig }
  | { readonly ok: true; readonly config: LocalEntryConfig }
  | { readonly ok: false; readonly issues: readonly CloudEntryConfigIssue[] };

// ── 配置项登记（键名即公开契约）──

/** 运行模式（03 §2）：`local` 保持现有行为，`cloud` 走本入口。 */
export const ZCODE_SERVER_MODE_ENV = "ZCODE_SERVER_MODE";
/** 云侧公网 origin（provider 回连与 attachment 地址的构造基点）。 */
export const ZCODE_CLOUD_PUBLIC_ORIGIN_ENV = "ZCODE_CLOUD_PUBLIC_ORIGIN";
export const ZCODE_CLOUD_LISTEN_HOST_ENV = "ZCODE_CLOUD_LISTEN_HOST";
export const ZCODE_CLOUD_LISTEN_PORT_ENV = "ZCODE_CLOUD_LISTEN_PORT";
/** 云持久卷；host 本体落 `<dataDir>/.zcode/`（03 §8、12 §4）。 */
export const ZCODE_CLOUD_DATA_DIR_ENV = "ZCODE_CLOUD_DATA_DIR";
/** Web 产物目录；静态托管 + SPA fallback（W5 §3）。 */
export const ZCODE_CLOUD_WEB_DIR_ENV = "ZCODE_CLOUD_WEB_DIR";
/** 启用的沙箱 provider 清单（逗号分隔，取值域由 W3 能力表决定）。 */
export const ZCODE_CLOUD_PROVIDERS_ENV = "ZCODE_CLOUD_PROVIDERS";
/** 部署显式勾选「未实测」provider（01 §4.2 门控；启用只影响可选性）。 */
export const ZCODE_CLOUD_ALLOW_UNVERIFIED_PROVIDERS_ENV = "ZCODE_CLOUD_ALLOW_UNVERIFIED_PROVIDERS";
/** 无账号登录态时的静态模型 fallback envelope 来源（12 §6 ②）。`provider:model`。 */
export const ZCODE_CLOUD_MODEL_ENV = "ZCODE_CLOUD_MODEL";
/** 并发 run 配额上限（01 §4.3：预留在 provisioning/ready/disconnected 期间都占槽）。 */
export const ZCODE_CLOUD_MAX_CONCURRENT_RUNS_ENV = "ZCODE_CLOUD_MAX_CONCURRENT_RUNS";
/** 可信单用户部署主体（03 §3）：认证凭据与该主体绑定。 */
export const ZCODE_CLOUD_PRINCIPAL_ID_ENV = "ZCODE_CLOUD_PRINCIPAL_ID";
/** 部署秘密的引用；值只由 `adapters/secret/deploySecrets.ts` 读取（W4 唯一 owner）。 */
export const ZCODE_SERVER_AUTH_TOKEN_FILE_ENV = "ZCODE_SERVER_AUTH_TOKEN_FILE";
export const ZCODE_CLOUD_GITHUB_APP_ID_ENV = "ZCODE_CLOUD_GITHUB_APP_ID";
export const ZCODE_CLOUD_GITHUB_APP_KEY_FILE_ENV = "ZCODE_CLOUD_GITHUB_APP_PRIVATE_KEY_FILE";
export const ZCODE_CLOUD_GITHUB_WEBHOOK_SECRET_FILE_ENV = "ZCODE_CLOUD_GITHUB_WEBHOOK_SECRET_FILE";
export const ZCODE_CLOUD_GITHUB_ALLOWED_INSTALLATIONS_ENV =
  "ZCODE_CLOUD_GITHUB_ALLOWED_INSTALLATIONS";
/** storage worker 入口覆盖（默认与构建产物同目录，见 entry-cloud-server）。 */
export const ZCODE_CLOUD_STORAGE_WORKER_ENTRY_ENV = "ZCODE_CLOUD_STORAGE_WORKER_ENTRY";
/**
 * 沙箱模板/镜像引用（`provider:ref`，多家逗号分隔，例如
 * `e2b:zcode-sandbox-template,daytona:zcode-sandbox`）。
 *
 * **非秘密**：模板 id 会出现在 Run recipe、日志与 capabilities 里；凭据仍只走
 * `adapters/secret`。这是镜像引用的**唯一部署侧来源**（01 §5.1：recipe 必须固定
 * 版本/digest，禁止 latest）；未配置表示「不提供默认模板」，不是报错。
 */
export const ZCODE_CLOUD_SANDBOX_TEMPLATE_REF_ENV = "ZCODE_CLOUD_SANDBOX_TEMPLATE_REF";
/**
 * 按 provider 核实的沙箱可用期上限（秒），`provider:seconds`，多家逗号分隔（如 `e2b:3600`）。
 *
 * **非秘密**（期限不是凭据）。语义是「**用真实账号核实过**的能力上限」：可用期取部署预算与
 * 该上限的较小值（01 §4.3）。**未配置 = 未核实**，driver 保持不上报上限的现状语义
 * （不虚构、不拿默认值猜测账号能力）。
 */
export const ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS_ENV =
  "ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS";

export const CLOUD_DEFAULT_LISTEN_PORT = 3030;
export const CLOUD_DEFAULT_MAX_CONCURRENT_RUNS = 2;

/** 云入口启动失败：携带归一错误码，供 HTTP 错误信封与运维诊断共用（03 §6）。 */
export class CloudEntryStartupError extends Error {
  readonly code: CloudErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: CloudErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = "CloudEntryStartupError";
    this.code = code;
    this.details = details;
  }
}

export function readTrimmed(
  env: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value ? value : undefined;
}

export function splitList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }
  return [
    ...new Set(
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

export function parsePositiveInt(value: string | undefined, fallback: number): number | null {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/** origin 只接受 scheme + authority：带 path/query/fragment 会让 attachment 地址拼错。 */
export function parsePublicOrigin(value: string | undefined): string | null {
  if (!value) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    return null;
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const loopback =
    host === "localhost" || host === "127.0.0.1" || host === "::1" || host.endsWith(".localhost");
  if (url.protocol === "http:" && !loopback) {
    // 明文 origin 只允许本机开发；公网部署必须 https（01 §7.2 凭据边界）。
    return null;
  }
  return url.origin;
}

export async function assertWebDir(webDir: string): Promise<CloudEntryConfigIssue | null> {
  try {
    const info = await stat(webDir);
    if (info.isDirectory()) {
      return null;
    }
  } catch {
    // 未命中 → 下面的统一 issue。
  }
  return {
    code: "web_dir_invalid",
    field: ZCODE_CLOUD_WEB_DIR_ENV,
    message: `webDir 必须是指向 Web 产物的可读目录: ${webDir}`,
  };
}

/** `local`（或未设置模式）返回本地配置；解析本身无副作用（磁盘探测在 host 本体）。 */

export function parseSandboxTemplateRefs(value: string | undefined): {
  value?: Readonly<Record<string, string>>;
  issues: CloudEntryConfigIssue[];
} {
  if (!value) {
    return { issues: [] };
  }
  const issues: CloudEntryConfigIssue[] = [];
  const refs: Record<string, string> = {};
  for (const entry of value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":");
    const provider = separator > 0 ? entry.slice(0, separator).trim() : "";
    const ref = separator > 0 ? entry.slice(separator + 1).trim() : "";
    const invalid = (message: string): void => {
      issues.push({
        code: "sandbox_template_invalid",
        field: ZCODE_CLOUD_SANDBOX_TEMPLATE_REF_ENV,
        message: `${message}（收到: ${entry}）`,
      });
    };
    if (!provider || !ref) {
      invalid("模板引用必须是 provider:ref 形式");
      continue;
    }
    if (!isSandboxProviderId(provider)) {
      invalid(`未知的沙箱 provider`);
      continue;
    }
    if (/(^|[:@])latest$/i.test(ref)) {
      invalid("镜像引用禁止 latest（版本/digest 必须固定）");
      continue;
    }
    if (refs[provider]) {
      invalid(`provider ${provider} 重复声明模板引用`);
      continue;
    }
    refs[provider] = ref;
  }
  if (issues.length > 0) {
    return { issues };
  }
  return { value: refs, issues };
}

export function parseIdList(value: string | undefined): number[] | undefined {
  if (!value) {
    return undefined;
  }
  const ids = value
    .split(",")
    .map((item) => Number.parseInt(item.trim(), 10))
    .filter((id) => Number.isInteger(id) && id > 0);
  return ids.length > 0 ? ids : undefined;
}

/**
 * `provider:seconds` 列表。fail-closed：缺 `:`、provider 未知、seconds 非正整数、
 * 同 provider 重复声明一律报 issue（01 §4.3 的上限必须是核实过的正整数秒）。
 */
export function parseSandboxLifetimeLimits(value: string | undefined): {
  value?: Readonly<Record<string, number>>;
  issues: CloudEntryConfigIssue[];
} {
  if (!value) {
    return { issues: [] };
  }
  const issues: CloudEntryConfigIssue[] = [];
  const limits: Record<string, number> = {};
  for (const entry of value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = entry.indexOf(":");
    const provider = separator > 0 ? entry.slice(0, separator).trim() : "";
    const rawSeconds = separator > 0 ? entry.slice(separator + 1).trim() : "";
    const invalid = (message: string): void => {
      issues.push({
        code: "sandbox_lifetime_invalid",
        field: ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS_ENV,
        message: `${message}（收到: ${entry}）`,
      });
    };
    if (!provider || !rawSeconds) {
      invalid("可用期上限必须是 provider:seconds 形式");
      continue;
    }
    if (!isSandboxProviderId(provider)) {
      invalid("未知的沙箱 provider");
      continue;
    }
    if (!/^\d+$/.test(rawSeconds) || Number.parseInt(rawSeconds, 10) <= 0) {
      invalid("可用期上限必须是正整数秒");
      continue;
    }
    if (limits[provider] !== undefined) {
      invalid(`provider ${provider} 重复声明可用期上限`);
      continue;
    }
    limits[provider] = Number.parseInt(rawSeconds, 10);
  }
  if (issues.length > 0) {
    return { issues };
  }
  return { value: limits, issues };
}

export function parseStaticModelFallback(
  value: string | undefined,
): CloudStaticModelFallback | null {
  if (!value) {
    return null;
  }
  const separator = value.indexOf(":");
  if (separator <= 0 || separator === value.length - 1) {
    return null;
  }
  const provider = value.slice(0, separator).trim();
  const model = value.slice(separator + 1).trim();
  return provider && model ? { provider, model } : null;
}

/** 把多条 issue 收敛成一个结构化启动错误（03 §6：不把细节伪装成成功）。 */

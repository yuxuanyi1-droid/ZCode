/**
 * 云入口配置的**公开键登记**与契约结构（specs/cloud-agent/03 §2/§8、W5 §3/§4）。
 *
 * 与 `entry-cloud-config.ts` 的分工：本文件只有「键名 + 类型/issue 结构 + 启动错误」，
 * 不含 IO 顺序与装配职责；`readCloudEntryConfig`（含跨字段校验与就绪顺序）在那里，
 * 并把本文件的键常量与错误类型原样 re-export，外部只要继续 import `entry-cloud-config.js`。
 * 纯值解析函数已拆至 `entry-cloud-config-parse.ts`（无行为变更的纯结构拆分，
 * 本文件被其单向 import）。
 */
import { stat } from "node:fs/promises";
import type { CloudErrorCode } from "@zcode/shared";

export type ZCodeServerMode = "local" | "cloud";

/**
 * 云入口鉴权模式（03 §3 修订 2026-10-07）：`token` = 既有 lite-token fail-closed（默认）；
 * `anonymous` = 本地调试逃生门，lite-token 校验全放行（principalId 仍必填）。
 */
export type CloudAuthMode = "token" | "anonymous";

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
  /** lite-token 鉴权模式（03 §3 修订）；默认 `token`，由 `readCloudEntryConfig` 落定。 */
  readonly authMode: CloudAuthMode;
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
  | "auth_mode_invalid"
  | "principal_id_required"
  | "principal_id_invalid"
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
/**
 * lite-token 鉴权模式（03 §3 修订 2026-10-07）：`token`（默认，fail-closed 不变）或
 * `anonymous`（本地调试逃生门：lite-token 校验全放行、authToken 引用可缺、principalId 仍必填）。
 * 非法值报 `auth_mode_invalid`，绝不静默当 `token` 或 `anonymous`。
 */
export const ZCODE_CLOUD_AUTH_MODE_ENV = "ZCODE_CLOUD_AUTH_MODE";
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

/** 把多条 issue 收敛成一个结构化启动错误（03 §6：不把细节伪装成成功）。 */

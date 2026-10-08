/**
 * 云侧部署秘密加载（specs/cloud-agent/01 §7.1 秘密所有者与存放、§7.3 凭据边界、
 * 03 §6 错误信封、12 §1.1 账号凭据归 host 本体）。
 *
 * 边界：
 * - 只加载**部署级**秘密：云 API 的 auth token 与 GitHub App 私钥（+可选 webhook secret）。
 *   账号/模型凭据归 host 本体 `ICredentialService`，本模块不读、不复制（01 §7.1、12 §1.1）。
 * - 文件权限 fail-closed：必须是自己拥有的 0600 常规文件；符号链接、组/其他可读、
 *   空文件、非法 PEM 一律拒绝，且错误信息里不含秘密材料。
 * - 没有 GitHub 配置不是错误（03 §6：`repositories` 端点此时返回 not_configured）；
 *   但只要声明了 GitHub 配置，其文件缺失/权限不对就是硬失败。
 * - 与 W5 的 `entry-cloud-secrets.ts` 共用本模块（W5 §3）。
 */
import { createPrivateKey } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode } from "@zcode/shared";
import type { CloudAdapterLogger } from "../github/logging.js";
import { createServiceLogger } from "@zcode/services/node";

export type DeploySecretProblem =
  | "missing"
  | "unreadable"
  | "symlink"
  | "not-a-file"
  | "mode-not-0600"
  | "owner-mismatch"
  | "empty"
  | "malformed"
  | "invalid-config";

/** 部署侧问题统一 not_configured：503 才是「服务未就绪」的正确信号（03 §6）。 */
export class DeploySecretError extends Error {
  readonly code: CloudErrorCode = "not_configured";
  readonly retryable = CLOUD_ERROR_RETRYABLE["not_configured"];
  readonly problem: DeploySecretProblem;
  readonly ref: string;

  constructor(problem: DeploySecretProblem, ref: string, message: string) {
    super(`deploy secret ${problem}: ${ref} (${message})`);
    this.name = "DeploySecretError";
    this.problem = problem;
    this.ref = ref;
  }
}

export interface DeploySecretsConfig {
  /** 可信单用户部署的唯一主体（09 §2.1）。 */
  principalId: string;
  /**
   * 云 API bearer token 文件；HTTP/WS 入口鉴权必需（03 §3）。仅在 anonymous 调试模式
   * （03 §3 修订 2026-10-07）下允许缺省——入口层保证 token 模式必填，本层不复制该判定。
   */
  authTokenFile?: string;
  github?: {
    appId: number;
    privateKeyFile: string;
    /** M7 条件性：未启用 webhook 时可缺省。 */
    webhookSecretFile?: string;
    apiBaseUrl?: string;
    /** 09 §2.1：显式配置允许的 installationIds（至少一个）。 */
    allowedInstallationIds: readonly number[];
    allowedRepositoryIds?: readonly number[];
  };
}

export interface DeploySecretsDescription {
  principalId: string;
  /** anonymous 模式未提供引用时缺省（authToken 未加载）。 */
  authTokenRef?: string;
  github?: {
    appId: number;
    privateKeyRef: string;
    webhookSecretRef?: string;
    apiBaseUrl: string;
    allowedInstallationIds: readonly number[];
    allowedRepositoryIds?: readonly number[];
  };
}

export interface LoadedGitHubAppSecrets {
  readonly appId: number;
  readonly privateKeyPem: string;
  readonly webhookSecret?: string;
  readonly apiBaseUrl: string;
  readonly allowedInstallationIds: readonly number[];
  readonly allowedRepositoryIds?: readonly number[];
}

export interface LoadedDeploySecrets {
  readonly principalId: string;
  /** anonymous 调试模式未提供 authTokenFile 时缺省（token 模式恒有值）。 */
  readonly authToken?: string;
  readonly github?: LoadedGitHubAppSecrets;
  /** 只含文件引用与校验事实：可安全写日志/诊断（不含秘密材料）。 */
  describe(): DeploySecretsDescription;
}

export interface DeploySecretsFs {
  lstat(path: string): Promise<{
    mode: number;
    uid: number;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readFile(path: string): Promise<string>;
}

export interface DeploySecretsLoadOptions {
  fs?: DeploySecretsFs;
  /** 期望的文件所有者；默认取当前进程 uid（Windows 无 uid 时传 undefined 跳过）。 */
  uid?: number;
  logger?: CloudAdapterLogger;
}

const DEFAULT_API_BASE_URL = "https://api.github.com";
const nodeFs: DeploySecretsFs = {
  lstat: (path) => lstat(path),
  readFile: (path) => readFile(path, "utf8"),
};

const SECRET_FILE_MODE_MASK = 0o077;

function currentUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

/** 0600 fail-closed：常规文件、非符号链接、组/其他不可读写、所有者匹配（01 §7.1）。 */
async function readSecretFile(
  fs: DeploySecretsFs,
  path: string,
  uid: number | undefined,
): Promise<string> {
  let stats: Awaited<ReturnType<DeploySecretsFs["lstat"]>>;
  try {
    stats = await fs.lstat(path);
  } catch {
    throw new DeploySecretError("missing", path, "file does not exist");
  }
  if (stats.isSymbolicLink()) {
    // 允许链接会把权限检查与真实读取目标解耦，间接替换秘密文件（01 §7.1 秘密边界）。
    throw new DeploySecretError("symlink", path, "symlinked secret files are rejected");
  }
  if (!stats.isFile()) {
    throw new DeploySecretError("not-a-file", path, "secret must be a regular file");
  }
  if ((stats.mode & SECRET_FILE_MODE_MASK) !== 0) {
    throw new DeploySecretError("mode-not-0600", path, "secret file must be mode 0600");
  }
  if (uid !== undefined && stats.uid !== uid) {
    throw new DeploySecretError(
      "owner-mismatch",
      path,
      "secret file must be owned by this account",
    );
  }
  let content: string;
  try {
    content = await fs.readFile(path);
  } catch {
    throw new DeploySecretError("unreadable", path, "secret file could not be read");
  }
  const trimmed = content.trim();
  if (trimmed.length === 0) throw new DeploySecretError("empty", path, "secret file is empty");
  return trimmed;
}

/** 私钥必须是可解析的 RSA PEM；错误里不带任何密钥材料（03 §9 日志边界）。 */
function assertRsaPrivateKey(pem: string, path: string): void {
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== "rsa") {
      throw new DeploySecretError("malformed", path, "app private key must be RSA");
    }
    const modulusLength = key.asymmetricKeyDetails?.modulusLength ?? 0;
    if (modulusLength > 0 && modulusLength < 2_048) {
      throw new DeploySecretError("malformed", path, "app private key must be at least 2048 bits");
    }
  } catch (error) {
    if (error instanceof DeploySecretError) throw error;
    throw new DeploySecretError("malformed", path, "app private key is not a valid RSA PEM");
  }
}

function assertPositiveIds(ids: readonly number[] | undefined, label: string): void {
  if (!ids || ids.length === 0) {
    throw new DeploySecretError("invalid-config", label, "at least one id is required");
  }
  for (const id of ids) {
    if (!Number.isInteger(id) || id <= 0) {
      throw new DeploySecretError("invalid-config", label, "ids must be positive integers");
    }
  }
}

export async function loadDeploySecrets(
  config: DeploySecretsConfig,
  options: DeploySecretsLoadOptions = {},
): Promise<LoadedDeploySecrets> {
  const fs = options.fs ?? nodeFs;
  const uid = options.uid ?? currentUid();
  const logger = options.logger ?? createServiceLogger("cloud-deploy-secrets");

  if (config.principalId.trim().length === 0) {
    throw new DeploySecretError("invalid-config", "principalId", "principalId must be set");
  }
  // anonymous 调试模式（03 §3 修订）不要求 auth token 文件：未提供引用时跳过读取，
  // 其余部署秘密（GitHub 等）照常加载；token 模式的必填判定在入口层 fail-closed。
  let authToken: string | undefined;
  if (config.authTokenFile) {
    const authTokenRef = config.authTokenFile;
    const value = await readSecretFile(fs, authTokenRef, uid);
    if (/\s/.test(value)) {
      // 换行/空白通常意味着读到了错误的文件；不做自动修复，避免把拼接内容当 token。
      throw new DeploySecretError("malformed", authTokenRef, "auth token must be a single token");
    }
    authToken = value;
  }

  let github: LoadedGitHubAppSecrets | undefined;
  if (config.github) {
    const { appId, privateKeyFile, webhookSecretFile } = config.github;
    if (!Number.isInteger(appId) || appId <= 0) {
      throw new DeploySecretError(
        "invalid-config",
        "github.appId",
        "appId must be a positive integer",
      );
    }
    const privateKeyPem = await readSecretFile(fs, privateKeyFile, uid);
    assertRsaPrivateKey(privateKeyPem, privateKeyFile);
    const webhookSecret =
      webhookSecretFile === undefined
        ? undefined
        : await readSecretFile(fs, webhookSecretFile, uid);
    assertPositiveIds(config.github.allowedInstallationIds, "github.allowedInstallationIds");
    if (config.github.allowedRepositoryIds !== undefined) {
      assertPositiveIds(config.github.allowedRepositoryIds, "github.allowedRepositoryIds");
    }
    github = {
      appId,
      privateKeyPem,
      webhookSecret,
      apiBaseUrl: config.github.apiBaseUrl ?? DEFAULT_API_BASE_URL,
      allowedInstallationIds: [...config.github.allowedInstallationIds],
      allowedRepositoryIds: config.github.allowedRepositoryIds
        ? [...config.github.allowedRepositoryIds]
        : undefined,
    };
  }

  // 只记录文件引用与结构事实：秘密材料不进日志（03 §9、01 §7.1）。
  logger.info(undefined, "deploy secrets loaded", {
    principalId: config.principalId,
    githubConfigured: github !== undefined,
    appId: github?.appId,
    allowedInstallationIds: github?.allowedInstallationIds.length ?? 0,
    hasWebhookSecret: github?.webhookSecret !== undefined,
  });

  return {
    principalId: config.principalId,
    ...(authToken !== undefined ? { authToken } : {}),
    github,
    describe: () => ({
      principalId: config.principalId,
      ...(config.authTokenFile ? { authTokenRef: config.authTokenFile } : {}),
      github: github
        ? {
            appId: github.appId,
            privateKeyRef: config.github!.privateKeyFile,
            webhookSecretRef:
              github.webhookSecret === undefined ? undefined : config.github!.webhookSecretFile,
            apiBaseUrl: github.apiBaseUrl,
            allowedInstallationIds: github.allowedInstallationIds,
            allowedRepositoryIds: github.allowedRepositoryIds,
          }
        : undefined,
    }),
  };
}

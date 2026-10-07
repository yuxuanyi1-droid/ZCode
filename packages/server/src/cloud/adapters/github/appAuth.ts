/**
 * GitHub App 身份（specs/cloud-agent/09 §2.1 installation 解析、§3 权限矩阵第一行、
 * §2.2 权威 owner/name/defaultBranch、11 §4.3 客户端元数据不能自证）。
 *
 * 边界：
 * - App JWT 与 installer 身份是两类凭据：JWT 只在控制面内存，用于 App 级端点；
 *   查 installation 不等于用户授权（09 §3），授权来自部署 allowlist（09 §2.1）。
 * - 本文件只做 App 身份与权威事实读取；installation token 的 mint 在 tokens.ts，
 *   仓库授权投影在 repositories.ts。
 */
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import type { CloudAdapterLogger } from "./logging.js";
import { GitHubApiError, expectOk, type GitHubTransport } from "./http.js";
import {
  asRecord,
  readBooleanOr,
  readNumber,
  readPermissionMap,
  readRecord,
  readString,
  type JsonRecord,
} from "./parse.js";

/** GitHub 要求 exp 距当前不超过 10 分钟，并建议 iat 回拨 60s 容忍时钟偏移。 */
export const APP_JWT_BACKDATE_MS = 60_000;
export const APP_JWT_MAX_LIFETIME_MS = 10 * 60_000;
const APP_JWT_DEFAULT_LIFETIME_MS = 9 * 60_000;

export interface GitHubAppCredentials {
  appId: number;
  /** PKCS#1/PKCS#8 PEM；只在内存，禁止落盘到云持久卷之外的位置（01 §7.1）。 */
  privateKeyPem: string;
}

export function createAppSigningKey(privateKeyPem: string): KeyObject {
  const key = createPrivateKey(privateKeyPem);
  // GitHub App 只接受 RSA 私钥；EC/Ed25519 一律 fail-closed（09 §3）。
  if (key.asymmetricKeyType !== "rsa") {
    throw new Error("github app private key must be RSA");
  }
  return key;
}

function base64Url(input: string): string {
  return Buffer.from(input, "utf8").toString("base64url");
}

/** App JWT（RS256）：`iss`=appId；claims 里不带任何用户或仓库信息（09 §3）。 */
export function signAppJwt(request: {
  appId: number;
  key: KeyObject;
  now: number;
  lifetimeMs?: number;
}): string {
  const lifetimeMs = Math.min(
    request.lifetimeMs ?? APP_JWT_DEFAULT_LIFETIME_MS,
    APP_JWT_MAX_LIFETIME_MS,
  );
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(
    JSON.stringify({
      iat: Math.floor((request.now - APP_JWT_BACKDATE_MS) / 1_000),
      exp: Math.floor((request.now + lifetimeMs) / 1_000),
      iss: request.appId,
    }),
  );
  const signature = createSign("RSA-SHA256")
    .update(`${header}.${payload}`)
    .sign(request.key)
    .toString("base64url");
  return `${header}.${payload}.${signature}`;
}

/** 便捷入口（一次性签名，例如部署自检）；高频路径请复用 appAuth 里的 key 缓存。 */
export function createAppJwt(request: {
  appId: number;
  privateKeyPem: string;
  now: number;
  lifetimeMs?: number;
}): string {
  return signAppJwt({
    appId: request.appId,
    key: createAppSigningKey(request.privateKeyPem),
    now: request.now,
    lifetimeMs: request.lifetimeMs,
  });
}

export interface GitHubInstallationFacts {
  installationId: number;
  appId: number;
  accountId: number;
  /** login 只用于展示；稳定身份是 accountId（09 §2.1）。 */
  accountLogin: string;
  accountType: string;
  repositorySelection: "all" | "selected" | "unknown";
  /** suspended 是撤权信号：停止 grant/新任务/外部写入（09 §2.1）。 */
  suspended: boolean;
  permissions: Readonly<Record<string, string>>;
}

/** 只接受结构完整的 installation 响应；畸形响应返回 null，由调用方按不可用处理。 */
export function parseInstallation(raw: unknown): GitHubInstallationFacts | null {
  const record = asRecord(raw);
  const installationId = readNumber(record, "id");
  const appId = readNumber(record, "app_id");
  if (!record || installationId === null || appId === null) return null;
  const account = readRecord(record, "account") ?? (record as JsonRecord);
  const accountId = readNumber(account, "id");
  const selection = record["repository_selection"];
  return {
    installationId,
    appId,
    accountId: accountId ?? 0,
    accountLogin: readString(account, "login") ?? "",
    accountType: readString(account, "type") ?? "",
    repositorySelection: selection === "all" || selection === "selected" ? selection : "unknown",
    suspended: record["suspended_at"] !== null && record["suspended_at"] !== undefined,
    permissions: readPermissionMap(record, "permissions"),
  };
}

export interface GitHubRepositoryFacts {
  repositoryId: number;
  installationId: number;
  nodeId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  private: boolean;
  archived: boolean;
  availability: "available" | "stale" | "unavailable";
  lastCheckedAt?: number;
}

/** 权威仓库事实：owner/name/defaultBranch 只来自 GitHub，不采信请求元数据（11 §4.3）。 */
export function parseRepositoryFacts(
  raw: unknown,
  options: { installationId: number; lastCheckedAt: number },
): GitHubRepositoryFacts | null {
  const record = asRecord(raw);
  const repositoryId = readNumber(record, "id");
  const owner = readString(readRecord(record, "owner"), "login");
  const name = readString(record, "name");
  if (repositoryId === null || !owner || !name) return null;
  return {
    repositoryId,
    installationId: options.installationId,
    nodeId: readString(record, "node_id") ?? "",
    owner,
    name,
    defaultBranch: readString(record, "default_branch") ?? "",
    private: readBooleanOr(record, "private", true),
    archived: readBooleanOr(record, "archived", false),
    availability: "available",
    lastCheckedAt: options.lastCheckedAt,
  };
}

export interface GitHubAppAuth {
  /** App 级端点用的 JWT；每次调用即时签发（<10min 生命周期）。 */
  jwt(traceId?: string): string;
  /** `GET /app/installations/:id`；不存在/不可见返回 null，不区分二者（09 §8）。 */
  getInstallation(request: {
    installationId: number;
    traceId?: string;
  }): Promise<GitHubInstallationFacts | null>;
  /** `GET /repositories/:id`；必须用该 installation 的 token，404 返回 null。 */
  getRepository(request: {
    repositoryId: number;
    installationId: number;
    installationToken: string;
    traceId?: string;
  }): Promise<GitHubRepositoryFacts | null>;
}

export function createGitHubAppAuth(deps: {
  transport: GitHubTransport;
  credentials: GitHubAppCredentials;
  now?: () => number;
  logger?: CloudAdapterLogger;
}): GitHubAppAuth {
  const key = createAppSigningKey(deps.credentials.privateKeyPem);
  const now = deps.now ?? Date.now;
  // 用局部函数而不是 this.jwt：方法被解构调用时 this 会丢失，凭据签发必须不依赖调用形态。
  const issueJwt = (traceId?: string): string => {
    const token = signAppJwt({ appId: deps.credentials.appId, key, now: now() });
    deps.logger?.debug(traceId, "github app jwt issued", { appId: deps.credentials.appId });
    return token;
  };

  return {
    jwt: issueJwt,

    async getInstallation({ installationId, traceId }) {
      const response = await deps.transport.send<unknown>({
        method: "GET",
        path: `/app/installations/${installationId}`,
        credential: { kind: "app-jwt", jwt: issueJwt(traceId) },
        traceId,
      });
      if (response.status === 404) return null;
      const body = expectOk(response, "get installation");
      const facts = parseInstallation(body);
      if (!facts) {
        throw new GitHubApiError({
          code: "validation_failed",
          retryable: false,
          status: response.status,
          message: "installation response missing id/app_id",
        });
      }
      return facts;
    },

    async getRepository({ repositoryId, installationId, installationToken, traceId }) {
      const response = await deps.transport.send<unknown>({
        method: "GET",
        path: `/repositories/${repositoryId}`,
        credential: { kind: "installation-token", token: installationToken },
        traceId,
      });
      // 404 = 该 installation 无权访问或仓库不存在；两者不得区分（09 §8）。
      if (response.status === 404) return null;
      const body = expectOk(response, "get repository");
      const facts = parseRepositoryFacts(body, {
        installationId,
        lastCheckedAt: now(),
      });
      if (!facts || facts.repositoryId !== repositoryId) {
        throw new GitHubApiError({
          code: "validation_failed",
          retryable: false,
          status: response.status,
          message: "repository response did not match requested id",
        });
      }
      return facts;
    },
  };
}

/**
 * installation token 的 mint 与撤销（specs/cloud-agent/09 §3 完整权限矩阵、
 * §8 错误归一、01 §7.2 单 repo 最小权限与「尽力撤销」）。
 *
 * 硬性规则：
 * - 每次 mint 必须显式单 repositoryId + 最小 permissions；回包不是单 repo、或缺权限、
 *   或多给权限一律明确失败，不回落「全 installation/全权限」（09 §3）。
 * - GitHub 原生 token 有效期约 1h，不能用单次兑换或 TTL 缩短（01 §7.2）。
 * - 撤销是尽力的：结果作为事实回传，不抛错、不宣称成功（01 §7.2）；installer 令牌
 *   一旦离开本进程就无法再撤销，只能等其到期或确认沙箱已死亡。
 */
import type { MintedToken } from "../../app/ports/gitHubPort.js";
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode } from "@zcode/shared";
import type { CloudAdapterLogger } from "./logging.js";
import { GitHubApiError, type GitHubHttpFailure, type GitHubTransport } from "./http.js";
import { readArray, readIsoTimestamp, readNumber, readPermissionMap, asRecord } from "./parse.js";

export type GitHubPermissionLevel = "read" | "write";

/**
 * 09 §3 权限矩阵的机器可读形式：每个 purpose 的**最小**权限集。
 * - clone/fetch → contents:read（分支/SHA 读取与 clone 同源）
 * - push        → contents:write（checkpoint；不含 PR/check/issues）
 * - pull-request→ pull_requests:write + contents:read（diff/merge 状态投影）
 * - checks      → checks:write（`zcode agent` check，M7；checks read 概要属 M4 可选，
 *                 需要独立 purpose 时须先改 frozen `MintTokenRequest`，见契约变更请求）
 * metadata:read 是所有用途的基础权限（09 §3 首段）。
 */
export const GITHUB_TOKEN_PERMISSION_MATRIX = {
  clone: { contents: "read", metadata: "read" },
  fetch: { contents: "read", metadata: "read" },
  push: { contents: "write", metadata: "read" },
  "pull-request": { pull_requests: "write", contents: "read", metadata: "read" },
  checks: { checks: "write", metadata: "read" },
} as const satisfies Record<string, Record<string, GitHubPermissionLevel>>;

export type GitHubTokenPurpose = keyof typeof GITHUB_TOKEN_PERMISSION_MATRIX;

const LEVEL_RANK: Readonly<Record<string, number>> = { read: 1, write: 2, admin: 3 };

export type GitHubTokenRevocation =
  | { revoked: true; reason: "revoked" | "already-invalid" }
  | {
      revoked: false;
      reason: "network-unknown" | "permission-revoked" | "unknown";
      retryable: boolean;
    };

export interface GitHubTokenService {
  /** 单 repo + 最小权限矩阵（09 §3）。 */
  mint(request: {
    installationId: number;
    repositoryId: number;
    purpose: GitHubTokenPurpose;
    traceId?: string;
  }): Promise<MintedToken>;
  /**
   * 仅用于 installation 候选仓库列表（09 §2.2）：固定 metadata:read、不带 repository_ids。
   * 该 token 不能用于任何写路径；本方法不接受 purpose 参数以免被当成通用入口。
   */
  mintInstallationMetadataToken(request: {
    installationId: number;
    traceId?: string;
  }): Promise<MintedToken>;
  /** 单 repo metadata:read：只用于解析权威 owner/name/defaultBranch（11 §4.3）。 */
  mintRepositoryMetadataToken(request: {
    installationId: number;
    repositoryId: number;
    traceId?: string;
  }): Promise<MintedToken>;
  /** 尽力撤销（01 §7.2）：只回事实，绝不抛错。 */
  revoke(request: { token: string; traceId?: string }): Promise<GitHubTokenRevocation>;
}

function tokenFailure(code: CloudErrorCode, message: string, status?: number): GitHubApiError {
  return new GitHubApiError({
    code,
    retryable: CLOUD_ERROR_RETRYABLE[code],
    status,
    message,
  });
}

/** mint 端点的错误有专属语义：installation 不存在/已卸载是撤权，不是「仓库不存在」。 */
function remapMintFailure(failure: GitHubHttpFailure): GitHubApiError {
  if (failure.status === 404) {
    return tokenFailure("installation_revoked", "installation not found for this app", 404);
  }
  if (failure.status === 401 || failure.status === 403) {
    return tokenFailure(
      "installation_revoked",
      "app or installation credentials rejected",
      failure.status,
    );
  }
  if (failure.status === 422) {
    // 请求的权限超过 App 注册表或 installation 已批准范围（09 §3 末段）。
    return tokenFailure(
      "permission_revoked",
      "requested permissions are not granted to the app",
      422,
    );
  }
  return new GitHubApiError(failure);
}

function assertPermissionsMatch(request: {
  requested: Readonly<Record<string, GitHubPermissionLevel>>;
  granted: Readonly<Record<string, string>>;
  repositoryId?: number;
  status?: number;
}): void {
  for (const [name, level] of Object.entries(request.requested)) {
    const grantedLevel = request.granted[name];
    const rank = grantedLevel === undefined ? 0 : (LEVEL_RANK[grantedLevel] ?? 0);
    if (rank < (LEVEL_RANK[level] ?? 0)) {
      throw tokenFailure(
        "permission_revoked",
        `installation token is missing required permission ${name}:${level}`,
        request.status,
      );
    }
  }
  // 多给权限同样是越权：不得把比请求更宽的 token 交给调用方或沙箱（09 §3）。
  for (const [name, level] of Object.entries(request.granted)) {
    const requestedLevel = request.requested[name];
    if (
      requestedLevel === undefined ||
      (LEVEL_RANK[level] ?? 0) > (LEVEL_RANK[requestedLevel] ?? 0)
    ) {
      throw tokenFailure(
        "validation_failed",
        `installation token granted more than requested: ${name}:${level}`,
        request.status,
      );
    }
  }
}

function flattenPermissions(granted: Readonly<Record<string, string>>): string[] {
  return Object.entries(granted)
    .map(([name, level]) => `${name}:${level}`)
    .sort();
}

export function createGitHubTokenService(deps: {
  transport: GitHubTransport;
  /** App JWT 提供者由组合层注入：tokens 不直接依赖 appAuth，避免两个 adapter 互相 import。 */
  appJwt: (traceId?: string) => string;
  now?: () => number;
  logger?: CloudAdapterLogger;
}): GitHubTokenService {
  const now = deps.now ?? Date.now;

  async function mintInstallationToken(request: {
    installationId: number;
    repositoryIds?: readonly number[];
    permissions: Readonly<Record<string, GitHubPermissionLevel>>;
    purpose: string;
    traceId?: string;
  }): Promise<MintedToken> {
    const response = await deps.transport.send<unknown>({
      method: "POST",
      path: `/app/installations/${request.installationId}/access_tokens`,
      credential: { kind: "app-jwt", jwt: deps.appJwt(request.traceId) },
      body: {
        ...(request.repositoryIds ? { repository_ids: [...request.repositoryIds] } : {}),
        permissions: { ...request.permissions },
      },
      traceId: request.traceId,
    });
    if (!response.ok) throw remapMintFailure(response.failure!);
    const body = asRecord(response.body);
    const token = body?.["token"];
    const expiresAt = readIsoTimestamp(body, "expires_at");
    if (typeof token !== "string" || token.length === 0 || expiresAt === null) {
      throw tokenFailure(
        "validation_failed",
        "installation token response is malformed",
        response.status,
      );
    }
    const granted = readPermissionMap(body, "permissions");
    assertPermissionsMatch({
      requested: request.permissions,
      granted,
      status: response.status,
    });
    if (request.repositoryIds) {
      // 单 repo 约束由响应回证：不是恰好这一次请求的仓库就失败（09 §3）。
      const ids = readArray(body, "repositories")
        .map((item) => readNumber(asRecord(item), "id"))
        .filter((id): id is number => id !== null);
      const expected = request.repositoryIds;
      if (ids.length !== expected.length || expected.some((id) => !ids.includes(id))) {
        throw tokenFailure(
          "validation_failed",
          "installation token was not scoped to the requested repository",
          response.status,
        );
      }
    }
    deps.logger?.info(request.traceId, "github installation token minted", {
      installationId: request.installationId,
      purpose: request.purpose,
      repositoryIds: request.repositoryIds ?? "installation-wide",
      permissions: flattenPermissions(granted),
      expiresAt,
      mintedAt: now(),
    });
    return { token, expiresAt, permissions: flattenPermissions(granted) };
  }

  return {
    async mint(request) {
      const permissions = GITHUB_TOKEN_PERMISSION_MATRIX[request.purpose];
      if (!permissions) {
        // 「不申请未知权限」是硬约束：purpose 未登记时不能回落任何默认矩阵（09 §3）。
        throw tokenFailure(
          "validation_failed",
          `unknown token purpose: ${String(request.purpose)}`,
        );
      }
      return mintInstallationToken({
        installationId: request.installationId,
        repositoryIds: [request.repositoryId],
        permissions,
        purpose: request.purpose,
        traceId: request.traceId,
      });
    },

    async mintInstallationMetadataToken(request) {
      return mintInstallationToken({
        installationId: request.installationId,
        permissions: { metadata: "read" },
        purpose: "installation-metadata",
        traceId: request.traceId,
      });
    },

    async mintRepositoryMetadataToken(request) {
      return mintInstallationToken({
        installationId: request.installationId,
        repositoryIds: [request.repositoryId],
        permissions: { metadata: "read" },
        purpose: "repository-metadata",
        traceId: request.traceId,
      });
    },

    async revoke(request) {
      try {
        const response = await deps.transport.send<unknown>({
          method: "DELETE",
          path: "/installation/token",
          credential: { kind: "installation-token", token: request.token },
          traceId: request.traceId,
        });
        if (response.ok) {
          deps.logger?.info(request.traceId, "github installation token revoked");
          return { revoked: true, reason: "revoked" };
        }
        if (response.status === 401 || response.status === 404) {
          // 已失效等同不可再用，但仍如实标注来源（01 §7.2 不伪造撤销完成）。
          deps.logger?.info(request.traceId, "github installation token already invalid", {
            status: response.status,
          });
          return { revoked: true, reason: "already-invalid" };
        }
        const code = response.failure?.code ?? "unknown";
        deps.logger?.warn(request.traceId, "github installation token revoke failed", {
          status: response.status,
          code,
        });
        return {
          revoked: false,
          reason: code === "network_unknown" ? "network-unknown" : "permission-revoked",
          retryable: code === "network_unknown",
        };
      } catch (error) {
        deps.logger?.warn(request.traceId, "github installation token revoke errored", {
          reason: error instanceof Error ? error.name : "unknown",
        });
        return { revoked: false, reason: "unknown", retryable: true };
      }
    },
  };
}

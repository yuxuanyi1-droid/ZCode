/**
 * 仓库列表与权威事实（specs/cloud-agent/09 §2.1 可信单用户 allowlist、
 * §2.2 installation 投影与 Project、11 §4.3 权威 installation/owner/name/defaultBranch、
 * 03 §6 `repositories` 端点的 not_configured 语义）。
 *
 * 规则：
 * - 不列举 App 的全部 installation（不得用「App 能列出所有 installation」当用户授权证明）；
 *   只读部署显式配置的 installationIds，并用 `allowedRepositoryIds` 二次收窄。
 * - 列表是候选来源，不是权限证明：接纳后的每次 grant/读写仍按当前授权校验
 *   （每次 mint 的单 repo 回证见 tokens.ts）。
 * - GitHub 不可用 → 已缓存投影标 stale，不把网络错误当仓库已删除（09 §2.2）。
 */
import { CLOUD_ERROR_RETRYABLE, type CloudErrorCode } from "@zcode/shared";
import type { CloudAdapterLogger } from "./logging.js";
import type { MintedToken, RepositoryRef } from "../../app/ports/gitHubPort.js";
import { GitHubApiError, type GitHubTransport } from "./http.js";
import { parseRepositoryFacts, type GitHubAppAuth, type GitHubRepositoryFacts } from "./appAuth.js";
import type { GitHubTokenPurpose, GitHubTokenService } from "./tokens.js";
import { asRecord, readArray } from "./parse.js";

const DEFAULT_CACHE_TTL_MS = 5 * 60_000;
const DEFAULT_MAX_PAGES_PER_CALL = 5;
const PAGE_SIZE = 100;

export interface GitHubRepositoryCatalogConfig {
  /** 可信单用户部署的唯一主体；其他 principal 一律拒绝（09 §2.1）。 */
  principalId: string;
  allowedInstallationIds: readonly number[];
  /** 可选二次收窄；配置后不在清单内的 repositoryId 一律拒绝（09 §2.1）。 */
  allowedRepositoryIds?: readonly number[];
  cacheTtlMs?: number;
  maxPagesPerCall?: number;
}

export interface GitHubRepositoryCatalog {
  /** false 表示 GitHub 侧部署配置缺失：调用方按 not_configured(503) 处理（03 §6）。 */
  isConfigured(): boolean;
  listRepositories(request: {
    principalId: string;
    cursor?: string;
    limit: number;
    query?: string;
    traceId?: string;
  }): Promise<{ items: RepositoryRef[]; nextCursor?: string }>;
  /** 权威事实（含 owner/name/defaultBranch）；不可用返回 null，网络未知抛错。 */
  locate(repositoryId: number, traceId?: string): Promise<GitHubRepositoryFacts | null>;
  /** allowlist 校验：非法 id/installation 直接拒绝，不做任何 GitHub 调用。 */
  assertAuthorized(request: { repositoryId: number; installationId?: number }): void;
  /** 组合层：先 allowlist，再按 purpose 单 repo mint（09 §3）。 */
  mintForPurpose(request: {
    repositoryId: number;
    installationId: number;
    purpose: GitHubTokenPurpose;
    traceId?: string;
  }): Promise<MintedToken>;
}

interface InstallationProjection {
  fetchedAt: number;
  items: GitHubRepositoryFacts[];
}

function catalogError(code: CloudErrorCode, message: string): GitHubApiError {
  return new GitHubApiError({ code, retryable: CLOUD_ERROR_RETRYABLE[code], message });
}

function encodeCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ v: 1, o: offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
      v?: unknown;
      o?: unknown;
    };
    const offset = parsed.o;
    if (parsed.v !== 1 || typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
      throw new Error("bad cursor shape");
    }
    return offset;
  } catch {
    throw catalogError("validation_failed", "invalid repository cursor");
  }
}

export function createGitHubRepositoryCatalog(deps: {
  transport: GitHubTransport;
  appAuth: GitHubAppAuth;
  tokens: GitHubTokenService;
  config: GitHubRepositoryCatalogConfig;
  now?: () => number;
  logger?: CloudAdapterLogger;
}): GitHubRepositoryCatalog {
  const now = deps.now ?? Date.now;
  const cacheTtlMs = deps.config.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const maxPages = deps.config.maxPagesPerCall ?? DEFAULT_MAX_PAGES_PER_CALL;
  const projections = new Map<number, InstallationProjection>();

  function isConfigured(): boolean {
    return deps.config.allowedInstallationIds.length > 0;
  }

  function requireConfigured(): void {
    if (!isConfigured()) {
      throw catalogError("not_configured", "github installation projection is not configured");
    }
  }

  function assertAuthorized(request: { repositoryId: number; installationId?: number }): void {
    requireConfigured();
    const { allowedRepositoryIds } = deps.config;
    if (
      allowedRepositoryIds !== undefined &&
      !allowedRepositoryIds.includes(request.repositoryId)
    ) {
      throw catalogError("unauthorized", "repository is not in the deployment allowlist");
    }
    if (
      request.installationId !== undefined &&
      !deps.config.allowedInstallationIds.includes(request.installationId)
    ) {
      throw catalogError("unauthorized", "installation is not in the deployment allowlist");
    }
  }

  /**
   * 一次性拉取 installation 可见仓库并缓存。失败时若已有缓存则降级为 stale，
   * 没有缓存才把错误上抛（09 §2.2「GitHub API 暂不可用显示 stale/unknown」）。
   */
  async function loadProjection(
    installationId: number,
    traceId?: string,
  ): Promise<{ items: GitHubRepositoryFacts[]; stale: boolean }> {
    const cached = projections.get(installationId);
    if (cached && now() - cached.fetchedAt < cacheTtlMs) {
      return { items: cached.items, stale: false };
    }
    try {
      const token = await deps.tokens.mintInstallationMetadataToken({ installationId, traceId });
      const items: GitHubRepositoryFacts[] = [];
      for (let page = 1; page <= maxPages; page += 1) {
        const response = await deps.transport.send<unknown>({
          method: "GET",
          path: "/installation/repositories",
          credential: { kind: "installation-token", token: token.token },
          query: { per_page: PAGE_SIZE, page },
          traceId,
        });
        if (!response.ok) throw new GitHubApiError(response.failure!);
        const repositories = readArray(asRecord(response.body), "repositories");
        for (const raw of repositories) {
          const facts = parseRepositoryFacts(raw, { installationId, lastCheckedAt: now() });
          if (facts) items.push(facts);
        }
        if (repositories.length < PAGE_SIZE) break;
      }
      projections.set(installationId, { fetchedAt: now(), items });
      return { items, stale: false };
    } catch (error) {
      if (cached) {
        deps.logger?.warn(traceId, "github repository projection is stale", {
          installationId,
          reason: error instanceof GitHubApiError ? error.code : "unknown",
        });
        return { items: cached.items, stale: true };
      }
      throw error;
    }
  }

  function isAllowed(facts: GitHubRepositoryFacts): boolean {
    const allowlist = deps.config.allowedRepositoryIds;
    return allowlist === undefined || allowlist.includes(facts.repositoryId);
  }

  /** 扁平化后的候选列表（allowlist 过滤 + query 过滤）；短期缓存，顺序稳定。 */
  async function snapshot(
    query: string | undefined,
    traceId?: string,
  ): Promise<{ items: RepositoryRef[]; stale: boolean }> {
    const collected: RepositoryRef[] = [];
    let stale = false;
    for (const installationId of deps.config.allowedInstallationIds) {
      const projection = await loadProjection(installationId, traceId);
      stale = stale || projection.stale;
      const availability = projection.stale ? "stale" : "available";
      for (const facts of projection.items) {
        if (!isAllowed(facts)) continue;
        if (query !== undefined && !`${facts.owner}/${facts.name}`.toLowerCase().includes(query)) {
          continue;
        }
        collected.push({ ...facts, availability });
      }
    }
    return { items: collected, stale };
  }

  return {
    isConfigured,
    assertAuthorized,

    listRepositories: async (request) => {
      requireConfigured();
      if (request.principalId !== deps.config.principalId) {
        // 单用户模型：非配置主体不是「空列表」，而是明确拒绝（09 §2.1）。
        throw catalogError("unauthorized", "principal is not the configured deployment principal");
      }
      const offset = decodeCursor(request.cursor);
      const query = request.query?.trim().toLowerCase();
      const { items } = await snapshot(query, request.traceId);
      const page = items.slice(offset, offset + request.limit);
      const nextOffset = offset + page.length;
      return nextOffset < items.length
        ? { items: page, nextCursor: encodeCursor(nextOffset) }
        : { items: page };
    },

    async locate(repositoryId, traceId) {
      assertAuthorized({ repositoryId });
      for (const installationId of deps.config.allowedInstallationIds) {
        const projection = projections.get(installationId);
        if (!projection || now() - projection.fetchedAt >= cacheTtlMs) continue;
        const cached = projection.items.find((facts) => facts.repositoryId === repositoryId);
        if (cached) return cached;
      }
      for (const installationId of deps.config.allowedInstallationIds) {
        const token = await deps.tokens.mintRepositoryMetadataToken({
          installationId,
          repositoryId,
          traceId,
        });
        const facts = await deps.appAuth.getRepository({
          repositoryId,
          installationId,
          installationToken: token.token,
          traceId,
        });
        // 404 = 该 installation 不可见；换下一个 allowlist installation，不据此断言「已删除」。
        if (!facts) continue;
        const projection = projections.get(installationId);
        if (projection) projection.items.push(facts);
        else projections.set(installationId, { fetchedAt: now(), items: [facts] });
        return facts;
      }
      return null;
    },

    async mintForPurpose(request) {
      assertAuthorized({
        repositoryId: request.repositoryId,
        installationId: request.installationId,
      });
      return deps.tokens.mint({
        installationId: request.installationId,
        repositoryId: request.repositoryId,
        purpose: request.purpose,
        traceId: request.traceId,
      });
    },
  };
}

/**
 * 仓库目录端点（03 §6 `repositories` / `repositories/:repoId/branches`、09 §2.1/§2.2、11 §5）。
 *
 * 边界：
 * - 授权、installation allowlist、分页游标与 stale 降级都由 W4 的 catalog 负责（注入）；
 *   控制面只做主体过滤、字段映射、冻结 schema 校验与错误归一；
 * - 未配置 GitHub → `not_configured`(503)，**不伪装空列表**（03 §6）；
 * - 越权/不可见 → 404（不泄漏存在性，03 §3）；
 * - provider 原始响应不透传给客户端，只回归一码与稳定 reason（09 §8）。
 */
import type { Context, Hono } from "hono";
import { randomUUID } from "node:crypto";
import {
  cloudBranchPageSchema,
  cloudListQuerySchema,
  cloudRepositoriesQuerySchema,
  cloudRepositoryPageSchema,
  isCloudErrorCode,
  type CloudErrorCode,
} from "@zcode/shared";
import { cloudCoreLogger } from "../../app/logger.js";
import {
  errorResponse,
  notImplemented,
  readQuery,
  type CloudHttpRouteDeps,
  type CloudRepositoryFacts,
} from "./support.js";

/** 列表端点缺省页大小（与冻结 schema 的上限 100 对齐）。 */
const DEFAULT_LIST_LIMIT = 50;

/** 归一码 → 稳定的机器可读 reason（用户可见文案由 UI/i18n 决定，03 §6）。 */
const GITHUB_FAILURE_REASONS: Partial<Record<CloudErrorCode, string>> = {
  permission_revoked: "github-permission-revoked",
  installation_revoked: "github-installation-revoked",
  repo_not_found: "github-repository-not-found",
  rate_limited: "github-rate-limited",
  network_unknown: "github-network-unknown",
  validation_failed: "github-validation-failed",
  unauthorized: "github-unauthorized",
  unauthenticated: "github-unauthenticated",
};

/** 仓库事实 → 冻结的展示记录：只回展示所需字段（不含任何凭据，03 §4/§6）。 */
function toRepositoryRecord(facts: CloudRepositoryFacts) {
  return {
    repositoryId: facts.repositoryId,
    installationId: facts.installationId,
    owner: facts.owner,
    name: facts.name,
    ...(facts.defaultBranch ? { defaultBranch: facts.defaultBranch } : {}),
    availability: facts.availability,
    ...(facts.lastCheckedAt === undefined ? {} : { lastCheckedAt: facts.lastCheckedAt }),
  };
}

/**
 * GitHub 归一错误 → 冻结错误信封（09 §8）：只回归一码与稳定 reason，
 * **不透传 provider 原始响应/文案**；细节只进服务端日志（不含 header/token）。
 */
function githubFailure(c: Context, error: unknown, scope: string) {
  const rawCode = (error as { code?: unknown } | null)?.code;
  const code: CloudErrorCode =
    typeof rawCode === "string" && isCloudErrorCode(rawCode) ? rawCode : "network_unknown";
  cloudCoreLogger.warn(undefined, "github route failure", {
    scope,
    code,
    name: error instanceof Error ? error.name : typeof error,
  });
  const reason = GITHUB_FAILURE_REASONS[code] ?? "github-error";
  return errorResponse(c, code, reason, { reason });
}

export function registerCloudRepositoryRoutes(app: Hono, deps: CloudHttpRouteDeps): void {
  const { principalId, githubConfigured } = deps;

  app.get("/api/cloud/repositories", async (c) => {
    const catalog = deps.repositoryCatalog;
    if (!catalog || !catalog.isConfigured() || !githubConfigured) {
      // 部署配置缺失 ≠ 用户未授权：按 503 not_configured（03 §6）。
      return errorResponse(c, "not_configured", "github app not configured", {
        reason: "github-not-configured",
      });
    }
    const query = cloudRepositoriesQuerySchema.safeParse(readQuery(c));
    if (!query.success) return errorResponse(c, "validation_failed", "invalid query");
    const traceId = `cloud-${randomUUID()}`;
    let page: { items: CloudRepositoryFacts[]; nextCursor?: string };
    try {
      page = await catalog.listRepositories({
        principalId,
        limit: query.data.limit ?? DEFAULT_LIST_LIMIT,
        ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        ...(query.data.query ? { query: query.data.query } : {}),
        traceId,
      });
    } catch (error) {
      return githubFailure(c, error, "repositories");
    }
    const mapped = {
      items: page.items.map(toRepositoryRecord),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
    // 冻结 schema 是消费方契约：不合规就明确失败，不把越界形状发给客户端（03 §6）。
    const parsed = cloudRepositoryPageSchema.safeParse(mapped);
    if (!parsed.success) {
      cloudCoreLogger.error(undefined, "github repository page failed schema validation", {
        count: mapped.items.length,
      });
      return errorResponse(c, "network_unknown", "repository page invalid", {
        reason: "repository-page-invalid",
      });
    }
    return c.json(parsed.data);
  });

  app.get("/api/cloud/repositories/:repoId/branches", async (c) => {
    const catalog = deps.repositoryCatalog;
    if (!catalog || !catalog.isConfigured() || !githubConfigured) {
      return errorResponse(c, "not_configured", "github app not configured", {
        reason: "github-not-configured",
      });
    }
    const repositoryId = Number.parseInt(c.req.param("repoId") ?? "", 10);
    if (!Number.isFinite(repositoryId) || repositoryId <= 0) {
      return errorResponse(c, "validation_failed", "invalid repository id");
    }
    try {
      // allowlist/可见性校验：拒绝即 404（跨主体资源统一 404，不泄漏存在性，03 §3）。
      catalog.assertAuthorized?.({ repositoryId });
    } catch {
      return errorResponse(c, "not_found", "repository-not-found", { reason: "not-found" });
    }
    const branches = deps.branchCatalog;
    if (!branches) {
      // 契约缺口：W4 的 branches 目前只有单分支 HEAD 查询，没有枚举（见报告 CR）。
      // 不伪造空列表、不用 getBranchHead 拼一个假分页。
      return notImplemented(c, "branch-enumeration-not-wired");
    }
    const query = cloudListQuerySchema.safeParse(readQuery(c));
    if (!query.success) return errorResponse(c, "validation_failed", "invalid query");
    let page: { items: { name: string; sha: string; isDefault: boolean }[]; nextCursor?: string };
    try {
      page = await branches.listBranches({
        repositoryId,
        limit: query.data.limit ?? DEFAULT_LIST_LIMIT,
        ...(query.data.cursor ? { cursor: query.data.cursor } : {}),
        traceId: `cloud-${randomUUID()}`,
      });
    } catch (error) {
      return githubFailure(c, error, "branches");
    }
    const mapped = {
      items: page.items.map((branch) => ({
        name: branch.name,
        sha: branch.sha,
        isDefault: branch.isDefault,
      })),
      ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
    };
    const parsed = cloudBranchPageSchema.safeParse(mapped);
    if (!parsed.success) {
      cloudCoreLogger.error(undefined, "github branch page failed schema validation", {
        repositoryId,
      });
      return errorResponse(c, "network_unknown", "branch page invalid", {
        reason: "branch-page-invalid",
      });
    }
    return c.json(parsed.data);
  });
}

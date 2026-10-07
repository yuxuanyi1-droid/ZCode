/**
 * cloud 路由的共享支撑：错误信封、请求体读取与路由依赖类型（03 §6 错误信封）。
 *
 * 错误信封是 shared 冻结的形状（`{code,message,retryable,traceId,details?}`）；
 * 状态码映射取 shared 的 `CLOUD_ERROR_HTTP_STATUS`，不在入口另立一份表。
 */
import type { Context } from "hono";
import {
  CLOUD_ERROR_HTTP_STATUS,
  CLOUD_ERROR_HTTP_STATUS_DEFAULT,
  CLOUD_ERROR_RETRYABLE,
  type CloudErrorCode,
  type CloudErrorEnvelope,
} from "@zcode/shared";
import { randomUUID } from "node:crypto";
import type { CloudControlPlane } from "../../app/assembleCloudControlPlane.js";
import type { CloudCommandRouter } from "../../app/attachments/router.js";
import type { CloudBridgeChannel } from "../ws/bridgeChannel.js";

/**
 * 仓库目录来源（W4 `GitHubRepositoryCatalog` 的结构子集）：按 installation allowlist 列举、
 * 分页与 stale 降级由适配层负责；控制面只做主体过滤、映射与错误归一。
 */
export interface CloudRepositoryFacts {
  repositoryId: number;
  installationId: number;
  owner: string;
  name: string;
  defaultBranch?: string;
  /** 授权投影状态（09 §2.2）：网络/5xx 不可用是 stale/unknown，不等于仓库已删除。 */
  availability: "available" | "stale" | "unavailable";
  lastCheckedAt?: number;
}

export interface CloudRepositoryCatalogSource {
  /** false 表示 GitHub 侧部署配置缺失：路由按 `not_configured`(503) 处理（03 §6）。 */
  isConfigured(): boolean;
  listRepositories(request: {
    principalId: string;
    cursor?: string;
    limit: number;
    query?: string;
    traceId?: string;
  }): Promise<{ items: CloudRepositoryFacts[]; nextCursor?: string }>;
  /** allowlist 校验：非法/无权 repo 直接拒绝（路由映射为 404，不泄漏存在性，03 §3）。 */
  assertAuthorized?(request: { repositoryId: number; installationId?: number }): void;
}

/**
 * 分支枚举来源（03 §6 `repositories/:repoId/branches` 行、11 §5「可搜索其他分支」）。
 *
 * **契约缺口（已报 W4）**：W4 的 `GitHubBranchService` 目前只有单个分支的 HEAD/比较
 * 查询，没有枚举；本接口是控制面侧的消费形状，W4 实现 `listBranches`
 * （`GET /repos/{owner}/{repo}/branches?per_page=..&page=..`）后在装配处注入即可，
 * 未注入时该端点保持结构化 `not_implemented`，不伪造空列表。
 */
export interface CloudBranchCatalogSource {
  listBranches(request: {
    repositoryId: number;
    cursor?: string;
    limit: number;
    traceId?: string;
  }): Promise<{ items: { name: string; sha: string; isDefault: boolean }[]; nextCursor?: string }>;
}

export interface CloudHttpRouteDeps {
  plane: CloudControlPlane;
  router: CloudCommandRouter;
  bridge: CloudBridgeChannel;
  principalId: string;
  /** GitHub App 是否已配置：未配置时 `repositories` 返回 `not_configured`（03 §6）。 */
  githubConfigured: boolean;
  /** 仓库目录（W4 catalog）；未注入即视为未配置。 */
  repositoryCatalog?: CloudRepositoryCatalogSource;
  /** 分支枚举（W4 `listBranches`）；未注入时该端点 `not_implemented`（见接口注释）。 */
  branchCatalog?: CloudBranchCatalogSource;
}

export interface CloudHttpRouteOptions {
  /**
   * 入口已创建的 `upgradeWebSocket`（`createNodeWebSocket({app})` 对同一 app 只能建一次）。
   * 未提供时两条 WS 通道返回结构化 `not_implemented`，不降级到本机执行域（03 §2）。
   */
  upgradeWebSocket?: CloudUpgradeWebSocket;
}

/** 结构性类型：与 hono 的 `UpgradeWebSocket` 兼容，避免把 WS 库绑进路由注册签名。 */
export type CloudUpgradeWebSocket = (createEvents: (c: Context) => unknown) => never;

export function httpStatus(code: CloudErrorCode): number {
  return CLOUD_ERROR_HTTP_STATUS[code] ?? CLOUD_ERROR_HTTP_STATUS_DEFAULT;
}

export function errorResponse(
  c: Context,
  code: CloudErrorCode,
  message: string,
  details?: Record<string, string | number | boolean>,
) {
  const envelope: CloudErrorEnvelope = {
    code,
    message: message.slice(0, 512),
    retryable: CLOUD_ERROR_RETRYABLE[code],
    traceId: `cloud-${randomUUID()}`,
    ...(details ? { details } : {}),
  };
  return c.json(envelope, httpStatus(code) as never);
}

/** app 用例统一失败 → 错误信封（不为每个端点重复映射）。 */
export function respondFailure(c: Context, failure: { code: CloudErrorCode; reason: string }) {
  return errorResponse(c, failure.code, failure.reason, { reason: failure.reason });
}

export function notImplemented(c: Context, reason: string) {
  return errorResponse(c, "not_implemented", reason, { reason });
}

/**
 * 查询串读取：先剔除入口传输层的 `token`（lite-token 走 `?token=`，不是业务契约字段），
 * 再交给 shared 的严格 schema 校验。
 */
export function readQuery(c: Context): Record<string, string> {
  const raw = c.req.query();
  const { token: _token, ...rest } = raw as Record<string, string | undefined>;
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(rest)) {
    if (value !== undefined) cleaned[key] = value;
  }
  return cleaned;
}

/** 空体动作端点也接受无 body 的请求（`cloudEmptyBodySchema` 只约束形状）。 */
export async function readJson(c: Context): Promise<unknown> {
  try {
    const text = await c.req.text();
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch {
    return null;
  }
}

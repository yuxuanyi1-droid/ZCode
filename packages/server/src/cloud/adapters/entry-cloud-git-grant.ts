/**
 * 执行节点 git-grant 端点的入口装配（specs/cloud-agent/01 §7.2、09 §3 权限矩阵、W5 §3/§4）。
 *
 * 这是**执行节点唯一的 HTTP 面**（对照 `isExecutionNodeHttpPath`）：沙箱 supervisor 在
 * bootstrap 阶段用 `Authorization: Bearer <当前 run 凭据>`（`execution/adapters/gitRunner.ts`）
 * 兑换一个短效、单次、run-scoped 的 git token。因此：
 *
 * - 本模块**只做装配**：鉴权材料解析 → `resolveRunPrincipal` → W4 的 broker 兑换；
 *   单次兑换、TTL、撤销与「旧代际不得领取」全部由 `createGitGrantBroker` 的 store CAS 保证，
 *   入口**不重写第二份兑换规则**（01 §7.2）。
 * - 主体不采信查询参数：`repositoryId`/`installationId` 取 run/project 的**持久事实**（11 §4.3），
 *   URL 上的 `purpose` 只是本次兑换目的，且必须落在规格枚举内。
 * - token 不进日志、不进 URL、不落盘：日志只记 status/code/grantId（broker 已按此口径写）。
 */
import type { Context } from "hono";
import type { GitGrantPurpose } from "../app/ports/gitGrantPort.js";
import type { RunCredentialRepo } from "../app/ports/credentialPort.js";
import type { ProjectRepo, RunRepo, TaskRepo } from "../app/ports/storagePort.js";
import type { CloudRunStatus } from "@zcode/shared";
import { sha256Hex, type GitGrantBroker } from "./secret/gitGrantBroker.js";
import type { CloudGitGrantService } from "../app/gitGrants.js";
import {
  createGitGrantRouteHandler,
  type GitGrantPrincipalResolution,
  type GitGrantRouteRequest,
  type GitGrantRouteResponse,
} from "./secret/gitGrantRoute.js";
import { createGitHubAdapter } from "./github/adapter.js";
import type { GitHubTokenService } from "./github/tokens.js";
import type { CloudAdapterLogger } from "./sandbox/adapterError.js";
import { CloudEntryStartupError } from "./entry-cloud-config.js";
import type { CloudDeploymentSecrets } from "./entry-cloud-secrets.js";
import { errorEnvelope } from "./entry-cloud-http.js";
import type { ContentfulStatusCode } from "hono/utils/http-status";

/** 规格枚举（`GitGrantPurpose`）：URL 上的 purpose 越界即拒，不猜意图。 */
const GIT_GRANT_PURPOSES: readonly GitGrantPurpose[] = ["clone", "fetch", "push"];

/** 终态 run 不得再兑换 git 凭据（08 §3.2：终态不可复活）。 */
const TERMINAL_RUN_STATUSES: readonly CloudRunStatus[] = ["stopped", "expired", "failed"];

export interface CloudGitGrantStorage {
  readonly runs: RunRepo;
  readonly tasks: TaskRepo;
  readonly projects: ProjectRepo;
  readonly credentials: RunCredentialRepo;
}

export interface CreateCloudGitGrantRouteDeps {
  /**
   * W1 的 git grant 服务（签发在 app 层、兑换在 HTTP 层）：**必须与控制面共用同一实例**，
   * 否则 broker 内存里的 heldTokens 会分裂，撤销退化成 `token-not-held`（01 §7.2）。
   */
  gitGrants: CloudGitGrantService;
  storage: CloudGitGrantStorage;
  logger: CloudAdapterLogger;
  /** GitHub App 是否已配置（能力声明用；未配置时兑换按 not_configured fail-closed）。 */
  configured?: boolean;
}

export interface CloudGitGrantRoute {
  /** `GET /api/cloud/runs/:runId/git-grant` 的 Hono 处理函数。 */
  readonly handle: (c: Context) => Promise<Response>;
  readonly configured: boolean;
}

/** 从 `Authorization` 头取 Bearer（01 §7.2：**只走请求头**，不放 query）。 */
function readBearerAuthorization(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  const credential = match?.[1]?.trim();
  return credential ? credential : undefined;
}

function isGitGrantPurpose(value: string | undefined): value is GitGrantPurpose {
  return value !== undefined && (GIT_GRANT_PURPOSES as readonly string[]).includes(value);
}

/**
 * 用部署秘密构建 GitHub token 服务（W4 工厂，单一实现）。未配置 App 返回 undefined：
 * 端点仍在，但兑换按 `not_configured` fail-closed，不伪造 token。
 */
export function createCloudGitHubTokenService(
  secrets: CloudDeploymentSecrets,
  logger: CloudAdapterLogger,
): GitHubTokenService | undefined {
  const app = secrets.gitHubApp;
  if (!app) {
    return undefined;
  }
  const appId = Number.parseInt(app.appId, 10);
  if (!Number.isFinite(appId) || appId <= 0) {
    throw new CloudEntryStartupError("not_configured", "github app id invalid", {
      appId: app.appId,
    });
  }
  return createGitHubAdapter({
    config: {
      principalId: secrets.principalId,
      appId,
      privateKeyPem: app.privateKeyPem,
      allowedInstallationIds: app.allowedInstallationIds,
    },
    logger,
  }).tokens;
}

export function createCloudGitGrantRoute(deps: CreateCloudGitGrantRouteDeps): CloudGitGrantRoute {
  const now = Date.now;

  /**
   * run-scoped 主体解析（W4 handler 的注入点）：
   * Bearer → sha256 → 非消费校验（`verifyActiveCredential`）→ run/task/project 持久事实。
   */
  async function resolveRunPrincipal(
    request: GitGrantRouteRequest,
  ): Promise<GitGrantPrincipalResolution> {
    if (!request.credential) {
      return { ok: false, code: "unauthenticated", message: "missing bearer credential" };
    }
    const record = await deps.storage.credentials.verifyActiveCredential({
      runId: request.runId,
      proofHash: sha256Hex(request.credential),
      now: now(),
    });
    if (!record) {
      // 无记录 / hash 不符 / 已撤销 / 已过期：统一 unauthenticated，不区分原因。
      return { ok: false, code: "unauthenticated", message: "run credential rejected" };
    }
    const run = await deps.storage.runs.get(request.runId);
    if (!run) {
      return { ok: false, code: "not_found", message: "run not found" };
    }
    if (run.runGeneration !== record.runGeneration) {
      return { ok: false, code: "stale", message: "credential generation is not current" };
    }
    if (TERMINAL_RUN_STATUSES.includes(run.status)) {
      return { ok: false, code: "stale", message: `run is ${run.status}` };
    }
    const task = await deps.storage.tasks.get(run.taskId);
    if (!task) {
      return { ok: false, code: "not_found", message: "task not found" };
    }
    const project = await deps.storage.projects.get(task.projectId);
    if (!project?.repositoryId || !project.installationId) {
      // 仓库授权事实缺失：部署/授权未就绪，不是「用户未授权」。
      return { ok: false, code: "not_configured", message: "project repository is not bound" };
    }
    return {
      ok: true,
      principal: {
        taskId: task.taskId,
        runId: run.runId,
        runGeneration: run.runGeneration,
        repositoryId: project.repositoryId,
      },
    };
  }

  // 兑换走控制面注入的服务（与签发同一 broker 实例）；URL 上的 purpose 与主体由上面校验。
  const broker: Pick<GitGrantBroker, "redeem"> = {
    redeem: (request) =>
      deps.gitGrants.redeem({
        runId: request.runId,
        purpose: request.purpose,
        runGeneration: request.runGeneration,
        repositoryId: request.repositoryId,
        ...(request.proof ? { proof: request.proof } : {}),
        ...(request.traceId ? { traceId: request.traceId } : {}),
      }),
  };

  const handler = createGitGrantRouteHandler({
    broker,
    resolveRunPrincipal,
    logger: deps.logger,
  });

  return {
    configured: deps.configured ?? true,
    async handle(c: Context): Promise<Response> {
      const runId = c.req.param("runId") ?? "";
      const purpose = c.req.query("purpose");
      if (!runId || !isGitGrantPurpose(purpose)) {
        // 目的越界即拒（01 §7.2 只接受规格枚举），不猜意图、不回落默认 purpose。
        const rejection = errorEnvelope(
          "validation_failed",
          "runId and purpose (clone|fetch|push) are required",
        );
        return c.json(rejection, 400);
      }
      const response: GitGrantRouteResponse = await handler({
        runId,
        credential: readBearerAuthorization(c.req.header("authorization")) ?? "",
        purpose,
      });
      return c.json(response.body, response.status as ContentfulStatusCode);
    },
  };
}

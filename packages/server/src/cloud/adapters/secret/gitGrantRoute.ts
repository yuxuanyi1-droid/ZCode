/**
 * `/api/cloud/runs/:runId/git-grant` 的传输无关处理器（specs/cloud-agent/01 §7.2、
 * 09 §3、03 §6 端点前缀与错误信封、W4 §4「对 W5：路由注册函数 + principal 解析注入」）。
 *
 * 边界：
 * - 本模块不读 cookie/query/Authorization：run-scoped 认证由入口层（W5）解析后经
 *   `resolveRunPrincipal` 注入；这里只做「凭据属于路径上的 run」与 grant 绑定校验。
 * - 响应形状必须命中 shared 冻结的 `cloudGitGrantResponseSchema`（03 §6），
 *   校验失败按服务端问题处理，不返回半成品。
 * - token 只在响应体出现一次；不写日志、不写磁盘、不进 URL（01 §7.2）。
 */
import { randomUUID } from "node:crypto";
import {
  CLOUD_ERROR_HTTP_STATUS,
  CLOUD_ERROR_RETRYABLE,
  cloudGitGrantResponseSchema,
  type CloudErrorCode,
  type CloudErrorEnvelope,
  type CloudGitGrantResponse,
} from "@zcode/shared";
import type { CloudAdapterLogger } from "../github/logging.js";
import type { GitGrantBroker, GitGrantDenial, GitGrantPurpose } from "./gitGrantBroker.js";

export interface GitGrantRouteRequest {
  /** 路径参数 runId（W5 从路由取出）。 */
  runId: string;
  /** 入口层透传的 run-scoped 凭据材料；本模块不解析其格式。 */
  credential: string;
  /** 本次兑换目的（helper 明确声明）；必须与签发时的 purpose 一致。 */
  purpose: GitGrantPurpose;
  traceId?: string;
}

export interface GitGrantPrincipal {
  taskId: string;
  runId: string;
  runGeneration: number;
  /** 该 run 冻结/授权的仓库；不采信查询参数（11 §4.3）。 */
  repositoryId: number;
}

export type GitGrantPrincipalResolution =
  | { ok: true; principal: GitGrantPrincipal }
  | { ok: false; code: CloudErrorCode; message: string };

export interface GitGrantRouteResponse {
  status: number;
  body: CloudGitGrantResponse | CloudErrorEnvelope;
}

export function createGitGrantRouteHandler(deps: {
  /**
   * 兑换动作：由控制面注入（W1 的 `CloudGitGrantService`，与签发共用同一 broker 实例）。
   * 只取 `redeem`，避免路由重新实现 TTL/CAS/绑定规则（01 §7.2）。
   */
  broker: Pick<GitGrantBroker, "redeem">;
  resolveRunPrincipal: (request: GitGrantRouteRequest) => Promise<GitGrantPrincipalResolution>;
  logger?: CloudAdapterLogger;
  newTraceId?: () => string;
}): (request: GitGrantRouteRequest) => Promise<GitGrantRouteResponse> {
  const newTraceId = deps.newTraceId ?? randomUUID;

  function errorResponse(
    code: CloudErrorCode,
    message: string,
    traceId: string,
  ): GitGrantRouteResponse {
    return {
      status: CLOUD_ERROR_HTTP_STATUS[code] ?? 400,
      body: {
        code,
        message: message.slice(0, 512),
        retryable: CLOUD_ERROR_RETRYABLE[code],
        traceId,
      },
    };
  }

  return async function handleGitGrant(request) {
    const traceId = request.traceId ?? newTraceId();
    const resolution = await deps.resolveRunPrincipal(request);
    if (!resolution.ok) {
      deps.logger?.warn(traceId, "git grant principal rejected", {
        runId: request.runId,
        code: resolution.code,
      });
      return errorResponse(resolution.code, resolution.message, traceId);
    }
    const principal = resolution.principal;
    if (principal.runId !== request.runId) {
      // 凭据必须属于路径上的 run：否则是跨 run 借用（01 §7.2 run-scoped 认证）。
      return errorResponse("unauthorized", "credential does not belong to this run", traceId);
    }
    // 兑换对象是「该 run+purpose 当前 issued 的 grant」，不接受请求方指定 grantId；
    // 单次兑换由 store 的 CAS 保证（01 §7.2）。
    const redemption = await deps.broker.redeem({
      taskId: principal.taskId,
      runId: principal.runId,
      runGeneration: principal.runGeneration,
      repositoryId: principal.repositoryId,
      purpose: request.purpose,
      proof: request.credential,
      traceId,
    });
    if (!redemption.ok) {
      return errorResponse(redemption.code, denialMessage(redemption), traceId);
    }
    const parsed = cloudGitGrantResponseSchema.safeParse({
      grantId: redemption.grantId,
      token: redemption.token,
      expiresAt: redemption.expiresAt,
      repositoryId: redemption.repositoryId,
      purpose: redemption.purpose,
    });
    if (!parsed.success) {
      deps.logger?.error(traceId, "git grant response failed schema validation", {
        grantId: redemption.grantId,
      });
      return errorResponse("validation_failed", "git grant response is malformed", traceId);
    }
    return { status: 200, body: parsed.data };
  };
}

function denialMessage(denial: GitGrantDenial): string {
  return `git grant denied: ${denial.reason}`;
}

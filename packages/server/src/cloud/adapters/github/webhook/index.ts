/**
 * GitHub webhook 入口（specs/cloud-agent/09 §6 全文、00 §11 决议⑤、W4 §8 风险项）。
 *
 * **本波次不实现验签、delivery inbox 与 sender 授权**：部署模型为单用户，
 * M7（多账号/公开服务/GitHub webhook 触发）不在当前路线图，保留为条件性设计
 * （00 §11 决议⑤）。切片只交付「端点存在、明确 501、默认拒绝」三件事：
 *
 * - `POST /api/cloud/github/webhook` 固定返回 `not_implemented`(501)，
 *   与 shared 端点矩阵 `githubWebhook` 行的 availability 一致（03 §6）。
 * - 不做「半套验签」：验签成功也只是来源证明，不是业务授权（09 §6.2），
 *   在 sender 授权、durable inbox、幂等业务键落地前，任何请求都不产生业务副作用。
 * - 启用前置条件（未完成前不得打开）：09 §6.1 的原始字节 HMAC + `(appId, deliveryId)`
 *   唯一 inbox + 事务后 2xx；09 §6.2 的 installation/repo/sender 授权与默认拒绝；
 *   09 §6.3 的触发矩阵与业务幂等键；以及 01 §7.2 的 Git 写隔离。
 */
import { randomUUID } from "node:crypto";
import type { CloudErrorEnvelope } from "@zcode/shared";

export interface GitHubWebhookRequest {
  /** 由入口层透传的请求头；本模块不解析它们（也不读 cookie/query）。 */
  headers: Readonly<Record<string, string | undefined>>;
  /** 原始请求字节；未实现阶段只用于大小判定，不做任何解析。 */
  rawBody: Uint8Array;
  traceId?: string;
}

export interface GitHubWebhookResponse {
  status: number;
  body: CloudErrorEnvelope;
}

export interface GitHubWebhookIngress {
  readonly enabled: boolean;
  handle(request: GitHubWebhookRequest): Promise<GitHubWebhookResponse>;
}

export function createGitHubWebhookIngress(options?: { enabled?: boolean }): GitHubWebhookIngress {
  const enabled = options?.enabled === true;
  if (enabled) {
    // 没有实现的能力不得被配置打开：宁可启动失败，也不要一个看起来在验签的入口。
    throw new Error(
      "github webhook ingress is M7-conditional and not implemented; see specs/cloud-agent/09 §6",
    );
  }
  return {
    enabled: false,
    async handle(request) {
      return {
        status: 501,
        body: {
          code: "not_implemented",
          message: "github webhook ingress is not implemented in this deployment model",
          retryable: false,
          traceId: request.traceId ?? randomUUID(),
        },
      };
    },
  };
}

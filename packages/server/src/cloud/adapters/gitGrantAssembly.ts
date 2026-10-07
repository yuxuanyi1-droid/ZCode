/**
 * git grant 的入口侧装配（specs/cloud-agent 01 §7.2 Git grant、09 §3 权限矩阵）。
 *
 * 为什么单独一个文件：控制面入口文件已顶到架构上限（`max-file-lines` 400），而这段装配
 * 是**唯一的 broker 实例**创建点 —— 签发（`app/gitGrants.ts` → `issueForRun`）与兑换
 * （执行节点 HTTP 端点）必须共用它，否则 broker 内存里的 heldTokens 会分裂、撤销退化成
 * `token-not-held`（01 §7.2 单次兑换 + 撤销）。
 *
 * 边界：
 * - token 服务注入优先（测试/嵌入方的 fake），否则由部署秘密构造 W4 adapter；两者都只在
 *   这里取一次，不允许调用方另建第二个 broker。
 * - store 不存在时不装配（`undefined`），由 app 层 fail-closed 成 `not_configured`，
 *   入口据此不挂载该端点，而不是伪造一个内存 store。
 */
import type { GitGrantStore } from "../app/ports/gitGrantPort.js";
import type { GitGrantBrokerPort } from "../app/ports/gitGrantBrokerPort.js";
import { createGitGrantBroker } from "./secret/gitGrantBroker.js";
import type { GitHubTokenService } from "./github/tokens.js";
import { createCloudGitHubTokenService } from "./entry-cloud-git-grant.js";
import type { CloudDeploymentSecrets } from "./entry-cloud-secrets.js";
import { CloudControlPlaneAssemblyError } from "./controlPlaneAssemblyError.js";
import { cloudCoreLogger } from "../app/logger.js";

/** W4 adapter 的 logger 形态（ServiceLogger + scope）。 */
export function cloudAdapterLogger(): { scope: string } & typeof cloudCoreLogger {
  return { ...cloudCoreLogger, scope: "cloud-control-plane" };
}

export function assembleGitGrantBroker(input: {
  store?: GitGrantStore;
  secrets: CloudDeploymentSecrets;
  /** 注入优先（测试 fake）；缺省按 `secrets.gitHubApp` 构造 W4 token 服务。 */
  injectedTokens?: GitHubTokenService;
  now: () => number;
}): GitGrantBrokerPort | undefined {
  const { store, secrets } = input;
  if (!store) return undefined;
  const tokens =
    input.injectedTokens ?? createCloudGitHubTokenService(secrets, cloudAdapterLogger());
  // 结构化赋值即漂移守卫：端口与 W4 broker 任一侧改形状都会在这里编译失败。
  const broker: GitGrantBrokerPort = createGitGrantBroker({
    store,
    mint: async ({ repositoryId, installationId, purpose }) => {
      if (!tokens) {
        throw new CloudControlPlaneAssemblyError(
          "not_configured",
          "github app is not configured; git grants cannot be minted",
        );
      }
      // 单 repo + 按 purpose 的最小权限矩阵在 W4 token 服务里（09 §3）。
      return tokens.mint({ installationId, repositoryId, purpose });
    },
    revokeToken: async (token) => {
      if (!tokens) return { revoked: false, reason: "not-configured" };
      const outcome = await tokens.revoke({ token });
      return { revoked: outcome.revoked, reason: outcome.reason };
    },
    now: input.now,
    logger: cloudAdapterLogger(),
  });
  return broker;
}

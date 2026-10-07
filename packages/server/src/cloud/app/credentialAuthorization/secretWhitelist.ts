/**
 * 沙箱秘密白名单（01 §7.1 授权与存放表、§7.1 实施决议、02 §9 安全与授权）。
 *
 * 冻结边界：
 * - Provider API key、App 私钥、webhook secret **永不**进沙箱；
 * - 模型凭据：可信单用户 v1 允许随 run 安装（单一配置源，run 内持久、沙箱销毁即灭），
 *   但它仍是「按 run 授权清单」安装，不是复制整个 credential store；
 * - MCP/registry/依赖凭据默认空，需要显式 task manifest 授权；
 * - bootstrap/reconnect ticket 绑定 run/runGeneration/期限，不是一般用户权限；
 * - GitHub installation token 只按单 repo + purpose 的 grant 短期领取（见 authorization.ts）。
 */
export type CloudSecretClass =
  | "provider-api-key"
  | "app-private-key"
  | "webhook-secret"
  | "github-installation-token"
  | "model-credential"
  | "mcp-credential"
  | "bootstrap-ticket";

export interface RunSecretPolicy {
  /** 允许安装进该 run 沙箱的秘密类别。 */
  allowed: readonly CloudSecretClass[];
  /** 需要显式 task manifest 授权的类别（默认不装）。 */
  requiresTaskManifest: readonly CloudSecretClass[];
}

/** 部署形态：可信单用户是首版唯一形态（00 §11 决议⑤、01 §7.1 实施决议）。 */
export type CloudDeploymentModel = "trusted-single-user" | "multi-tenant";

export function resolveRunSecretPolicy(input: {
  deployment: CloudDeploymentModel;
  taskAuthorizesMcp: boolean;
}): RunSecretPolicy {
  const allowed: CloudSecretClass[] = ["bootstrap-ticket", "github-installation-token"];
  if (input.deployment === "trusted-single-user") {
    allowed.push("model-credential");
  }
  if (input.taskAuthorizesMcp) allowed.push("mcp-credential");
  return {
    allowed,
    requiresTaskManifest: ["mcp-credential"],
  };
}

export function isSecretAllowed(policy: RunSecretPolicy, secretClass: CloudSecretClass): boolean {
  return policy.allowed.includes(secretClass);
}

/**
 * 白名单执行：返回被拒类别（调用方必须据此拒绝安装，而不是静默跳过）。
 * provider key / App 私钥 / webhook secret 永远被拒（01 §7.1 表格「沙箱权限：无」）。
 */
export function rejectDisallowedSecrets(
  policy: RunSecretPolicy,
  requested: readonly CloudSecretClass[],
): CloudSecretClass[] {
  return requested.filter((secretClass) => !isSecretAllowed(policy, secretClass));
}

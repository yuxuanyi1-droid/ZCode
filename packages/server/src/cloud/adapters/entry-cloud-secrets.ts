/**
 * 云侧部署秘密加载（specs/cloud-agent/modules/W5-cloud-entry.md §3；03 §3/§8、09 §3、01 §7.1）。
 *
 * 入口侧适配层：把入口配置里的**秘密引用**映射成 `adapters/secret` 的 `loadDeploySecrets`
 * 输入，并把失败归一为入口的结构化启动错误。秘密的读取、0600/属主/符号链接判定与 PEM
 * 校验只有一份实现（`../secret/deploySecrets.ts`，W4 负责人文件）——入口**不**复制一套
 * 权限判定，否则两处规则漂移会直接变成凭据边界缺口。
 *
 * 边界：
 * - 秘密**值**只在本模块与调用方内存中出现；`describe()` 只回引用与结构化事实。
 * - 缺 auth token 一律启动失败：cloud 模式没有匿名入口（03 §3）。
 * - 账号/模型凭据归 host 本体 `ICredentialService`（12 §1.1），本文件只处理部署级秘密。
 */
import { createServiceLogger } from "@zcode/services/node";
import {
  loadDeploySecrets,
  DeploySecretError,
  type DeploySecretsFs,
} from "./secret/deploySecrets.js";
import { CloudEntryStartupError, type CloudSecretRefs } from "./entry-cloud-config.js";
import type { CloudAdapterLogger } from "./sandbox/adapterError.js";

export interface CloudGitHubAppSecret {
  /** 字符串形式便于放进配置投影；数值合法性由 `loadDeploySecrets` 校验。 */
  readonly appId: string;
  /** PEM 正文；只经内存传给 GitHub App JWT 签名，不落盘、不进日志。 */
  readonly privateKeyPem: string;
  readonly allowedInstallationIds: readonly number[];
}

export interface CloudDeploymentSecrets {
  readonly authToken: string;
  /** host 凭据存储的加密密钥（12 §4：部署注入），属 host 账号域，不是 GitHub 秘密。 */
  readonly credentialSecret?: string;
  readonly gitHubApp?: CloudGitHubAppSecret;
  readonly principalId: string;
  /** 脱敏摘要：只有引用与「已配置/未配置」，可安全进日志与诊断。 */
  describe(): CloudDeploymentSecretsDescription;
}

export interface CloudDeploymentSecretsDescription {
  readonly principalId: string;
  readonly authToken: "configured";
  readonly credentialSecret: "configured" | "absent";
  readonly gitHubApp: "configured" | "absent";
}

export interface LoadCloudEntrySecretsOptions {
  readonly refs: CloudSecretRefs;
  readonly env: Record<string, string | undefined>;
  /** 注入点沿用 W4 的实现（测试可不落盘）。 */
  readonly fs?: DeploySecretsFs;
  readonly uid?: number;
  /** 日志注入（测试可静音）；缺省用 `cloud-entry-secrets` scope。 */
  readonly logger?: CloudAdapterLogger;
}

/** 部署秘密失败统一映射为入口的 `not_configured`（03 §6：503 才是未就绪的正确信号）。 */
function toStartupError(error: unknown): CloudEntryStartupError {
  if (error instanceof DeploySecretError) {
    return new CloudEntryStartupError("not_configured", error.message, {
      problem: error.problem,
      ref: error.ref,
    });
  }
  return new CloudEntryStartupError(
    "not_configured",
    `部署秘密加载失败: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * 加载部署秘密。任一项缺失/权限不合格即抛出结构化错误，调用方负责回收已启动资源
 * （03 §8：host 本体先起，失败必须回落清理）。
 */
export async function loadCloudEntrySecrets(
  options: LoadCloudEntrySecretsOptions,
): Promise<CloudDeploymentSecrets> {
  const { refs, env } = options;
  if (!refs.principalId?.trim()) {
    throw new CloudEntryStartupError(
      "not_configured",
      "cloud 模式必须配置稳定的 deploymentPrincipalId（03 §3）",
    );
  }
  if (!refs.authTokenFile) {
    throw new CloudEntryStartupError(
      "not_configured",
      "cloud 模式缺少认证凭据：必须以 0600 文件提供 auth token，才允许监听入口",
    );
  }

  const github =
    refs.githubAppId && refs.githubAppPrivateKeyFile
      ? {
          appId: Number(refs.githubAppId),
          privateKeyFile: refs.githubAppPrivateKeyFile,
          ...(refs.githubWebhookSecretFile
            ? { webhookSecretFile: refs.githubWebhookSecretFile }
            : {}),
          allowedInstallationIds: refs.githubAllowedInstallationIds ?? [],
        }
      : undefined;

  let loaded: Awaited<ReturnType<typeof loadDeploySecrets>>;
  try {
    loaded = await loadDeploySecrets(
      {
        principalId: refs.principalId.trim(),
        authTokenFile: refs.authTokenFile,
        ...(github ? { github } : {}),
      },
      {
        ...(options.fs ? { fs: options.fs } : {}),
        ...(options.uid !== undefined ? { uid: options.uid } : {}),
        logger: options.logger ?? createServiceLogger("cloud-entry-secrets"),
      },
    );
  } catch (error) {
    throw toStartupError(error);
  }

  const credentialSecret = refs.credentialSecretEnv
    ? env[refs.credentialSecretEnv]?.trim() || undefined
    : undefined;

  const describe = (): CloudDeploymentSecretsDescription => ({
    principalId: loaded.principalId,
    authToken: "configured",
    credentialSecret: credentialSecret ? "configured" : "absent",
    gitHubApp: loaded.github ? "configured" : "absent",
  });

  return {
    authToken: loaded.authToken,
    principalId: loaded.principalId,
    ...(credentialSecret ? { credentialSecret } : {}),
    ...(loaded.github
      ? {
          gitHubApp: {
            appId: String(loaded.github.appId),
            privateKeyPem: loaded.github.privateKeyPem,
            allowedInstallationIds: [...loaded.github.allowedInstallationIds],
          },
        }
      : {}),
    describe,
  };
}

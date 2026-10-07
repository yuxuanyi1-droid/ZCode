export const SERVICE_AUTHORITY_MODE_ENV = "ZCODE_SERVICE_AUTHORITY_MODE";

/**
 * 权威模式（07 §8）：决定「谁应答 runtime preferences/policy、是否暴露 provider
 * provisioning target、是否是本机 workspace 执行域」。
 *
 * - `desktop-local` / `desktop-attached-remote`：既有的桌面/远控语义，未改动；
 * - `standalone-server`：既有远端服务端模式；
 * - `cloud-execution-node`（冻结，v1 云执行节点使用）：远端裁剪——**不提供**本机
 *   workspace 执行（云任务落点只有沙箱 attachment，03 §2）；runtime preferences/policy
 *   由**节点自身应答**，不依赖浏览器在线（07 §8）；**开启** provider provisioning target
 *   （账号/静态 envelope 经 `bootstrap.config` 安装，12 §6）。
 */
export const serviceAuthorityModes = [
  "desktop-local",
  "desktop-attached-remote",
  "standalone-server",
  "cloud-execution-node",
] as const;

export type ServiceAuthorityMode = (typeof serviceAuthorityModes)[number];

export function isServiceAuthorityMode(value: unknown): value is ServiceAuthorityMode {
  return typeof value === "string" && serviceAuthorityModes.includes(value as ServiceAuthorityMode);
}

export function parseServiceAuthorityMode(env: Record<string, string | undefined>): {
  mode: ServiceAuthorityMode | undefined;
  invalidRawValue: string | undefined;
} {
  const rawValue = env[SERVICE_AUTHORITY_MODE_ENV]?.trim();
  if (!rawValue) {
    return {
      mode: undefined,
      invalidRawValue: undefined,
    };
  }

  if (isServiceAuthorityMode(rawValue)) {
    return {
      mode: rawValue,
      invalidRawValue: undefined,
    };
  }

  return {
    mode: undefined,
    invalidRawValue: rawValue,
  };
}

/**
 * 是否使用 host 本体的 provider registry source 组装 provisioning envelope。
 * `cloud-execution-node` 需要它（envelope 经 `bootstrap.config` 安装，12 §6），
 * 因此与 `desktop-local`/`standalone-server` 同侧、不在排除之列。
 */
export function shouldUseProviderRegistrySourceForAuthorityMode(
  mode: ServiceAuthorityMode | undefined,
): boolean {
  return mode !== "desktop-attached-remote";
}

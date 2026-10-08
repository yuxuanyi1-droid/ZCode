/**
 * 云入口配置读取与 fail-closed 校验（specs/cloud-agent/03 §2/§3/§8、W5 §3/§4）。
 * 公开配置契约：全部配置项在此登记，禁止入口各层散落 `process.env` 直读（03 §2 末段）。
 * fail-closed（W5 §5）：缺认证 / 数据目录不可写 / 迁移未就绪 / provider 版本不兼容
 * 一律明确失败，**不隐式切回 local**；`local` 是显式模式值，不是云入口的回退。
 */
import {
  CLOUD_DEFAULT_LISTEN_PORT,
  CLOUD_DEFAULT_MAX_CONCURRENT_RUNS,
  CloudEntryStartupError,
  ZCODE_CLOUD_ALLOW_UNVERIFIED_PROVIDERS_ENV,
  ZCODE_CLOUD_AUTH_MODE_ENV,
  ZCODE_CLOUD_DATA_DIR_ENV,
  ZCODE_CLOUD_GITHUB_ALLOWED_INSTALLATIONS_ENV,
  ZCODE_CLOUD_GITHUB_APP_ID_ENV,
  ZCODE_CLOUD_GITHUB_APP_KEY_FILE_ENV,
  ZCODE_CLOUD_GITHUB_WEBHOOK_SECRET_FILE_ENV,
  ZCODE_CLOUD_LISTEN_HOST_ENV,
  ZCODE_CLOUD_LISTEN_PORT_ENV,
  ZCODE_CLOUD_MAX_CONCURRENT_RUNS_ENV,
  ZCODE_CLOUD_MODEL_ENV,
  ZCODE_CLOUD_PRINCIPAL_ID_ENV,
  ZCODE_CLOUD_PROVIDERS_ENV,
  ZCODE_CLOUD_PUBLIC_ORIGIN_ENV,
  ZCODE_CLOUD_SANDBOX_IDLE_PAUSE_SECONDS_ENV,
  ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS_ENV,
  ZCODE_CLOUD_SANDBOX_TEMPLATE_REF_ENV,
  ZCODE_CLOUD_STORAGE_WORKER_ENTRY_ENV,
  ZCODE_CLOUD_WEB_DIR_ENV,
  ZCODE_SERVER_AUTH_TOKEN_FILE_ENV,
  ZCODE_SERVER_MODE_ENV,
  assertWebDir,
  type CloudAuthMode,
  type CloudEntryConfig,
  type CloudEntryConfigIssue,
  type CloudEntryConfigIssueCode,
  type CloudEntryConfigResult,
  type CloudSecretRefs,
  type CloudStaticModelFallback,
  type LocalEntryConfig,
  type ZCodeServerMode,
} from "./entry-cloud-config-contract.js";
import {
  parseCloudAuthMode,
  parseIdList,
  parseOptionalNonNegativeInt,
  parsePositiveInt,
  parsePrincipalId,
  parsePublicOrigin,
  parseSandboxLifetimeLimits,
  parseSandboxTemplateRefs,
  parseStaticModelFallback,
  readTrimmed,
  splitList,
} from "./entry-cloud-config-parse.js";

// 公开配置契约（键名、默认值、启动错误类型、配置形状）原样再导出：外部消费方不变。
export {
  CLOUD_DEFAULT_LISTEN_PORT,
  CLOUD_DEFAULT_MAX_CONCURRENT_RUNS,
  CloudEntryStartupError,
  ZCODE_CLOUD_ALLOW_UNVERIFIED_PROVIDERS_ENV,
  ZCODE_CLOUD_AUTH_MODE_ENV,
  ZCODE_CLOUD_DATA_DIR_ENV,
  ZCODE_CLOUD_GITHUB_ALLOWED_INSTALLATIONS_ENV,
  ZCODE_CLOUD_GITHUB_APP_ID_ENV,
  ZCODE_CLOUD_GITHUB_APP_KEY_FILE_ENV,
  ZCODE_CLOUD_GITHUB_WEBHOOK_SECRET_FILE_ENV,
  ZCODE_CLOUD_LISTEN_HOST_ENV,
  ZCODE_CLOUD_LISTEN_PORT_ENV,
  ZCODE_CLOUD_MAX_CONCURRENT_RUNS_ENV,
  ZCODE_CLOUD_MODEL_ENV,
  ZCODE_CLOUD_PRINCIPAL_ID_ENV,
  ZCODE_CLOUD_PROVIDERS_ENV,
  ZCODE_CLOUD_PUBLIC_ORIGIN_ENV,
  ZCODE_CLOUD_SANDBOX_IDLE_PAUSE_SECONDS_ENV,
  ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS_ENV,
  ZCODE_CLOUD_SANDBOX_TEMPLATE_REF_ENV,
  ZCODE_CLOUD_STORAGE_WORKER_ENTRY_ENV,
  ZCODE_CLOUD_WEB_DIR_ENV,
  ZCODE_SERVER_AUTH_TOKEN_FILE_ENV,
  ZCODE_SERVER_MODE_ENV,
} from "./entry-cloud-config-contract.js";
export type {
  CloudAuthMode,
  CloudEntryConfig,
  CloudEntryConfigIssue,
  CloudEntryConfigIssueCode,
  CloudEntryConfigResult,
  CloudSecretRefs,
  CloudStaticModelFallback,
  LocalEntryConfig,
  ZCodeServerMode,
} from "./entry-cloud-config-contract.js";

export async function readCloudEntryConfig(
  env: Record<string, string | undefined>,
): Promise<CloudEntryConfigResult> {
  const modeValue = readTrimmed(env, ZCODE_SERVER_MODE_ENV);
  if (modeValue && modeValue !== "local" && modeValue !== "cloud") {
    // 拼错的模式不能静默当 local：那等于把云部署降级成本机入口（W5 §5）。
    return {
      ok: false,
      issues: [
        {
          code: "mode_invalid",
          field: ZCODE_SERVER_MODE_ENV,
          message: `${ZCODE_SERVER_MODE_ENV} 只能是 local 或 cloud`,
        },
      ],
    };
  }
  if (modeValue !== "cloud") {
    return { ok: true, config: { mode: "local" } };
  }

  const issues: CloudEntryConfigIssue[] = [];

  // 鉴权模式先解析：它决定 authTokenFile 是否必填（03 §3 修订 2026-10-07 的跨字段校验）。
  const authMode = parseCloudAuthMode(readTrimmed(env, ZCODE_CLOUD_AUTH_MODE_ENV));
  if (authMode === "invalid") {
    issues.push({
      code: "auth_mode_invalid",
      field: ZCODE_CLOUD_AUTH_MODE_ENV,
      message: `${ZCODE_CLOUD_AUTH_MODE_ENV} 只能是 token 或 anonymous`,
    });
  }
  // anonymous 是本地调试逃生门：authToken 引用允许缺失；principalId 仍必填（下一条）。
  const resolvedAuthMode: CloudAuthMode =
    authMode === undefined || authMode === "invalid" ? "token" : authMode;

  const principalId = readTrimmed(env, ZCODE_CLOUD_PRINCIPAL_ID_ENV);
  if (!principalId) {
    issues.push({
      code: "principal_id_required",
      field: ZCODE_CLOUD_PRINCIPAL_ID_ENV,
      message: "cloud 模式必须配置稳定的 deploymentPrincipalId（03 §3）",
    });
  } else if (parsePrincipalId(principalId) === "invalid") {
    // 2026-10-08 真实事故：非 UUID 的 principalId（如 local-debug）曾被启动放行并透传进
    // capabilities 响应，客户端 safeParse 失败被误读为「版本不兼容」。启动期 fail-closed：
    // 非法形状在配置解析层就报 principal_id_invalid，绝不进入 capabilities。
    // 优先级：空值 → required（上方分支），非空且非法 → invalid（本分支）。
    issues.push({
      code: "principal_id_invalid",
      field: ZCODE_CLOUD_PRINCIPAL_ID_ENV,
      message: "principalId 形状必须是 UUID（与 capabilities 契约一致），非法值不得透传给客户端",
    });
  }
  const authTokenFile = readTrimmed(env, ZCODE_SERVER_AUTH_TOKEN_FILE_ENV);
  if (!authTokenFile && resolvedAuthMode === "token") {
    issues.push({
      code: "auth_required",
      field: ZCODE_SERVER_AUTH_TOKEN_FILE_ENV,
      message: "cloud 模式必须以 0600 文件提供认证凭据（环境变量不承载部署 token）",
    });
  }

  const dataDir = readTrimmed(env, ZCODE_CLOUD_DATA_DIR_ENV);
  if (!dataDir) {
    issues.push({
      code: "data_dir_required",
      field: ZCODE_CLOUD_DATA_DIR_ENV,
      message: "cloud 模式必须指定持久数据目录，禁止使用默认主目录",
    });
  }

  const publicOrigin = parsePublicOrigin(readTrimmed(env, ZCODE_CLOUD_PUBLIC_ORIGIN_ENV));
  if (!publicOrigin) {
    issues.push({
      code: readTrimmed(env, ZCODE_CLOUD_PUBLIC_ORIGIN_ENV)
        ? "public_origin_invalid"
        : "public_origin_required",
      field: ZCODE_CLOUD_PUBLIC_ORIGIN_ENV,
      message: "必须配置裸 origin（无 path/query；公网明文 http 只允许回环地址）",
    });
  }

  const providers = splitList(readTrimmed(env, ZCODE_CLOUD_PROVIDERS_ENV));
  if (providers.length === 0) {
    issues.push({
      code: "providers_required",
      field: ZCODE_CLOUD_PROVIDERS_ENV,
      message: "cloud 模式必须显式列出启用的沙箱 provider，不做默认兜底",
    });
  }

  const portValue = readTrimmed(env, ZCODE_CLOUD_LISTEN_PORT_ENV);
  const listenPort = parsePositiveInt(portValue, CLOUD_DEFAULT_LISTEN_PORT);
  if (listenPort === null || listenPort > 65535) {
    issues.push({
      code: "listen_port_invalid",
      field: ZCODE_CLOUD_LISTEN_PORT_ENV,
      message: "监听端口必须是 1..65535 的整数",
    });
  }

  const maxConcurrentRuns = parsePositiveInt(
    readTrimmed(env, ZCODE_CLOUD_MAX_CONCURRENT_RUNS_ENV),
    CLOUD_DEFAULT_MAX_CONCURRENT_RUNS,
  );
  if (maxConcurrentRuns === null) {
    issues.push({
      code: "max_concurrent_runs_invalid",
      field: ZCODE_CLOUD_MAX_CONCURRENT_RUNS_ENV,
      message: "并发配额必须是正整数",
    });
  }

  const templateRefs = parseSandboxTemplateRefs(
    readTrimmed(env, ZCODE_CLOUD_SANDBOX_TEMPLATE_REF_ENV),
  );
  issues.push(...templateRefs.issues);
  const lifetimeLimits = parseSandboxLifetimeLimits(
    readTrimmed(env, ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS_ENV),
  );
  issues.push(...lifetimeLimits.issues);
  // 空闲 pause 阈值（秒；0 = 显式禁用）：非负整数校验 fail-closed，负数/非整数报 issue，
  // 不静默回落缺省（吞掉部署方的禁用意图比启动失败更难排查，W5 §5）。
  const idlePauseSeconds = parseOptionalNonNegativeInt(
    readTrimmed(env, ZCODE_CLOUD_SANDBOX_IDLE_PAUSE_SECONDS_ENV),
  );
  if (idlePauseSeconds === null) {
    issues.push({
      code: "sandbox_idle_pause_invalid",
      field: ZCODE_CLOUD_SANDBOX_IDLE_PAUSE_SECONDS_ENV,
      message: "空闲 pause 阈值必须是非负整数秒（0 = 显式禁用）",
    });
  }

  const webDir = readTrimmed(env, ZCODE_CLOUD_WEB_DIR_ENV);
  if (webDir) {
    const webDirIssue = await assertWebDir(webDir);
    if (webDirIssue) {
      issues.push(webDirIssue);
    }
  }

  const staticModelFallback = parseStaticModelFallback(readTrimmed(env, ZCODE_CLOUD_MODEL_ENV));
  if (readTrimmed(env, ZCODE_CLOUD_MODEL_ENV) && !staticModelFallback) {
    issues.push({
      code: "model_invalid",
      field: ZCODE_CLOUD_MODEL_ENV,
      message: "静态 fallback 模型必须是 `provider:model` 形式",
    });
  }

  if (issues.length > 0 || !dataDir || !publicOrigin || listenPort === null) {
    return { ok: false, issues };
  }

  // 数据目录的可写性由 host 本体在接管数据目录前探测（`startCloudHostBody`）：
  // 配置解析保持无副作用，磁盘事实不在解析层猜测（03 §4）。
  const credentialSecretEnv = readTrimmed(env, "ZCODE_CREDENTIAL_SECRET")
    ? "ZCODE_CREDENTIAL_SECRET"
    : undefined;
  const githubAppPrivateKeyFile = readTrimmed(env, ZCODE_CLOUD_GITHUB_APP_KEY_FILE_ENV);
  const githubWebhookSecretFile = readTrimmed(env, ZCODE_CLOUD_GITHUB_WEBHOOK_SECRET_FILE_ENV);
  const allowedInstallationIds = parseIdList(
    readTrimmed(env, ZCODE_CLOUD_GITHUB_ALLOWED_INSTALLATIONS_ENV),
  );

  return {
    ok: true,
    config: {
      mode: "cloud",
      authMode: resolvedAuthMode,
      publicOrigin,
      ...(readTrimmed(env, ZCODE_CLOUD_LISTEN_HOST_ENV)
        ? { listenHost: readTrimmed(env, ZCODE_CLOUD_LISTEN_HOST_ENV) }
        : {}),
      listenPort,
      dataDir,
      ...(webDir ? { webDir } : {}),
      providers,
      allowUnverifiedProviders: splitList(
        readTrimmed(env, ZCODE_CLOUD_ALLOW_UNVERIFIED_PROVIDERS_ENV),
      ),
      maxConcurrentRuns: maxConcurrentRuns ?? CLOUD_DEFAULT_MAX_CONCURRENT_RUNS,
      ...(staticModelFallback ? { staticModelFallback } : {}),
      ...(readTrimmed(env, ZCODE_CLOUD_STORAGE_WORKER_ENTRY_ENV)
        ? { storageWorkerEntryPath: readTrimmed(env, ZCODE_CLOUD_STORAGE_WORKER_ENTRY_ENV) }
        : {}),
      ...(templateRefs.value ? { sandboxTemplateRefs: templateRefs.value } : {}),
      ...(lifetimeLimits.value ? { sandboxMaxLifetimeSeconds: lifetimeLimits.value } : {}),
      ...(idlePauseSeconds !== undefined && idlePauseSeconds !== null
        ? { sandboxIdlePauseSeconds: idlePauseSeconds }
        : {}),
      secrets: {
        ...(principalId ? { principalId } : {}),
        ...(authTokenFile ? { authTokenFile } : {}),
        ...(readTrimmed(env, ZCODE_CLOUD_GITHUB_APP_ID_ENV)
          ? { githubAppId: readTrimmed(env, ZCODE_CLOUD_GITHUB_APP_ID_ENV) }
          : {}),
        ...(githubAppPrivateKeyFile ? { githubAppPrivateKeyFile } : {}),
        ...(githubWebhookSecretFile ? { githubWebhookSecretFile } : {}),
        ...(allowedInstallationIds ? { githubAllowedInstallationIds: allowedInstallationIds } : {}),
        ...(credentialSecretEnv ? { credentialSecretEnv } : {}),
      },
    },
  };
}

/**
 * `provider:ref` 列表。fail-closed：形式非法（缺 `:`、provider 未知、ref 为空、重复声明）
 * 或引用为 `latest` 一律报 issue（01 §5.1 第 2 条禁 latest，不在 worker 里替换模板）。
 */
export function configIssuesToStartupError(
  issues: readonly CloudEntryConfigIssue[],
): CloudEntryStartupError {
  // 归一规则（2026-10-08 修订，与入口既有语义一致：entry-cloud-drivers 的「未知 provider」
  // 等值非法也归 validation_failed）：issue code 以 `_invalid` 结尾 = 部署方**配了但形状非法**
  // → `validation_failed`；其余（`*_required` 等）= **漏配** → `not_configured`。
  // 两者排查方向不同，混在一个码里会误导运维（2026-10-08 事故中非法 principalId 若归成
  // not_configured，会再次掩盖「值配错」这一真实根因）。非法值优先于缺失：更具体的根因先报，
  // 全部 issue 仍随 details 透出。
  const code = issues.some((issue) => issue.code.endsWith("_invalid"))
    ? "validation_failed"
    : "not_configured";
  return new CloudEntryStartupError(
    code,
    `cloud entry configuration is invalid: ${issues.map((issue) => issue.field).join(", ")}`,
    { issues: issues.map((issue) => ({ ...issue })) },
  );
}

/**
 * 只读数据目录（HOME 隔离专用，见 `entry-cloud-home.ts`）。
 *
 * 可执行引导必须在**加载服务图之前**知道它：`services/paths.ts` 在模块加载时就固化 `HOME`，
 * 一旦服务图被 import 就无法再隔离。此处与完整配置读取共用同一 env 名常量与读取口径，
 * 不引入第二份字面量；完整校验仍由 `readCloudEntryConfig` 负责（缺值在那里 fail-closed）。
 */
export function readCloudDataDirFromEnv(
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  return readTrimmed(env, ZCODE_CLOUD_DATA_DIR_ENV);
}

/**
 * 入口分派的模式读取（04 §2.1、W5 §3.1）：单一入口 `entry-http.ts` 必须在**加载服务图
 * 之前**知道运行模式，用法与口径同 `readCloudDataDirFromEnv`。
 *
 * 三态而非布尔：`mode: "local"`（含未设置/空值，既有默认语义）走本地行为，`mode: "cloud"`
 * 走云入口启动事务，③ 其它取值返回 `invalid` 由调用方 fail-closed 退出——非法值**不能**静默
 * 当 local，那正是 W5 §5 禁止的「隐式切 local」。与 `readCloudEntryConfig` 共用同一键常量与
 * 同一取值域，不引入第二份字面量（完整校验仍在那里）。
 */
export function readZCodeServerModeFromEnv(
  env: Record<string, string | undefined> = process.env,
): { readonly mode: ZCodeServerMode } | { readonly invalid: string } {
  const declared = readTrimmed(env, ZCODE_SERVER_MODE_ENV);
  if (declared === "cloud") {
    return { mode: "cloud" };
  }
  if (declared === undefined || declared === "local") {
    return { mode: "local" };
  }
  return { invalid: declared };
}

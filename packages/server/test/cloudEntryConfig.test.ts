/**
 * 云入口配置 / 部署秘密 / driver 门控的 fail-closed 矩阵
 * （specs/cloud-agent/modules/W5-cloud-entry.md §6 启动矩阵；03 §2/§8）。
 *
 * 断言的是「明确失败」这一事实：缺认证、数据目录不可写、provider 版本不兼容都必须在
 * 创建任何 provider 资源之前以结构化错误结束，绝不静默降级或切回 local。
 */
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CloudEntryStartupError,
  ZCODE_CLOUD_AUTH_MODE_ENV,
  ZCODE_CLOUD_DATA_DIR_ENV,
  ZCODE_CLOUD_GITHUB_ALLOWED_INSTALLATIONS_ENV,
  ZCODE_CLOUD_LISTEN_PORT_ENV,
  ZCODE_CLOUD_PRINCIPAL_ID_ENV,
  ZCODE_CLOUD_MODEL_ENV,
  ZCODE_CLOUD_PROVIDERS_ENV,
  ZCODE_CLOUD_PUBLIC_ORIGIN_ENV,
  ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS_ENV,
  ZCODE_CLOUD_SANDBOX_TEMPLATE_REF_ENV,
  ZCODE_SERVER_MODE_ENV,
  configIssuesToStartupError,
  readCloudEntryConfig,
  type CloudEntryConfigIssueCode,
} from "../src/cloud/adapters/entry-cloud-config.js";
import { resolveCloudStoragePaths } from "../src/cloud/adapters/entry-cloud-host-body.js";
import type { SandboxDriverBinding } from "../src/cloud/adapters/sandbox/providers.js";
import {
  createCloudDriverRegistry,
  createConfiguredSandboxTemplateResolver,
  createDriverSecretReader,
  resolveDriverDeploymentConfigs,
  resolveProductionDriverBindings,
  SANDBOX_DRIVER_CONTRACT_VERSION,
} from "../src/cloud/adapters/entry-cloud-drivers.js";
import { loadCloudEntrySecrets } from "../src/cloud/adapters/entry-cloud-secrets.js";
import {
  SANDBOX_ADAPTER_CONTRACT_VERSION,
  SANDBOX_DRIVER_SECRET_NAMES,
} from "../src/cloud/adapters/sandbox/providers.js";
import type { SandboxDriverPort } from "../src/cloud/app/ports/sandboxDriverPort.js";

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function issueCodes(
  result: Awaited<ReturnType<typeof readCloudEntryConfig>>,
): CloudEntryConfigIssueCode[] {
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

/**
 * 基线 principalId 必须是合法 UUID（2026-10-08 起启动期校验形状，与 capabilities 契约
 * 同款 `cloudUuidSchema`）；基线配置不得自带非法值，否则每个用例都会先撞形状校验。
 */
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000000";

function baseCloudEnv(dataDir: string): Record<string, string | undefined> {
  return {
    [ZCODE_SERVER_MODE_ENV]: "cloud",
    [ZCODE_CLOUD_PRINCIPAL_ID_ENV]: PRINCIPAL_ID,
    ZCODE_SERVER_AUTH_TOKEN_FILE: "/run/secrets/zcode-auth-token",
    [ZCODE_CLOUD_PUBLIC_ORIGIN_ENV]: "https://cloud.example.com",
    [ZCODE_CLOUD_DATA_DIR_ENV]: dataDir,
    [ZCODE_CLOUD_PROVIDERS_ENV]: "e2b",
  };
}

function isStartupError(error: unknown, problem?: string): boolean {
  if (!(error instanceof CloudEntryStartupError)) {
    return false;
  }
  return problem === undefined || error.details["problem"] === problem;
}

const silentLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

test("未设置或 local 模式返回本地配置，云入口据此拒绝启动而不是回退", async () => {
  assert.deepEqual(await readCloudEntryConfig({}), { ok: true, config: { mode: "local" } });
  assert.deepEqual(await readCloudEntryConfig({ [ZCODE_SERVER_MODE_ENV]: "local" }), {
    ok: true,
    config: { mode: "local" },
  });
  // 拼错的模式必须显式失败：静默当 local 等于把云部署降级成本机入口。
  const invalidMode = await readCloudEntryConfig({ [ZCODE_SERVER_MODE_ENV]: "staging" });
  assert.deepEqual(issueCodes(invalidMode), ["mode_invalid"]);
});

test("cloud 模式缺认证凭据与数据目录时 fail-closed（不做任何磁盘写入）", async () => {
  const result = await readCloudEntryConfig({ [ZCODE_SERVER_MODE_ENV]: "cloud" });
  const codes = issueCodes(result);
  assert.ok(codes.includes("principal_id_required"));
  assert.ok(codes.includes("auth_required"));
  assert.ok(codes.includes("data_dir_required"));
  assert.ok(codes.includes("public_origin_required"));
  assert.ok(codes.includes("providers_required"));
});

test("principalId 形状必须是 UUID（2026-10-08 事故）：空值=required、非 UUID=invalid、合法 UUID 通过", async () => {
  await withTempDir("cloud-entry-config-", async (dataDir) => {
    // (1) 空值（含纯空白）仍是「缺配置」语义：报 principal_id_required，不误报形状非法。
    const missing = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_PRINCIPAL_ID_ENV]: "   ",
    });
    assert.deepEqual(issueCodes(missing), ["principal_id_required"]);

    // (2) 非 UUID 一律启动期 fail-closed。事故现场值 local-debug 曾被放行并透传进
    // capabilities 响应，客户端 safeParse 失败被误读为 incompatible-bundle（版本不兼容）；
    // 现在必须在配置解析层报 principal_id_invalid，绝不进入 capabilities。
    for (const invalid of [
      "local-debug", // 2026-10-08 事故现场值
      "deployment-principal", // 人类可读名同样不是 UUID
      "00000000-0000-4000-8000-00000000000G", // 长度对但含非 hex 字符
      "ABCDEF00-0000-4000-8000-000000000000", // 大写不满足 cloudUuidSchema（与客户端同宽同严）
      "0123456a-b89c-4d0e-a234-567890abcde", // 少一位
    ]) {
      const result = await readCloudEntryConfig({
        ...baseCloudEnv(dataDir),
        [ZCODE_CLOUD_PRINCIPAL_ID_ENV]: invalid,
      });
      assert.deepEqual(
        issueCodes(result),
        ["principal_id_invalid"],
        `非法 principalId 应在启动期被拒绝: ${invalid}`,
      );
    }

    // (3) 合法 UUID（与 capabilities 契约同款形状）通过，并原样进入 secrets 引用。
    const validUuid = "0123456a-b89c-4d0e-a234-567890abcdef";
    const valid = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_PRINCIPAL_ID_ENV]: validUuid,
    });
    assert.ok(valid.ok);
    assert.equal(valid.config.secrets.principalId, validUuid);

    // (4) 启动错误归一：值非法（*_invalid）→ validation_failed，缺失（*_required）→
    // not_configured。非法 principalId 若被归成 not_configured 或透传到客户端，都会
    // 掩盖「部署值配错」这一真实根因（2026-10-08 事故的教训）。
    const invalidResult = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_PRINCIPAL_ID_ENV]: "local-debug",
    });
    assert.ok(!invalidResult.ok);
    assert.equal(configIssuesToStartupError(invalidResult.issues).code, "validation_failed");
    assert.ok(!missing.ok);
    assert.equal(configIssuesToStartupError(missing.issues).code, "not_configured");
  });
});

test("publicOrigin 只接受裸 origin：带 path 或公网明文 http 一律拒绝", async () => {
  await withTempDir("cloud-entry-config-", async (dataDir) => {
    const withPath = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_PUBLIC_ORIGIN_ENV]: "https://cloud.example.com/app",
    });
    assert.deepEqual(issueCodes(withPath), ["public_origin_invalid"]);

    const insecurePublic = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_PUBLIC_ORIGIN_ENV]: "http://cloud.example.com",
    });
    assert.deepEqual(issueCodes(insecurePublic), ["public_origin_invalid"]);

    const loopback = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_PUBLIC_ORIGIN_ENV]: "http://127.0.0.1:3030",
    });
    assert.ok(loopback.ok, "回环地址允许明文，供本地云模式联调");
  });
});

test("完整 cloud 配置解析出稳定字段，providers 去重、端口与模型 fallback 生效", async () => {
  await withTempDir("cloud-entry-config-", async (dataDir) => {
    const result = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_PROVIDERS_ENV]: "e2b, daytona ,e2b",
      ZCODE_CLOUD_ALLOW_UNVERIFIED_PROVIDERS: "e2b",
      [ZCODE_CLOUD_LISTEN_PORT_ENV]: "4010",
      ZCODE_CLOUD_LISTEN_HOST: "127.0.0.1",
      [ZCODE_CLOUD_MODEL_ENV]: "zai:glm-4.6",
      ZCODE_CLOUD_GITHUB_APP_ID: "12345",
      ZCODE_CLOUD_GITHUB_APP_PRIVATE_KEY_FILE: "/run/secrets/app.pem",
      [ZCODE_CLOUD_GITHUB_ALLOWED_INSTALLATIONS_ENV]: "42,43",
      ZCODE_CREDENTIAL_SECRET: "credential-secret",
    });
    assert.ok(result.ok);
    assert.equal(result.config.mode, "cloud");
    assert.deepEqual(result.config.providers, ["e2b", "daytona"]);
    assert.deepEqual(result.config.allowUnverifiedProviders, ["e2b"]);
    assert.equal(result.config.listenPort, 4010);
    assert.equal(result.config.listenHost, "127.0.0.1");
    assert.deepEqual(result.config.staticModelFallback, {
      provider: "zai",
      model: "glm-4.6",
    });
    assert.equal(result.config.secrets.principalId, PRINCIPAL_ID);
    assert.equal(result.config.secrets.githubAppId, "12345");
    assert.deepEqual(result.config.secrets.githubAllowedInstallationIds, [42, 43]);
    assert.equal(result.config.secrets.credentialSecretEnv, "ZCODE_CREDENTIAL_SECRET");
    // 秘密值不进入配置对象（只留引用）。
    assert.ok(!JSON.stringify(result.config).includes("deployment-token"));
  });
});

test("非法端口与非法 model fallback 各自产生结构化 issue", async () => {
  await withTempDir("cloud-entry-config-", async (dataDir) => {
    const result = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_LISTEN_PORT_ENV]: "not-a-port",
      [ZCODE_CLOUD_MODEL_ENV]: "glm-4.6",
    });
    const codes = issueCodes(result);
    assert.ok(codes.includes("listen_port_invalid"));
    assert.ok(codes.includes("model_invalid"));
  });
});

test("host 数据目录与 cloud 持久库不共用路径（W5 §8 目录冲突实证）", async () => {
  const paths = resolveCloudStoragePaths("/srv/zcode-cloud");
  assert.equal(paths.hostDataRoot, path.join("/srv/zcode-cloud", ".zcode"));
  assert.equal(paths.hostConfigDir, path.join("/srv/zcode-cloud", ".zcode", "v2"));
  assert.equal(paths.databasePath, path.join("/srv/zcode-cloud", "cloud", "cloud.db"));
  assert.equal(paths.attachmentsDir, path.join("/srv/zcode-cloud", "cloud", "attachments"));
  assert.ok(!paths.databasePath.startsWith(`${paths.hostConfigDir}${path.sep}`));
  assert.ok(!paths.attachmentsDir.startsWith(`${paths.hostConfigDir}${path.sep}`));
});

test("部署秘密：由 W4 的唯一 loader 读取（缺文件/权限过宽/非 RSA 都 fail-closed）", async () => {
  await withTempDir("cloud-entry-secrets-", async (dir) => {
    const tokenFile = path.join(dir, "auth-token");
    await writeFile(tokenFile, "deployment-token\n", { mode: 0o600 });

    // 缺 principalId：入口在委托之前就拒绝。
    await assert.rejects(
      () =>
        loadCloudEntrySecrets({
          refs: { authTokenFile: tokenFile },
          env: {},
          logger: silentLogger,
        }),
      (error: unknown) =>
        error instanceof CloudEntryStartupError && error.code === "not_configured",
    );

    // 文件缺失：归一 problem=missing。
    await assert.rejects(
      () =>
        loadCloudEntrySecrets({
          refs: { principalId: "deployment-principal", authTokenFile: path.join(dir, "nope") },
          env: {},
          logger: silentLogger,
        }),
      (error: unknown) => isStartupError(error, "missing"),
    );

    if (process.platform !== "win32") {
      await chmod(tokenFile, 0o644);
      await assert.rejects(
        () =>
          loadCloudEntrySecrets({
            refs: { principalId: "deployment-principal", authTokenFile: tokenFile },
            env: {},
            logger: silentLogger,
          }),
        (error: unknown) => isStartupError(error, "mode-not-0600"),
      );
      await chmod(tokenFile, 0o600);
    }

    // 配置了 GitHub App 但私钥不是 RSA PEM → 硬失败（不是「没配置」）。
    const badKey = path.join(dir, "bad.pem");
    await writeFile(badKey, "not-a-key", { mode: 0o600 });
    await assert.rejects(
      () =>
        loadCloudEntrySecrets({
          refs: {
            principalId: "deployment-principal",
            authTokenFile: tokenFile,
            githubAppId: "123",
            githubAppPrivateKeyFile: badKey,
            githubAllowedInstallationIds: [42],
          },
          env: {},
          logger: silentLogger,
        }),
      (error: unknown) => isStartupError(error, "malformed"),
    );
  });
});

test("部署秘密：合法部署加载成功，describe 只回引用与配置事实", async () => {
  await withTempDir("cloud-entry-secrets-", async (dir) => {
    const tokenFile = path.join(dir, "auth-token");
    await writeFile(tokenFile, "deployment-token\n", { mode: 0o600 });
    const keyFile = path.join(dir, "app.pem");
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    await writeFile(keyFile, privateKey.export({ type: "pkcs1", format: "pem" }) as string, {
      mode: 0o600,
    });

    const loaded = await loadCloudEntrySecrets({
      refs: {
        principalId: "deployment-principal",
        authTokenFile: tokenFile,
        githubAppId: "123",
        githubAppPrivateKeyFile: keyFile,
        githubAllowedInstallationIds: [42, 43],
        credentialSecretEnv: "ZCODE_CREDENTIAL_SECRET",
      },
      env: { ZCODE_CREDENTIAL_SECRET: "credential-secret" },
      logger: silentLogger,
    });

    assert.equal(loaded.authToken, "deployment-token");
    assert.equal(loaded.principalId, "deployment-principal");
    assert.equal(loaded.credentialSecret, "credential-secret");
    assert.equal(loaded.gitHubApp?.appId, "123");
    assert.deepEqual(loaded.gitHubApp?.allowedInstallationIds, [42, 43]);
    const description = loaded.describe();
    assert.deepEqual(description, {
      principalId: "deployment-principal",
      authMode: "token",
      authToken: "configured",
      credentialSecret: "configured",
      gitHubApp: "configured",
    });
    assert.ok(!JSON.stringify(description).includes("deployment-token"));
  });
});

test("ZCODE_CLOUD_AUTH_MODE：默认 token；anonymous 允许缺 token 文件；非法值 fail-closed", async () => {
  await withTempDir("cloud-entry-config-", async (dataDir) => {
    // (1) 未设置（默认 token）：缺 token 文件仍 auth_required——fail-closed 不变。
    const tokenless = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      ZCODE_SERVER_AUTH_TOKEN_FILE: undefined,
    });
    assert.ok(!tokenless.ok);
    assert.ok(issueCodes(tokenless).includes("auth_required"));

    // 未设置 + 齐备 → authMode 落定为 token（默认值进入配置对象）。
    const defaulted = await readCloudEntryConfig(baseCloudEnv(dataDir));
    assert.ok(defaulted.ok);
    assert.equal(defaulted.config.authMode, "token");

    // (2) anonymous（03 §3 修订 2026-10-07，本地调试逃生门）：authToken 引用允许缺失，
    // 不再报 auth_required；authMode 进入配置。
    const anonymous = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      ZCODE_SERVER_AUTH_TOKEN_FILE: undefined,
      [ZCODE_CLOUD_AUTH_MODE_ENV]: "anonymous",
    });
    assert.ok(anonymous.ok);
    assert.equal(anonymous.config.authMode, "anonymous");
    assert.equal(anonymous.config.secrets.authTokenFile, undefined);

    // anonymous 不豁免 principalId（03 §3：主体仍必填）。
    const anonymousNoPrincipal = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      ZCODE_SERVER_AUTH_TOKEN_FILE: undefined,
      [ZCODE_CLOUD_PRINCIPAL_ID_ENV]: undefined,
      [ZCODE_CLOUD_AUTH_MODE_ENV]: "anonymous",
    });
    assert.ok(issueCodes(anonymousNoPrincipal).includes("principal_id_required"));

    // (3) 拼错的取值必须显式失败：静默当 token/anonymous 都是边界漂移。
    const invalid = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_AUTH_MODE_ENV]: "anonymos",
    });
    assert.deepEqual(issueCodes(invalid), ["auth_mode_invalid"]);
  });
});

test("部署秘密：anonymous 允许缺 authToken 引用（principalId 仍必填），describe 报可区分事实", async () => {
  // anonymous 也要求 principalId：主体不随鉴权门槛一起放开。
  await assert.rejects(
    () => loadCloudEntrySecrets({ refs: {}, authMode: "anonymous", env: {}, logger: silentLogger }),
    (error: unknown) => error instanceof CloudEntryStartupError && error.code === "not_configured",
  );

  // anonymous 且未提供 token 引用：加载成功，authToken 缺省，describe 脱敏可区分。
  const loaded = await loadCloudEntrySecrets({
    refs: { principalId: "deployment-principal" },
    authMode: "anonymous",
    env: {},
    logger: silentLogger,
  });
  assert.equal(loaded.authToken, undefined);
  assert.equal(loaded.principalId, "deployment-principal");
  assert.deepEqual(loaded.describe(), {
    principalId: "deployment-principal",
    authMode: "anonymous",
    authToken: "absent",
    credentialSecret: "absent",
    gitHubApp: "absent",
  });

  // 未声明 authMode（既有调用方口径）行为完全不变：缺 authTokenFile 仍 fail-closed。
  await assert.rejects(
    () =>
      loadCloudEntrySecrets({
        refs: { principalId: "deployment-principal" },
        env: {},
        logger: silentLogger,
      }),
    (error: unknown) => error instanceof CloudEntryStartupError && error.code === "not_configured",
  );

  // anonymous + 仍提供 token 文件：照常加载（?token= 命中种 cookie 的既有握手不破坏）。
  await withTempDir("cloud-entry-secrets-", async (dir) => {
    const tokenFile = path.join(dir, "auth-token");
    await writeFile(tokenFile, "deployment-token\n", { mode: 0o600 });
    const withToken = await loadCloudEntrySecrets({
      refs: { principalId: "deployment-principal", authTokenFile: tokenFile },
      authMode: "anonymous",
      env: {},
      logger: silentLogger,
    });
    assert.equal(withToken.authToken, "deployment-token");
    assert.deepEqual(withToken.describe(), {
      principalId: "deployment-principal",
      authMode: "anonymous",
      authToken: "configured",
      credentialSecret: "absent",
      gitHubApp: "absent",
    });
  });
});

function driverStub(): SandboxDriverPort {
  return {
    describeCapabilities: async () => ({
      createOperationLookup: "metadata-search",
      canInspect: true,
      canExtendDeadline: true,
      canConfirmTermination: true,
      deadlineSource: "provider",
      supportsOutboundWss: true,
    }),
    create: async () => ({ provider: "e2b", sandboxId: "sbx" }),
    findCreateResult: async () => ({ status: "notFound" }),
    inspect: async () => ({ status: "running", observedAt: 0, evidenceSource: "provider-api" }),
    extendDeadline: async () => ({ status: "unsupported" }),
    terminate: async () => ({ status: "terminated" }),
  };
}

function binding(overrides: Partial<SandboxDriverBinding> = {}): SandboxDriverBinding {
  return {
    provider: "e2b",
    contractVersion: 1,
    requiredSecretNames: [],
    createDriver: () => driverStub(),
    ...overrides,
  };
}

test("driver 装配：未知 provider / 缺实现 / 版本不兼容都在创建 driver 之前失败", async () => {
  await assert.rejects(
    () =>
      createCloudDriverRegistry({
        providers: ["mystery"],
        bindings: [],
        readSecret: () => undefined,
        logger: silentLogger,
      }),
    (error: unknown) =>
      error instanceof CloudEntryStartupError && error.code === "validation_failed",
  );

  await assert.rejects(
    () =>
      createCloudDriverRegistry({
        providers: ["e2b"],
        bindings: [],
        readSecret: () => undefined,
        logger: silentLogger,
      }),
    (error: unknown) => error instanceof CloudEntryStartupError && error.code === "not_configured",
  );

  let created = 0;
  await assert.rejects(
    () =>
      createCloudDriverRegistry({
        providers: ["e2b"],
        bindings: [
          binding({
            contractVersion: 99,
            createDriver: () => {
              created += 1;
              return driverStub();
            },
          }),
        ],
        readSecret: () => undefined,
        logger: silentLogger,
      }),
    (error: unknown) =>
      error instanceof CloudEntryStartupError && error.code === "protocol_incompatible",
  );
  assert.equal(created, 0, "版本不兼容时不得创建 driver（因此没有 provider 调用）");

  await assert.rejects(
    () =>
      createCloudDriverRegistry({
        providers: ["e2b"],
        bindings: [binding({ requiredSecretNames: ["E2B_API_KEY"] })],
        readSecret: () => undefined,
        logger: silentLogger,
      }),
    (error: unknown) => error instanceof CloudEntryStartupError && error.code === "not_configured",
  );
});

test("driver 装配：未解禁 provider 拒绝，显式 allowUnverified 后可用并列出能力", async () => {
  await assert.rejects(
    () =>
      createCloudDriverRegistry({
        providers: ["e2b"],
        bindings: [binding()],
        readSecret: () => undefined,
        logger: silentLogger,
      }),
    (error: unknown) =>
      error instanceof CloudEntryStartupError && error.code === "validation_failed",
  );

  const registry = await createCloudDriverRegistry({
    providers: ["e2b"],
    bindings: [binding()],
    readSecret: () => undefined,
    allowUnverified: ["e2b"],
    logger: silentLogger,
  });
  assert.equal(await registry.resolve("modal"), null, "未启用 provider 不得回落到其它 provider");
  assert.ok(await registry.resolve("e2b"));
  const providers = await registry.listProviders();
  assert.deepEqual(
    providers.map((entry) => entry.provider),
    ["e2b"],
  );
});

test("driver 契约版本：入口期望值与 W3 适配器同值（两处必须同时递增）", () => {
  assert.equal(SANDBOX_DRIVER_CONTRACT_VERSION, SANDBOX_ADAPTER_CONTRACT_VERSION);
});

test("配置齐全（fake env）：三家绑定齐备，启动校验阶段不创建 driver", async () => {
  const readSecret = createDriverSecretReader({
    E2B_API_KEY: "e2b-key",
    MODAL_TOKEN_ID: "modal-id",
    MODAL_TOKEN_SECRET: "modal-secret",
    DAYTONA_API_KEY: "daytona-key",
  });
  const bindings = resolveProductionDriverBindings(
    resolveDriverDeploymentConfigs(readSecret),
    silentLogger,
  );
  assert.deepEqual(bindings.map((item) => item.provider).sort(), ["daytona", "e2b", "modal"]);
  for (const item of bindings) {
    assert.deepEqual(
      [...item.requiredSecretNames],
      [...SANDBOX_DRIVER_SECRET_NAMES[item.provider]],
    );
    assert.equal(item.contractVersion, SANDBOX_DRIVER_CONTRACT_VERSION);
  }

  let created = 0;
  const spied = bindings.map((item) => ({
    ...item,
    createDriver: (context: Parameters<typeof item.createDriver>[0]) => {
      created += 1;
      return item.createDriver(context);
    },
  }));
  const registry = await createCloudDriverRegistry({
    providers: ["e2b", "modal", "daytona"],
    bindings: spied,
    readSecret,
    allowUnverified: ["e2b", "modal", "daytona"],
    logger: silentLogger,
  });
  assert.equal(created, 0, "启动校验阶段不得创建 driver（因此没有 provider 调用）");

  // 只读能力声明（静态表，不触达 provider API）；门控不得改写声明本身。
  const entries = await registry.listProviders();
  assert.deepEqual(entries.map((item) => item.provider).sort(), ["daytona", "e2b", "modal"]);
  assert.equal(
    entries.find((item) => item.provider === "modal")?.capabilities.canExtendDeadline,
    false,
  );
  assert.equal(created, 3, "只有真正解析 provider 时才创建 driver");
});

test("显式声明的 provider 缺 secret：启动失败并点名 provider 与缺失秘密名", async () => {
  const readSecret = createDriverSecretReader({ E2B_API_KEY: "e2b-key" });
  const bindings = resolveProductionDriverBindings(
    resolveDriverDeploymentConfigs(readSecret),
    silentLogger,
  );

  await assert.rejects(
    () =>
      createCloudDriverRegistry({
        providers: ["e2b", "modal"],
        bindings,
        readSecret,
        allowUnverified: ["e2b", "modal"],
        logger: silentLogger,
      }),
    (error: unknown) =>
      error instanceof CloudEntryStartupError &&
      error.code === "not_configured" &&
      error.message.includes("modal") &&
      error.message.includes("MODAL_TOKEN_ID") &&
      (error.details["missingSecrets"] as string[]).includes("MODAL_TOKEN_SECRET"),
  );

  // 一个 secret 都没有：同样点名，不降级成「没有 provider 也能起」。
  const emptyEnvReader = createDriverSecretReader({});
  await assert.rejects(
    () =>
      createCloudDriverRegistry({
        providers: ["e2b"],
        bindings: resolveProductionDriverBindings(
          resolveDriverDeploymentConfigs(emptyEnvReader),
          silentLogger,
        ),
        readSecret: emptyEnvReader,
        logger: silentLogger,
      }),
    (error: unknown) =>
      error instanceof CloudEntryStartupError &&
      error.code === "not_configured" &&
      error.message.includes("E2B_API_KEY"),
  );

  // 启用清单为空（绕过配置层时）同样拒绝。
  await assert.rejects(
    () =>
      createCloudDriverRegistry({
        providers: [],
        bindings: [],
        readSecret: () => undefined,
        logger: silentLogger,
      }),
    (error: unknown) => error instanceof CloudEntryStartupError && error.code === "not_configured",
  );
});

test("未解禁 provider 拒绝启动；allowUnverified 放行并留 warn，能力声明不变", async () => {
  const readSecret = createDriverSecretReader({ DAYTONA_API_KEY: "daytona-key" });
  const bindings = resolveProductionDriverBindings(
    resolveDriverDeploymentConfigs(readSecret),
    silentLogger,
  );

  await assert.rejects(
    () =>
      createCloudDriverRegistry({
        providers: ["daytona"],
        bindings,
        readSecret,
        logger: silentLogger,
      }),
    (error: unknown) =>
      error instanceof CloudEntryStartupError && error.code === "validation_failed",
  );

  const warnings: unknown[][] = [];
  const registry = await createCloudDriverRegistry({
    providers: ["daytona"],
    bindings,
    readSecret,
    allowUnverified: ["daytona"],
    logger: {
      ...silentLogger,
      warn: (...args: unknown[]) => {
        warnings.push(args);
      },
    },
  });
  assert.equal(warnings.length, 1, "带未验证证据启用必须留一条 warn");
  const driver = await registry.resolve("daytona");
  assert.ok(driver);
  // 门控只影响可选性，不把未验证的能力写成已验证（01 §4.2）。
  const capabilities = await driver.describeCapabilities();
  assert.equal(capabilities.deadlineSource, "provider");
});

test("沙箱模板引用：合法多条目解析成 provider→ref，非法形式一律 fail-closed", async () => {
  await withTempDir("cloud-entry-config-", async (dataDir) => {
    const ok = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_SANDBOX_TEMPLATE_REF_ENV]:
        "e2b:zcode-sandbox-template, daytona:zcode-sandbox:1.2.3",
    });
    assert.ok(ok.ok);
    assert.deepEqual(ok.config.sandboxTemplateRefs, {
      e2b: "zcode-sandbox-template",
      daytona: "zcode-sandbox:1.2.3",
    });

    // 未配置不是错误：表示「不提供默认模板」，由接纳事务按 unsupported_template 失败。
    const unset = await readCloudEntryConfig(baseCloudEnv(dataDir));
    assert.ok(unset.ok);
    assert.equal(unset.config.sandboxTemplateRefs, undefined);

    for (const invalid of [
      "e2b", // 缺 `:`
      ":tpl", // provider 为空
      "mystery:tpl", // provider 未知
      "e2b:", // ref 为空
      "e2b:zcode:latest", // 禁 latest（01 §5.1 第 2 条）
      "e2b:latest",
      "e2b:a,e2b:b", // 重复声明
    ]) {
      const result = await readCloudEntryConfig({
        ...baseCloudEnv(dataDir),
        [ZCODE_CLOUD_SANDBOX_TEMPLATE_REF_ENV]: invalid,
      });
      assert.deepEqual(
        issueCodes(result),
        ["sandbox_template_invalid"],
        `非法输入应被拒绝: ${invalid}`,
      );
    }
  });
});

test("模板 resolver：命中返回固定 imageRef/revision，未配置与客户端自选一律 null", async () => {
  const warnings: unknown[][] = [];
  const logger = {
    ...silentLogger,
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
  };

  const resolver = createConfiguredSandboxTemplateResolver(
    { e2b: "zcode-sandbox-template" },
    logger,
  );
  assert.deepEqual(await resolver.resolve({ provider: "e2b" }), {
    imageRef: "zcode-sandbox-template",
    templateRevision: "zcode-sandbox-template",
  });
  // 客户端确认部署已固定的模板：同一值仍然通过。
  assert.deepEqual(
    await resolver.resolve({ provider: "e2b", templateRef: "zcode-sandbox-template" }),
    { imageRef: "zcode-sandbox-template", templateRevision: "zcode-sandbox-template" },
  );
  // 未配置该 provider：不造默认镜像、不回落其它 provider。
  assert.equal(await resolver.resolve({ provider: "daytona" }), null);
  assert.equal(await resolver.resolve({ provider: "mystery" }), null);
  // 客户端自选镜像：拒绝（不得绕过部署侧控制），并留痕。
  assert.equal(await resolver.resolve({ provider: "e2b", templateRef: "attacker-image" }), null);
  assert.equal(warnings.length, 1);

  const unconfigured = createConfiguredSandboxTemplateResolver(undefined, logger);
  assert.equal(await unconfigured.resolve({ provider: "e2b" }), null);
});

test("沙箱可用期上限：合法多条目解析，非法形式一律 fail-closed", async () => {
  await withTempDir("cloud-entry-config-", async (dataDir) => {
    const ok = await readCloudEntryConfig({
      ...baseCloudEnv(dataDir),
      [ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS_ENV]: "e2b:3600, daytona:7200",
    });
    assert.ok(ok.ok);
    assert.deepEqual(ok.config.sandboxMaxLifetimeSeconds, { e2b: 3600, daytona: 7200 });

    // 未配置 = 未核实：不虚构账号能力。
    const unset = await readCloudEntryConfig(baseCloudEnv(dataDir));
    assert.ok(unset.ok);
    assert.equal(unset.config.sandboxMaxLifetimeSeconds, undefined);

    for (const invalid of [
      "e2b", // 缺 `:`
      ":3600", // provider 为空
      "mystery:3600", // provider 未知
      "e2b:", // 缺秒数
      "e2b:abc", // 非数字
      "e2b:0", // 必须正整数
      "e2b:-1",
      "e2b:1.5",
      "e2b:3600,e2b:60", // 重复声明
    ]) {
      const result = await readCloudEntryConfig({
        ...baseCloudEnv(dataDir),
        [ZCODE_CLOUD_SANDBOX_MAX_LIFETIME_SECONDS_ENV]: invalid,
      });
      assert.deepEqual(
        issueCodes(result),
        ["sandbox_lifetime_invalid"],
        `非法输入应被拒绝: ${invalid}`,
      );
    }
  });
});

test("已核实的可用期上限进入 driver 能力声明；未核实的 provider 不上报", async () => {
  const readSecret = createDriverSecretReader({
    E2B_API_KEY: "e2b-key",
    DAYTONA_API_KEY: "daytona-key",
  });
  const configs = resolveDriverDeploymentConfigs(readSecret, { e2b: 3600 });
  assert.equal(configs.e2b?.maxLifetimeSeconds, 3600);
  assert.equal(configs.daytona?.maxLifetimeSeconds, undefined, "未核实不上报");

  const bindings = resolveProductionDriverBindings(configs, silentLogger);
  const registry = await createCloudDriverRegistry({
    providers: ["e2b", "daytona"],
    bindings,
    readSecret,
    allowUnverified: ["e2b", "daytona"],
    logger: silentLogger,
  });
  const entries = await registry.listProviders();
  assert.equal(
    entries.find((item) => item.provider === "e2b")?.capabilities.maxLifetimeSeconds,
    3600,
  );
  assert.equal(
    entries.find((item) => item.provider === "daytona")?.capabilities.maxLifetimeSeconds,
    undefined,
  );
});

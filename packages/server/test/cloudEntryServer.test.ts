/**
 * 云入口启动/关闭顺序与启动矩阵（specs/cloud-agent/modules/W5-cloud-entry.md §3/§5/§6；
 * 03 §8 启动顺序、CP-01）。
 *
 * 断言的是可观察事实：失败不发生副作用（不建 host 目录、不调用 provider）、监听先于
 * 后台循环、关闭顺序为 delivery → lifecycle → server → cloud → host 本体 dispose。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ISettingService, ServiceCollection } from "@zcode/services";
import { createServiceLogger } from "@zcode/services/node";
import {
  CloudEntryStartupError,
  type CloudEntryConfig,
} from "../src/cloud/adapters/entry-cloud-config.js";
import {
  resolveCloudStorageWorkerEntryPath,
  resolveDefaultCloudControlPlaneFactory,
  startCloudServer,
  type CloudBackgroundLoop,
  type CloudControlPlane,
  type CloudControlPlaneContext,
  type CloudEntryLogger,
} from "../src/cloud/adapters/entry-cloud-server.js";
import type { CloudDeploymentSecrets } from "../src/cloud/adapters/entry-cloud-secrets.js";
import type { CloudHostBody } from "../src/cloud/adapters/entry-cloud-host-body.js";
import type { SandboxDriverBinding } from "../src/cloud/adapters/sandbox/providers.js";
import type { SandboxDriverRegistryPort } from "../src/cloud/app/ports/sandboxDriverRegistryPort.js";
import type { LoopSchedulerPort } from "../src/cloud/app/ports/loopSchedulerPort.js";
import type { StorageReadiness } from "../src/cloud/app/ports/storagePort.js";

const AUTH_TOKEN = "cloud-entry-server-token";

/** 注入用部署秘密；秘密读取本身由 `cloudEntryConfig.test.ts` 覆盖（W4 loader）。 */
function testSecrets(): CloudDeploymentSecrets {
  return {
    authToken: AUTH_TOKEN,
    principalId: "deployment-principal",
    describe: () => ({
      principalId: "deployment-principal",
      authToken: "configured",
      credentialSecret: "absent",
      gitHubApp: "absent",
    }),
  };
}

/** 手动调度器：用例自己驱动 tick，避免后台循环干扰。 */
function manualScheduler(): LoopSchedulerPort {
  return { schedule: () => () => {}, delay: () => () => {} };
}

const fakeDrivers: SandboxDriverRegistryPort = {
  resolve: async () => null,
  listProviders: async () => [],
};

function baseConfig(dataDir: string): CloudEntryConfig {
  return {
    mode: "cloud",
    publicOrigin: "http://127.0.0.1:1",
    listenPort: 0,
    dataDir,
    providers: ["e2b"],
    allowUnverifiedProviders: [],
    maxConcurrentRuns: 1,
    // 秘密引用为空表示「未提供 0600 token 文件」；注入用例直接给 secrets。
    secrets: {},
  };
}

function hostServices(): ServiceCollection {
  return new ServiceCollection().register(ISettingService, {
    get: async () => ({ ok: true }),
  } as unknown as ISettingService);
}

/**
 * 从入口自己的 listening 日志里取真实端口：绑 0 由系统分配，避免"预留端口→稍后绑定"
 * 的 TOCTOU 竞态（该日志发生在后台循环启动之前，正是本用例要断言的顺序）。
 */
function portCapturingLogger(): { logger: CloudEntryLogger; port: () => number | undefined } {
  let captured: number | undefined;
  const record = (...args: unknown[]): void => {
    for (const arg of args) {
      const candidate = arg as { port?: unknown } | undefined;
      if (candidate && typeof candidate.port === "number") {
        captured = candidate.port;
      }
    }
  };
  return {
    logger: createServiceLogger("cloud-entry-test", {
      sink: { log: record, warn: record, error: record },
      isDebugEnabled: false,
    }),
    port: () => captured,
  };
}

/** 入口是否还在接新连接（连接被回收后 fetch 直接失败）。 */
async function isEntryReachable(port: number): Promise<boolean> {
  return fetch(`http://127.0.0.1:${port}/api/cloud/capabilities?token=${AUTH_TOKEN}`).then(
    () => true,
    () => false,
  );
}

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function loop(name: string, events: string[]): CloudBackgroundLoop {
  return {
    name,
    start: () => {
      events.push(`${name}.start`);
    },
    stop: async () => {
      events.push(`${name}.stop`);
    },
  };
}

function fakeHostBody(events: string[]): CloudHostBody & { disposed: boolean } {
  const body = {
    services: hostServices(),
    paths: {
      hostDataRoot: "/tmp/.zcode",
      hostConfigDir: "/tmp/.zcode/v2",
      cloudDir: "/tmp/cloud",
      databasePath: "/tmp/cloud/cloud.db",
      attachmentsDir: "/tmp/cloud/attachments",
    },
    dataDir: "/tmp",
    provisioningSource: undefined,
    disposed: false,
    async dispose(): Promise<void> {
      body.disposed = true;
      events.push("host.disposed");
    },
  };
  return body as CloudHostBody & { disposed: boolean };
}

test("storage worker 入口解析：源码形态与打包形态各自指向真实存在的入口", async () => {
  // 默认调用（源码形态，tsx 运行入口模块）：必须落在 cloud/adapters/storage/ 下且文件真实存在。
  const sourceEntry = resolveCloudStorageWorkerEntryPath();
  assert.equal(
    sourceEntry,
    path.join(import.meta.dirname, "../src/cloud/adapters/storage/storageWorkerMain.ts"),
  );
  assert.ok((await stat(sourceEntry)).isFile(), "源码形态必须指向真实的 worker 入口文件");

  // 打包形态：tsup 入口名与 bundle 同目录，W2 的默认解析才成立。
  const distEntry = resolveCloudStorageWorkerEntryPath(
    new URL("../dist/entry-cloud.js", import.meta.url).href,
  );
  assert.equal(distEntry, path.join(import.meta.dirname, "../dist/storageWorkerMain.js"));
  // 构建过就顺带断言产物真的在那里（干净检出时跳过，不把"未构建"当失败）；
  // 同时确认 `node:` 前缀没被构建链剥掉（tsup `removeNodeProtocol: false`）——
  // worker 只依赖 `node:sqlite`，剥前缀会在打包产物里 ERR_MODULE_NOT_FOUND。
  const distExists = await stat(distEntry).then(
    (info) => info.isFile(),
    () => false,
  );
  if (distExists) {
    const { readdir } = await import("node:fs/promises");
    const distDir = path.dirname(distEntry);
    const bundleSources = await Promise.all(
      (await readdir(distDir))
        .filter((name) => name.endsWith(".js"))
        .map((name) => readFile(path.join(distDir, name), "utf8")),
    );
    assert.ok(
      !bundleSources.some((text) => text.includes('from "sqlite"')),
      "打包产物不得出现裸 `sqlite` 模块名（node: 前缀必须保留）",
    );
  }
});

test("启动顺序：监听成功后才启动后台循环，cloud 路由与 host /ws 挂同一 app", async () => {
  await withTempDir("cloud-entry-server-", async (dataDir) => {
    const events: string[] = [];
    const capture = portCapturingLogger();
    const probe: { reachableAtLifecycleStart?: boolean } = {};
    let lifecycleStarted: Promise<void> | undefined;

    const controlPlane: CloudControlPlane = {
      principalId: "deployment-principal",
      registerRoutes: (app) => {
        events.push("registerRoutes");
        app.get("/api/cloud/capabilities", (c) => c.json({ mode: "cloud" }));
      },
      loops: {
        delivery: loop("delivery", events),
        lifecycle: {
          name: "lifecycle",
          start: () => {
            events.push("lifecycle.start");
            lifecycleStarted = (async () => {
              probe.reachableAtLifecycleStart = await isEntryReachable(capture.port() ?? 0);
            })();
          },
          stop: async () => {
            events.push("lifecycle.stop");
          },
        },
      },
      close: async () => {
        events.push("cloud.close");
      },
    };

    const handle = await startCloudServer({
      config: baseConfig(dataDir),
      secrets: testSecrets(),
      drivers: fakeDrivers,
      hostServices: hostServices(),
      controlPlane,
      listenPort: 0,
      listenHost: "127.0.0.1",
      logger: capture.logger,
    });
    await lifecycleStarted;
    assert.equal(capture.port(), handle.port);

    assert.deepEqual(events.slice(0, 3), ["registerRoutes", "lifecycle.start", "delivery.start"]);
    assert.equal(probe.reachableAtLifecycleStart, true, "后台循环必须在监听成功之后才启动");

    const unauthorized = await fetch(`http://127.0.0.1:${handle.port}/api/cloud/capabilities`);
    assert.equal(unauthorized.status, 401);
    const unauthorizedBody = (await unauthorized.json()) as { code?: string; retryable?: boolean };
    assert.equal(unauthorizedBody.code, "unauthenticated");
    assert.equal(unauthorizedBody.retryable, false);

    const authorized = await fetch(
      `http://127.0.0.1:${handle.port}/api/cloud/capabilities?token=${AUTH_TOKEN}`,
    );
    assert.equal(authorized.status, 200);
    assert.match(authorized.headers.get("set-cookie") ?? "", /zcode_lite_token=/);
    assert.deepEqual(await authorized.json(), { mode: "cloud" });

    const viaCookie = await fetch(`http://127.0.0.1:${handle.port}/api/cloud/capabilities`, {
      headers: { cookie: `zcode_lite_token=${AUTH_TOKEN}` },
    });
    assert.equal(viaCookie.status, 200, "cookie 是 lite-token 的第二种放行方式");

    await handle.close();
    assert.deepEqual(events.slice(-3), ["delivery.stop", "lifecycle.stop", "cloud.close"]);
  });
});

test("关闭顺序：delivery → lifecycle → server close（含连接回收）→ cloud close → host dispose", async () => {
  await withTempDir("cloud-entry-server-", async (dataDir) => {
    const events: string[] = [];
    const hostBody = fakeHostBody(events);
    const probe: { port?: number } = {};

    const handle = await startCloudServer({
      config: baseConfig(dataDir),
      secrets: testSecrets(),
      drivers: fakeDrivers,
      hostServices: hostServices(),
      hostBody,
      listenPort: 0,
      listenHost: "127.0.0.1",
      controlPlane: {
        principalId: "deployment-principal",
        registerRoutes: () => {},
        loops: { delivery: loop("delivery", events), lifecycle: loop("lifecycle", events) },
        close: async () => {
          // cloud close 时 server 必须已经关闭（含连接回收）：新连接不再被接受。
          assert.equal(await isEntryReachable(probe.port ?? 0), false);
          events.push("cloud.close:server-closed");
        },
      },
    });
    probe.port = handle.port;

    await handle.close();
    assert.deepEqual(events, [
      "lifecycle.start",
      "delivery.start",
      "delivery.stop",
      "lifecycle.stop",
      "cloud.close:server-closed",
      "host.disposed",
    ]);
    assert.equal(hostBody.disposed, true);
    await handle.close();
    assert.equal(events.length, 6, "close 幂等");
  });
});

test("启动矩阵：provider 版本不兼容在启动 host 本体之前失败，且不调用 provider", async () => {
  await withTempDir("cloud-entry-server-", async (dataDir) => {
    let driverCreated = 0;
    const driverBindings: SandboxDriverBinding[] = [
      {
        provider: "e2b",
        contractVersion: 99,
        createDriver: () => {
          driverCreated += 1;
          throw new Error("provider 不应被调用");
        },
      },
    ];
    await assert.rejects(
      () =>
        startCloudServer({
          config: baseConfig(dataDir),
          env: { ZCODE_SERVER_AUTH_TOKEN: AUTH_TOKEN, E2B_API_KEY: "x" },
          secrets: testSecrets(),
          driverBindings,
          hostServices: hostServices(),
          listenPort: 0,
          listenHost: "127.0.0.1",
        }),
      (error: unknown) =>
        error instanceof CloudEntryStartupError && error.code === "protocol_incompatible",
    );
    assert.equal(driverCreated, 0, "版本不兼容不得创建 driver（无 provider 调用）");
    await assert.rejects(() => stat(path.join(dataDir, "cloud")), "host 本体不得启动");
  });
});

test("启动矩阵：存储迁移未就绪时明确失败并回收已启动的 host 本体", async () => {
  await withTempDir("cloud-entry-server-", async (dataDir) => {
    const events: string[] = [];
    const hostBody = fakeHostBody(events);
    const notReady: StorageReadiness = {
      lastAppliedMigrationId: null,
      schemaVersion: 0,
      writable: true,
      attachmentsWritable: true,
    };
    await assert.rejects(
      () =>
        startCloudServer({
          config: baseConfig(dataDir),
          secrets: testSecrets(),
          drivers: fakeDrivers,
          hostServices: hostServices(),
          hostBody,
          storage: { readiness: async () => notReady },
          listenPort: 0,
          listenHost: "127.0.0.1",
        }),
      (error: unknown) =>
        error instanceof CloudEntryStartupError && error.code === "not_configured",
    );
    assert.equal(hostBody.disposed, true, "失败必须回落清理 host 本体");
    assert.deepEqual(events, ["host.disposed"]);
  });
});

test("入口 driver 阶段：声明了却缺 secret 即点名失败；齐全时越过该阶段进入存储就绪门", async () => {
  await withTempDir("cloud-entry-server-", async (dataDir) => {
    // (1) 声明 e2b 但 env 里没有 E2B_API_KEY：启动失败并点名 provider + 秘密名。
    await assert.rejects(
      () =>
        startCloudServer({
          config: { ...baseConfig(dataDir), allowUnverifiedProviders: [] },
          secrets: testSecrets(),
          env: { E2B_API_KEY: "" },
          hostServices: hostServices(),
          listenPort: 0,
          listenHost: "127.0.0.1",
          loopScheduler: manualScheduler(),
        }),
      (error: unknown) =>
        error instanceof CloudEntryStartupError &&
        error.code === "not_configured" &&
        error.message.includes("e2b") &&
        error.message.includes("E2B_API_KEY"),
    );

    // (2) 秘密齐全 + 显式解禁：driver 阶段通过，失败点前移到存储就绪门（证明装配链路已通）。
    const notReady: StorageReadiness = {
      lastAppliedMigrationId: null,
      schemaVersion: 0,
      writable: true,
      attachmentsWritable: true,
    };
    await assert.rejects(
      () =>
        startCloudServer({
          config: { ...baseConfig(dataDir), allowUnverifiedProviders: ["e2b"] },
          secrets: testSecrets(),
          env: { E2B_API_KEY: "e2b-key" },
          hostServices: hostServices(),
          storage: { readiness: async () => notReady },
          listenPort: 0,
          listenHost: "127.0.0.1",
          loopScheduler: manualScheduler(),
        }),
      (error: unknown) =>
        error instanceof CloudEntryStartupError && error.message.includes("存储未就绪"),
    );
  });
});

test("入口把模板 resolver 注入 context.templates（镜像引用的唯一部署侧来源）", async () => {
  await withTempDir("cloud-entry-server-", async (dataDir) => {
    const events: string[] = [];
    let captured: CloudControlPlaneContext | undefined;
    const handle = await startCloudServer({
      config: { ...baseConfig(dataDir), sandboxTemplateRefs: { e2b: "zcode-sandbox-template" } },
      secrets: testSecrets(),
      drivers: fakeDrivers,
      hostServices: hostServices(),
      loopScheduler: manualScheduler(),
      listenPort: 0,
      listenHost: "127.0.0.1",
      createControlPlane: async (context) => {
        captured = context;
        return {
          principalId: "deployment-principal",
          registerRoutes: () => {},
          loops: { delivery: loop("delivery", events), lifecycle: loop("lifecycle", events) },
          close: async () => {},
        };
      },
    });
    try {
      assert.ok(captured?.templates, "context.templates 必须由入口提供");
      assert.deepEqual(await captured?.templates.resolve({ provider: "e2b" }), {
        imageRef: "zcode-sandbox-template",
        templateRevision: "zcode-sandbox-template",
      });
      // 未配置的 provider 不回落：接纳事务会按 unsupported_template 明确失败。
      assert.equal(await captured?.templates.resolve({ provider: "modal" }), null);
    } finally {
      await handle.close();
    }
  });
});

test("入口把已核实可用期上限透传到 driver 能力声明（context.drivers）", async () => {
  await withTempDir("cloud-entry-server-", async (dataDir) => {
    const events: string[] = [];
    let captured: CloudControlPlaneContext | undefined;
    const handle = await startCloudServer({
      config: {
        ...baseConfig(dataDir),
        allowUnverifiedProviders: ["e2b"],
        sandboxMaxLifetimeSeconds: { e2b: 3600 },
      },
      secrets: testSecrets(),
      env: { E2B_API_KEY: "e2b-key" },
      hostServices: hostServices(),
      loopScheduler: manualScheduler(),
      listenPort: 0,
      listenHost: "127.0.0.1",
      createControlPlane: async (context) => {
        captured = context;
        return {
          principalId: "deployment-principal",
          registerRoutes: () => {},
          loops: { delivery: loop("delivery", events), lifecycle: loop("lifecycle", events) },
          close: async () => {},
        };
      },
    });
    try {
      const entries = await captured?.drivers.listProviders();
      assert.equal(
        entries?.find((item) => item.provider === "e2b")?.capabilities.maxLifetimeSeconds,
        3600,
        "核实的账号上限必须进入 driver 能力声明（01 §4.3）",
      );
    } finally {
      await handle.close();
    }
  });
});

test("默认控制面工厂：入口直接接到 contract.ts 的 assembleCloudControlPlane", async () => {
  // 生产路径不再有 not_implemented 分支；装配失败由工厂自己抛结构化错误（见 WS 用例的真装配）。
  const contract = await import("../src/cloud/contract.js");
  assert.equal(resolveDefaultCloudControlPlaneFactory(), contract.assembleCloudControlPlane);
});

test("启动矩阵：部署秘密缺失时明确失败并回收 host 本体", async () => {
  await withTempDir("cloud-entry-server-", async (dataDir) => {
    const events: string[] = [];
    const hostBody = fakeHostBody(events);
    await assert.rejects(
      () =>
        startCloudServer({
          config: baseConfig(dataDir),
          env: {},
          drivers: fakeDrivers,
          hostServices: hostServices(),
          hostBody,
          listenPort: 0,
          listenHost: "127.0.0.1",
        }),
      (error: unknown) =>
        error instanceof CloudEntryStartupError && error.code === "not_configured",
    );
    assert.equal(hostBody.disposed, true);
  });
});

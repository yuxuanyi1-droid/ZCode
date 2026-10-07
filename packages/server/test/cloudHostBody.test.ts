/**
 * 云入口 host 本体装配与 host 通道暴露面
 * （specs/cloud-agent/modules/W5-cloud-entry.md §3/§5；03 §2/§8、12 §1.2/§4）。
 *
 * 覆盖：
 * - 装配顺序 `setDataBaseDir → materialize builtin → createLocalServices`；
 * - 数据目录实证：host 落 `<dataDir>/.zcode/v2`，cloud 持久库在 `<dataDir>/cloud`（W5 §8 风险项）；
 * - host 通道暴露面：账号域可见，本机执行域被裁掉（CP-01 的静态一半）；
 * - 凭据代际观察（12 §6 A-08）：代际递增并可被订阅。
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ServiceCollection,
  IFileService,
  ISettingService,
  ITerminalService,
} from "@zcode/services";
import { getAppConfigDir, setDataBaseDir } from "@zcode/services/node";
import { CLOUD_SERVICE_CHANNEL_FACETS } from "@zcode/shared";
import { CloudEntryStartupError } from "../src/cloud/adapters/entry-cloud-config.js";
import {
  startCloudHostBody,
  type CloudHostBodyDeps,
} from "../src/cloud/adapters/entry-cloud-host-body.js";
import {
  CLOUD_HOST_CHANNEL_ALLOWLIST,
  CLOUD_HOST_DENIED_EXECUTION_CHANNELS,
  createCloudHostChannelServices,
  createProvisioningSourceChangeObserver,
} from "../src/cloud/adapters/entry-cloud-host-ws.js";

async function withTempDir<T>(prefix: string, run: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function recordingDeps(events: string[]): CloudHostBodyDeps {
  return {
    setDataBaseDir: (dir) => {
      events.push(`setDataBaseDir:${dir ?? "null"}`);
    },
    materializeBuiltinConfig: async () => {
      events.push("materialize");
      return "/tmp/zcode-builtin.json";
    },
    createServices: (options) => {
      events.push(`createServices:${options.zcodeBuiltinProviderConfigFilePath}`);
      options.onProvisioningSourceChanged("credential");
      return new ServiceCollection();
    },
    disposeServices: () => {
      events.push("disposeServices");
    },
  };
}

test("host 本体按 setDataBaseDir → materialize builtin → createLocalServices 顺序装配", async () => {
  await withTempDir("cloud-host-body-", async (dataDir) => {
    const events: string[] = [];
    const body = await startCloudHostBody({
      dataDir,
      deps: recordingDeps(events),
      onProvisioningSourceChanged: (trigger) => events.push(`trigger:${trigger}`),
    });

    assert.deepEqual(events, [
      `setDataBaseDir:${dataDir}`,
      "materialize",
      "createServices:/tmp/zcode-builtin.json",
      "trigger:credential",
    ]);
    assert.equal(body.dataDir, dataDir);
    assert.equal(body.zcodeBuiltinProviderConfigFilePath, "/tmp/zcode-builtin.json");
    // 注入 deps 路径下服务图由本函数持有，但 provisioning source 只有真实
    // createLocalServices 装配才有（host 自带能力，入口不伪造）。
    assert.equal(body.provisioningSource, undefined);

    await body.dispose();
    assert.deepEqual(events.slice(4), ["disposeServices", "setDataBaseDir:null"]);
    assert.equal(body.disposed, true);
    await body.dispose();
    assert.deepEqual(events.slice(4), ["disposeServices", "setDataBaseDir:null"], "dispose 幂等");
  });
});

test("注入 hostServices 时不设置全局数据目录、不调用 createLocalServices（测试注入缝）", async () => {
  await withTempDir("cloud-host-body-", async (dataDir) => {
    const events: string[] = [];
    const deps = recordingDeps(events);
    const services = new ServiceCollection();
    const body = await startCloudHostBody({ dataDir, hostServices: services, deps });

    assert.deepEqual(events, [], "注入路径不得设置全局数据目录或启动服务图");
    assert.equal(body.services, services);
    // 只准备云持久卷目录；不写真实 ~/.zcode（数据目录来自临时目录）。
    assert.ok((await stat(path.join(dataDir, "cloud"))).isDirectory());
    await body.dispose();
    assert.deepEqual(events, [], "注入的服务图由调用方持有，入口不 dispose");
  });
});

test("数据目录不可写（路径被普通文件占用）：在接管数据目录之前明确失败", async () => {
  await withTempDir("cloud-host-body-", async (dir) => {
    const filePath = path.join(dir, "not-a-dir");
    await writeFile(filePath, "x");
    const events: string[] = [];
    await assert.rejects(
      () => startCloudHostBody({ dataDir: filePath, deps: recordingDeps(events) }),
      (error: unknown) =>
        error instanceof CloudEntryStartupError && error.code === "not_configured",
    );
    assert.deepEqual(events, [], "探测失败必须在 setDataBaseDir/createLocalServices 之前发生");
  });
});

test("数据目录实证：createLocalServices 时 app config 落在 <dataDir>/.zcode/v2，与 cloud 库分离", async () => {
  await withTempDir("cloud-host-body-", async (dataDir) => {
    let appConfigDirAtCreate = "";
    let hostDataRootAtCreate = "";
    await startCloudHostBody({
      dataDir,
      deps: {
        ...recordingDeps([]),
        setDataBaseDir: (dir) => setDataBaseDir(dir),
        createServices: () => {
          appConfigDirAtCreate = getAppConfigDir();
          hostDataRootAtCreate = path.dirname(getAppConfigDir());
          return new ServiceCollection();
        },
      },
    });

    assert.equal(appConfigDirAtCreate, path.join(dataDir, ".zcode", "v2"));
    assert.equal(hostDataRootAtCreate, path.join(dataDir, ".zcode"));
    // cloud 侧的持久库/附件目录已经建立，且不在 host 目录里。
    const cloudDir = path.join(dataDir, "cloud");
    assert.ok((await stat(cloudDir)).isDirectory());
    assert.ok((await stat(path.join(cloudDir, "attachments"))).isDirectory());
    assert.ok(!cloudDir.startsWith(path.join(dataDir, ".zcode")));

    setDataBaseDir(null);
  });
});

test("host 通道暴露面：账号域可见，本机执行域被裁掉", () => {
  const source = new ServiceCollection()
    .register(ISettingService, { get: async () => ({}) } as unknown as ISettingService)
    .register(IFileService, { readFile: async () => "boom" } as unknown as IFileService)
    .register(ITerminalService, { create: async () => "boom" } as unknown as ITerminalService);

  const exposed = createCloudHostChannelServices(source);
  assert.ok(exposed.getOptional(ISettingService));
  assert.equal(exposed.getOptional(IFileService), undefined);
  assert.equal(exposed.getOptional(ITerminalService), undefined);

  assert.ok(CLOUD_HOST_CHANNEL_ALLOWLIST.includes(ISettingService.channelName));
  for (const channel of CLOUD_HOST_DENIED_EXECUTION_CHANNELS) {
    assert.ok(
      !CLOUD_HOST_CHANNEL_ALLOWLIST.includes(channel),
      `执行域频道不得出现在云 host 暴露面: ${channel}`,
    );
  }
  // 分面表的 host 通道就是 `/ws`（03 §7.1）——本文件挂载路径必须与之一致。
  assert.equal(CLOUD_SERVICE_CHANNEL_FACETS.host?.upgradePath, "/ws");
});

test("凭据代际观察：代际递增、订阅可收到变更、退订后不再收到", () => {
  const observer = createProvisioningSourceChangeObserver();
  const seen: string[] = [];
  const unsubscribe = observer.onDidChange((change) =>
    seen.push(`${change.generation}:${change.trigger}`),
  );

  observer.notify("credential");
  observer.notify("account-settings");
  assert.equal(observer.generation, 2);
  assert.deepEqual(seen, ["1:credential", "2:account-settings"]);

  unsubscribe();
  observer.notify("personal-config");
  assert.deepEqual(seen, ["1:credential", "2:account-settings"]);
  assert.equal(observer.generation, 3);
});

/**
 * 云入口的 host 本体装配（specs/cloud-agent/12 §1.2/§4、03 §2/§8；决议⑧）。
 *
 * 「云服务端 = 一台标准 ZCode host 本体」：这里按既有 web 模式同款步骤启动服务图，
 * 并把数据目录指向云持久卷。账号域（oauth/credential/usage/setting/provider
 * registry/provisioning source）全部是 host 自带能力，本文件**不新增任何账号装配**。
 *
 * 启动顺序（03 §8）：`setDataBaseDir(cloudDataDir)` → materialize builtin →
 * `createLocalServices`。目录分工见 `resolveCloudStoragePaths`：host 归
 * `<dataDir>/.zcode/`，cloud 持久库归 `<dataDir>/cloud/`，两者不互相覆盖。
 *
 * 测试注入：`deps` 与 `hostServices` 都是显式注入缝；注入后不再触碰真实数据目录，
 * 也不会写 `~/.zcode`（W5 §4）。
 */
import { constants } from "node:fs";
import { access, mkdir, unlink, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  createLocalServices,
  disposeServiceResources,
  getAppConfigDir,
  getProviderProvisioningSource,
  materializeZCodeBuiltinProviderConfig,
  setDataBaseDir,
  type ProviderProvisioningSource,
} from "@zcode/services/node";
import type { ServiceCollection } from "@zcode/services";
import { readBundledZCodeBuiltinProviderConfig } from "../../bundledZCodeBuiltinProviderConfig.js";
import { CloudEntryStartupError } from "./entry-cloud-config.js";

/**
 * 云持久卷内的目录分工（W5 §8 风险项实证：host `<dataDir>/.zcode/v2/` 与 cloud
 * `cloud.db` 不同 root，避免迁移账本与附件清扫互相覆盖；`packages/services/src/paths.ts`）。
 */
export interface CloudStoragePaths {
  readonly hostDataRoot: string;
  readonly hostConfigDir: string;
  readonly cloudDir: string;
  readonly databasePath: string;
  readonly attachmentsDir: string;
}

export function resolveCloudStoragePaths(dataDir: string): CloudStoragePaths {
  const root = resolve(dataDir);
  const hostDataRoot = join(root, ".zcode");
  const cloudDir = join(root, "cloud");
  const paths: CloudStoragePaths = {
    hostDataRoot,
    hostConfigDir: join(hostDataRoot, "v2"),
    cloudDir,
    databasePath: join(cloudDir, "cloud.db"),
    attachmentsDir: join(cloudDir, "attachments"),
  };
  const collision = [paths.databasePath, paths.attachmentsDir].find((candidate) =>
    isInside(paths.hostConfigDir, candidate),
  );
  if (collision) {
    // 两个所有者写同一目录会让 host 迁移账本与 cloud 备份互相污染（03 §4）。
    throw new CloudEntryStartupError(
      "validation_failed",
      "cloud storage paths collide with host data directory",
      { collision },
    );
  }
  return paths;
}

function isInside(root: string, candidate: string): boolean {
  const rootPath = resolve(root);
  const candidatePath = resolve(candidate);
  return candidatePath === rootPath || candidatePath.startsWith(`${rootPath}${sep}`);
}

/** 数据目录可写性/锁/空间探测（03 §4：数据库与附件目录启动时检测可写性）。 */
export async function assertDataDirWritable(dataDir: string): Promise<void> {
  try {
    await mkdir(dataDir, { recursive: true });
    await access(dataDir, constants.W_OK);
    const probe = join(dataDir, `.zcode-cloud-write-probe-${process.pid}`);
    await writeFile(probe, "probe", { encoding: "utf8", mode: 0o600 });
    await unlink(probe);
  } catch (error) {
    throw new CloudEntryStartupError(
      "not_configured",
      `cloud data directory is not writable: ${dataDir}`,
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }
}

export interface CloudHostBodyDeps {
  setDataBaseDir(dir: string | null): void;
  materializeBuiltinConfig(): Promise<string>;
  createServices(options: {
    zcodeBuiltinProviderConfigFilePath: string;
    onProvisioningSourceChanged: (trigger: CloudProvisioningChangeTrigger) => void;
  }): ServiceCollection;
  disposeServices(services: ServiceCollection): void;
}

/** 12 §6 A-08：凭据/账号配置代际变化的来源（触发点由 host 装配给出）。 */
export type CloudProvisioningChangeTrigger = "credential" | "personal-config" | "account-settings";

export interface StartCloudHostBodyOptions {
  readonly dataDir: string;
  /**
   * 运行中 Run 的凭据代际观察回调（12 §6 A-08）。实现取向固定为「标记 + 下次 bridge
   * 连接时重装」：入口只转发代际事件，不做重推决策（那是控制面 app 的规则）。
   */
  readonly onProvisioningSourceChanged?: (trigger: CloudProvisioningChangeTrigger) => void;
  /** 测试注入：直接给定 host 服务图，跳过 createLocalServices（不写真实数据目录）。 */
  readonly hostServices?: ServiceCollection;
  readonly deps?: Partial<CloudHostBodyDeps>;
  readonly platform?: NodeJS.Platform;
}

export interface CloudHostBody {
  readonly services: ServiceCollection;
  readonly paths: CloudStoragePaths;
  readonly dataDir: string;
  /** host 自身的 provisioning source（12 §6：唯一 owner 是 host，零新增装配）。 */
  readonly provisioningSource: ProviderProvisioningSource | undefined;
  readonly zcodeBuiltinProviderConfigFilePath?: string;
  readonly disposed: boolean;
  dispose(): Promise<void>;
}

function createProductionDeps(): CloudHostBodyDeps {
  return {
    setDataBaseDir: (dir) => setDataBaseDir(dir),
    materializeBuiltinConfig: async () => {
      try {
        return await materializeZCodeBuiltinProviderConfig({
          environmentConfigRoot: getAppConfigDir(),
          content: readBundledZCodeBuiltinProviderConfig(),
        });
      } catch (error) {
        // 构建未内嵌 builtin 配置时不得静默跳过：沙箱模型清单与 host 目录必须同源（12 §6）。
        throw new CloudEntryStartupError(
          "not_configured",
          "无法物化 ZCode Built-in Provider Config",
          { reason: error instanceof Error ? error.message : String(error) },
        );
      }
    },
    createServices: ({ zcodeBuiltinProviderConfigFilePath, onProvisioningSourceChanged }) =>
      createLocalServices({
        zcodeBuiltinProviderConfigFilePath,
        // 云服务端是 provisioning **source**（读本机账号事实），不是任何 Environment 的
        // target；target 只应在沙箱内装配（12 §1.1、01 §6.2）。
        providerProvisioningTargetEnabled: false,
        onProviderProvisioningSourceChanged: (trigger) =>
          onProvisioningSourceChanged(trigger as CloudProvisioningChangeTrigger),
      }),
    disposeServices: (services) => disposeServiceResources(services),
  };
}

export async function startCloudHostBody(
  options: StartCloudHostBodyOptions,
): Promise<CloudHostBody> {
  // 数据目录不可写/被文件占用时在接管之前明确失败（03 §4：数据库与附件目录启动检测）。
  await assertDataDirWritable(options.dataDir);
  const paths = resolveCloudStoragePaths(options.dataDir);
  try {
    await mkdir(paths.cloudDir, { recursive: true });
    await mkdir(paths.attachmentsDir, { recursive: true });
  } catch (error) {
    // 数据目录不可写时明确失败：不在半可写卷上启动迁移与 provider 操作（03 §4/§8）。
    throw new CloudEntryStartupError(
      "not_configured",
      `cloud storage directory is not writable: ${paths.cloudDir}`,
      { reason: error instanceof Error ? error.message : String(error) },
    );
  }

  const deps: CloudHostBodyDeps = { ...createProductionDeps(), ...options.deps };
  let ownsDataBaseDir = false;
  let services: ServiceCollection;
  let zcodeBuiltinProviderConfigFilePath: string | undefined;

  if (options.hostServices) {
    // 注入路径：调用方已持有服务图与数据目录，入口不重复设置全局状态。
    services = options.hostServices;
  } else {
    deps.setDataBaseDir(options.dataDir);
    ownsDataBaseDir = true;
    zcodeBuiltinProviderConfigFilePath = await deps.materializeBuiltinConfig();
    services = deps.createServices({
      zcodeBuiltinProviderConfigFilePath,
      onProvisioningSourceChanged: options.onProvisioningSourceChanged ?? (() => {}),
    });
  }

  let disposed = false;
  const body: CloudHostBody = {
    services,
    paths,
    dataDir: options.dataDir,
    provisioningSource: getProviderProvisioningSource(services),
    ...(zcodeBuiltinProviderConfigFilePath ? { zcodeBuiltinProviderConfigFilePath } : {}),
    get disposed() {
      return disposed;
    },
    async dispose(): Promise<void> {
      if (disposed) {
        return;
      }
      disposed = true;
      if (!options.hostServices) {
        deps.disposeServices(services);
      }
      if (ownsDataBaseDir) {
        // 只归还本入口设置过的全局状态，不影响同进程其它 host 装配。
        deps.setDataBaseDir(null);
      }
    },
  };
  return body;
}

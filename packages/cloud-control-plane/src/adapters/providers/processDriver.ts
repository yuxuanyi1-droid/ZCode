import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { SandboxDriver, SandboxHandle, SandboxSpec } from "./types.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../");
export const BRIDGE_ENTRY = resolve(REPO_ROOT, "packages/cloud-bridge/src/main.ts");
export const FAKE_DAEMON_ENTRY = resolve(
  REPO_ROOT,
  "packages/cloud-control-plane/src/adapters/providers/fakeDaemonEntry.ts",
);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface ProcessSandboxDriverOptions {
  id: string;
  label: string;
  sandboxRoot: string;
  capabilities: { pause: boolean; maxLifetimeSeconds: number; verified: boolean };
  /** 覆盖 daemon 启动命令（argv 前缀）。 */
  serverCommand: string[];
  /** fake provider 不需要真实 checkout。 */
  skipCheckout?: boolean;
}

/**
 * 用本机子进程模拟沙箱：真实 bridge + 真实（或替身）daemon。
 * 与云 provider 的差别只在"沙箱如何创建"，隧道与 daemon 协议完全一致。
 */
export class ProcessSandboxDriver implements SandboxDriver {
  public readonly capabilities;
  public readonly skipCheckout: boolean;
  public readonly seedsProviderConfig = true;

  public constructor(private readonly options: ProcessSandboxDriverOptions) {
    this.capabilities = options.capabilities;
    this.skipCheckout = options.skipCheckout ?? false;
  }

  public get id(): string {
    return this.options.id;
  }

  public get label(): string {
    return this.options.label;
  }

  public checkoutPath(taskStableId: string, repoName: string): string {
    return join(this.options.sandboxRoot, this.options.id, taskStableId, "workspace", repoName);
  }

  public async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const root = join(
      this.options.sandboxRoot,
      this.options.id,
      spec.taskStableId,
      `run-${spec.generation}`,
    );
    // server-cli 只在 <base>/.zcode/server 布局下把 dataBaseDir 推导为 <base>，
    // 其它路径会把数据根固定到 serverRoot 自身；这里与生产目录保持一致。
    const dataDir = root;
    const serverRoot = join(dataDir, ".zcode", "server");
    await mkdir(serverRoot, { recursive: true });
    if (spec.providerConfig) {
      // daemon 的数据根是 <ZCODE_DATA_BASE_DIR>/.zcode/v2。
      const configDir = join(dataDir, ".zcode", "v2");
      await mkdir(configDir, { recursive: true });
      await writeFile(
        join(configDir, "provider_config.json"),
        JSON.stringify({ schemaVersion: 1, config: spec.providerConfig }),
        { mode: 0o600 },
      );
    }
    // checkout 由控制面通过 exec 完成；这里只确保父目录存在。
    await mkdir(dirname(spec.checkoutPath), { recursive: true });

    const bootstrapPath = join(root, "bootstrap.json");
    await writeFile(
      bootstrapPath,
      JSON.stringify(
        {
          v: 1,
          controlPlaneUrl: spec.controlPlaneUrl,
          attachToken: spec.attachToken,
          runId: spec.runId,
          taskId: spec.taskId,
          taskStableId: spec.taskStableId,
          generation: spec.generation,
          serverRoot,
          dataDir,
          workspacePath: spec.checkoutPath,
          serverCommand: this.options.serverCommand,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );

    const logPath = join(root, "bridge.log");
    const logFd = openSync(logPath, "a");
    const child = spawn(
      process.execPath,
      ["--import", "tsx", BRIDGE_ENTRY, "--config", bootstrapPath],
      {
        cwd: REPO_ROOT,
        // 隔离 HOME：Agent CLI 的 rollout/session 存储直接基于 homedir()，若不改写
        // 会落进开发机的 ~/.zcode，并与其它 Run 共享历史。
        env: { ...process.env, HOME: dataDir, USERPROFILE: dataDir, ZCODE_DATA_BASE_DIR: dataDir },
        detached: true,
        stdio: ["ignore", logFd, logFd],
      },
    );
    closeSync(logFd);
    child.unref();

    return {
      id: spec.runId,
      provider: this.options.id,
      meta: { root, pid: child.pid, bootstrapPath, serverRoot, dataDir },
    };
  }

  public async terminate(handle: SandboxHandle): Promise<void> {
    const root = typeof handle.meta["root"] === "string" ? handle.meta["root"] : undefined;
    const serverRoot =
      typeof handle.meta["serverRoot"] === "string" ? handle.meta["serverRoot"] : undefined;
    const dataDir = typeof handle.meta["dataDir"] === "string" ? handle.meta["dataDir"] : undefined;
    // 先让 server-cli 自己停 supervisor：只杀 bridge 会留下 detached 的 daemon。
    const serverCommand = this.options.serverCommand;
    if (serverRoot && dataDir && serverCommand) {
      await new Promise<void>((resolve) => {
        const child = spawn(
          serverCommand[0]!,
          [...serverCommand.slice(1), "stop", "--server-root", serverRoot],
          {
            env: {
              ...process.env,
              HOME: dataDir,
              USERPROFILE: dataDir,
              ZCODE_DATA_BASE_DIR: dataDir,
            },
            stdio: "ignore",
          },
        );
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
        child.once("error", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    const pid = typeof handle.meta["pid"] === "number" ? handle.meta["pid"] : undefined;
    if (pid) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // 已退出。
      }
    }
    await sleep(500);
    if (root) {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

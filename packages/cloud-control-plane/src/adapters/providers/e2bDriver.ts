import { readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Sandbox } from "e2b";

import type { BootstrapConfig } from "@zcode/cloud-protocol";

import type { SandboxDriver, SandboxHandle, SandboxSpec } from "./types.js";

const API_BASE = "https://api.e2b.dev";
const DONE_DIR = "/home/user/.zcode/cloud";

export interface E2bSandboxDriverOptions {
  apiKey: string;
  templateId: string;
  maxLifetimeSeconds: number;
  bridgeBundlePath: string;
  /** 控制面公开下载地址；runId 用于鉴权与审计。 */
  releaseAssetUrl: (runId: string) => string;
  workspaceRoot?: string;
}

function toArrayBuffer(value: Buffer): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

/**
 * E2B 沙箱驱动：标准 zcode-server daemon + cloud-bridge。
 * 沙箱只出站连接控制面；daemon 仍监听 loopback，由 bridge 桥接。
 */
export class E2bSandboxDriver implements SandboxDriver {
  public readonly id = "e2b";
  public readonly label = "E2B sandbox";
  public readonly capabilities;
  public readonly skipCheckout = false;
  public readonly seedsProviderConfig = true;

  public constructor(private readonly options: E2bSandboxDriverOptions) {
    this.capabilities = {
      pause: true,
      maxLifetimeSeconds: options.maxLifetimeSeconds,
      verified: true,
    };
  }

  public checkoutPath(taskStableId: string, repoName: string): string {
    const root = this.options.workspaceRoot ?? "/home/user/workspace";
    return `${root}/${taskStableId}/${repoName}`;
  }

  public async create(spec: SandboxSpec): Promise<SandboxHandle> {
    const sandbox = await Sandbox.create(this.options.templateId, {
      apiKey: this.options.apiKey,
      timeoutMs: this.options.maxLifetimeSeconds * 1_000,
      metadata: {
        runId: spec.runId,
        taskId: spec.taskId,
        generation: String(spec.generation),
      },
    });
    const sandboxId = sandbox.sandboxId;
    const serverRoot = "/home/user/.zcode/server";
    try {
      const bridge = await readFile(this.options.bridgeBundlePath);
      const bootstrap: BootstrapConfig = {
        v: 1,
        controlPlaneUrl: spec.controlPlaneUrl,
        attachToken: spec.attachToken,
        runId: spec.runId,
        taskId: spec.taskId,
        taskStableId: spec.taskStableId,
        generation: spec.generation,
        serverRoot,
        dataDir: "/home/user",
        workspacePath: spec.checkoutPath,
        serverCommand: ["node", `${serverRoot}/runtime/server-cli.js`],
      };
      if (spec.providerConfig) {
        // daemon 的数据根是 <ZCODE_DATA_BASE_DIR>/.zcode/v2；base=/home/user。
        await sandbox.commands.run("mkdir -p /home/user/.zcode/v2", { timeoutMs: 30_000 });
        await sandbox.files.write(
          "/home/user/.zcode/v2/provider_config.json",
          JSON.stringify({ schemaVersion: 1, config: spec.providerConfig }),
        );
      }
      await sandbox.files.write(`${DONE_DIR}/bridge.mjs`, toArrayBuffer(bridge));
      await sandbox.files.write(`${DONE_DIR}/bootstrap.json`, JSON.stringify(bootstrap));

      const setupScript = [
        "set -eu",
        `mkdir -p ${serverRoot} ${dirname(spec.checkoutPath)} ${DONE_DIR}`,
        `curl -fsSL -H "Authorization: Bearer ${spec.attachToken}" "${this.options.releaseAssetUrl(spec.runId)}" -o /tmp/zcode-release.tar.gz`,
        // 归档根目录是 zcode-server-linux-x64/；serverRoot 必须直接包含 runtime/server-cli.js。
        `tar -xzf /tmp/zcode-release.tar.gz -C ${serverRoot} --strip-components=1`,
        "rm -f /tmp/zcode-release.tar.gz",
        `rm -f ${DONE_DIR}/setup.sh`,
      ].join("\n");
      await sandbox.files.write(`${DONE_DIR}/setup.sh`, setupScript);
      const setup = await sandbox.commands.run(`bash ${DONE_DIR}/setup.sh`, {
        timeoutMs: 300_000,
      });
      if (setup.exitCode !== 0) {
        throw new Error(`sandbox setup failed: ${setup.stderr.slice(-1_000)}`);
      }

      await sandbox.commands.run(
        `node ${DONE_DIR}/bridge.mjs --config ${DONE_DIR}/bootstrap.json >> ${DONE_DIR}/bridge.log 2>&1`,
        {
          background: true,
          timeoutMs: (this.options.maxLifetimeSeconds + 300) * 1_000,
        },
      );

      return { id: spec.runId, provider: this.id, meta: { sandboxId } };
    } catch (error) {
      await Sandbox.kill(sandboxId, { apiKey: this.options.apiKey }).catch(() => undefined);
      throw error;
    }
  }

  public async terminate(handle: SandboxHandle): Promise<void> {
    const sandboxId = handle.meta["sandboxId"];
    if (typeof sandboxId !== "string" || !sandboxId) {
      return;
    }
    await Sandbox.kill(sandboxId, { apiKey: this.options.apiKey }).catch(() => undefined);
  }

  public async pause(handle: SandboxHandle): Promise<void> {
    await this.postSandboxAction(handle, "pause");
  }

  public async resume(handle: SandboxHandle): Promise<void> {
    // ResumedSandbox.timeout 默认只有 15 秒；不显式续期会在恢复后立刻再次自动暂停。
    await this.postSandboxAction(handle, "resume", {
      timeout: this.options.maxLifetimeSeconds,
    });
  }

  private async postSandboxAction(
    handle: SandboxHandle,
    action: "pause" | "resume",
    body?: Record<string, unknown>,
  ): Promise<void> {
    const sandboxId = handle.meta["sandboxId"];
    if (typeof sandboxId !== "string" || !sandboxId) {
      throw new Error("e2b sandbox handle missing sandboxId");
    }
    const response = await fetch(
      `${API_BASE}/sandboxes/${encodeURIComponent(sandboxId)}/${action}`,
      {
        method: "POST",
        headers: {
          "X-API-Key": this.options.apiKey,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      },
    );
    if (!response.ok) {
      throw new Error(`e2b ${action} failed: ${response.status} ${await response.text()}`);
    }
  }
}

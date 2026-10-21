import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { DaemonState } from "@zcode/cloud-protocol";

import { resolveDaemonArgs, resolveDaemonEnv, resolveStopArgs } from "./config.js";
import type { BootstrapConfig } from "@zcode/cloud-protocol";

export interface DaemonStatusInfo {
  state: DaemonState;
  port?: number;
  ingressToken?: string;
  version?: string;
}

interface DaemonStatusFile {
  state?: unknown;
  port?: unknown;
  version?: unknown;
}

const READY_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 10_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DaemonSupervisor {
  private status: DaemonStatusInfo = { state: "starting" };
  private healthTimer?: ReturnType<typeof setInterval>;
  private stopping = false;

  public constructor(
    private readonly config: BootstrapConfig,
    private readonly onStatus: (status: DaemonStatusInfo) => void,
  ) {}

  public current(): DaemonStatusInfo {
    return { ...this.status };
  }

  public async start(): Promise<DaemonStatusInfo> {
    this.update({ state: "starting" });
    const { command, args } = resolveDaemonArgs(this.config);
    const child = spawn(command, args, {
      env: resolveDaemonEnv(this.config),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      process.stderr.write(`[daemon:out] ${chunk.toString("utf8")}`);
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      process.stderr.write(`[daemon:err] ${chunk.toString("utf8")}`);
    });
    const exit = new Promise<number>((resolve) => {
      child.once("exit", (code) => resolve(code ?? 1));
    });
    const ready = await Promise.race([
      this.waitForReady(
        exit,
        () => stdout,
        () => stderr,
      ),
      sleep(READY_TIMEOUT_MS).then(() => null),
    ]);
    if (!ready) {
      child.kill("SIGTERM");
      throw new Error(
        `daemon did not become ready within ${READY_TIMEOUT_MS}ms: ${stderr || stdout}`,
      );
    }
    this.startHealthLoop();
    return this.status;
  }

  public async restart(): Promise<DaemonStatusInfo> {
    await this.stop();
    this.stopping = false;
    return await this.start();
  }

  public async stop(): Promise<void> {
    this.stopping = true;
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = undefined;
    }
    const { command, args } = resolveStopArgs(this.config);
    await new Promise<void>((resolve) => {
      const child = spawn(command, args, {
        env: resolveDaemonEnv(this.config),
        stdio: "ignore",
      });
      child.once("exit", () => resolve());
      child.once("error", () => resolve());
    });
    this.update({ state: "stopped" });
  }

  private async waitForReady(
    exit: Promise<number>,
    readStdout: () => string,
    readStderr: () => string,
  ): Promise<DaemonStatusInfo | null> {
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const parsed = this.parseReadyOutput(readStdout());
      if (parsed) {
        const ingressToken = await this.readIngressToken();
        if (ingressToken) {
          const status: DaemonStatusInfo = {
            state: "ready",
            port: parsed.port,
            ingressToken,
            ...(parsed.version ? { version: parsed.version } : {}),
          };
          this.update(status);
          return status;
        }
      }
      const exited = await Promise.race([exit, sleep(250).then(() => null)]);
      if (exited !== null) {
        const fallback = await this.readStatusFile();
        if (fallback?.state === "ready") {
          const ingressToken = await this.readIngressToken();
          if (ingressToken) {
            const status: DaemonStatusInfo = {
              state: "ready",
              port: fallback.port,
              ingressToken,
              ...(fallback.version ? { version: fallback.version } : {}),
            };
            this.update(status);
            return status;
          }
        }
        throw new Error(`daemon exited before ready (code=${exited}): ${readStderr().trim()}`);
      }
    }
    return null;
  }

  private parseReadyOutput(stdout: string): { port: number; version?: string } | null {
    const lines = stdout.trim().split("\n").reverse();
    for (const line of lines) {
      try {
        const value = JSON.parse(line) as DaemonStatusFile;
        if (value.state === "ready" && typeof value.port === "number" && value.port > 0) {
          return {
            port: value.port,
            ...(typeof value.version === "string" ? { version: value.version } : {}),
          };
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private async readStatusFile(): Promise<{
    state: string;
    port: number;
    version?: string;
  } | null> {
    try {
      const raw = await readFile(join(this.config.serverRoot, "run", "status.json"), "utf8");
      const value = JSON.parse(raw) as DaemonStatusFile;
      if (value.state === "ready" && typeof value.port === "number" && value.port > 0) {
        return {
          state: "ready",
          port: value.port,
          ...(typeof value.version === "string" ? { version: value.version } : {}),
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  private async readIngressToken(): Promise<string | null> {
    try {
      const token = (
        await readFile(join(this.config.serverRoot, "run", "ingress-token"), "utf8")
      ).trim();
      return token || null;
    } catch {
      return null;
    }
  }

  private startHealthLoop(): void {
    if (this.healthTimer) {
      return;
    }
    this.healthTimer = setInterval(() => {
      void this.checkHealth();
    }, HEALTH_INTERVAL_MS);
    this.healthTimer.unref?.();
  }

  private async checkHealth(): Promise<void> {
    if (this.stopping) {
      return;
    }
    const file = await this.readStatusFile();
    if (!file) {
      if (this.status.state === "ready") {
        this.update({ state: "stopped" });
      }
      return;
    }
    const ingressToken = await this.readIngressToken();
    if (!ingressToken) {
      return;
    }
    if (
      this.status.state !== "ready" ||
      this.status.port !== file.port ||
      this.status.ingressToken !== ingressToken
    ) {
      this.update({
        state: "ready",
        port: file.port,
        ingressToken,
        ...(file.version ? { version: file.version } : {}),
      });
    }
  }

  private update(status: DaemonStatusInfo): void {
    this.status = status;
    this.onStatus({ ...status });
  }
}

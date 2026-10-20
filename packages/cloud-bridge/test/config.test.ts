import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadBootstrapConfig,
  resolveDaemonArgs,
  resolveDaemonEnv,
  resolveStopArgs,
} from "../src/index.js";
import type { BootstrapConfig } from "@zcode/cloud-protocol";

const config: BootstrapConfig = {
  v: 1,
  controlPlaneUrl: "ws://127.0.0.1:4040/api/cloud/bridge/attach",
  attachToken: "0123456789abcdef",
  runId: "run-1",
  taskId: "task-1",
  taskStableId: "t-abc123",
  generation: 1,
  serverRoot: "/tmp/server",
  dataDir: "/tmp/data",
  workspacePath: "/tmp/workspace",
};

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("bridge config", () => {
  it("uses the stable launcher by default", () => {
    expect(resolveDaemonArgs(config)).toEqual({
      command: "/tmp/server/bin/zcode",
      args: ["serve", "--daemon", "--json", "--server-root", "/tmp/server"],
    });
    expect(resolveStopArgs(config)).toEqual({
      command: "/tmp/server/bin/zcode",
      args: ["stop", "--server-root", "/tmp/server"],
    });
  });

  it("honors a serverCommand override", () => {
    expect(
      resolveDaemonArgs({ ...config, serverCommand: ["/usr/bin/node", "/opt/server-cli.js"] }),
    ).toEqual({
      command: "/usr/bin/node",
      args: ["/opt/server-cli.js", "serve", "--daemon", "--json", "--server-root", "/tmp/server"],
    });
  });

  it("injects daemon environment", () => {
    const env = resolveDaemonEnv(config, { PATH: "/bin" });
    expect(env["ZCODE_SERVER_SKIP_SERVICE_REGISTRATION"]).toBe("1");
    expect(env["ZCODE_DATA_BASE_DIR"]).toBe("/tmp/data");
    expect(env["ZCODE_SERVER_WORKSPACE"]).toBe("/tmp/workspace");
  });

  it("loads and validates a bootstrap file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cloud-bridge-"));
    tempDirs.push(dir);
    const path = join(dir, "bootstrap.json");
    await writeFile(path, JSON.stringify(config));
    await expect(loadBootstrapConfig(path)).resolves.toMatchObject({ runId: "run-1" });
  });

  it("rejects invalid bootstrap files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cloud-bridge-"));
    tempDirs.push(dir);
    const path = join(dir, "bootstrap.json");
    await writeFile(path, JSON.stringify({ ...config, generation: 0 }));
    await expect(loadBootstrapConfig(path)).rejects.toThrow();
  });
});

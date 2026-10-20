import { readFile } from "node:fs/promises";

import { parseBootstrapConfig, type BootstrapConfig } from "@zcode/cloud-protocol";

export async function loadBootstrapConfig(path: string): Promise<BootstrapConfig> {
  const raw = await readFile(path, "utf8");
  return parseBootstrapConfig(JSON.parse(raw) as unknown);
}

export function resolveDaemonArgs(config: BootstrapConfig): { command: string; args: string[] } {
  const command = config.serverCommand?.[0] ?? `${config.serverRoot}/bin/zcode`;
  const prefix = config.serverCommand?.slice(1) ?? [];
  return {
    command,
    args: [...prefix, "serve", "--daemon", "--json", "--server-root", config.serverRoot],
  };
}

export function resolveStopArgs(config: BootstrapConfig): { command: string; args: string[] } {
  const command = config.serverCommand?.[0] ?? `${config.serverRoot}/bin/zcode`;
  const prefix = config.serverCommand?.slice(1) ?? [];
  return {
    command,
    args: [...prefix, "stop", "--server-root", config.serverRoot],
  };
}

export function resolveDaemonEnv(
  config: BootstrapConfig,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    ZCODE_SERVER_SKIP_SERVICE_REGISTRATION: "1",
    ZCODE_DATA_BASE_DIR: config.dataDir,
    ZCODE_SERVER_WORKSPACE: config.workspacePath,
    ZCODE_SERVER_ROOT: config.serverRoot,
  };
}

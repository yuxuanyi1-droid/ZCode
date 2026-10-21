import { DaemonSupervisor } from "./daemon.js";
import { loadBootstrapConfig } from "./config.js";
import { TunnelClient } from "./tunnel.js";

function parseConfigPath(argv: string[]): string {
  const index = argv.indexOf("--config");
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (!value) {
    throw new Error("usage: zcode-cloud-bridge --config <bootstrap.json>");
  }
  return value;
}

function log(message: string): void {
  process.stderr.write(`[cloud-bridge] ${new Date().toISOString()} ${message}\n`);
}

process.on("uncaughtException", (error) => {
  log(`uncaught: ${error.stack ?? error.message}`);
  process.exit(1);
});
process.on("unhandledRejection", (error) => {
  log(`unhandled: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
});
process.on("exit", (code) => {
  process.stderr.write(`[cloud-bridge] exit ${code}\n`);
});

async function main(): Promise<void> {
  const configPath = parseConfigPath(process.argv.slice(2));
  const config = await loadBootstrapConfig(configPath);
  let tunnel: TunnelClient | undefined;
  const daemon = new DaemonSupervisor(config, (status) => {
    tunnel?.notifyDaemonStatus(status);
  });
  tunnel = new TunnelClient(config, daemon, {
    onLog: log,
    onEpoch: (epoch) => log(`epoch=${epoch}`),
  });

  const shutdown = (): void => {
    tunnel?.close();
    void daemon.stop().finally(() => process.exit(0));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);

  try {
    await daemon.start();
    tunnel.connect();
  } catch (error) {
    log(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();

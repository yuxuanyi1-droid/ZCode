import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { loadConfig } from "../config.js";
import { ProcessSandboxDriver, FAKE_DAEMON_ENTRY } from "../adapters/providers/processDriver.js";
import { CloudStore } from "../adapters/storage/db.js";
import { SecretBox } from "../adapters/storage/secrets.js";
import { BridgeServer } from "../adapters/tunnel/server.js";
import type { SandboxDriver } from "../adapters/providers/types.js";
import { EventHub } from "../app/events.js";
import { Orchestrator } from "../app/orchestrator.js";
import { CloudHttpServer } from "../http/server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  await mkdir(config.dataDir, { recursive: true });
  const store = new CloudStore(join(config.dataDir, "cloud.db"));
  const secrets = await SecretBox.fromDataDir(config.dataDir);
  const events = new EventHub();

  const drivers = new Map<string, SandboxDriver>();
  for (const id of config.providers) {
    if (id === "fake") {
      drivers.set(
        "fake",
        new ProcessSandboxDriver({
          id: "fake",
          label: "Fake sandbox",
          sandboxRoot: config.sandboxRoot,
          capabilities: { pause: false, maxLifetimeSeconds: 86_400, verified: true },
          serverCommand: [process.execPath, "--import", "tsx", FAKE_DAEMON_ENTRY],
          skipCheckout: true,
        }),
      );
      continue;
    }
    if (id === "local") {
      if (!config.serverBin) {
        throw new Error("ZCODE_SERVER_BIN is required when CLOUD_PROVIDERS includes local");
      }
      drivers.set(
        "local",
        new ProcessSandboxDriver({
          id: "local",
          label: "Local process sandbox",
          sandboxRoot: config.sandboxRoot,
          capabilities: { pause: false, maxLifetimeSeconds: 86_400, verified: true },
          serverCommand: [process.execPath, config.serverBin],
        }),
      );
      continue;
    }
    throw new Error(`unsupported provider: ${id}`);
  }

  const orchestrator = new Orchestrator({
    store,
    secrets,
    drivers,
    defaultProvider: config.defaultProvider,
    publicUrl: config.publicUrl,
    broadcast: events.broadcast,
  });

  const bridgeServer = new BridgeServer({
    verifyAttach: (runId, token) => orchestrator.verifyAttach(runId, token),
    onAttached: (attachment) => orchestrator.onAttached(attachment),
    onDetached: (runId, epoch) => orchestrator.onDetached(runId, epoch),
    onDaemonStatus: (attachment) => orchestrator.onDaemonStatus(attachment),
  });

  const httpServer = new CloudHttpServer({
    host: config.host,
    port: config.port,
    accessToken: config.accessToken,
    webDistDir: config.webDistDir,
    orchestrator,
    bridgeServer,
    events,
    accountLink: null,
    providers: [...drivers.values()].map((driver) => ({
      id: driver.id,
      label: driver.label,
      pause: driver.capabilities.pause,
      maxLifetimeSeconds: driver.capabilities.maxLifetimeSeconds,
      verified: driver.capabilities.verified,
    })),
  });

  await httpServer.start();
  const address = httpServer.address();
  process.stdout.write(
    `[cloud-control-plane] listening on http://${address.host}:${address.port} providers=${[...drivers.keys()].join(",")}\n`,
  );

  const shutdown = (): void => {
    httpServer.close();
    orchestrator.dispose();
    bridgeServer.closeAll("server shutdown");
    store.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

await main().catch((error: unknown) => {
  process.stderr.write(
    `[cloud-control-plane] fatal: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exit(1);
});

import { serve } from "@hono/node-server";
import { loadProvisionerConfig } from "./config.js";
import { createConsoleLogger } from "./logger.js";
import { createDriverRegistry } from "./providers/index.js";
import { createProvisionerApp } from "./server.js";

const config = loadProvisionerConfig();
const log = createConsoleLogger();

if (!config.token && !isLoopback(config.host)) {
  // 未配置 token 又不绑回环 = 任何人都能在你的云账号上开沙箱。
  log.warn(
    "sandbox provisioner is exposed without a bearer token; anyone who can reach it can create sandboxes",
    { host: config.host },
  );
}

const drivers = createDriverRegistry(config);
const app = createProvisionerApp({
  drivers,
  gitBaseUrl: config.gitBaseUrl,
  ...(config.token ? { token: config.token } : {}),
  log,
});

serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  log.info("sandbox provisioner listening", {
    url: `http://${config.host}:${info.port}`,
    gitBaseUrl: config.gitBaseUrl,
    providers: [...drivers.values()].map((driver) => ({
      provider: driver.provider,
      configured: driver.isConfigured(),
    })),
  });
});

function isLoopback(host: string): boolean {
  return host === "127.0.0.1" || host === "::1" || host === "localhost";
}

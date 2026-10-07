/**
 * cloud 路由注册入口：HTTP（03 §6 端点矩阵）+ 两条 WS 通道（03 §7.1）。
 * 入口层只调用这一个函数，不关心 HTTP/WS 的拆分。
 */
import type { Hono } from "hono";
import { registerCloudHttpRoutes } from "./routes.js";
import { registerCloudWsRoutes } from "./wsRoutes.js";
import type { CloudHttpRouteDeps, CloudHttpRouteOptions } from "./support.js";

export function registerCloudRoutes(
  app: Hono,
  deps: CloudHttpRouteDeps,
  options: CloudHttpRouteOptions = {},
): void {
  registerCloudHttpRoutes(app, deps);
  registerCloudWsRoutes(app, deps, options.upgradeWebSocket);
}

export type { CloudHttpRouteDeps, CloudHttpRouteOptions };
export type {
  CloudBranchCatalogSource,
  CloudRepositoryCatalogSource,
  CloudRepositoryFacts,
  CloudUpgradeWebSocket,
} from "./support.js";

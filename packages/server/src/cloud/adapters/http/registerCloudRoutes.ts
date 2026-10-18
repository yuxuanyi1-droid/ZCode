/**
 * cloud 路由注册入口：HTTP（03 §6 端点矩阵）+ 两条 WS 通道（03 §7.1）。
 * 入口层只调用这一个函数，不关心 HTTP/WS 的拆分。
 */
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { registerCloudHttpRoutes } from "./routes.js";
import { registerCloudWsRoutes } from "./wsRoutes.js";
import { errorResponse, type CloudHttpRouteDeps, type CloudHttpRouteOptions } from "./support.js";

/**
 * `/api/cloud/*` JSON 请求体的全局上限（2MiB）。
 *
 * 输入正文上限是 200k 字符（shared/CONTRACT.md 尺寸上限），2MiB 足够覆盖正文 + 附件引用 +
 * 执行配置；这是内存 DoS 防护——没有上限时一个超大 JSON 会被完整读入进程内存。
 */
export const CLOUD_REQUEST_BODY_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 用户资源 profile 的条目上传路径（矩阵首个 PUT）：已有专用 80MiB `bodyLimit`
 * （`CLOUD_PROFILE_UPLOAD_BODY_MAX_BYTES`，userProfileRoutes），全局 2MiB 中间件必须跳过它，
 * 否则 2MiB~80MiB 的合法 profile 会被误拒。
 */
export function isCloudProfileEntryUploadPath(method: string, path: string): boolean {
  if (method !== "PUT") return false;
  const prefix = "/api/cloud/user-profile/entries/";
  if (!path.startsWith(prefix)) return false;
  const segments = path.slice(prefix.length).split("/");
  return segments.length === 2 && segments.every((segment) => segment.length > 0);
}

/** 超限统一走既有错误信封（03 §6）：413 `payload_too_large`。 */
const cloudBodyLimit = bodyLimit({
  maxSize: CLOUD_REQUEST_BODY_MAX_BYTES,
  onError: (c) => errorResponse(c, "payload_too_large", "cloud-request-body-too-large"),
});

export function registerCloudRoutes(
  app: Hono,
  deps: CloudHttpRouteDeps,
  options: CloudHttpRouteOptions = {},
): void {
  // 全局 JSON 体上限必须先于路由注册（Hono 只把先注册的中间件应用到后续 handler）。
  // profile 条目 PUT 例外：它自带 80MiB 限制，这里按 method+path 直接放行。
  app.use("/api/cloud/*", (c, next) => {
    if (isCloudProfileEntryUploadPath(c.req.method, c.req.path)) return next();
    return cloudBodyLimit(c, next);
  });
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

/**
 * Cloud SDK 装配入口（specs/cloud-agent/W7 §4：W8 只经 `createCloudClient` 访问云服务）。
 *
 * `createCloudClient({ origin, token?, fetch?, taskId? })` → `{ controlPlane, attach }`：
 * - `controlPlane`：控制面 HTTP（Project/Task/Input/lifecycle/history/events/capabilities）。
 * - `attach`：任务级 attachment（`/ws/cloud/tasks/:taskId`，ChannelClient 承载 + 订阅 + 重连）。
 * 两者共享同一显式 origin 与鉴权模式：有 token 走 bearer 头，无 token 走同源 cookie。
 *
 * 任务身份（04 §5 主路由 `/?task=<taskId>`）在创建时给出；切任务时新建客户端并
 * `attach.close()` 旧实例，旧 tuple 的事件/响应自然失效（不在同一实例里复用连接）。
 */
import {
  createCloudAttachClient,
  type CloudAttachClient,
  type CloudAttachConnector,
  type CloudAttachReconnectPolicy,
} from "./cloudAttachClient.js";
import type { CloudWebSocketFactory } from "./cloudAttachmentSocket.js";
import {
  createCloudControlPlaneClient,
  type CloudControlPlaneClient,
} from "./cloudControlPlaneClient.js";
import {
  createCloudHttpTransport,
  type CloudFetchLike,
  type CloudHttpAuth,
} from "./cloudHttpTransport.js";

export interface CreateCloudClientOptions {
  readonly origin: string;
  /** 有 token → bearer 头；无 token → 同源 cookie 主体认证（03 §3、§7.1）。 */
  readonly token?: string | undefined;
  /** 显式鉴权模式：与 token 同时给出时以 auth 为准。 */
  readonly auth?: CloudHttpAuth | undefined;
  readonly fetch?: CloudFetchLike | undefined;
  readonly timeoutMs?: number | undefined;
  /** 任务身份；attachment 必需（缺失时 connect/subscribe 报配置错误）。 */
  readonly taskId?: string | undefined;
  readonly connector?: CloudAttachConnector | undefined;
  readonly webSocketFactory?: CloudWebSocketFactory | undefined;
  readonly reconnect?: CloudAttachReconnectPolicy | undefined;
  readonly connectTimeoutMs?: number | undefined;
}

export interface CloudClient {
  readonly origin: string;
  readonly controlPlane: CloudControlPlaneClient;
  readonly attach: CloudAttachClient;
}

export function createCloudClient(options: CreateCloudClientOptions): CloudClient {
  const auth: CloudHttpAuth =
    options.auth ??
    (options.token === undefined ? { mode: "cookie" } : { mode: "bearer", token: options.token });
  const transport = createCloudHttpTransport({
    origin: options.origin,
    auth,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs,
  });
  const controlPlane = createCloudControlPlaneClient(transport);
  const attach = createCloudAttachClient({
    origin: transport.origin,
    taskId: options.taskId,
    auth,
    connector: options.connector,
    webSocketFactory: options.webSocketFactory,
    reconnect: options.reconnect,
    connectTimeoutMs: options.connectTimeoutMs,
  });
  return { origin: transport.origin, controlPlane, attach };
}

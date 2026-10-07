/**
 * attachment 客户端的公开契约（specs/cloud-agent/W7 §3/§4、03 §7.1、07 §9）。
 * 只放类型：连接状态、socket/connector、重连策略、订阅契约；实现在
 * `cloudAttachClient.ts`，浏览器 WebSocket 适配在 `cloudAttachmentSocket.ts`。
 */
import type { Event, IChannelClient, IDisposable, IMessagePassingProtocol } from "@zcode/rpc";
import type { CloudApiError, CloudResyncRequiredError } from "./cloudApiError.js";
import type { CloudHttpAuth } from "./cloudHttpTransport.js";
import type { CloudWebSocketFactory } from "./cloudAttachmentSocket.js";
import type {
  CloudAttachSubscriptionHandle,
  CloudAttachSubscriptionSpec,
  CloudAttachSubscribeOptions,
} from "./cloudAttachSubscription.js";

export type CloudAttachState = "idle" | "connecting" | "connected" | "reconnecting" | "closed";

/** 一条 attachment socket：协议 + 对端关闭事实 + 本地释放。 */
export interface CloudAttachSocket {
  readonly protocol: IMessagePassingProtocol;
  /** 对端断开（不是本地 close）时触发；用于区分「掉线待重连」与「主动关闭」。 */
  readonly onDidClose: Event<void>;
  dispose(reason?: Error): void;
}

export interface CloudAttachConnectorInput {
  readonly url: string;
  readonly taskId: string;
  readonly auth: CloudHttpAuth;
}

export type CloudAttachConnector = (input: CloudAttachConnectorInput) => Promise<CloudAttachSocket>;

export interface CloudAttachReconnectPolicy {
  readonly enabled?: boolean;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  /** 连续失败次数上限；缺省不限次（关页/断网恢复由 close() 决定终点）。 */
  readonly maxAttempts?: number;
}

export interface CloudAttachClientOptions {
  readonly origin: string;
  /** 任务身份；缺失时 connect/subscribe 直接报配置错误（不构造野路径）。 */
  readonly taskId?: string | undefined;
  readonly auth?: CloudHttpAuth;
  readonly connector?: CloudAttachConnector;
  readonly reconnect?: CloudAttachReconnectPolicy;
  readonly connectTimeoutMs?: number;
  /** 自定义 WebSocket 工厂（bearer 模式必须提供，见 cloudAttachmentSocket.ts）。 */
  readonly webSocketFactory?: CloudWebSocketFactory;
}

export interface CloudAttachStateChange {
  readonly state: CloudAttachState;
  /** 进入 reconnecting/closed 的原因；正常状态为 undefined。 */
  readonly error?: CloudApiError;
}

/**
 * attachment 客户端：`getChannel` 让既有服务代理（`RemoteServiceAccess`）直接挂到当前连接，
 * `subscribe` 提供跨重连的订阅与水位恢复。
 */
export interface CloudAttachClient extends IChannelClient {
  readonly origin: string;
  readonly taskId: string | undefined;
  readonly state: CloudAttachState;
  readonly lastError: CloudApiError | undefined;
  onDidChangeState(listener: (change: CloudAttachStateChange) => void): IDisposable;
  /** 后台重连重订阅时无法续接水位：调用方需重新读取权威快照（02 §7.3）。 */
  onDidRequireResync(listener: (error: CloudResyncRequiredError) => void): IDisposable;
  connect(): Promise<void>;
  subscribe<TFrame>(
    spec: CloudAttachSubscriptionSpec,
    options: CloudAttachSubscribeOptions<TFrame>,
  ): Promise<CloudAttachSubscriptionHandle>;
  close(reason?: Error): void;
}

// 订阅契约与恢复判定实现在 cloudAttachSubscription.ts；这里为公开入口统一再导出。
export type {
  CloudAttachSubscriptionSpec,
  CloudAttachSubscriptionState,
  CloudAttachSubscriptionHandle,
  CloudAttachSubscribeOptions,
  CloudSubscriptionWatermark,
} from "./cloudAttachSubscription.js";

export type { CloudWebSocketFactory };

/**
 * Cloud attachment 客户端（specs/cloud-agent/03 §7.1/§7.2、02 §2 不变量、§7.3 快照与恢复、
 * 07 §9 多端订阅与恢复、04 §5 路由身份与事件顺序）。
 *
 * 承载：浏览器 ↔ `/ws/cloud/tasks/:taskId` 的 Channel RPC。复用既有 ChannelClient 与
 * 服务面（02 §0），不新造文件/Git/终端协议；服务通道名与命令名由服务契约给出，SDK 不发明。
 *
 * 语义边界（最容易出错，先固定用例再实现）：
 * - 断连只释放本客户端的订阅 scope：不释放共享 Run、不重发输入、不重放任何挂起请求
 *   （02 §2 不变量 4；07 §9「一端断开：释放其scope，不释放共享Run」）。
 * - 订阅恢复使用调用方声明的 `{logEpoch, seq}` 水位；服务端无法续接时显式上抛
 *   `CloudResyncRequiredError`，调用方必须改读权威快照（02 §7.3、03 §9）。
 * - SDK 不解析帧 payload（topic 级 schema 属 W6/W8）；水位由调用方在应用帧后回填。
 * - 重连与重订阅不产生新的输入写入路径：SDK 从不在 attach 上发送输入（03 §7 单一输入通路）。
 */
import { ChannelClient, Emitter, Event, type CancellationToken, type IChannel } from "@zcode/rpc";
import { CLOUD_SERVICE_CHANNEL_FACETS, isCloudAttachmentServiceAllowed } from "@zcode/shared";
import { subscribeParamsSchema } from "@zcode/shared/zcode-protocol-v4";
import {
  CloudResyncRequiredError,
  cloudAttachmentUnavailableError,
  cloudChannelNotAllowedError,
  cloudConfigurationError,
  isCloudApiError,
  isCloudResyncRequiredError,
  normalizeCloudRpcError,
  type CloudApiError,
} from "./cloudApiError.js";
import {
  assertResumeHonored,
  createCloudAttachSubscriptionHandle,
  createSubscriptionEntry,
  parseSubscribeAck,
  subscriptionParamsFor,
  type CloudAttachSubscriptionEntry,
  type CloudAttachSubscriptionHandle,
  type CloudAttachSubscriptionSpec,
  type CloudAttachSubscribeOptions,
} from "./cloudAttachSubscription.js";
import {
  buildCloudWebSocketUrl,
  normalizeCloudOrigin,
  type CloudHttpAuth,
} from "./cloudHttpTransport.js";
import { parseCloudValue } from "./cloudWireSchemas.js";
import { createBrowserCloudAttachConnector } from "./cloudAttachmentSocket.js";

import type {
  CloudAttachClient,
  CloudAttachClientOptions,
  CloudAttachConnectorInput,
  CloudAttachSocket,
  CloudAttachState,
  CloudAttachStateChange,
} from "./cloudAttachTypes.js";

export type * from "./cloudAttachTypes.js";

const DEFAULT_RECONNECT_INITIAL_DELAY_MS = 500;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;

export function createCloudAttachClient(options: CloudAttachClientOptions): CloudAttachClient {
  const origin = normalizeCloudOrigin(options.origin);
  const auth: CloudHttpAuth = options.auth ?? { mode: "cookie" };
  if (auth.mode === "bearer" && auth.token.trim().length === 0) {
    throw cloudConfigurationError(`bearer auth requires a non-empty token`);
  }
  const facet = CLOUD_SERVICE_CHANNEL_FACETS["taskAttachment"];
  if (facet === undefined) {
    throw cloudConfigurationError(`cloud attachment facet is not frozen in shared`);
  }
  const upgradePath = facet.upgradePath;
  const taskId = options.taskId;
  const connector =
    options.connector ??
    createBrowserCloudAttachConnector(
      options.webSocketFactory === undefined
        ? undefined
        : { webSocketFactory: options.webSocketFactory },
    );
  const connectTimeoutMs = options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const reconnectPolicy = {
    enabled: options.reconnect?.enabled ?? true,
    initialDelayMs: options.reconnect?.initialDelayMs ?? DEFAULT_RECONNECT_INITIAL_DELAY_MS,
    maxDelayMs: options.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS,
    maxAttempts: options.reconnect?.maxAttempts ?? Number.POSITIVE_INFINITY,
  };

  const entries = new Set<CloudAttachSubscriptionEntry>();
  const onState = new Emitter<CloudAttachStateChange>();
  const onResync = new Emitter<CloudResyncRequiredError>();

  let state: CloudAttachState = "idle";
  let lastError: CloudApiError | undefined;
  let channelClient: ChannelClient | undefined;
  let socket: CloudAttachSocket | undefined;
  let pendingConnect: Promise<void> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempts = 0;
  let subscriptionRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let subscriptionRetryAttempts = 0;

  function emitState(next: CloudAttachState, error?: CloudApiError): void {
    state = next;
    if (error !== undefined) lastError = error;
    else if (next === "connected") lastError = undefined;
    onState.fire(error === undefined ? { state: next } : { state: next, error });
  }

  function requireTaskId(): string {
    if (taskId === undefined || taskId.trim().length === 0) {
      throw cloudConfigurationError(`cloud attach client requires a taskId`);
    }
    return taskId;
  }

  /**
   * 只允许 shared 冻结的 attachment 白名单 channel（03 §7.1、CONTRACT「禁止任何一端硬编码
   * channel 字符串」）：账号域/host 本体的 channel 走 host `/ws`，不经沙箱通道借用。
   * 判定放在调用时而不是 `getChannel` 构造时——`RemoteServiceAccess` 会为全部服务预先取
   * channel 引用，构造期拒绝会挡住「base=host + 执行域覆盖」的装配方式。
   */
  function assertChannelAllowed(channelName: string): void {
    if (isCloudAttachmentServiceAllowed(channelName)) return;
    throw cloudChannelNotAllowedError(channelName);
  }

  function requireChannelClient(): ChannelClient {
    if (state !== "connected" || channelClient === undefined) {
      throw cloudAttachmentUnavailableError(`cloud attachment is not connected (${state})`);
    }
    return channelClient;
  }

  function teardownConnection(reason: CloudApiError): void {
    const client = channelClient;
    const current = socket;
    channelClient = undefined;
    socket = undefined;
    // ChannelClient.dispose 会把已发出/排队的 RPC 全部 reject：断连不重放任何请求。
    client?.dispose(reason);
    current?.dispose(reason);
  }

  async function waitForInitialize(
    client: ChannelClient,
    closed: Event<void>,
    timeoutMs: number,
  ): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      function cleanup(): void {
        clearTimeout(timer);
        onInitialize.dispose();
        onClosed.dispose();
      }
      const timer = setTimeout(() => {
        cleanup();
        reject(
          cloudAttachmentUnavailableError(
            `cloud attachment did not initialize within ${String(timeoutMs)}ms`,
          ),
        );
      }, timeoutMs);
      const onInitialize = client.onDidInitialize(() => {
        cleanup();
        resolve();
      });
      const onClosed = closed(() => {
        cleanup();
        reject(cloudAttachmentUnavailableError(`cloud attachment closed before initialize`));
      });
    });
  }

  function connectWithTimeout(): Promise<CloudAttachSocket> {
    const id = requireTaskId();
    const input: CloudAttachConnectorInput = {
      url: buildCloudWebSocketUrl(origin, upgradePath, { taskId: id }),
      taskId: id,
      auth,
    };
    return new Promise<CloudAttachSocket>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(
          cloudAttachmentUnavailableError(
            `cloud attachment connect timed out after ${String(connectTimeoutMs)}ms`,
          ),
        );
      }, connectTimeoutMs);
      connector(input).then(
        (opened) => {
          clearTimeout(timer);
          resolve(opened);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(normalizeCloudRpcError(error, `cloud attachment connect failed`));
        },
      );
    });
  }

  function handleConnectionDropped(): void {
    // 只有已建立连接上的掉线才由本函数接管；连接中/重连中的失败由 connect() 与
    // attemptReconnect() 的 await 处理，避免双重重连计时器。
    if (state !== "connected") return;
    const error = cloudAttachmentUnavailableError(`cloud attachment connection dropped`);
    teardownConnection(error);
    releaseSubscriptions();
    emitState("reconnecting", error);
    scheduleReconnect();
  }

  async function openConnection(): Promise<void> {
    const opened = await connectWithTimeout();
    const client = new ChannelClient(opened.protocol);
    socket = opened;
    channelClient = client;
    opened.onDidClose(() => {
      if (socket === opened) handleConnectionDropped();
    });
    try {
      await waitForInitialize(client, opened.onDidClose, connectTimeoutMs);
    } catch (error) {
      const apiError = normalizeCloudRpcError(error, `cloud attachment did not initialize`);
      teardownConnection(apiError);
      throw apiError;
    }
  }

  /** 断线只把订阅标记为 released：不发送上行命令、不退订、不重发输入（07 §9）。 */
  function releaseSubscriptions(): void {
    for (const entry of entries) {
      entry.listener?.dispose();
      entry.listener = undefined;
      if (entry.state === "active") entry.state = "released";
    }
  }

  async function attachSubscription(entry: CloudAttachSubscriptionEntry): Promise<void> {
    const client = requireChannelClient();
    const channel = client.getChannel<IChannel>(entry.spec.channel);
    // 先拿 ack 再挂帧监听：初始 snapshot/resume 由服务端在响应之后发出（transport.ts 注释）。
    const rawAck = await channel.call(entry.spec.subscribeCommand, subscriptionParamsFor(entry));
    const ack = parseSubscribeAck(rawAck);
    assertResumeHonored(ack, entry.spec.subscribeParams);
    const listen = channel.listen(entry.spec.frameEvent, entry.spec.frameParams);
    entry.listener = listen((frame: unknown) => entry.onFrame(frame));
    entry.ack = ack;
    entry.state = "active";
    subscriptionRetryAttempts = 0;
  }

  function closeEntry(entry: CloudAttachSubscriptionEntry): void {
    entry.listener?.dispose();
    entry.listener = undefined;
    entry.state = "closed";
  }

  async function reestablishSubscriptions(): Promise<void> {
    // 先快照待重建的订阅：await 期间调用方可能新增/释放订阅，不能边走边改集合。
    const pending: CloudAttachSubscriptionEntry[] = [];
    for (const entry of entries) {
      if (entry.state === "released") pending.push(entry);
    }
    for (const entry of pending) {
      try {
        await attachSubscription(entry);
      } catch (error) {
        if (isCloudResyncRequiredError(error)) {
          closeEntry(entry);
          onResync.fire(error);
          continue;
        }
        subscriptionRetryAttempts += 1;
        scheduleSubscriptionRetry();
      }
    }
  }

  function scheduleSubscriptionRetry(): void {
    if (state !== "connected" || subscriptionRetryTimer !== undefined) return;
    if (![...entries].some((entry) => entry.state === "released")) return;
    const delay = Math.min(
      reconnectPolicy.initialDelayMs * 2 ** subscriptionRetryAttempts,
      reconnectPolicy.maxDelayMs,
    );
    subscriptionRetryTimer = setTimeout(() => {
      subscriptionRetryTimer = undefined;
      void reestablishSubscriptions();
    }, delay);
  }

  function scheduleReconnect(): void {
    if (state === "closed" || reconnectTimer !== undefined) return;
    if (!reconnectPolicy.enabled || reconnectAttempts >= reconnectPolicy.maxAttempts) {
      emitState("closed", lastError);
      return;
    }
    const delay = Math.min(
      reconnectPolicy.initialDelayMs * 2 ** reconnectAttempts,
      reconnectPolicy.maxDelayMs,
    );
    reconnectAttempts += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void attemptReconnect();
    }, delay);
  }

  async function attemptReconnect(): Promise<void> {
    if (state === "closed") return;
    try {
      await openConnection();
      reconnectAttempts = 0;
      emitState("connected");
      await reestablishSubscriptions();
    } catch (error) {
      emitState("reconnecting", normalizeCloudRpcError(error, `cloud attachment reconnect failed`));
      scheduleReconnect();
    }
  }

  function connect(): Promise<void> {
    if (state === "connected") return Promise.resolve();
    if (state === "closed") {
      return Promise.reject(cloudAttachmentUnavailableError(`cloud attachment is closed`, false));
    }
    if (pendingConnect === undefined) {
      emitState("connecting");
      pendingConnect = (async () => {
        await openConnection();
        reconnectAttempts = 0;
        emitState("connected");
        await reestablishSubscriptions();
      })()
        .catch((error: unknown) => {
          const apiError = normalizeCloudRpcError(error, `cloud attachment connect failed`);
          if (state !== "closed") emitState("idle", apiError);
          throw apiError;
        })
        .finally(() => {
          pendingConnect = undefined;
        });
    }
    return pendingConnect;
  }

  return {
    origin,
    taskId,
    get state() {
      return state;
    },
    get lastError() {
      return lastError;
    },
    onDidChangeState: onState.event,
    onDidRequireResync: onResync.event,

    connect,

    async subscribe<TFrame>(
      spec: CloudAttachSubscriptionSpec,
      subscribeOptions: CloudAttachSubscribeOptions<TFrame>,
    ): Promise<CloudAttachSubscriptionHandle> {
      assertChannelAllowed(spec.channel);
      // 订阅参数必须是冻结形状：调用方不能塞自定义字段（subscribeParamsSchema 为 strict）。
      const params = parseCloudValue(
        subscribeParamsSchema,
        spec.subscribeParams,
        "attachment subscribeParams",
      );
      await connect();
      const entry = createSubscriptionEntry(
        spec,
        params,
        subscribeOptions.onFrame as (frame: unknown) => void,
      );
      entries.add(entry);
      try {
        await attachSubscription(entry);
      } catch (error) {
        closeEntry(entry);
        entries.delete(entry);
        throw error;
      }
      return createCloudAttachSubscriptionHandle(entry, {
        connected: () => state === "connected" && channelClient !== undefined,
        call: async (channel, command, params) => {
          await requireChannelClient().getChannel<IChannel>(channel).call(command, params);
        },
        release: () => {
          closeEntry(entry);
          entries.delete(entry);
        },
      });
    },

    close(reason?: Error) {
      if (state === "closed") return;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (subscriptionRetryTimer !== undefined) clearTimeout(subscriptionRetryTimer);
      reconnectTimer = undefined;
      subscriptionRetryTimer = undefined;
      const closeReason = isCloudApiError(reason)
        ? reason
        : cloudAttachmentUnavailableError(`cloud attachment closed by caller`, false);
      teardownConnection(closeReason);
      for (const entry of entries) closeEntry(entry);
      entries.clear();
      emitState("closed", closeReason);
      onState.dispose();
      onResync.dispose();
    },

    getChannel<T extends IChannel>(channelName: string): T {
      // 通道代理每次调用都解析当前连接：重连后旧引用仍然可用（不持有过期 ChannelClient）。
      return {
        // async：未连接时返回 rejected promise（而不是同步抛出），调用方可统一用 await/catch。
        call: async (command: string, arg?: unknown, token?: CancellationToken) => {
          assertChannelAllowed(channelName);
          return requireChannelClient().getChannel<IChannel>(channelName).call(command, arg, token);
        },
        listen: (event: string, arg?: unknown) => {
          assertChannelAllowed(channelName);
          if (state !== "connected" || channelClient === undefined) {
            // 未连接时裸事件流没有意义；需要跨重连的订阅请用 subscribe()（07 §9）。
            return Event.None as Event<unknown>;
          }
          return channelClient.getChannel<IChannel>(channelName).listen(event, arg);
        },
      } as T;
    },
  };
}

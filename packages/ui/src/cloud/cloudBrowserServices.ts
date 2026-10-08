/**
 * 云模式浏览器 accessor 合成（specs/cloud-agent/W8 §3/§4、12 §5、03 §7.1、04 §3.0/§4）。
 *
 * ```
 * base          = host `/ws` accessor        ← 账号域 + 模型目录 + host 本体能力
 * 执行域覆盖     = 当前 Run attachment        ← `/ws/cloud/tasks/:taskId`（白名单内 channel）
 * 无 attachment = 显式 unavailable            ← 不回落部署机执行域，不伪造空数据
 * ```
 *
 * 合成规则只有一条：按 `CLOUD_EXECUTION_SERVICE_BINDINGS`（由 shared 的
 * `CLOUD_ATTACHMENT_SERVICE_ALLOWLIST` 派生）逐字段决定来源，其余字段一律保留 host base。
 * 组件因此看不到「云分支」——`useServices()` 拿到的是已经定好作用域的 accessor。
 *
 * 账号域**不在这里覆盖**：登录/套餐/模型目录就是 host `/ws` 的既有服务，
 * 模型设置页与 WelcomeScreen 零改动（12 §5）。
 */
import { ProxyChannel, type Event, type IChannelClient } from "@zcode/rpc";
import { ServiceChannels, buildCloudTaskWorkspaceIdentity } from "@zcode/shared";
import type {
  IFileService,
  IFileWatcherService,
  IGitCheckpointService,
  IGitService,
  IMediaPreviewService,
  IServiceAccessor,
  ISystemService,
  ITerminalService,
  IZCodeAgentService,
  IZCodeSessionService,
} from "@zcode/services";
import {
  CLOUD_EXECUTION_SERVICE_BINDINGS,
  assertCloudExecutionBindingsMatchAllowlist,
  describeCloudExecutionTargets,
  describeCloudHostTargets,
  type CloudExecutionScope,
  type CloudServiceTargetDescriptor,
} from "./cloudServiceScope.js";
import { getCloudAttachmentUnavailableServices } from "./unavailableServiceAccessor.js";

/**
 * 当前 Run attachment 的服务通道。
 *
 * `channelClient` 就是云 attachment 的 ChannelClient（`/ws/cloud/tasks/:taskId`），
 * 与桌面 SSH 复用同一套 RPC 代理语义（04 §3.0.1「保留原组件的命令、事件与二进制语义」）。
 */
export interface CloudAttachmentAccessor {
  readonly taskId: string;
  readonly channelClient: IChannelClient;
  /** 服务端解析出的当前 Run 代际；只作 expected 值用于 stale 检测（04 §5）。 */
  readonly expectedRun?: {
    readonly runId: string;
    readonly runGeneration: number;
    readonly connectionEpoch: number;
  };
}

export interface CloudBrowserServicesOptions {
  /** host `/ws` 的 accessor；合成结果的全部 host 域服务来自它。 */
  readonly hostAccessor: IServiceAccessor;
  /** 当前 Run attachment；缺省 / null 表示尚无 ready attachment，执行域回落 unavailable。 */
  readonly attachment?: CloudAttachmentAccessor | null;
  /** 不可用时的原因文案（进结构化错误，不作为业务判断依据）。 */
  readonly unavailableReason?: string;
}

export interface CloudBrowserServices {
  /** 交给 `ServiceProvider` / `Root` 的最终 accessor。 */
  readonly services: IServiceAccessor;
  readonly executionScope: CloudExecutionScope;
  /** 服务目标证据：哪个字段打到 host `/ws`、哪个打到当前 Run attachment（04 §9）。 */
  readonly hostTargets: readonly CloudServiceTargetDescriptor[];
  readonly executionTargets: readonly CloudServiceTargetDescriptor[];
}

/**
 * 为某个 cloud task 挑选可用的 attachment。
 *
 * 规则（04 §3.2/§3.4.1、03 §2 不变量 7）：只有 attachment 的归属任务与当前工作区
 * 身份**一致**时才可用；不一致时返回 null，让执行域回落 unavailable——
 * 既不借用别的任务的服务，也不回落到 host 本机执行域。
 */
export function selectCloudAttachmentForTask(
  attachment: CloudAttachmentAccessor | null | undefined,
  taskId: string | null,
): CloudAttachmentAccessor | null {
  if (!attachment || taskId === null) {
    return null;
  }
  return attachment.taskId === taskId ? attachment : null;
}

const EXECUTION_ACCESSOR_KEYS: ReadonlySet<string> = new Set(
  CLOUD_EXECUTION_SERVICE_BINDINGS.map((binding) => binding.accessorKey as string),
);

function isExecutionAccessorKey(property: PropertyKey): boolean {
  return typeof property === "string" && EXECUTION_ACCESSOR_KEYS.has(property);
}

/**
 * 把执行域 accessor 叠在 host base 上。
 *
 * 这里显式补齐 `ownKeys` / `getOwnPropertyDescriptor`：既有代码存在
 * `{ ...baseServices, fileService: remote.fileService }` 这类展开式合并
 * （`packages/desktop/src/renderer/src/remoteWorkspaceSessionServices.ts`），
 * 若只拦 `get`，展开会按 base 的自有键取值，覆盖就会在展开那一刻悄悄丢失。
 */
function mergeCloudServiceScopes(
  hostAccessor: IServiceAccessor,
  executionAccessor: IServiceAccessor,
): IServiceAccessor {
  const hostKeys = Reflect.ownKeys(hostAccessor).filter(
    (key): key is string => typeof key === "string",
  );
  const mergedKeys = [...new Set([...hostKeys, ...EXECUTION_ACCESSOR_KEYS])];

  return new Proxy(hostAccessor, {
    get(target, property, receiver) {
      if (isExecutionAccessorKey(property)) {
        return Reflect.get(executionAccessor, property, executionAccessor);
      }
      return Reflect.get(target, property, receiver);
    },
    has(target, property) {
      return isExecutionAccessorKey(property) || Reflect.has(target, property);
    },
    ownKeys() {
      return mergedKeys;
    },
    getOwnPropertyDescriptor(target, property) {
      if (isExecutionAccessorKey(property)) {
        return {
          value: Reflect.get(executionAccessor, property, executionAccessor),
          writable: false,
          enumerable: true,
          configurable: true,
        };
      }
      const descriptor = Reflect.getOwnPropertyDescriptor(target, property);
      // 代理不变量：ownKeys 报出的键必须能被描述符查询到且 configurable。
      if (descriptor) {
        return { ...descriptor, configurable: true };
      }
      return {
        value: Reflect.get(target, property, target),
        writable: false,
        enumerable: true,
        configurable: true,
      };
    },
  }) as IServiceAccessor;
}

/**
 * attachment 通道的重连感知面（specs/cloud-agent/07 §9、04 §3.3）。
 *
 * `CloudAttachClient`（packages/client）结构性提供 `onDidChangeState`；按「UI 不 import
 * SDK」的边界，这里只做结构探测，不引入对 SDK 具体类型的依赖。没有该面的实现
 * （测试替身 / 未来实现）返回 null，包装退化为原行为。
 */
interface ReconnectAwareAttachmentChannel {
  onDidChangeState?(
    listener: (change: { readonly state: string }) => void,
  ): { readonly dispose: () => void } | void;
}

type AgentRuntimeLifecycleState = "available" | "unavailable";

interface AttachmentReconnectHub {
  /**
   * 注册一个「重连边沿重挂」闭包：断连与重连边沿都会被调用（闭包内部先释放旧
   * 注册再按当前连接状态重挂；未连接时底层 listen 返回空事件，等价安全退场）。
   * 返回解除登记函数。
   */
  onRebind(listener: () => void): () => void;
  /** 合成 runtime 生命周期信号：断连边沿 unavailable、重连成功边沿 available。 */
  onLifecycle(listener: (state: AgentRuntimeLifecycleState) => void): () => void;
}

/**
 * 会话面板「断连后订阅静默死亡」的根因修复点（2026-10-09 终验缺陷 C）：
 * `attach.getChannel().listen` 的裸事件注册绑定在**当次连接**上，bridge 断连
 * （如 frame-rejected 4001）时 ChannelClient 整体销毁，SDK 的自动重连只重建
 * `attach.subscribe()` 登记的订阅，经 `ProxyChannel.toService` 走裸 listen 的
 * 会话帧流（onDynamicConversationFrame）不重挂，控制面连接虽恢复（epoch 3→4），
 * 页面订阅再收不到任何帧。此 hub 在每个重连边沿统一重挂受管事件，并向前端
 * 施加合成 runtime 生命周期信号——ConversationProjectionStore 的
 * handleRuntimeUnavailable/handleRuntimeAvailable 状态机随即携原水位重订阅，
 * 新连接上的 initial snapshot 经重挂后的帧流收回（pending overlay 一并按权威投影收口）。
 */
function createAttachmentReconnectHub(
  channelClient: ReconnectAwareAttachmentChannel,
): AttachmentReconnectHub | null {
  const onDidChangeState = channelClient.onDidChangeState;
  if (typeof onDidChangeState !== "function") {
    return null;
  }
  const rebinds = new Set<() => void>();
  const lifecycleListeners = new Set<(state: AgentRuntimeLifecycleState) => void>();
  // 执行域服务在 attach.connect() 成功之后构建，初始即视为已连接；首个观察到的
  // 非连接态就是断连边沿。
  let connected = true;
  const dispose = onDidChangeState.call(channelClient, (change) => {
    const isConnected = change?.state === "connected";
    if (isConnected === connected) {
      return;
    }
    connected = isConnected;
    // 两个边沿统一重挂：断连边沿重挂会落到空事件（未连接不可listen），即安全退场；
    // 重连边沿重挂到新连接，随后才广播 available，保证 store 重订阅发出的
    // initial snapshot 有帧流可落。
    for (const rebind of rebinds) {
      rebind();
    }
    const state: AgentRuntimeLifecycleState = isConnected ? "available" : "unavailable";
    for (const listener of lifecycleListeners) {
      listener(state);
    }
  });
  void dispose;
  return {
    onRebind(listener) {
      rebinds.add(listener);
      return () => {
        rebinds.delete(listener);
      };
    },
    onLifecycle(listener) {
      lifecycleListeners.add(listener);
      return () => {
        lifecycleListeners.delete(listener);
      };
    },
  };
}

/** 事件 Disposable 的最小结构面（rpc 的 IDisposable / 普通函数返回值都满足）。 */
interface EventSubscription {
  dispose(): void;
}

function toEventSubscription(disposable: unknown): EventSubscription {
  if (typeof disposable === "function") {
    return { dispose: disposable as () => void };
  }
  return (disposable as EventSubscription) ?? { dispose: () => {} };
}

/**
 * 云 attachment 的 agent 通道不做 clientHello（`initializeConversationV4`）绑定。
 *
 * 事实链（实测 + `zcodeAgentConnectionScope.ts` / supervisor relay 源码）：
 * - 沙箱 runtime 把 agent 通道经 **一条** stdio 连接暴露给 supervisor
 *   （`stdio.ts`：`role: "trusted-host-relay"`），supervisor 再把**所有**浏览器 RPC 流
 *   复用到这同一条连接上（`rpcRelay`：`localRpc.channel(...)` 单例）。
 * - 该共享 scope 上 `initializeConversationV4` 是 first-wins：第一个握手的浏览器把自己的
 *   clientId 绑上去（`boundClientId`），之后任何**其他** clientId 都被
 *   `fault.connection.clientChanged` 永久拒绝（清理只发生在 scope dispose，即沙箱重启）。
 *   每次无头探针都是全新 profile（新 `client-<uuid>`），于是稳定复现。
 * - relay 角色下 scope 的 `handshakeComplete` 初始即为 true（订阅只需 `assertReady`，
 *   不校验 `boundClientId`），且 command 归属校验只在 `terminal-client` 角色生效——
 *   也就是说 clientHello 在这条链路上**既不必要也容不下第二个浏览器**。
 * - 云任务的输入提交走控制面 inputs API（03 §6），不经 agent command 通道，
 *   跳过绑定不影响任何写入路径。
 *
 * 因此这里把 clientHello 就地吸收为 no-op：握手只剩 hello（拿 clientMode/能力声明），
 * 订阅/快照/命令照常工作。桌面 / 本地 web / 手机远控的直连 scope 不经过本包装，语义不变。
 *
 * 2026-10-09 缺陷 C 修订：事件面接入重连 hub——会话帧流（`onDynamic*`）与 runtime
 * 生命周期/换代事件在断连后由 hub 统一重挂到新连接；`onAgentRuntimeLifecycle` 额外
 * 合成断连/重连边沿，让 v4 投影 store 的既有 runtime 状态机驱动重订阅（保留回放水位）。
 */
function createCloudAttachmentAgentService(
  channelClient: CloudAttachmentAccessor["channelClient"],
  taskId: string,
): IZCodeAgentService {
  const service = ProxyChannel.toService<IZCodeAgentService>(
    channelClient.getChannel(ServiceChannels.ZCodeAgent),
  );
  // CloudAttachClient 在 IChannelClient 之外结构性携带 onDidChangeState（packages/client）；
  // UI 不 import SDK，按结构面探测，缺失时退化为原行为。
  const hub = createAttachmentReconnectHub(channelClient as ReconnectAwareAttachmentChannel);
  if (hub === null) {
    return new Proxy(service, {
      get(target, property, receiver) {
        if (property === "initializeConversationV4") {
          return async () => {};
        }
        return Reflect.get(target, property, receiver);
      },
    });
  }
  /** 重挂式事件：每次订阅/重连边沿都向**当前连接**重新取底层事件再挂监听。 */
  const resilientEvent = <T>(underlying: () => Event<T>): Event<T> => {
    return (listener: (event: T) => void) => {
      let subscription: EventSubscription | undefined;
      const rebind = () => {
        subscription?.dispose();
        subscription = toEventSubscription(underlying()(listener));
      };
      rebind();
      const offRebind = hub.onRebind(rebind);
      return {
        dispose: () => {
          offRebind();
          subscription?.dispose();
          subscription = undefined;
        },
      };
    };
  };
  return new Proxy(service, {
    get(target, property, receiver) {
      if (property === "initializeConversationV4") {
        return async () => {};
      }
      if (typeof property === "string") {
        if (property.startsWith("onDynamic")) {
          // 动态事件带参（workspace 描述）：每次重挂都重新取属性再传参，
          // 底层 toService 会调用当次连接的 channel.listen。
          return (arg: unknown): Event<unknown> =>
            resilientEvent(() => {
              const dynamicEvent = Reflect.get(target, property, receiver) as (
                a: unknown,
              ) => Event<unknown>;
              return dynamicEvent(arg);
            });
        }
        if (property === "onAgentRuntimeLifecycle" || property === "onAgentRuntimeRestarted") {
          // 合成边沿必须携带 transport 的 workspaceKey（= workspaceIdentity，08 §4.1）：
          // agentConversationTransport 的生命周期/换代监听按它过滤，缺失会被当作
          // 「别的 workspace」丢弃。
          const syntheticWorkspaceKey = buildCloudTaskWorkspaceIdentity(taskId);
          return (listener: (event: unknown) => void): EventSubscription => {
            let inner: EventSubscription | undefined;
            const lifecycleOff =
              property === "onAgentRuntimeLifecycle"
                ? hub.onLifecycle((state) => {
                    // 合成边沿：断连 unavailable / 重连 available。底层真实事件仍并行转发，
                    // 两路不同源——合成边沿只出现在连接换代时刻，不会与 runtime 进程
                    // 生命周期事件重复。
                    listener({ workspaceKey: syntheticWorkspaceKey, state });
                  })
                : undefined;
            inner = toEventSubscription(
              resilientEvent(() => {
                const plainEvent = Reflect.get(target, property, receiver) as Event<unknown>;
                return plainEvent;
              })(listener),
            );
            return {
              dispose: () => {
                lifecycleOff?.();
                inner?.dispose();
                inner = undefined;
              },
            };
          };
        }
      }
      return Reflect.get(target, property, receiver);
    },
  }) as IZCodeAgentService;
}

function createAttachmentExecutionServices(attachment: CloudAttachmentAccessor): IServiceAccessor {
  const { channelClient } = attachment;
  // 逐字段显式取 channel：channel 名统一来自 shared 的 ServiceChannels 常量
  // （CONTRACT「白名单」段禁止任何一端硬编码 channel 字符串）。
  return {
    fileService: ProxyChannel.toService<IFileService>(
      channelClient.getChannel(CLOUD_EXECUTION_SERVICE_BINDINGS[0].channel),
    ),
    fileWatcherService: ProxyChannel.toService<IFileWatcherService>(
      channelClient.getChannel(CLOUD_EXECUTION_SERVICE_BINDINGS[1].channel),
    ),
    mediaPreviewService: ProxyChannel.toService<IMediaPreviewService>(
      channelClient.getChannel(CLOUD_EXECUTION_SERVICE_BINDINGS[2].channel),
    ),
    gitService: ProxyChannel.toService<IGitService>(
      channelClient.getChannel(CLOUD_EXECUTION_SERVICE_BINDINGS[3].channel),
    ),
    gitCheckpointService: ProxyChannel.toService<IGitCheckpointService>(
      channelClient.getChannel(CLOUD_EXECUTION_SERVICE_BINDINGS[4].channel),
    ),
    systemService: ProxyChannel.toService<ISystemService>(
      channelClient.getChannel(CLOUD_EXECUTION_SERVICE_BINDINGS[5].channel),
    ),
    terminalService: ProxyChannel.toService<ITerminalService>(
      channelClient.getChannel(CLOUD_EXECUTION_SERVICE_BINDINGS[6].channel),
    ),
    zcodeAgentService: createCloudAttachmentAgentService(channelClient, attachment.taskId),
    zcodeSessionService: ProxyChannel.toService<IZCodeSessionService>(
      channelClient.getChannel(CLOUD_EXECUTION_SERVICE_BINDINGS[8].channel),
    ),
  } as IServiceAccessor;
}

/** 合成云浏览器 accessor。 */
export function createCloudBrowserServices(
  options: CloudBrowserServicesOptions,
): CloudBrowserServices {
  assertCloudExecutionBindingsMatchAllowlist();

  const { hostAccessor, attachment } = options;
  const executionScope: CloudExecutionScope = attachment ? "attachment-ready" : "unavailable";
  // 无 attachment：执行域整体换成显式不可用面。账号域与模型目录仍来自 host，
  // 因此 draft 期登录、套餐、模型设置页照常可用（12 §5）。
  const executionAccessor = attachment
    ? createAttachmentExecutionServices(attachment)
    : getCloudAttachmentUnavailableServices(options.unavailableReason);

  return {
    services: mergeCloudServiceScopes(hostAccessor, executionAccessor),
    executionScope,
    hostTargets: describeCloudHostTargets(),
    executionTargets: describeCloudExecutionTargets(),
  };
}

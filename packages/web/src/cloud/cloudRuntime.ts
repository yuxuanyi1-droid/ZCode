/**
 * 云模式启动编排（specs/cloud-agent/modules/W9 §3/§4；12 §4/§5；03 §7.1；04 §2/§4）。
 *
 * 与 React 解耦：连接器、客户端工厂、能力探测都可注入，测试可以断言
 * 「账号域打到 host `/ws`」「base = host accessor」而无需渲染原 `Root`。
 *
 * 三条硬边界（任一不满足都停在失败面，绝不回落本机）：
 * 1) origin 只用来构造同源地址，不指向开发机 / 本机 workspace bootstrap（04 §2/§6）；
 * 2) 能力与模式只读 `/api/cloud/capabilities`（W5 决议：`/api/server-info` 把
 *    `desktopContinuous` 冻结为 literal true，云入口故意不挂它）；
 * 3) 无 W8 组合时不渲染半套 UI，返回 `ui-unavailable`。
 */
import {
  createCloudClient,
  connectViaWebSocket,
  type CloudClient,
  type CreateCloudClientOptions,
} from "@zcode/client";
import type { CapabilitiesResponse } from "@zcode/shared";
import {
  buildCloudHostChannelUrl,
  classifyCapabilitiesMismatch,
  classifyCloudBootError,
  createCloudBootFailure,
  type CloudBootFailure,
  type CloudEntryPlan,
} from "./cloudBoot.js";
import { createCloudAttachmentProvider } from "./cloudAttachment.js";
import type {
  CloudAttachmentProviderLike,
  CloudUiBootstrapInput,
  CloudUiComposition,
  HostServiceAccessor,
} from "./cloudUi.js";

export interface CloudHostChannelConnection {
  readonly accessor: HostServiceAccessor;
  /** 关闭底层连接；重试/卸载时调用，避免留下不再使用的 host 通道。 */
  readonly close: () => void;
}

export type CloudHostChannelConnector = (wsUrl: string) => Promise<CloudHostChannelConnection>;

/** 默认连接 host 本体 `/ws`（12 §4：与 web 模式同款连接，凭据走 cookie）。 */
const openDefaultHostChannel: CloudHostChannelConnector = async (wsUrl) => {
  let socket: WebSocket | null = null;
  const accessor = await connectViaWebSocket(wsUrl, {
    onOpenSocket: (opened) => {
      socket = opened;
    },
  });
  return {
    accessor,
    close: () => socket?.close(),
  };
};

export interface CloudRuntimeDependencies {
  /** W8 的服务/provider 组合（生产实现见 `cloudUiComposition.ts`）。 */
  readonly ui: CloudUiComposition;
  readonly connectHostChannel?: CloudHostChannelConnector | undefined;
  readonly createClient?: ((options: CreateCloudClientOptions) => CloudClient) | undefined;
}

export interface CloudRuntime {
  readonly origin: string;
  readonly client: CloudClient;
  readonly capabilities: CapabilitiesResponse;
  /** 客户端确认信息（主体 + 控制面 origin + taskId）；来源见 `resolveCloudUiBootstrap`。 */
  readonly bootstrap: CloudUiBootstrapInput;
  /** host 本体访问面（账号域唯一来源）——UI 组合的 base accessor。 */
  readonly hostAccessor: HostServiceAccessor;
  /** 当前 Run attachment 提供方：执行域由它覆盖（无 run 时 UI 回落 unavailable）。 */
  readonly attachmentProvider: CloudAttachmentProviderLike;
  readonly dispose: () => void;
}

export type CloudRuntimeResult =
  | { readonly ok: true; readonly runtime: CloudRuntime }
  | { readonly ok: false; readonly failure: CloudBootFailure };

/**
 * 启动顺序固定为 客户端 → 能力/模式 → host `/ws` → UI 组合：
 * 前面的失败必须优先暴露（认证/版本问题不能被「UI 未装配」掩盖），且每一步失败都不产生
 * 本机回落路径（04 §2、04 §8 阶段与回退）。
 */
export async function bootstrapCloudRuntime(
  plan: CloudEntryPlan,
  dependencies: CloudRuntimeDependencies,
): Promise<CloudRuntimeResult> {
  const createClient = dependencies.createClient ?? createCloudClient;
  let client: CloudClient;
  try {
    client = createClient({
      origin: plan.origin,
      // 浏览器一直用同源 cookie 主体认证（03 §3「默认浏览器 cookie」）：lite-token 由服务端
      // 下发为 HttpOnly cookie，浏览器不持有 token 正文（12 §5）。
      auth: { mode: "cookie" },
      ...(plan.taskId === undefined ? {} : { taskId: plan.taskId }),
    });
  } catch {
    // SDK 对非法 origin 抛配置错误：这是入口/部署问题，不进入探测阶段，也不回落本机。
    return { ok: false, failure: createCloudBootFailure("not-configured") };
  }

  let capabilities: CapabilitiesResponse;
  try {
    capabilities = await client.controlPlane.getCapabilities();
  } catch (error) {
    // 协议版本不兼容由 SDK 的 getCapabilities 判定（00 §8）；这里只做归一，不解析文案。
    return {
      ok: false,
      failure: classifyCloudBootError(error, { tokenProvided: plan.token !== undefined }),
    };
  }
  // 云启动流程要求能力响应确为 cloud（04 §2.1：探测已经把本地分流走；这里再对账一次，
  // 模式不符按 not-configured 失败，不把本地答案当云能力继续用）。
  const mismatch = classifyCapabilitiesMismatch(capabilities, { expectedMode: "cloud" });
  if (mismatch) {
    return { ok: false, failure: mismatch };
  }

  const connectHostChannel = dependencies.connectHostChannel ?? openDefaultHostChannel;
  let connection: CloudHostChannelConnection;
  try {
    connection = await connectHostChannel(buildCloudHostChannelUrl(plan.origin));
  } catch {
    // WS 握手失败在浏览器里拿不到状态码；不猜测具体原因，也不改用本机 workspace bootstrap。
    return { ok: false, failure: createCloudBootFailure("host-channel-unavailable") };
  }

  const ui = dependencies.ui;
  // 会话路由 = 运行时同源 origin + 主路由 taskId（主体由 W8 从 capabilities 读取）。
  const bootstrap = ui.createBootstrap({
    controlPlaneOrigin: plan.origin,
    ...(plan.taskId === undefined ? {} : { taskId: plan.taskId }),
  });
  if (bootstrap === null) {
    connection.close();
    return { ok: false, failure: createCloudBootFailure("bootstrap-unavailable") };
  }

  const attachmentProvider = createCloudAttachmentProvider({
    origin: plan.origin,
    ...(dependencies.createClient === undefined ? {} : { createClient: dependencies.createClient }),
  });

  let disposed = false;
  return {
    ok: true,
    runtime: {
      origin: plan.origin,
      client,
      capabilities,
      bootstrap,
      hostAccessor: connection.accessor,
      attachmentProvider,
      dispose: () => {
        if (disposed) {
          return;
        }
        disposed = true;
        connection.close();
        client.attach.close();
      },
    },
  };
}

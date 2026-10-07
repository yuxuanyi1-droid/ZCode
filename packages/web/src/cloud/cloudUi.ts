/**
 * W9 → W8 的接缝类型（specs/cloud-agent/modules/W9 §3/§4；W8 §4「对外接口」）。
 *
 * 本文件只声明**入口交给 UI 的事实**，不 import `@zcode/ui`：`cloudRuntime.ts` 的运行期
 * 依赖要能在 node 下测试（不加载 React/组件树）。真正接线在 `cloudUiComposition.ts` 一处。
 *
 * 组合形状对齐 W8 已冻结的公开入口：
 * `CloudWorkspaceProvider({ bootstrap, controlPlane, hostAccessor, attachmentProvider, children })`
 * + `parseCloudUiBootstrap`（`packages/ui/src/cloud/cloudUiBootstrap.ts`）。
 */
import type { CloudClient, connectViaWebSocket } from "@zcode/client";
import type { ComponentType, ReactNode } from "react";

/**
 * host `/ws` 服务访问面。从客户端公开入口推导，而不是 import `@zcode/services`：
 * web 包的 dependencies 不声明该包，深导入会破坏跨包边界（AGENTS「跨包导入使用公开入口」）。
 */
export type HostServiceAccessor = Awaited<ReturnType<typeof connectViaWebSocket>>;

/** W8 `CloudAttachmentAccessor`（`cloudBrowserServices.ts`）的入口侧结构描述。 */
export interface CloudAttachmentAccessorLike {
  readonly taskId: string;
  /** SDK 的 `CloudAttachClient` 本身就是 `IChannelClient`，直接满足 W8 的 `channelClient`。 */
  readonly channelClient: CloudClient["attach"];
}

/** W8 `CloudAttachmentProvider`（`cloudAttachmentProvider.ts`）：UI 与 attachment 传输的唯一接缝。 */
export interface CloudAttachmentProviderLike {
  /** 无可 attach 的 run 时返回 null（不是错误，执行域保持 unavailable）。 */
  open(taskId: string): Promise<CloudAttachmentAccessorLike | null>;
  /** 只做本地释放，不向沙箱发送停止指令（04 §3.0.1）。 */
  close(taskId: string): void;
  onDidChange?(listener: () => void): () => void;
}

/**
 * W8 `CloudUiBootstrap`（`cloudUiBootstrap.ts`）的入口侧结构描述。
 *
 * 主体**不在**这里：`principalId` 由 W8 控制器从 `capabilities` 读取
 * （`readCloudPrincipalId`），入口只给控制面 origin 与主路由 taskId（04 §3.4.1）。
 */
export interface CloudUiBootstrapInput {
  readonly controlPlaneOrigin: string;
  readonly taskId?: string | undefined;
}

/** bootstrap 的构造输入：运行时同源 origin + 主路由 `?task=`（04 §5）。 */
export interface CloudUiBootstrapSource {
  readonly controlPlaneOrigin: string;
  readonly taskId?: string | undefined;
}

export interface CloudUiWorkspaceInputs {
  readonly bootstrap: CloudUiBootstrapInput;
  /** SDK 的 `createCloudClient(...).controlPlane` 与 W8 的 `CloudControlPlanePort` 结构一致。 */
  readonly controlPlane: CloudClient["controlPlane"];
  readonly hostAccessor: HostServiceAccessor;
  readonly attachmentProvider: CloudAttachmentProviderLike;
}

export interface CloudUiComposition {
  /**
   * 严格构造会话路由（fail-closed）：构造不出来就返回 null，由启动流程给出
   * `bootstrap-unavailable` 失败面——不猜、不用假身份顶替（08 §4.1）。
   */
  createBootstrap(source: CloudUiBootstrapSource): CloudUiBootstrapInput | null;
  /** 原 `Root` 外层的云工作区/provider 组合；它不渲染布局，只注入作用域（W8 §4）。 */
  readonly WorkspaceProvider: ComponentType<
    CloudUiWorkspaceInputs & { readonly children: ReactNode }
  >;
}

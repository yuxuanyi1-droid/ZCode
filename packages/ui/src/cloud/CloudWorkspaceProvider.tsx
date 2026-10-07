/**
 * `CloudWorkspaceProvider` —— 云模式的顶层接缝（specs/cloud-agent/W8 §4）。
 *
 * W9 的 `cloudApp.tsx` 只需包一层它，然后把 `createCloudBrowserServices(...)` 的
 * 结果（或 provider 下的 `useServices()`）传给原 `Root`：
 *
 * ```tsx
 * <CloudWorkspaceProvider bootstrap={...} controlPlane={client.controlPlane}
 *                         hostAccessor={hostAccessor} attachmentProvider={...}>
 *   <Root services={hostAccessor} platform={platform} />
 * </CloudWorkspaceProvider>
 * ```
 *
 * **它不是外壳**：不渲染任何布局、不提前 return 替代页面、不接管路由分支。
 * 原 `Root` / `RootWorkspaceContent` / `App` / `WorkspaceShellLayout` 仍是唯一渲染路径
 * （04 §3.0/§3.0.1）。
 */
import type { ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import type { CloudAttachmentProvider } from "./cloudAttachmentProvider.js";
import type { CloudControlPlanePort } from "./cloudPorts.js";
import type { CloudUiBootstrap } from "./cloudUiBootstrap.js";
import { CloudWorkspaceContextProvider } from "./cloudWorkspaceContext.js";
import { CloudServicesProvider } from "./CloudServicesProvider.js";
import { useCloudWorkspaceController } from "@/hooks/cloud/useCloudWorkspaceController.js";

export interface CloudWorkspaceProviderProps {
  readonly bootstrap: CloudUiBootstrap;
  /** W9 用 `createCloudClient(...).controlPlane` 注入；未配置时传 null。 */
  readonly controlPlane: CloudControlPlanePort | null;
  /** host `/ws` 的 accessor（同 web 模式的连接方式）。 */
  readonly hostAccessor: IServiceAccessor;
  /** 当前 Run attachment 的提供方；缺省表示不做执行域覆盖。 */
  readonly attachmentProvider?: CloudAttachmentProvider | null;
  /**
   * 用户切换任务时回写稳定路由（04 §5 主路由 `/?task=<taskId>`）。
   *
   * 只在界面上真实发生的切换（侧栏选中任务等）触发；入口从路由读到的 taskId 请走
   * `bootstrap.taskId`，不要把路由回灌接到这里，否则会和入口的写入形成回环。
   * 未提供时回落到 UI 自带的 `openCloudTaskRoute`。
   */
  readonly onNavigateTask?: ((taskId: string | null) => void) | undefined;
  readonly children: ReactNode;
}

export function CloudWorkspaceProvider({
  bootstrap,
  controlPlane,
  hostAccessor,
  attachmentProvider,
  onNavigateTask,
  children,
}: CloudWorkspaceProviderProps) {
  const controller = useCloudWorkspaceController({
    bootstrap,
    controlPlane,
    hostAccessor,
    attachmentProvider: attachmentProvider ?? null,
    onNavigateTask,
  });

  return (
    <CloudWorkspaceContextProvider value={controller}>
      <CloudServicesProvider hostAccessor={hostAccessor} attachment={controller.attachment}>
        {children}
      </CloudServicesProvider>
    </CloudWorkspaceContextProvider>
  );
}

/**
 * 云服务作用域 Provider（specs/cloud-agent/W8 §4）。
 *
 * 它同时做两件事，且只做这两件：
 * 1. 用 `createCloudBrowserServices` 合成 accessor，并通过既有 `ServiceProvider`
 *    注入 —— 原组件的 `useServices()` 因此拿到**已经定好作用域**的服务，
 *    组件里不需要任何 `isCloud` 分支。
 * 2. 把执行域状态（`attachment-ready` / `unavailable`）与服务目标描述放在
 *    context 上，供能力门控与证据断言读取。
 *
 * 账号域**不在**这里做任何覆盖：登录/套餐/模型目录就是 host base 提供的既有服务
 * （12 §5）。
 */
import { createContext, useContext, useMemo, type ReactNode } from "react";
import type { IServiceAccessor } from "@zcode/services";
import { ServiceProvider } from "@/hooks/useServices.js";
import type { CloudAttachmentAccessor } from "./cloudBrowserServices.js";
import { createCloudBrowserServices } from "./cloudBrowserServices.js";
import type { CloudExecutionScope, CloudServiceTargetDescriptor } from "./cloudServiceScope.js";

export interface CloudServicesScopeValue {
  readonly executionScope: CloudExecutionScope;
  readonly hostTargets: readonly CloudServiceTargetDescriptor[];
  readonly executionTargets: readonly CloudServiceTargetDescriptor[];
  /** 当前 attachment 归属的 taskId；null 表示执行域不可用（不是「空数据」）。 */
  readonly attachmentTaskId: string | null;
}

const CloudServicesScopeContext = createContext<CloudServicesScopeValue | null>(null);

export interface CloudServicesProviderProps {
  /** host `/ws` 的 accessor：base，承载账号域与模型目录。 */
  readonly hostAccessor: IServiceAccessor;
  /**
   * 当前 Run attachment。`undefined` / `null` 都表示尚无 ready attachment，
   * 执行域整体回落 `attachment_unavailable`（不回落本机执行域）。
   */
  readonly attachment?: CloudAttachmentAccessor | null;
  readonly unavailableReason?: string;
  readonly children: ReactNode;
}

export function CloudServicesProvider({
  hostAccessor,
  attachment,
  unavailableReason,
  children,
}: CloudServicesProviderProps) {
  const composed = useMemo(
    () =>
      createCloudBrowserServices({
        hostAccessor,
        attachment: attachment ?? null,
        ...(unavailableReason === undefined ? {} : { unavailableReason }),
      }),
    [hostAccessor, attachment, unavailableReason],
  );

  const scopeValue = useMemo<CloudServicesScopeValue>(
    () => ({
      executionScope: composed.executionScope,
      hostTargets: composed.hostTargets,
      executionTargets: composed.executionTargets,
      attachmentTaskId: attachment ? attachment.taskId : null,
    }),
    [composed, attachment],
  );

  return (
    <CloudServicesScopeContext.Provider value={scopeValue}>
      <ServiceProvider services={composed.services}>{children}</ServiceProvider>
    </CloudServicesScopeContext.Provider>
  );
}

/**
 * 读取云服务作用域元数据；非云模式下返回 null（调用方按「没有云作用域」处理，
 * 而不是造一个假的 ready）。
 */
export function useCloudServicesScope(): CloudServicesScopeValue | null {
  return useContext(CloudServicesScopeContext);
}

/**
 * 执行域是否可用。
 *
 * 这是 UI 侧能力门控的**唯一判据**：文件/Git/终端/会话相关的入口一律读它，
 * 不再各自检查 taskId、run 状态或连接态（避免 04 §3.0 说的「在多个组件里长出分支判断」）。
 */
export function useCloudExecutionScope(): CloudExecutionScope | null {
  return useCloudServicesScope()?.executionScope ?? null;
}

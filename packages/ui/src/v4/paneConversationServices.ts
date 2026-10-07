/**
 * pane 数据面的 services 选择规则（specs/cloud-agent/W8 §3、04 §3.0/§4；v4 分屏宿主）。
 *
 * 两种作用域，判定必须分开：
 * - **云任务工作区**（identity = `cloud-task:<taskId>`）：服务由 `CloudWorkspaceProvider`
 *   合成 —— host base + 当前 Run attachment，判定在 `useCloudWorkspaceServices` 一处。
 *   云任务**没有、也不会有** remote session 登记，因此不能再要求通用解析的 `rpcReady`：
 *   按通用解析它会永远停在 `remote-waiting`，pane 直接不挂数据层（表现为右侧空白）。
 * - **本地 / SSH / 已配对手机远控**：沿用原判定 —— remote services 尚未注册时保持
 *   `remote-waiting`（`rpcReady=false`），不挂数据层、不回落 base services（远控保护约束）。
 *
 * 纯函数：不持有状态、不做 IO，仅把上面两条规则收成一处，便于直接覆盖。
 */
import type { IServiceAccessor } from "@zcode/services";

export interface V4PaneWorkspaceServicesResolution {
  readonly rpcReady: boolean;
  readonly services: IServiceAccessor;
  /** 诊断字段：`remote-waiting` 表示远端 services 尚未注册。 */
  readonly connectionKind: "local-ready" | "remote-waiting" | "remote-ready";
}

export interface ResolveV4PaneConversationServicesParams {
  /** `useCloudWorkspaceServices(identity)` 的结果；非云身份为 null。 */
  readonly cloudServices: IServiceAccessor | null;
  readonly resolution: V4PaneWorkspaceServicesResolution;
}

/** 返回 pane 数据层要用的 accessor；null 表示当前不挂数据层（保持原 fail-closed 语义）。 */
export function resolveV4PaneConversationServices(
  params: ResolveV4PaneConversationServicesParams,
): IServiceAccessor | null {
  if (params.cloudServices) {
    return params.cloudServices;
  }
  return params.resolution.rpcReady ? params.resolution.services : null;
}

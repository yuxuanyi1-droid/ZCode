/**
 * CloudWorkspace context（specs/cloud-agent/04 §3.0.1）。
 *
 * 这里**只携带控制面选择与当前 Run 路由**：选中的 Project/Task、稳定草稿 scope、
 * 控制面端口、能力投影。它不携带替代页面、不携带 workspace shell，也不复制
 * Task/Run 权威状态——原 `Root` / `App` / `WorkspaceShellLayout` 仍是唯一渲染路径。
 */
import { createContext, useContext } from "react";
import type { CapabilitiesResponse, CloudErrorCode, TaskDetailResponse } from "@zcode/shared";
import type { IServiceAccessor } from "@zcode/services";
import type { CloudAttachmentAccessor } from "./cloudBrowserServices.js";
import type { CloudControlPlanePort } from "./cloudPorts.js";
import type { CloudDraftScope } from "./cloudDraftScope.js";

export interface CloudWorkspaceSelection {
  readonly principalId: string | null;
  /** 已归一的控制面 origin；空字符串表示还未配置。 */
  readonly controlPlaneOrigin: string;
  readonly projectId: string | null;
  readonly taskId: string | null;
  /** principal + controlPlaneOrigin + taskId 的稳定键；未选任务时为 null。 */
  readonly draftScope: CloudDraftScope | null;
}

/** 能力投影状态：`ready` 之前不做任何执行类动作（fail-closed）。 */
export type CloudCapabilitiesStatus = "idle" | "loading" | "ready" | "error";

export interface CloudWorkspaceContextValue {
  readonly selection: CloudWorkspaceSelection;
  /** W9 注入的控制面端口；未配置时为 null。 */
  readonly controlPlane: CloudControlPlanePort | null;
  /**
   * host `/ws` 的 base accessor：账号域与模型目录的来源。
   * 工作区级作用域（`useCloudWorkspaceServices`）需要它来为**非当前选中**的
   * cloud-task 工作区合成一个执行域不可用的 accessor。
   */
  readonly hostAccessor: IServiceAccessor | null;
  /** 当前选中 Task 的 attachment；为 null 表示执行域不可用。 */
  readonly attachment: CloudAttachmentAccessor | null;
  readonly capabilities: CapabilitiesResponse | null;
  readonly capabilitiesStatus: CloudCapabilitiesStatus;
  readonly capabilitiesError: string | null;
  /** 当前 Task 的详情投影（task + activeRun + execution + checkpoint + artifact）。 */
  readonly taskDetail: TaskDetailResponse | null;
  readonly taskDetailStatus: CloudCapabilitiesStatus;
  readonly taskDetailError: string | null;
  /**
   * 详情加载失败的结构化错误码（2026-10-08 巡检修订）：`not_found` 表示主路由任务
   * 不存在，入口据此渲染 task-not-found 错误屏而不是回落欢迎页；文案投影见
   * `taskDetailError`。
   */
  readonly taskDetailErrorCode: CloudErrorCode | null;

  selectProject(projectId: string | null): void;
  selectTask(taskId: string | null): void;
  reloadCapabilities(): Promise<void>;
  reloadTask(taskId?: string): Promise<void>;
  /**
   * 请求对**当前选中的任务**启动一次有界 run 观察（04 §3.2.4「202 后等待环境」）：
   * 首发/reopen 被控制面持久接收（202/200）后调用，控制器按 2s 间隔、60s 上限
   * 静默刷新详情，run 可见且非 provisioning、或到达上限、或切换任务时停止。
   * 非云模式下 context 为 null，调用方直接跳过。
   */
  beginTaskRunWatch(): void;
}

const CloudWorkspaceContext = createContext<CloudWorkspaceContextValue | null>(null);

export const CloudWorkspaceContextProvider = CloudWorkspaceContext.Provider;

/** 读取云工作区上下文；非云模式返回 null。 */
export function useCloudWorkspaceContext(): CloudWorkspaceContextValue | null {
  return useContext(CloudWorkspaceContext);
}

/** 当前 Task 的稳定草稿 scope；没有选中 Task 时返回 null（调用方不得伪造 scope）。 */
export function useCloudDraftScope(): CloudDraftScope | null {
  return useContext(CloudWorkspaceContext)?.selection.draftScope ?? null;
}

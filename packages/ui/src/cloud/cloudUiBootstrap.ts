/**
 * 云 UI bootstrap（specs/cloud-agent/W8 §3、12 §4/§5、04 §5）。
 *
 * 只解析**客户端确认信息**：控制面 origin 与主路由上的 taskId。
 *
 * 这两样都**不在这里**：
 * - **主体标识**由控制面 `GET /api/cloud/capabilities` 返回，见 `cloudPrincipal.ts`；
 *   `ui-bootstrap` 的静态投影不再被浏览器消费（12 §5）。
 * - **模型目录**来自 host `/ws` 的账号域服务（`modelSelectionService` /
 *   `codingPlanSubscriptionService` / `oauthService`），UI 不自持目录副本。
 */
import { cloudTaskIdSchema, isCloudTaskWorkspaceIdentity } from "@zcode/shared";

/**
 * 控制面 origin 归一：绝对 http(s)、无路径/query/hash/凭据（与 SDK 的
 * `normalizeCloudOrigin` 同一规则）。
 *
 * 之所以在 UI 侧再写一次：`packages/ui` 不能依赖 `@zcode/client`（UI 不直连 SDK，
 * W8 §4 的注入方式是 W9 把已构造好的端口传进来），而草稿 scope 的稳定性
 * （04 §3.4.1）要求 origin 在拼 key 前已经归一。W9 传入的 origin 若已归一，
 * 这里是恒等变换；未归一时由本函数收口，不做静默容错。
 */
export function normalizeCloudControlPlaneOrigin(rawOrigin: string): string {
  let url: URL;
  try {
    url = new URL(rawOrigin);
  } catch {
    throw new CloudBootstrapError("controlPlaneOrigin", "expected absolute url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new CloudBootstrapError("controlPlaneOrigin", "expected http(s)");
  }
  const bareOrigin = url.pathname === "/" && !url.search && !url.hash;
  if (!bareOrigin || url.username || url.password) {
    throw new CloudBootstrapError(
      "controlPlaneOrigin",
      "must not contain path, query, hash or credentials",
    );
  }
  return url.origin;
}

export interface CloudUiBootstrap {
  /** 显式控制面 origin；云入口不回落开发机 / 本机 workspace bootstrap（04 §4）。 */
  readonly controlPlaneOrigin: string;
  /** 主路由 `?task=<taskId>` 指定的当前任务；缺省表示还没选任务。 */
  readonly taskId?: string;
}

/** bootstrap 解析失败时抛出的结构化错误，调用方按 code 分支而不是解析文案。 */
export class CloudBootstrapError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`invalid cloud ui bootstrap: ${field} (${reason})`);
    this.name = "CloudBootstrapError";
    this.field = field;
  }
}

function readRequiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CloudBootstrapError(field, "expected non-empty string");
  }
  return value.trim();
}

/**
 * 严格解析 bootstrap：未知字段与非法 taskId 一律拒绝（fail-closed），
 * 不按旧字段猜测解析，也不在解析失败时回落本机模式（04 §2）。
 */
export function parseCloudUiBootstrap(value: unknown): CloudUiBootstrap {
  if (!value || typeof value !== "object") {
    throw new CloudBootstrapError("bootstrap", "expected object");
  }
  const record = value as Record<string, unknown>;

  const expectedKeys = new Set(["controlPlaneOrigin", "taskId"]);
  for (const key of Object.keys(record)) {
    if (!expectedKeys.has(key)) {
      throw new CloudBootstrapError(key, "unknown field");
    }
  }

  const controlPlaneOrigin = readRequiredString(record.controlPlaneOrigin, "controlPlaneOrigin");

  let taskId: string | undefined;
  if (record.taskId !== undefined) {
    const parsed = cloudTaskIdSchema.safeParse(record.taskId);
    if (!parsed.success) {
      throw new CloudBootstrapError("taskId", "expected cloud task uuid");
    }
    taskId = parsed.data;
  }

  return {
    controlPlaneOrigin: normalizeCloudControlPlaneOrigin(controlPlaneOrigin),
    ...(taskId === undefined ? {} : { taskId }),
  };
}

// ── 主路由（04 §5）──
//
// 主路由固定 `/?task=<taskId>`：项目展开/选择不改身份（只改查询参数以外的 UI 选择），
// `?remote=<id>` 保留原本机 Web / 桌面远控语义，不自动导入 CloudTask。

export const CLOUD_TASK_ROUTE_PARAM = "task";

/** 从 location.search 读取当前 cloud taskId；非法 / 缺失返回 null（不抛，路由要能渲染错误态）。 */
export function readCloudTaskIdFromSearch(search: string): string | null {
  const params = new URLSearchParams(search);
  const raw = params.get(CLOUD_TASK_ROUTE_PARAM);
  if (raw === null) {
    return null;
  }
  const parsed = cloudTaskIdSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** 生成主路由 search（保留其它查询参数，不改动它们的语义）。 */
export function withCloudTaskSearch(search: string, taskId: string | null): string {
  const params = new URLSearchParams(search);
  if (taskId === null) {
    params.delete(CLOUD_TASK_ROUTE_PARAM);
  } else {
    params.set(CLOUD_TASK_ROUTE_PARAM, cloudTaskIdSchema.parse(taskId));
  }
  const rendered = params.toString();
  return rendered.length === 0 ? "" : `?${rendered}`;
}

/**
 * 解析工作区身份对应的 taskId。
 *
 * `workspaceIdentity = cloud-task:<taskId>`（08 §4.1），UI 只从身份取 taskId，
 * **不从身份反推执行路径**：真实 checkout 路径来自 run 元数据（04 §5）。
 */
export function resolveCloudTaskIdFromWorkspaceIdentity(
  workspaceIdentity: string | null | undefined,
): string | null {
  const identity = workspaceIdentity?.trim();
  if (!identity || !isCloudTaskWorkspaceIdentity(identity)) {
    return null;
  }
  return identity.slice("cloud-task:".length);
}

/**
 * 打开主路由指向某个 Cloud Task（04 §5：主路由 `/?task=<taskId>`）。
 *
 * 侧栏选中任务时只更新**路由**，由入口（W9 的 `cloudApp.tsx`）据此建立 / 切换工作区 tab。
 * 这里刻意不构造 workspacePath：云任务的执行路径来自 run 元数据，未 ready 时不得
 * 用任何占位路径诱发 IO（04 §3.4.1「未 ready 时不传伪 workspacePath 诱发 IO」）。
 *
 * 非浏览器环境（SSR / 单测）为 no-op：路由只是入口输入，不是云任务的唯一事实源。
 */
export function openCloudTaskRoute(
  taskId: string | null,
  options?: { readonly replace?: boolean },
): void {
  if (typeof window === "undefined" || typeof window.history?.pushState !== "function") {
    return;
  }
  let nextTaskId: string | null = null;
  if (taskId !== null) {
    const parsed = cloudTaskIdSchema.safeParse(taskId);
    if (!parsed.success) {
      // 非法 taskId 不写进 URL：宁可什么都不做，也不让脏身份进入路由。
      return;
    }
    nextTaskId = parsed.data;
  }
  const search = withCloudTaskSearch(window.location.search, nextTaskId);
  const href = `${window.location.pathname}${search}`;
  if (options?.replace === true) {
    window.history.replaceState(window.history.state, "", href);
    return;
  }
  window.history.pushState(window.history.state, "", href);
}

/**
 * Cloud 草稿 / 提交对账的稳定 scope（specs/cloud-agent/04 §3.2/§3.4/§3.4.1、11 §5）。
 *
 * 唯一键是 **principal + controlPlaneOrigin + taskId**：
 * - 不用 `runtimeSessionId` 当草稿身份，也不用临时 `workspacePath`——Run 换代
 *   （重开、换 provider、断连重连）时草稿归属不能漂移（04 §3.4.1）。
 * - 不用裸 `taskId`：跨主体/跨部署的 taskId 不保证唯一，且登出切主体必须清投影
 *   （04 §3.4.1「登出切主体清投影，attempt 按原主体隔离」）。
 * - 现 `__draft__` 哨兵仍可作为「scope 内没有 session」的标记，但不是 scope 本身。
 */

export interface CloudDraftScopeInput {
  readonly principalId: string;
  /** 已归一化的控制面 origin（`normalizeCloudControlPlaneOrigin` 的输出）。 */
  readonly controlPlaneOrigin: string;
  readonly taskId: string;
}

export interface CloudDraftScope {
  readonly principalId: string;
  readonly controlPlaneOrigin: string;
  readonly taskId: string;
  /** 稳定字符串键：持久化、缓存与请求关联统一用它。 */
  readonly key: string;
}

/** scope 键分隔符：origin 归一后不含 `|`，principal/taskId 是 uuid，因此键无歧义。 */
const CLOUD_DRAFT_SCOPE_SEPARATOR = "|";

export function buildCloudDraftScope(input: CloudDraftScopeInput): CloudDraftScope {
  const principalId = input.principalId.trim();
  const controlPlaneOrigin = input.controlPlaneOrigin.trim();
  const taskId = input.taskId.trim();
  if (!principalId || !controlPlaneOrigin || !taskId) {
    throw new Error("cloud draft scope requires principalId, controlPlaneOrigin and taskId");
  }
  return {
    principalId,
    controlPlaneOrigin,
    taskId,
    key: [principalId, controlPlaneOrigin, taskId].join(CLOUD_DRAFT_SCOPE_SEPARATOR),
  };
}

/**
 * 从稳定键还原 scope。解析失败返回 null：调用方必须丢弃这条本地记录，
 * 不能猜一个 scope 把别人的草稿挂上去（04 §3.4.1）。
 */
export function parseCloudDraftScopeKey(key: string): CloudDraftScope | null {
  const parts = key.split(CLOUD_DRAFT_SCOPE_SEPARATOR);
  if (parts.length !== 3) {
    return null;
  }
  const [principalId, controlPlaneOrigin, taskId] = parts;
  if (!principalId || !controlPlaneOrigin || !taskId) {
    return null;
  }
  return { principalId, controlPlaneOrigin, taskId, key };
}

/**
 * 两个 scope 是否是同一个草稿归属：只比稳定键。
 *
 * Runtime session 换代、provider 变化、workspacePath 变化都**不**改变结果
 * （04 §3.4.1；对照 04 §5「每次绑定校验 runId/runGeneration/connectionEpoch」——
 * 那是事件 stale 检测，不是草稿身份）。
 */
export function isSameCloudDraftScope(
  a: CloudDraftScope | null | undefined,
  b: CloudDraftScope | null | undefined,
): boolean {
  if (!a || !b) {
    return false;
  }
  return a.key === b.key;
}

/** 主体切换（登出/换账号）时用于清投影：同 key 前缀即同一主体的全部 scope。 */
export function cloudDraftScopePrincipalPrefix(principalId: string): string {
  return `${principalId}${CLOUD_DRAFT_SCOPE_SEPARATOR}`;
}

/**
 * 本地生成创建幂等键（Project / Task 的 `creationKey`）。
 *
 * 与 `commandId` 是不同一族：`commandId` 标识一条**输入命令**，`creationKey` 标识一次
 * **元数据创建**（03 §6 两处幂等键互不借用）。两者都由调用方生成并在重试时沿用。
 */
export function createCloudCreationKey(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  throw new Error("crypto.randomUUID is required to create a cloud creationKey");
}

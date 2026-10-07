/**
 * Cloud Task 身份契约（specs/cloud-agent/00 §5、02 §2 不变量 1、08 §4.1）。
 *
 * 仓库任务的稳定 `workspaceIdentity = cloud-task:<taskId>`：不编码 provider、
 * repo slug、path、runId 或 connectionEpoch。`workspacePath` 用于 IO/cwd/Git/
 * 展示，由 run 元数据单独传递；禁止从 identity 反推执行路径（02 §2 不变量 1）。
 *
 * 身份无法识别（含前缀但 taskId 非法）时必须拒绝或要求协议升级，不得回落本机
 * cwd（08 §4.1；`packages/shared/src/remote-workspace-identity.ts` 当前只解析
 * ssh/wsl/docker，cloud 前缀的接入属实现阶段，W0 只冻结形状）。
 */
import { z } from "zod";

export const CLOUD_TASK_IDENTITY_PREFIX = "cloud-task:" as const;

/**
 * taskId 由控制面生成（当前实现为 crypto.randomUUID()，见 03 §4 taskId 唯一）。
 * 只约束「服务端生成、不可拼读、固定形态」，不锁定 uuid 版本，避免将来切换
 * v7 时破坏已持久化身份。
 */
export const cloudTaskIdSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export type CloudTaskId = z.infer<typeof cloudTaskIdSchema>;

/** 服务端/客户端生成的 id 共用形态：runId、commandId、operationId、streamId 等。 */
export const cloudUuidSchema = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
export type CloudUuid = z.infer<typeof cloudUuidSchema>;

/** 仓库任务的 workspaceIdentity：前缀 + 合法 taskId。 */
export const cloudTaskWorkspaceIdentitySchema = z
  .string()
  .max(1024)
  .refine(
    (value) =>
      value.startsWith(CLOUD_TASK_IDENTITY_PREFIX) &&
      cloudTaskIdSchema.safeParse(value.slice(CLOUD_TASK_IDENTITY_PREFIX.length)).success,
    "cloud task workspaceIdentity must be cloud-task:<uuid>",
  );
export type CloudTaskWorkspaceIdentity = z.infer<typeof cloudTaskWorkspaceIdentitySchema>;

export interface ParsedCloudTaskWorkspaceIdentity {
  kind: "cloud-task";
  taskId: CloudTaskId;
}

/**
 * 统一构造 Cloud Task 的 workspaceIdentity。taskId 非法时抛错（服务端生成流程
 * 中的编程错误），禁止静默产出无法 round-trip 的身份。
 */
export function buildCloudTaskWorkspaceIdentity(taskId: string): CloudTaskWorkspaceIdentity {
  return cloudTaskWorkspaceIdentitySchema.parse(`${CLOUD_TASK_IDENTITY_PREFIX}${taskId}`);
}

/**
 * 解析 cloud-task 身份。返回 null 只表示「不是合法的 cloud-task 身份」，不代表
 * 可以回落本机路径——路径不在该身份中，调用方必须从 run 元数据取 workspacePath。
 */
export function parseCloudTaskWorkspaceIdentity(
  identity: string,
): ParsedCloudTaskWorkspaceIdentity | null {
  if (!identity.startsWith(CLOUD_TASK_IDENTITY_PREFIX)) return null;
  const taskId = cloudTaskIdSchema.safeParse(identity.slice(CLOUD_TASK_IDENTITY_PREFIX.length));
  if (!taskId.success) return null;
  return { kind: "cloud-task", taskId: taskId.data };
}

export function isCloudTaskWorkspaceIdentity(identity: string): boolean {
  return parseCloudTaskWorkspaceIdentity(identity) !== null;
}

/**
 * 身份 key 的统一取值（AGENTS「Workspace Identity」；00 §5 保留既有本地 fallback）：
 * `workspaceIdentity?.trim() || workspacePath`。用于去重、绑定、缓存、队列、
 * 持久化与请求关联；云任务上两者同时传递，不互相推导。
 */
export function resolveWorkspaceIdentityKey(input: {
  workspaceIdentity?: string | null;
  workspacePath: string;
}): string {
  const identity = input.workspaceIdentity?.trim();
  return identity && identity.length > 0 ? identity : input.workspacePath;
}

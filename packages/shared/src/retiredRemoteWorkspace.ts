import { z } from "zod";
import { RETIRED_REMOTE_TARGET_KINDS, type RetiredRemoteTargetKind } from "./remoteTarget.js";

/**
 * 退役远端目标的只读失效投影（specs/cloud-agent/06 §3.2）。
 *
 * Docker/WSL 远程连接目标退役后，旧 setting.json 里的对应历史记录不能丢：
 * 它们仍表达用户数据归属与最近打开时间，但不再可连接、不可启动任务、不可打开本地同路径。
 * 因此持久层新增该只读分支，活跃 `RemoteTarget`、backend 和连接接口都不接受它。
 */

/** 退役目标的显示元数据；只保留展示信息，不含密码/私钥/可执行 target。 */
export const retiredRemoteOriginalAuthoritySchema = z
  .object({
    distro: z.string().optional(),
    user: z.string().optional(),
    container: z.string().optional(),
  })
  .strict();

export const retiredRemoteWorkspaceEntrySchema = z
  .object({
    kind: z.literal("retired-remote"),
    retiredKind: z.enum(RETIRED_REMOTE_TARGET_KINDS),
    workspacePath: z.string().trim().min(1),
    workspaceIdentity: z.string().trim().min(1).optional(),
    label: z.string().trim().min(1).optional(),
    lastOpenedAt: z.number().int().nonnegative().optional(),
    invalidReason: z.literal("target-retired"),
    originalAuthority: retiredRemoteOriginalAuthoritySchema.optional(),
  })
  .strict();

export type RetiredRemoteWorkspaceOriginalAuthority = z.infer<
  typeof retiredRemoteOriginalAuthoritySchema
>;

export interface RetiredRemoteWorkspaceEntry {
  kind: "retired-remote";
  retiredKind: RetiredRemoteTargetKind;
  workspacePath: string;
  workspaceIdentity?: string;
  label?: string;
  lastOpenedAt?: number;
  invalidReason: "target-retired";
  originalAuthority?: RetiredRemoteWorkspaceOriginalAuthority;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** 从旧 target 中提取纯显示用的 authority 元数据；非法/缺失字段一律省略。 */
function readRetiredRemoteOriginalAuthority(
  retiredKind: RetiredRemoteTargetKind,
  target: unknown,
): RetiredRemoteWorkspaceOriginalAuthority | undefined {
  if (!isRecord(target)) {
    return undefined;
  }
  if (retiredKind === "docker") {
    const container = readNonEmptyString(target.container);
    return container ? { container } : undefined;
  }
  const distro = readNonEmptyString(target.distro);
  const user = readNonEmptyString(target.user);
  if (!distro && !user) {
    return undefined;
  }
  return {
    ...(distro ? { distro } : {}),
    ...(user ? { user } : {}),
  };
}

/** 从任意旧记录（lastWorkspaceSession 旧项或更老 history 项）中提取只读字段。 */
function projectRetiredRemoteEntryFields(
  value: unknown,
): Omit<RetiredRemoteWorkspaceEntry, "kind" | "invalidReason"> | null {
  if (!isRecord(value)) {
    return null;
  }
  const target = value.target;
  if (!isRecord(target)) {
    return null;
  }
  const retiredKind = target.kind;
  if (retiredKind !== "wsl" && retiredKind !== "docker") {
    return null;
  }
  const workspacePath = readNonEmptyString(value.workspacePath);
  if (!workspacePath) {
    return null;
  }
  const workspaceIdentity = readNonEmptyString(value.workspaceIdentity);
  const label = readNonEmptyString(value.label);
  const lastOpenedAt = readNonNegativeInteger(value.lastOpenedAt);
  const originalAuthority = readRetiredRemoteOriginalAuthority(retiredKind, target);
  return {
    retiredKind,
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
    ...(label ? { label } : {}),
    ...(lastOpenedAt === undefined ? {} : { lastOpenedAt }),
    ...(originalAuthority ? { originalAuthority } : {}),
  };
}

/**
 * 把活跃 schema 之前的旧记录投影成退役只读失效记录；不是退役目标时返回 null。
 * 只读取展示/归属所需的最小字段，不读取任何凭据或可执行 target。
 */
export function projectRetiredRemoteWorkspaceEntry(
  value: unknown,
): RetiredRemoteWorkspaceEntry | null {
  const fields = projectRetiredRemoteEntryFields(value);
  if (!fields) {
    return null;
  }
  return { kind: "retired-remote", invalidReason: "target-retired", ...fields };
}

/** 严格校验已经投影过的退役记录；非法记录返回 null（调用方只丢弃该条，不影响整份设置）。 */
export function normalizeRetiredRemoteWorkspaceEntry(
  value: unknown,
): RetiredRemoteWorkspaceEntry | null {
  const parsed = retiredRemoteWorkspaceEntrySchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/**
 * 原始文件里是否仍有需要迁移的退役目标记录（settings 迁移写回的触发条件）。
 *
 * 只按「旧 kind 仍在文件里」判定，因此迁移落盘后重复读取不再触发写入（幂等），
 * 也允许用户手工把文件改回旧格式后再次被识别。
 */
export function hasLegacyRetiredRemoteTargets(rawValue: unknown): boolean {
  if (!isRecord(rawValue)) {
    return false;
  }
  const lastWorkspaceSession = Array.isArray(rawValue.lastWorkspaceSession)
    ? rawValue.lastWorkspaceSession
    : [];
  if (lastWorkspaceSession.some((entry) => projectRetiredRemoteWorkspaceEntry(entry) !== null)) {
    return true;
  }
  const legacyHistory = Array.isArray(rawValue.remoteWorkspaceHistory)
    ? rawValue.remoteWorkspaceHistory
    : [];
  return legacyHistory.some((entry) => projectRetiredRemoteWorkspaceEntry(entry) !== null);
}

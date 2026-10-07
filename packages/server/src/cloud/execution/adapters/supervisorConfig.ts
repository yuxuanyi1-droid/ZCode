/**
 * supervisor 自举配置读取（specs/cloud-agent/01 §6.2 实施决议、W6 §3「自举 env 读取」）。
 *
 * 两类输入分开：
 * 1. **自举要素**（W3 冻结的 env 名，`sandboxSupervisorStart.ts` 的
 *    `SUPERVISOR_START_ENV_NAMES`）：publicOrigin / runId / runGeneration / ticket / operationKey；
 * 2. **run 地址补充**（taskId / workspacePath）：`bridge.hello` 的 `CloudRunAddress` 要求合法
 *    `taskId` 与 `workspaceIdentity = cloud-task:<taskId>`，而这两个字段都不在自举 env 里，
 *    也不是沙箱能从 runId 推导的事实（02 §2 不变量 1 禁止从身份猜执行路径）。
 *    因此从本地描述文件 `${stateDir}/bootstrap.json` 或显式 env 读取；**缺席即 fail closed**，
 *    不编造占位身份（编造的 taskId 会污染 attachment 地址与投影去重键）。
 *
 * 该缺口已作为契约变更请求上报（见 W6 报告）：需在 provider 命令通道补
 * `ZCODE_CLOUD_TASK_ID` / `ZCODE_CLOUD_WORKSPACE_PATH`，或由 provisioning 落描述文件。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cloudTaskIdSchema, cloudUuidSchema } from "@zcode/shared";
import { DEFAULT_RUNTIME_STATE_DIR } from "./credentialStateFile.js";

/** 与 W3 的 `SUPERVISOR_START_ENV_NAMES` 同名（不新增别名，避免两套 env 契约）。 */
export const SUPERVISOR_ENV = {
  publicOrigin: "ZCODE_CLOUD_PUBLIC_ORIGIN",
  runId: "ZCODE_CLOUD_RUN_ID",
  runGeneration: "ZCODE_CLOUD_RUN_GENERATION",
  bootstrapTicket: "ZCODE_CLOUD_BOOTSTRAP_TICKET",
  operationKey: "ZCODE_CLOUD_OPERATION_KEY",
} as const;

/** run 地址补充（缺失时的显式变量名；也接受描述文件）。 */
export const SUPERVISOR_ADDRESS_ENV = {
  taskId: "ZCODE_CLOUD_TASK_ID",
  workspacePath: "ZCODE_CLOUD_WORKSPACE_PATH",
} as const;

export interface SupervisorBootstrapConfig {
  runId: string;
  runGeneration: number;
  taskId: string;
  publicOrigin: string;
  bootstrapTicket: string;
  operationKey: string;
  workspacePath: string;
  stateDir: string;
}

export type SupervisorConfigResult =
  | { ok: true; value: SupervisorBootstrapConfig }
  | { ok: false; missing: string[] };

interface AddressDescriptor {
  taskId?: unknown;
  workspacePath?: unknown;
}

async function readDescriptor(stateDir: string): Promise<AddressDescriptor> {
  const raw = await readFile(join(stateDir, "bootstrap.json"), "utf8").catch(() => null);
  if (raw === null) return {};
  try {
    const value = JSON.parse(raw) as AddressDescriptor;
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

export async function readSupervisorConfig(
  env: Record<string, string | undefined>,
  stateDir: string = DEFAULT_RUNTIME_STATE_DIR,
): Promise<SupervisorConfigResult> {
  const missing: string[] = [];
  const publicOrigin = env[SUPERVISOR_ENV.publicOrigin]?.trim();
  const runId = env[SUPERVISOR_ENV.runId]?.trim();
  const runGenerationRaw = env[SUPERVISOR_ENV.runGeneration]?.trim();
  const bootstrapTicket = env[SUPERVISOR_ENV.bootstrapTicket]?.trim();
  const operationKey = env[SUPERVISOR_ENV.operationKey]?.trim();

  if (!publicOrigin) missing.push(SUPERVISOR_ENV.publicOrigin);
  if (!runId || !cloudUuidSchema.safeParse(runId).success) missing.push(SUPERVISOR_ENV.runId);
  const runGeneration = runGenerationRaw ? Number.parseInt(runGenerationRaw, 10) : Number.NaN;
  if (!Number.isInteger(runGeneration) || runGeneration <= 0) {
    missing.push(SUPERVISOR_ENV.runGeneration);
  }
  if (!bootstrapTicket) missing.push(SUPERVISOR_ENV.bootstrapTicket);
  if (!operationKey) missing.push(SUPERVISOR_ENV.operationKey);

  const descriptor = await readDescriptor(stateDir);
  const taskId =
    env[SUPERVISOR_ADDRESS_ENV.taskId]?.trim() ||
    (typeof descriptor.taskId === "string" ? descriptor.taskId : "") ||
    "";
  const workspacePath =
    env[SUPERVISOR_ADDRESS_ENV.workspacePath]?.trim() ||
    (typeof descriptor.workspacePath === "string" ? descriptor.workspacePath : "") ||
    "";
  if (!cloudTaskIdSchema.safeParse(taskId).success) missing.push(SUPERVISOR_ADDRESS_ENV.taskId);
  if (!workspacePath.startsWith("/")) missing.push(SUPERVISOR_ADDRESS_ENV.workspacePath);

  if (missing.length > 0) return { ok: false, missing };
  return {
    ok: true,
    value: {
      runId: runId as string,
      runGeneration,
      taskId,
      publicOrigin: publicOrigin as string,
      bootstrapTicket: bootstrapTicket as string,
      operationKey: operationKey as string,
      workspacePath,
      stateDir,
    },
  };
}

/** 出站 bridge 地址：`/ws/cloud/bridge/:runId`（02 §4，只接受执行节点出站连接）。 */
export function bridgeUrl(publicOrigin: string, runId: string): string {
  const url = new URL(`/ws/cloud/bridge/${encodeURIComponent(runId)}`, publicOrigin);
  url.protocol = url.protocol === "http:" ? "ws:" : "wss:";
  return url.toString();
}

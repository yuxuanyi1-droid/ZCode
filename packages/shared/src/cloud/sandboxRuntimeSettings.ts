/**
 * Cloud 沙箱运行时账号设置（specs/cloud-agent/01 §4.3/§5.1 修订 2026-10-08、12 §2 修订）。
 *
 * 设置页「Cloud 运行时」的沙箱配置归属账号域：
 * - 非秘密（按 provider 的超时秒数）走 host `settingService` 的
 *   `AppSettings.cloudRuntime.sandboxTimeoutSeconds`；
 * - 秘密（provider key）走 host `credentialService`，凭据标识固定 `cloud-sandbox/<provider>`
 *   （落盘已加密；UI 只写不回显，服务端 create 时读取）。
 *
 * 生效规则（01 §4.3 修订）：部署 env 是基线与硬上界；生效超时 = min(设置值, env 核实上限)，
 * 生效 key = credential 存储值 ?? env 部署值；覆盖只影响新 create。
 */
import { z } from "zod";

/** 单 key 型 provider：账号设置可覆盖其 provider key（Modal 是 token 对，不走此通道）。 */
export const CLOUD_SANDBOX_SINGLE_KEY_PROVIDERS: readonly string[] = ["e2b", "daytona"];

/** 凭据标识：设置页写入 ↔ 控制面 create 时读取的唯一约定，不在业务代码手写格式。 */
export function cloudSandboxCredentialKey(provider: string): string {
  return `cloud-sandbox/${provider}`;
}

/** 超时秒数的公共取值域：设置 schema 与 UI clamp 共用同一来源。 */
export const CLOUD_SANDBOX_TIMEOUT_SECONDS_MIN = 60;
export const CLOUD_SANDBOX_TIMEOUT_SECONDS_MAX = 60 * 60 * 24 * 7;

const providerKeySchema = z.string().trim().min(1).max(64);

/** `cloudRuntime.sandboxTimeoutSeconds` 的形状：provider → 秒。 */
export const cloudSandboxTimeoutSecondsSchema = z.record(
  providerKeySchema,
  z.number().int().min(CLOUD_SANDBOX_TIMEOUT_SECONDS_MIN).max(CLOUD_SANDBOX_TIMEOUT_SECONDS_MAX),
);
export type CloudSandboxTimeoutSeconds = z.infer<typeof cloudSandboxTimeoutSecondsSchema>;

/** `AppSettings.cloudRuntime` section（非秘密；秘密走 credentialService，不进 setting）。 */
export const cloudRuntimeSettingsSchema = z.object({
  sandboxTimeoutSeconds: cloudSandboxTimeoutSecondsSchema.optional(),
});
export type CloudRuntimeSettings = z.infer<typeof cloudRuntimeSettingsSchema>;

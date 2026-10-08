/**
 * 设置页沙箱配置的纯决策逻辑（specs/cloud-agent/01 §4.3 修订 2026-10-08）：
 * 生效超时收敛与超时草稿解析。无 JSX、无 hook，供组件与测试共用；
 * 公式与 server `SandboxRuntimeSettingsPort` 单一约定对齐（生效值 = min(设置值, env 核实上限)）。
 */
import {
  CLOUD_SANDBOX_TIMEOUT_SECONDS_MAX,
  CLOUD_SANDBOX_TIMEOUT_SECONDS_MIN,
  type SandboxProviderCapabilities,
} from "@zcode/shared";

/** 生效超时与来源：min(设置值（若有）, env 核实上限)；来源区分设置覆盖 / 部署基线。 */
export function resolveEffectiveSandboxTimeout(
  provider: Pick<SandboxProviderCapabilities, "maxLifetimeSeconds"> & { provider: string },
  settingSeconds: number | undefined,
): { seconds: number | undefined; source: "account-setting" | "deployment-env" } {
  const envMax = provider.maxLifetimeSeconds;
  const seconds =
    settingSeconds !== undefined && envMax !== undefined
      ? Math.min(settingSeconds, envMax)
      : (settingSeconds ?? envMax);
  return {
    seconds,
    source: settingSeconds !== undefined ? "account-setting" : "deployment-env",
  };
}

/** 超时草稿的解析结果：设置覆盖 / 恢复基线 / 非法输入。 */
export type SandboxTimeoutDraftResolution =
  | { readonly kind: "clear"; readonly record: Record<string, number> }
  | { readonly kind: "set"; readonly seconds: number; readonly record: Record<string, number> }
  | { readonly kind: "invalid" };

/**
 * 超时草稿 → 下一次 `cloudRuntime.sandboxTimeoutSeconds` 记录：
 * - 空输入 = 清除该 provider 的覆盖（恢复部署基线）；
 * - 数值按 shared 取值域与 env 核实上限 clamp（服务端端口还会再收敛一次）；
 * - 其它 provider 的既有覆盖原样保留（patch 语义是整组记录）。
 */
export function resolveSandboxTimeoutDraft(input: {
  existing: Record<string, number> | undefined;
  provider: string;
  draft: string;
  maxLifetimeSeconds: number;
}): SandboxTimeoutDraftResolution {
  const trimmed = input.draft.trim();
  const existing = input.existing ?? {};
  if (trimmed === "") {
    const next = { ...existing };
    delete next[input.provider];
    return { kind: "clear", record: next };
  }
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) {
    return { kind: "invalid" };
  }
  const seconds = Math.min(
    Math.max(parsed, CLOUD_SANDBOX_TIMEOUT_SECONDS_MIN),
    Math.min(input.maxLifetimeSeconds, CLOUD_SANDBOX_TIMEOUT_SECONDS_MAX),
  );
  return { kind: "set", seconds, record: { ...existing, [input.provider]: seconds } };
}

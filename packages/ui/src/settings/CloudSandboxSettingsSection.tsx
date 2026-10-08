/**
 * 设置页「Cloud 运行时」的 Sandbox 分区（specs/cloud-agent/01 §4.1、§4.3 修订 2026-10-08、
 * 12 §2 修订）。
 *
 * 能力声明（对账通道/期限来源等）是控制面自述的**只读**事实；E2B 等 provider key 与
 * 沙箱超时预算是账号设置**可编辑**项：key 走凭据服务只写不回显（`cloud-sandbox/<provider>`），
 * 超时走 `AppSettings.cloudRuntime`，上限取 capabilities 的 `maxLifetimeSeconds`
 * （env 核实上限，硬上界）；生效值 = min(设置值, env 核实上限)，覆盖只影响新 create。
 */
import { useEffect, useState } from "react";
import {
  CLOUD_SANDBOX_SINGLE_KEY_PROVIDERS,
  CLOUD_SANDBOX_TIMEOUT_SECONDS_MAX,
  CLOUD_SANDBOX_TIMEOUT_SECONDS_MIN,
  cloudSandboxCredentialKey,
  type CapabilitiesResponse,
} from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useCloudCapabilities } from "@/hooks/cloud/useCloudCapabilities.js";
import { useCredentials } from "@/hooks/useCredentials.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  CloudSectionHint,
  CloudSectionShell,
  describeCloudSettingsError,
} from "@/settings/cloudRuntimeSectionParts.js";
import {
  resolveEffectiveSandboxTimeout,
  resolveSandboxTimeoutDraft,
} from "@/settings/cloudSandboxSettingsLogic.js";

/** E2B key 编辑行：写入型输入，保存走凭据服务；占位显示已配置态，永不回显。 */
function CloudSandboxApiKeyRow({
  provider,
  configured,
  onSaved,
}: {
  provider: string;
  configured: boolean;
  onSaved: () => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const credentials = useCredentials();
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const trimmed = draft.trim();
    if (!trimmed || state === "saving") {
      return;
    }
    setState("saving");
    setError(null);
    try {
      // 只写不回显（01 §7.1、12 §2 修订）：key 落 host 加密凭据存储，不进 setting/日志。
      await credentials.save(cloudSandboxCredentialKey(provider), trimmed);
      setDraft("");
      setState("saved");
      await onSaved();
    } catch (saveError) {
      setState("error");
      setError(describeCloudSettingsError(saveError));
    }
  };

  return (
    <SettingsRow
      label={intl.formatMessage({
        id: "settings.cloudRuntime.sandbox.apiKey.label",
      })}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span
            className={
              configured ? "text-ui-base text-foreground-subtle" : "text-ui-base text-destructive"
            }
          >
            {intl.formatMessage({
              id: configured
                ? "settings.cloudRuntime.sandbox.apiKey.configured"
                : "settings.cloudRuntime.sandbox.apiKey.notConfigured",
            })}
          </span>
          <span className="text-ui-base text-foreground-subtle">
            {state === "saved"
              ? intl.formatMessage({
                  id: "settings.cloudRuntime.sandbox.apiKey.saved",
                })
              : intl.formatMessage({
                  id: "settings.cloudRuntime.sandbox.apiKey.description",
                })}
          </span>
          {state === "error" && error ? (
            <span className="text-ui-base text-destructive">{error}</span>
          ) : null}
        </span>
      }
      control={
        <span className="flex w-full max-w-64 items-center justify-end gap-2">
          <Input
            type="password"
            autoComplete="off"
            size="sm"
            className="min-w-0 flex-1"
            value={draft}
            placeholder={intl.formatMessage({
              id: "settings.cloudRuntime.sandbox.apiKey.placeholder",
            })}
            onChange={(event) => {
              setDraft(event.target.value);
              if (state !== "idle") setState("idle");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={draft.trim().length === 0 || state === "saving"}
            onClick={() => void save()}
          >
            {intl.formatMessage({ id: "common.save" })}
          </Button>
        </span>
      }
    />
  );
}

/** 沙箱超时编辑行：数字输入，上限取 capabilities 的 env 核实上限；空输入恢复部署基线。 */
function CloudSandboxTimeoutRow({
  provider,
  maxLifetimeSeconds,
  settingSeconds,
  onSaved,
}: {
  provider: string;
  maxLifetimeSeconds: number;
  settingSeconds: number | undefined;
  onSaved: () => void | Promise<void>;
}) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const [draft, setDraft] = useState(settingSeconds === undefined ? "" : String(settingSeconds));
  const [state, setState] = useState<"idle" | "saving" | "saved" | "cleared" | "error">("idle");
  const [error, setError] = useState<string | null>(null);
  /** 保存时被上限收敛的目标值（2026-10-08 巡检 P3）：>0 时给出显式提示，不再静默改数。 */
  const [clampedToSeconds, setClampedToSeconds] = useState<number | null>(null);

  // 保存成功（设置刷新）后回填草稿；未保存的本地草稿不被远端事实覆盖。
  useEffect(() => {
    if (state === "saved" || state === "cleared") {
      setDraft(settingSeconds === undefined ? "" : String(settingSeconds));
    }
  }, [settingSeconds, state]);

  const effective = resolveEffectiveSandboxTimeout(
    { provider, maxLifetimeSeconds },
    settingSeconds,
  );

  const save = async () => {
    if (state === "saving") {
      return;
    }
    const resolution = resolveSandboxTimeoutDraft({
      existing: settings?.cloudRuntime?.sandboxTimeoutSeconds,
      provider,
      draft,
      maxLifetimeSeconds,
    });
    if (resolution.kind === "invalid") {
      setState("error");
      setError(
        intl.formatMessage({
          id: "settings.cloudRuntime.sandbox.timeout.invalid",
        }),
      );
      return;
    }
    if (resolution.kind === "set") {
      const parsedDraft = Number.parseInt(draft.trim(), 10);
      // 收敛提示依据：用户输入的数值经部署上限/取值域 clamp 后发生变化（3600 → 3300）。
      // 只改草稿不提示是巡检实测的静默钳制问题；这里记录目标值，保存成功后显式呈现。
      setClampedToSeconds(
        Number.isFinite(parsedDraft) && parsedDraft !== resolution.seconds
          ? resolution.seconds
          : null,
      );
      if (String(resolution.seconds) !== draft.trim()) {
        setDraft(String(resolution.seconds));
      }
    } else {
      setClampedToSeconds(null);
    }
    setState("saving");
    setError(null);
    try {
      await update({
        cloudRuntime: { sandboxTimeoutSeconds: resolution.record },
      });
      setState(resolution.kind === "clear" ? "cleared" : "saved");
      await onSaved();
    } catch (saveError) {
      setState("error");
      setError(describeCloudSettingsError(saveError));
    }
  };

  const statusMessage =
    state === "cleared"
      ? intl.formatMessage({
          id: "settings.cloudRuntime.sandbox.timeout.cleared",
        })
      : effective.seconds === undefined
        ? intl.formatMessage({
            id: "settings.cloudRuntime.sandbox.timeout.effective.none",
          })
        : intl.formatMessage(
            {
              id:
                effective.source === "account-setting"
                  ? "settings.cloudRuntime.sandbox.timeout.effective.accountSetting"
                  : "settings.cloudRuntime.sandbox.timeout.effective.deploymentEnv",
            },
            { seconds: effective.seconds },
          );

  return (
    <SettingsRow
      label={intl.formatMessage({
        id: "settings.cloudRuntime.sandbox.timeout.label",
      })}
      description={
        <span className="flex flex-wrap items-center gap-2">
          <span className="text-ui-base text-foreground-subtle">{statusMessage}</span>
          {state === "saved" && clampedToSeconds !== null ? (
            <span
              className="text-ui-base text-foreground"
              data-testid="cloud-sandbox-timeout-clamped"
            >
              {intl.formatMessage(
                { id: "cloud.run.settings.timeoutClamped" },
                { seconds: clampedToSeconds },
              )}
            </span>
          ) : null}
          <span className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.cloudRuntime.sandbox.timeout.hint" },
              { max: maxLifetimeSeconds },
            )}
          </span>
          {state === "error" && error ? (
            <span className="text-ui-base text-destructive">{error}</span>
          ) : null}
        </span>
      }
      control={
        <span className="flex w-full max-w-64 items-center justify-end gap-2">
          <Input
            type="number"
            inputMode="numeric"
            size="sm"
            className="min-w-0 flex-1"
            value={draft}
            placeholder={String(maxLifetimeSeconds)}
            min={CLOUD_SANDBOX_TIMEOUT_SECONDS_MIN}
            max={Math.min(maxLifetimeSeconds, CLOUD_SANDBOX_TIMEOUT_SECONDS_MAX)}
            onChange={(event) => {
              setDraft(event.target.value);
              if (state !== "idle") setState("idle");
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void save();
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={state === "saving"}
            onClick={() => void save()}
          >
            {intl.formatMessage({ id: "common.save" })}
          </Button>
        </span>
      }
    />
  );
}

/**
 * Sandbox 分区：控制面自述的 provider 能力 + 账号设置覆盖（2026-10-08 修订）。
 * 能力声明（对账通道/期限来源等）仍是只读事实；key 与超时预算是账号设置可编辑项。
 */
export function CloudSandboxSettingsSection() {
  const { intl } = useZCodeIntl();
  const capabilities = useCloudCapabilities();
  const { settings } = useSettings();
  const providers: CapabilitiesResponse["providers"] = capabilities.capabilities?.providers ?? [];

  return (
    <CloudSectionShell
      title={intl.formatMessage({ id: "settings.cloudRuntime.sandbox.title" })}
      description={intl.formatMessage({
        id: "settings.cloudRuntime.sandbox.description",
      })}
    >
      {capabilities.status !== "ready" && providers.length === 0 ? (
        <CloudSectionHint tone="muted">
          {capabilities.status === "error"
            ? describeCloudSettingsError(capabilities.error)
            : intl.formatMessage({ id: "settings.cloudRuntime.loading" })}
        </CloudSectionHint>
      ) : null}
      {capabilities.status === "ready" && providers.length === 0 ? (
        <CloudSectionHint tone="muted">
          {intl.formatMessage({ id: "settings.cloudRuntime.sandbox.none" })}
        </CloudSectionHint>
      ) : null}
      {providers.map((provider) => {
        const settingSeconds = settings?.cloudRuntime?.sandboxTimeoutSeconds?.[provider.provider];
        return (
          <div key={provider.provider} className="border-t border-border first:border-t-0">
            <SettingsRow
              label={provider.provider}
              detail={
                <span className="text-ui-base text-foreground-subtle">
                  {intl.formatMessage({
                    id: "settings.cloudRuntime.sandbox.capability.deadlineSource",
                  })}
                  : {provider.deadlineSource}
                  {provider.maxLifetimeSeconds === undefined
                    ? null
                    : ` · ${intl.formatMessage({ id: "settings.cloudRuntime.sandbox.capability.maxLifetime" })}: ${provider.maxLifetimeSeconds}`}
                </span>
              }
              controlLayout="wide"
              control={
                <span className="flex flex-wrap gap-2 text-ui-base text-foreground-subtle">
                  <span>
                    {intl.formatMessage({
                      id: "settings.cloudRuntime.sandbox.capability.createOperationLookup",
                    })}
                    : {provider.createOperationLookup}
                  </span>
                  <span>
                    {intl.formatMessage({
                      id: "settings.cloudRuntime.sandbox.capability.inspect",
                    })}
                    : {String(provider.canInspect)}
                  </span>
                  <span>
                    {intl.formatMessage({
                      id: "settings.cloudRuntime.sandbox.capability.extendDeadline",
                    })}
                    : {String(provider.canExtendDeadline)}
                  </span>
                  <span>
                    {intl.formatMessage({
                      id: "settings.cloudRuntime.sandbox.capability.confirmTermination",
                    })}
                    : {String(provider.canConfirmTermination)}
                  </span>
                  <span>
                    {intl.formatMessage({
                      id: "settings.cloudRuntime.sandbox.capability.outboundWss",
                    })}
                    : {String(provider.supportsOutboundWss)}
                  </span>
                </span>
              }
            />
            {CLOUD_SANDBOX_SINGLE_KEY_PROVIDERS.includes(provider.provider) ? (
              <CloudSandboxApiKeyRow
                provider={provider.provider}
                configured={provider.apiKeyConfigured}
                onSaved={() => void capabilities.reload()}
              />
            ) : null}
            {provider.maxLifetimeSeconds === undefined ? null : (
              <CloudSandboxTimeoutRow
                provider={provider.provider}
                maxLifetimeSeconds={provider.maxLifetimeSeconds}
                settingSeconds={settingSeconds}
                onSaved={() => void capabilities.reload()}
              />
            )}
          </div>
        );
      })}
      <CloudSectionHint tone="muted">
        {intl.formatMessage({ id: "settings.cloudRuntime.sandbox.secretNote" })}
      </CloudSectionHint>
    </CloudSectionShell>
  );
}

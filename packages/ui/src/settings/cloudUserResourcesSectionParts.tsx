/**
 * 云用户资源管理分区的共享结构件（specs/cloud-agent/14 §9.4；W11 §12）。
 *
 * 只放「三个面板（归档 / MCP / AGENTS.md）共用」的展示件：
 * - 条目行的统一渲染（名称、entryId、字节、sha256 前缀、开关、删除）；
 * - 校验失败 / 结构化错误的文案映射（i18n key 由纯逻辑层给出，本文件只做取值）；
 * - 分组头部（类别名 + 上限提示 + 条目计数）。
 *
 * 样式一律走 DESIGN.md 的 `text-ui-*` 与语义色（`text-foreground-subtle` / `text-destructive`），
 * 外壳复用 `cloudRuntimeSectionParts` 的 `CloudSectionShell`/`CloudSectionHint`，不另造一套。
 */
import { Trash2 } from "lucide-react";
import type { CloudUserProfileEntry } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Switch } from "@/components/ui/switch.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  formatUserResourceBytes,
  userResourcesErrorKey,
  userResourceShortSha256,
  type CloudUserResourcesError,
  type UserResourceMcpJsonFailure,
  type UserResourceValidationFailure,
} from "@/cloud/userResourcesModel.js";
import type { UserResourceActionError } from "@/hooks/cloud/useCloudUserResources.js";

/** 客户端前置校验失败 → 用户可见文案（上限数值经 `formatUserResourceBytes` 本地化）。 */
function describeUserResourceValidationFailure(
  failure: UserResourceValidationFailure | UserResourceMcpJsonFailure,
  format: (descriptor: { id: string }, values?: Record<string, string | number>) => string,
): string {
  switch (failure.reason) {
    case "empty":
      return format({ id: "settings.cloudUserResources.validation.empty" });
    case "shape":
      return format(
        { id: "settings.cloudUserResources.validation.shape" },
        { pattern: failure.pattern },
      );
    case "empty-file":
      return format({ id: "settings.cloudUserResources.validation.emptyFile" });
    case "file-too-large":
      return format(
        { id: "settings.cloudUserResources.validation.fileTooLarge" },
        { max: formatUserResourceBytes(failure.maxBytes) },
      );
    case "body-too-large":
      return format(
        { id: "settings.cloudUserResources.validation.bodyTooLarge" },
        { max: formatUserResourceBytes(failure.maxBytes) },
      );
    // markdown 单文件条目（commands/subagents，14 §4.5）：后缀缺失与正文字节超限各有专文案。
    case "markdown-suffix":
      return format(
        { id: "settings.cloudUserResources.validation.markdownSuffix" },
        {
          suffix: failure.suffix,
        },
      );
    case "markdown-too-large":
      return format(
        { id: "settings.cloudUserResources.validation.markdownTooLarge" },
        { max: formatUserResourceBytes(failure.maxBytes) },
      );
    case "invalid-json":
      return format({ id: "settings.cloudUserResources.validation.jsonInvalid" });
    case "not-object":
      return format({ id: "settings.cloudUserResources.validation.jsonNotObject" });
    case "too-large":
      return format(
        { id: "settings.cloudUserResources.validation.jsonTooLarge" },
        { max: formatUserResourceBytes(failure.maxJsonChars) },
      );
  }
}

/** 结构化错误（控制面拒绝/结果未知）→ 用户可见文案：按 code/reason 取 key，不解析服务端文案。 */
export function describeUserResourcesErrorText(
  error: CloudUserResourcesError,
  format: (descriptor: { id: string }) => string,
): string {
  return format({ id: userResourcesErrorKey(error) });
}

/** 动作失败（校验或服务端）→ 文案；调用方直接渲染在行内。 */
export function describeUserResourceActionErrorText(
  error: UserResourceActionError,
  format: (descriptor: { id: string }, values?: Record<string, string | number>) => string,
): string {
  return error.kind === "validation"
    ? describeUserResourceValidationFailure(error.failure, format)
    : describeUserResourcesErrorText(error.error, format);
}

/** 分组头：类别名 + 上限提示 + 当前条目数（沿用设置页行内小标题的排版）。 */
export function UserResourceGroupHeader({
  title,
  hint,
  count,
}: {
  title: string;
  hint: string;
  count: number;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-border px-4 py-3 first:border-t-0">
      <span className="text-ui-base font-medium text-foreground">{title}</span>
      <span className="text-ui-base text-foreground-subtle">{hint}</span>
      <span className="ml-auto text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.cloudUserResources.group.count" }, { count })}
      </span>
    </div>
  );
}

/** 条目行内错误（红字，UI 不抛异常、不弹全局 toast 掩盖上下文）。 */
export function UserResourceInlineError({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <span className="text-ui-base text-destructive" role="alert">
      {text}
    </span>
  );
}

/**
 * 条目行：displayName（缺省 entryId）+ entryId/bytes/sha256 前缀 + 开关 + 删除。
 *
 * 开关与删除在 pending 期间禁用（防重复提交）；删除的二次确认由调用方在动作前完成
 * （`useConfirmDialog`），本组件只负责触发回调。
 */
export function UserResourceEntryRow({
  entry,
  pendingLabel,
  errorText,
  onEnabledChange,
  onDelete,
  extraControl,
}: {
  entry: CloudUserProfileEntry;
  pendingLabel: string | null;
  errorText: string | null;
  // 返回值不参与渲染（调用方多用 hook 动作的 Promise 结果），故只约束"可 await"。
  onEnabledChange: (enabled: boolean) => unknown;
  onDelete: () => unknown;
  extraControl?: React.ReactNode;
}) {
  const { intl } = useZCodeIntl();
  const pending = pendingLabel !== null;
  const label = entry.displayName ?? entry.entryId;
  return (
    <SettingsRow
      label={label}
      description={
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui-base text-foreground-subtle">
          <span className="font-mono">{entry.entryId}</span>
          <span>{formatUserResourceBytes(entry.bytes)}</span>
          <span className="font-mono">{userResourceShortSha256(entry.sha256)}</span>
          {pendingLabel === null ? null : <span>{pendingLabel}</span>}
          {entry.enabled ? null : (
            <span className="text-foreground-subtle">
              {intl.formatMessage({ id: "settings.cloudUserResources.entry.disabled" })}
            </span>
          )}
          <UserResourceInlineError text={errorText} />
        </span>
      }
      control={
        <span className="flex items-center gap-2">
          {extraControl}
          <Switch
            size="sm"
            checked={entry.enabled}
            disabled={pending}
            aria-label={intl.formatMessage(
              { id: "settings.cloudUserResources.entry.enabledAria" },
              { name: label },
            )}
            onCheckedChange={(checked) => void onEnabledChange(checked)}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={pending}
            aria-label={intl.formatMessage(
              { id: "settings.cloudUserResources.entry.deleteAria" },
              { name: label },
            )}
            onClick={() => void onDelete()}
          >
            <Trash2 className="size-3.5" aria-hidden="true" />
          </Button>
        </span>
      }
    />
  );
}

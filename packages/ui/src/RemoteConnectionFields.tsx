/* eslint-disable max-lines -- 远程连接字段较多，SSH 表单与历史/失效展示暂集中在单文件维护。 */
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  RemoteAssetInstallMode,
  RemoteWorkspaceSessionEntry,
  RetiredRemoteWorkspaceEntry,
  SSHConfigAliasOption,
} from "@zcode/shared";
import { ChevronDownIcon, Plus } from "lucide-react";
import {
  TID_SSH_CONFIG_ALIAS_SELECT,
  TID_SSH_AUTH_PASSWORD,
  TID_SSH_AUTH_PRIVATE_KEY,
  TID_SSH_HOST_INPUT,
  TID_SSH_PASSWORD_INPUT,
  TID_SSH_PORT_INPUT,
  TID_SSH_PRIVATE_KEY_INPUT,
  TID_SSH_USERNAME_INPUT,
} from "@zcode/shared";
import type { SSHAuthMethod } from "@/hooks/useRemoteConnectionForm.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { cn } from "@/components/lib/utils.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { RemoteConnectionHistoryInput } from "@/remote-connection/RemoteConnectionHistoryInput.js";
import { buildSshConnectionHistorySuggestions } from "@/remote-connection/sshHistorySuggestions.js";
import { formatRetiredRemoteWorkspaceEntryLabel } from "@/lib/remoteWorkspaceHistory.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const NO_SSH_CONFIG_ALIAS_VALUE = "__ssh_config_alias_none__";

function formatSshConfigAliasSummary(aliasOption: SSHConfigAliasOption): string {
  const host = aliasOption.host?.trim() || aliasOption.alias;
  const username = aliasOption.username?.trim();
  const withUser = username ? `${username}@${host}` : host;
  return aliasOption.port != null ? `${withUser}:${aliasOption.port}` : withUser;
}

/**
 * 退役远端目标的只读失效展示：只说明“这条历史不能再连接”，不提供任何入口。
 * 不提供重连、打开本地同路径或补建 tab 的动作（specs/cloud-agent/06 §3.2）。
 */
function RetiredRemoteWorkspaceNotice({
  entries,
}: {
  entries: readonly RetiredRemoteWorkspaceEntry[];
}) {
  const { intl } = useZCodeIntl();
  if (entries.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1 rounded-2xl border border-border bg-card px-4 py-3">
      <p className="text-ui-base font-medium text-foreground">
        {intl.formatMessage({ id: "remote.retiredHistory.title" })}
      </p>
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "remote.retiredHistory.description" })}
      </p>
      <ul className="space-y-1">
        {entries.map((entry) => (
          <li
            key={entry.workspaceIdentity?.trim() || `${entry.retiredKind}:${entry.workspacePath}`}
            className="flex min-w-0 flex-col text-ui-base"
          >
            <span className="truncate text-foreground">
              {formatRetiredRemoteWorkspaceEntryLabel(entry)}
            </span>
            <span className="truncate text-foreground-subtle">{entry.workspacePath}</span>
          </li>
        ))}
      </ul>
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "remote.retiredHistory.reason" })}
      </p>
    </div>
  );
}

export function RemoteConnectionFields({
  host,
  port,
  username,
  sshAuthMethod,
  assetInstallMode,
  password,
  privateKeyPath,
  privateKeyPassphrase,
  sshConfigAliases,
  sshConfigAliasesLoading,
  sshConfigAliasesError,
  selectedSshConfigAlias,
  remoteWorkspaceSessions = [],
  retiredRemoteWorkspaceEntries = [],
  applySshConfigAlias,
  clearSelectedSshConfigAlias,
  setHost,
  setPort,
  setUsername,
  setSshAuthMethod,
  setAssetInstallMode,
  setPassword,
  setPrivateKeyPath,
  setPrivateKeyPassphrase,
}: {
  host: string;
  port: string;
  username: string;
  sshAuthMethod: SSHAuthMethod;
  assetInstallMode: RemoteAssetInstallMode;
  password: string;
  privateKeyPath: string;
  privateKeyPassphrase: string;
  sshConfigAliases: SSHConfigAliasOption[];
  sshConfigAliasesLoading: boolean;
  sshConfigAliasesError: string;
  selectedSshConfigAlias: string | null;
  remoteWorkspaceSessions?: RemoteWorkspaceSessionEntry[];
  retiredRemoteWorkspaceEntries?: RetiredRemoteWorkspaceEntry[];
  applySshConfigAlias: (value: SSHConfigAliasOption) => void;
  clearSelectedSshConfigAlias: () => void;
  setHost: (value: string) => void;
  setPort: (value: string) => void;
  setUsername: (value: string) => void;
  setSshAuthMethod: (value: SSHAuthMethod) => void;
  setAssetInstallMode: (value: RemoteAssetInstallMode) => void;
  setPassword: (value: string) => void;
  setPrivateKeyPath: (value: string) => void;
  setPrivateKeyPassphrase: (value: string) => void;
}) {
  const { intl } = useZCodeIntl();
  const platform = usePlatform();
  const [sshAliasPopoverOpen, setSshAliasPopoverOpen] = useState(false);
  const sshAliasListRef = useRef<HTMLDivElement | null>(null);
  const sshHistorySuggestions = buildSshConnectionHistorySuggestions(remoteWorkspaceSessions);
  const selectedSshAliasOption =
    selectedSshConfigAlias == null
      ? null
      : (sshConfigAliases.find((option) => option.alias === selectedSshConfigAlias) ?? null);
  const sshAliasTriggerLabel = sshConfigAliasesLoading
    ? intl.formatMessage({ id: "common.loading" })
    : (selectedSshAliasOption?.alias ??
      (sshConfigAliases.length === 0
        ? intl.formatMessage({ id: "ssh.configAliasEmpty" })
        : intl.formatMessage({ id: "ssh.configAliasPlaceholder" })));
  const handleSshAliasListWheel = useCallback((event: React.WheelEvent<HTMLDivElement>) => {
    const listElement = event.currentTarget;
    if (listElement.scrollHeight <= listElement.clientHeight) {
      return;
    }

    // Popover 嵌在 Dialog 中时，外层滚动锁会吞掉默认滚轮行为，
    // 导致 alias CommandList 只能拖滚动条、不能直接滚轮滚动。
    // 这里显式驱动列表自身 scrollTop，确保鼠标滚轮和触控板都能滚动候选项。
    listElement.scrollTop += event.deltaY;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  useEffect(() => {
    if (!sshAliasPopoverOpen) {
      return;
    }

    const frameId = window.requestAnimationFrame(() => {
      const selectedAliasItem = sshAliasListRef.current?.querySelector<HTMLElement>(
        '[data-ssh-config-alias-selected="true"]',
      );
      selectedAliasItem?.scrollIntoView({ block: "nearest" });
    });

    return () => {
      window.cancelAnimationFrame(frameId);
    };
  }, [sshAliasPopoverOpen, selectedSshConfigAlias, sshConfigAliases.length]);

  return (
    <div className="space-y-3">
      <RetiredRemoteWorkspaceNotice entries={retiredRemoteWorkspaceEntries} />
      <div className="space-y-1">
        <label className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "ssh.configAlias" })}
        </label>
        <Popover open={sshAliasPopoverOpen} onOpenChange={setSshAliasPopoverOpen}>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="lg"
              disabled={sshConfigAliasesLoading || sshConfigAliases.length === 0}
              data-testid={TID_SSH_CONFIG_ALIAS_SELECT}
              className="h-9 w-full max-w-80 justify-between rounded-lg border-input-border bg-input px-3 text-ui-base font-normal hover:border-input-border-hover hover:bg-input aria-expanded:border-input-border-focused aria-expanded:bg-input-focused"
            >
              <span className="min-w-0 truncate text-left">{sshAliasTriggerLabel}</span>
              <ChevronDownIcon className="size-3.5 text-foreground-subtle" />
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" sideOffset={6} className="w-80 gap-0 bg-menu p-0">
            <Command className="bg-transparent p-0 text-foreground">
              <CommandInput
                placeholder={intl.formatMessage({
                  id: "ssh.configAliasSearchPlaceholder",
                })}
                className="h-8"
              />
              <CommandList
                ref={sshAliasListRef}
                className="max-h-60 overscroll-contain"
                onWheel={handleSshAliasListWheel}
              >
                <CommandEmpty className="px-4 py-5 text-foreground-subtle">
                  {intl.formatMessage({ id: "ssh.configAliasEmpty" })}
                </CommandEmpty>
                <CommandGroup className="p-1">
                  <CommandItem
                    value={NO_SSH_CONFIG_ALIAS_VALUE}
                    data-checked={selectedSshConfigAlias == null ? "true" : undefined}
                    data-ssh-config-alias-selected={
                      selectedSshConfigAlias == null ? "true" : undefined
                    }
                    className="min-h-8 cursor-pointer px-2 text-ui-base"
                    onSelect={() => {
                      clearSelectedSshConfigAlias();
                      setSshAliasPopoverOpen(false);
                    }}
                  >
                    <span className="truncate">
                      {intl.formatMessage({ id: "ssh.configAliasPlaceholder" })}
                    </span>
                  </CommandItem>
                  {sshConfigAliases.map((aliasOption) => (
                    <CommandItem
                      key={aliasOption.alias}
                      value={`${aliasOption.alias} ${formatSshConfigAliasSummary(aliasOption)}`}
                      data-checked={
                        selectedSshConfigAlias === aliasOption.alias ? "true" : undefined
                      }
                      data-ssh-config-alias-selected={
                        selectedSshConfigAlias === aliasOption.alias ? "true" : undefined
                      }
                      className="min-h-8 cursor-pointer px-2 text-ui-base"
                      onSelect={() => {
                        applySshConfigAlias(aliasOption);
                        setSshAliasPopoverOpen(false);
                      }}
                    >
                      <span className="flex min-w-0 flex-1 flex-col text-left">
                        <span className="truncate">{aliasOption.alias}</span>
                        <span className="truncate text-ui-base text-foreground-subtle">
                          {formatSshConfigAliasSummary(aliasOption)}
                        </span>
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
        <p
          className={cn(
            "text-ui-base",
            sshConfigAliasesError ? "text-warning" : "text-foreground-subtle",
          )}
        >
          {sshConfigAliasesLoading
            ? intl.formatMessage({ id: "common.loading" })
            : sshConfigAliasesError
              ? intl.formatMessage({ id: "ssh.configAliasLoadFailed" })
              : sshConfigAliases.length === 0
                ? intl.formatMessage({ id: "ssh.configAliasEmpty" })
                : intl.formatMessage({ id: "ssh.configAliasDescription" })}
        </p>
      </div>

      {/* Electron / Chromium 的原生 autocomplete 在 SSH 向导里不稳定，
          而且默认值（如 localhost / 22）会把历史候选提前过滤掉。
          这里改成用应用自身持久化的远程连接历史做显式候选，focus 时先展示完整历史；密码仍然不参与历史回填。 */}
      {/* 建议列表之前直接跟着全宽输入框展开，在大对话框里会变成长条。
          这里把宽度限制在字段语义范围内，只收窄建议列表，不改变原输入框布局。 */}
      {/* 示例值直接作为 placeholder 会被误认为已有默认值。
          这里改成“输入提示 + 示例”，让用户知道仍需手动填写必填字段。 */}
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_6.5rem]">
        <RemoteConnectionHistoryInput
          className="h-9 text-ui-base"
          label={intl.formatMessage({ id: "ssh.host" })}
          value={host}
          onChange={setHost}
          placeholder={intl.formatMessage({ id: "ssh.hostPlaceholder" })}
          suggestions={sshHistorySuggestions.hosts}
          emptyText={intl.formatMessage({ id: "remote.history.empty" })}
          suggestionWidth="min(30ch, calc(100vw - 2rem))"
          autoCapitalize="none"
          spellCheck={false}
          data-testid={TID_SSH_HOST_INPUT}
        />
        <RemoteConnectionHistoryInput
          className="h-9 text-ui-base"
          label={intl.formatMessage({ id: "ssh.port" })}
          value={port}
          onChange={setPort}
          placeholder="22"
          suggestions={sshHistorySuggestions.ports}
          emptyText={intl.formatMessage({ id: "remote.history.empty" })}
          suggestionWidth="min(8ch, calc(100vw - 2rem))"
          inputMode="numeric"
          data-testid={TID_SSH_PORT_INPUT}
        />
      </div>

      {/* 认证方式之前复用了端口的 6.5rem 窄列，两个选项扣除 padding 后会把中英文文案挤到换行或溢出。
          这里单独给认证方式保留 12rem，并禁止选项文字换行。 */}
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-end">
        <RemoteConnectionHistoryInput
          className="h-9 text-ui-base"
          label={intl.formatMessage({ id: "ssh.username" })}
          value={username}
          onChange={setUsername}
          placeholder={intl.formatMessage({ id: "ssh.usernamePlaceholder" })}
          suggestions={sshHistorySuggestions.usernames}
          emptyText={intl.formatMessage({ id: "remote.history.empty" })}
          suggestionWidth="min(30ch, calc(100vw - 2rem))"
          autoCapitalize="none"
          spellCheck={false}
          data-testid={TID_SSH_USERNAME_INPUT}
        />

        <div>
          <label className="mb-1 block text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "ssh.authMethod" })}
          </label>
          <div className="inline-flex w-full items-center rounded-lg border border-input-border bg-input p-[3px]">
            {(["password", "privateKey"] as const).map((value) => {
              const selected = sshAuthMethod === value;

              return (
                <button
                  key={value}
                  type="button"
                  onClick={() => setSshAuthMethod(value)}
                  data-testid={
                    value === "password" ? TID_SSH_AUTH_PASSWORD : TID_SSH_AUTH_PRIVATE_KEY
                  }
                  className={cn(
                    "inline-flex h-7 flex-1 items-center justify-center rounded-md px-3 text-ui-base font-medium whitespace-nowrap transition-colors",
                    selected
                      ? "bg-background text-foreground"
                      : "text-foreground-subtle hover:text-foreground",
                  )}
                >
                  {intl.formatMessage({ id: `ssh.auth.${value}` })}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {sshAuthMethod === "password" ? (
        <div>
          <label className="mb-1 block text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "ssh.password" })}
          </label>
          <Input
            size="lg"
            className="h-9 text-ui-base"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={intl.formatMessage({
              id: "ssh.passwordPlaceholder",
            })}
            name="remote-ssh-password"
            autoComplete="off"
            data-testid={TID_SSH_PASSWORD_INPUT}
          />
        </div>
      ) : (
        <div>
          <label className="mb-1 block text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "ssh.privateKey" })}
          </label>
          <div className="relative mb-3">
            <RemoteConnectionHistoryInput
              className="h-9 pr-10 text-ui-base"
              value={privateKeyPath}
              onChange={setPrivateKeyPath}
              placeholder={intl.formatMessage({
                id: "ssh.privateKeyPlaceholder",
              })}
              suggestions={sshHistorySuggestions.privateKeyPaths}
              emptyText={intl.formatMessage({
                id: "remote.history.empty",
              })}
              autoCapitalize="none"
              spellCheck={false}
              data-testid={TID_SSH_PRIVATE_KEY_INPUT}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon-lg"
              className="absolute top-1/2 right-0.5 -translate-y-1/2"
              title={intl.formatMessage({ id: "ssh.privateKeySelect" })}
              onClick={() => {
                void (async () => {
                  const selectedPath = await platform.selectFile();
                  if (selectedPath) {
                    setPrivateKeyPath(selectedPath);
                  }
                })();
              }}
            >
              <Plus className="size-4" />
            </Button>
          </div>
          <label className="mb-1 block text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "ssh.privateKeyPassphrase" })}
          </label>
          <Input
            size="lg"
            className="h-9 text-ui-base"
            type="password"
            value={privateKeyPassphrase}
            onChange={(e) => setPrivateKeyPassphrase(e.target.value)}
            placeholder={intl.formatMessage({
              id: "ssh.privateKeyPassphrasePlaceholder",
            })}
            name="remote-ssh-private-key-passphrase"
            autoComplete="off"
          />
        </div>
      )}

      <div>
        <label className="mb-1 block text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "ssh.assetInstallMode" })}
        </label>
        <div className="inline-flex w-full max-w-md flex-col items-stretch rounded-lg border border-input-border bg-input p-[3px] sm:w-fit sm:flex-row sm:items-center">
          {(["local-download-upload", "remote-download"] as const).map((value) => {
            const selected = assetInstallMode === value;

            return (
              <button
                key={value}
                type="button"
                onClick={() => setAssetInstallMode(value)}
                className={cn(
                  "inline-flex min-h-7 min-w-0 flex-1 items-center justify-center rounded-md px-3 py-1 text-center text-ui-base font-medium transition-colors sm:flex-none",
                  selected
                    ? "bg-background text-foreground"
                    : "text-foreground-subtle hover:text-foreground",
                )}
              >
                <span className="min-w-0 break-words">
                  {intl.formatMessage({
                    id: `ssh.assetInstallMode.${value}`,
                  })}
                </span>
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "ssh.assetInstallModeDescription" })}
        </p>
      </div>
    </div>
  );
}

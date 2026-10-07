/**
 * 设置页「Cloud 运行时」分组视图（specs/cloud-agent/04 §3.1、09 §2.2、01 §4.1）。
 *
 * 规则：
 * - GitHub 与 Sandbox 位于**该分组**，不能落进基础设置（04 §3.1）。
 * - 只展示当前主体**可访问的操作**；App/provider 密钥由控制面秘密 owner 保存，
 *   这里既不请求也不回显真实秘密（01 §4.1、09）。
 * - 两种引导必须与空态区分：`not_configured`（部署未装配）与撤权 / 未安装 App
 *   是不同事实，不能都渲染成「没有仓库」（04 §3.1、CT-02）。
 * - Provider 能力是控制面自述的**只读**投影：不给密钥/配额写入口（01 §4.1）。
 *
 * i18n：文案走仓库既有的 `useZCodeIntl()`（键位 `settings.cloudRuntime.*`）。
 */
import type { ReactNode } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import type { CapabilitiesResponse, CloudRepositoryRecord } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useCloudCapabilities } from "@/hooks/cloud/useCloudCapabilities.js";
import { useCloudRepositories } from "@/hooks/cloud/useCloudRepositories.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";

/** 供设置导航注册的 id 常量（导航配置不在本工作单 roots 内，由设置 owner 接线）。 */
export const CLOUD_RUNTIME_SETTINGS_GROUP_ID = "cloudRuntime";
export const CLOUD_RUNTIME_SETTINGS_SECTION_ID = "cloudRuntime";

/** 控件区文案统一在这里取：错误只按 code 归类，不解析服务端文案（04 §6）。 */
export function describeCloudSettingsError(error: unknown): string {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function CloudSectionShell({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-2">
      <div className="px-0.5">
        <h3 className="text-ui-base font-medium text-foreground">{title}</h3>
        <p className="mt-1 text-ui-base leading-6 text-foreground-subtle">{description}</p>
      </div>
      <SettingsGroupCard>{children}</SettingsGroupCard>
    </section>
  );
}

function CloudSectionHint({ tone, children }: { tone: "muted" | "warning"; children: ReactNode }) {
  return (
    <p
      className={
        tone === "warning"
          ? "px-4 py-3 text-ui-base leading-6 text-destructive"
          : "px-4 py-3 text-ui-base leading-6 text-foreground-subtle"
      }
    >
      {children}
    </p>
  );
}

function formatRepositoryLabel(repository: CloudRepositoryRecord): string {
  const owner = repository.owner ?? "";
  const name = repository.name ?? "";
  return owner && name ? `${owner}/${name}` : name || owner || String(repository.repositoryId);
}

/**
 * GitHub 分区：已授权仓库（云项目来源）。
 *
 * 不提供「添加仓库」的原生动作：授权发生在 GitHub 侧（App installation），
 * 这里只暴露状态与引导，避免造出第二条授权写入路径（09 §2.2）。
 */
export function CloudGithubSettingsSection() {
  const { intl } = useZCodeIntl();
  const repositories = useCloudRepositories();

  if (repositories.blockingReason === "not_configured") {
    return (
      <CloudSectionShell
        title={intl.formatMessage({ id: "settings.cloudRuntime.github.title" })}
        description={intl.formatMessage({ id: "settings.cloudRuntime.github.description" })}
      >
        <CloudSectionHint tone="warning">
          {intl.formatMessage({ id: "settings.cloudRuntime.github.notConfigured" })}
        </CloudSectionHint>
      </CloudSectionShell>
    );
  }

  if (repositories.blockingReason === "revoked") {
    return (
      <CloudSectionShell
        title={intl.formatMessage({ id: "settings.cloudRuntime.github.title" })}
        description={intl.formatMessage({ id: "settings.cloudRuntime.github.description" })}
      >
        <CloudSectionHint tone="warning">
          {intl.formatMessage({ id: "settings.cloudRuntime.github.revoked" })}
        </CloudSectionHint>
      </CloudSectionShell>
    );
  }

  return (
    <CloudSectionShell
      title={intl.formatMessage({ id: "settings.cloudRuntime.github.title" })}
      description={intl.formatMessage({ id: "settings.cloudRuntime.github.description" })}
    >
      {repositories.status === "loading" && repositories.repositories.length === 0 ? (
        <CloudSectionHint tone="muted">
          {intl.formatMessage({ id: "settings.cloudRuntime.loading" })}
        </CloudSectionHint>
      ) : null}
      {repositories.status === "error" && repositories.error ? (
        <SettingsRow
          label={describeCloudSettingsError(repositories.error)}
          description={intl.formatMessage({ id: "settings.cloudRuntime.github.taskCountHint" })}
          control={
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => void repositories.refresh()}
            >
              <RefreshCw className="size-3.5" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.cloudRuntime.retry" })}
            </Button>
          }
        />
      ) : null}
      {repositories.status === "ready" && repositories.repositories.length === 0 ? (
        <CloudSectionHint tone="muted">
          {intl.formatMessage({ id: "settings.cloudRuntime.github.empty" })}{" "}
          {intl.formatMessage({ id: "settings.cloudRuntime.github.installHint" })}
        </CloudSectionHint>
      ) : null}
      {repositories.repositories.map((repository) => (
        <SettingsRow
          key={repository.repositoryId}
          label={formatRepositoryLabel(repository)}
          description={repository.defaultBranch ?? undefined}
          control={
            <span className="text-ui-base text-foreground-subtle">{repository.availability}</span>
          }
        />
      ))}
      {repositories.hasMore ? (
        <div className="px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void repositories.loadMore()}
          >
            {intl.formatMessage({ id: "settings.cloudRuntime.github.loadMore" })}
          </Button>
        </div>
      ) : null}
    </CloudSectionShell>
  );
}

/** Sandbox 分区：控制面自述的 provider 能力（只读）。 */
export function CloudSandboxSettingsSection() {
  const { intl } = useZCodeIntl();
  const capabilities = useCloudCapabilities();
  const providers: CapabilitiesResponse["providers"] = capabilities.capabilities?.providers ?? [];

  return (
    <CloudSectionShell
      title={intl.formatMessage({ id: "settings.cloudRuntime.sandbox.title" })}
      description={intl.formatMessage({ id: "settings.cloudRuntime.sandbox.description" })}
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
      {providers.map((provider) => (
        <SettingsRow
          key={provider.provider}
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
                {intl.formatMessage({ id: "settings.cloudRuntime.sandbox.capability.inspect" })}:{" "}
                {String(provider.canInspect)}
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
                {intl.formatMessage({ id: "settings.cloudRuntime.sandbox.capability.outboundWss" })}
                : {String(provider.supportsOutboundWss)}
              </span>
            </span>
          }
        />
      ))}
      <CloudSectionHint tone="muted">
        {intl.formatMessage({ id: "settings.cloudRuntime.sandbox.secretNote" })}
      </CloudSectionHint>
    </CloudSectionShell>
  );
}

/**
 * 「Cloud 运行时」分组内容：GitHub + Sandbox。
 *
 * 注册方式（设置导航 owner 接线，两行）：
 * ```ts
 * // settings/settingsPageConfig.ts
 * { id: "cloudRuntime", icon: Cloud, titleId: "settings.cloudRuntime.title",
 *   groupId: "cloudRuntime" }
 * // SettingsPage.tsx 的三元链
 * activeSection === "cloudRuntime" ? <CloudRuntimeSection /> : …
 * ```
 * 未在云模式下（没有 CloudWorkspaceProvider）时给出明确提示，而不是渲染空卡片。
 */
export function CloudRuntimeSection() {
  const { intl } = useZCodeIntl();
  const context = useCloudWorkspaceContext();

  if (!context) {
    return (
      <CloudSectionShell
        title={intl.formatMessage({ id: "settings.cloudRuntime.title" })}
        description={intl.formatMessage({ id: "settings.cloudRuntime.description" })}
      >
        <CloudSectionHint tone="muted">
          {intl.formatMessage({ id: "settings.cloudRuntime.notCloudMode" })}
        </CloudSectionHint>
      </CloudSectionShell>
    );
  }

  return (
    <div className="space-y-6">
      <CloudGithubSettingsSection />
      <CloudSandboxSettingsSection />
      <p className="flex items-center gap-1.5 px-0.5 text-ui-base text-foreground-subtle">
        <ExternalLink className="size-3.5" aria-hidden="true" />
        {intl.formatMessage({ id: "settings.cloudRuntime.description" })}
      </p>
    </div>
  );
}

/**
 * 设置页「Cloud 运行时」分组视图（specs/cloud-agent/04 §3.1、09 §2.2、01 §4.1、
 * 01 §4.3 修订 2026-10-08、12 §2 修订）。
 *
 * 规则：
 * - GitHub 与 Sandbox 位于**该分组**，不能落进基础设置（04 §3.1）。
 * - 只展示当前主体**可访问的操作**；App/provider 密钥由控制面秘密 owner 保存，
 *   设置页不请求也不回显真实秘密（01 §4.1、09）。
 * - 两种引导必须与空态区分：`not_configured`（部署未装配）与撤权 / 未安装 App
 *   是不同事实，不能都渲染成「没有仓库」（04 §3.1、CT-02）。
 * - 沙箱分区自 2026-10-08 修订起支持账号设置覆盖（key / 超时预算），见
 *   `CloudSandboxSettingsSection.tsx`；本文件保留 GitHub 分区与分组外壳。
 *
 * i18n：文案走仓库既有的 `useZCodeIntl()`（键位 `settings.cloudRuntime.*`）。
 */
import { ExternalLink } from "lucide-react";
import type { CloudRepositoryRecord } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Button } from "@/components/ui/button.js";
import { useCloudRepositories } from "@/hooks/cloud/useCloudRepositories.js";
import { SettingsRow } from "@/settings/SettingsPageParts.js";
import {
  CloudSectionHint,
  CloudSectionShell,
  describeCloudSettingsError,
} from "@/settings/cloudRuntimeSectionParts.js";
import { CloudSandboxSettingsSection } from "@/settings/CloudSandboxSettingsSection.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";

// 公开入口（packages/ui/src/index.ts）历史上从本文件导出沙箱分区与错误描述：
// 拆分后在此原样转出，外部 import 路径不变。
export { describeCloudSettingsError } from "@/settings/cloudRuntimeSectionParts.js";
export { CloudSandboxSettingsSection } from "@/settings/CloudSandboxSettingsSection.js";

/** 供设置导航注册的 id 常量（导航配置不在本工作单 roots 内，由设置 owner 接线）。 */
export const CLOUD_RUNTIME_SETTINGS_GROUP_ID = "cloudRuntime";
export const CLOUD_RUNTIME_SETTINGS_SECTION_ID = "cloudRuntime";

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

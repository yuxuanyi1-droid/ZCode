/**
 * 设置页「云用户资源」分区（specs/cloud-agent/14 §4.5/§9.4①；W11 §12/§13D；W8 §3 的设置页宿主扩展）。
 *
 * 位置与显示：挂进「Cloud 运行时」分组（`CloudRuntimeSection`），**只在云模式渲染**
 * （`CloudRuntimeSection` 已有的显示判定；本组件自身再守卫一次，避免被别处引用时在
 * 非云模式渲染出半截空面板）。
 *
 * 语义（14 §1/§4.6/§9.1②，2026-10-11 简化定调）：
 * - 资源由控制面 profile 持有，**沙箱连接建立后自动同步一次**、连接中的任务可在任务面板
 *   手动同步；未连接时不提供同步 —— 顶部常驻该说明（不再有"新任务安装/运行中冻结版本"口径）；
 * - 条目级 `enabled` 开关承担"逐条关闭"（v1 无任务粒度勾选 UI）；
 * - 录入面按类别唯一（`userResourceInputKindOf`）：skills/plugins 归档上传、mcp JSON 表单、
 *   commands/subagents 单文件 markdown 文本、agents-md 单例文本；
 * - 上限、错误码与文案全部来自 shared 常量与 i18n（UI 不复制数值、不解析服务端文案）。
 */
import { useState } from "react";
import {
  CLOUD_USER_PROFILE_CATEGORIES,
  CLOUD_USER_PROFILE_ENTRY_MAX_BYTES,
  CLOUD_USER_PROFILE_MAX_ENTRIES,
  CLOUD_USER_PROFILE_TOTAL_MAX_BYTES,
  type CloudUserProfileCategory,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCloudWorkspaceContext } from "@/cloud/cloudWorkspaceContext.js";
import {
  formatUserResourceBytes,
  isUserResourceArchiveCategory,
  isUserResourceMarkdownCategory,
} from "@/cloud/userResourcesModel.js";
import { useCloudUserResources } from "@/hooks/cloud/useCloudUserResources.js";
import { SettingsSegmentedTabs } from "@/settings/SettingsSegmentedTabs.js";
import { CloudSectionHint, CloudSectionShell } from "@/settings/cloudRuntimeSectionParts.js";
import { describeUserResourcesErrorText } from "@/settings/cloudUserResourcesSectionParts.js";
import { CloudUserResourceArchivePanel } from "@/settings/cloudUserResourcesArchivePanel.js";
import { CloudUserResourceMarkdownPanel } from "@/settings/cloudUserResourcesMarkdownPanel.js";
import { CloudUserResourceMcpPanel } from "@/settings/cloudUserResourcesMcpPanel.js";
import { CloudUserResourceAgentsMdPanel } from "@/settings/cloudUserResourcesAgentsMdPanel.js";

/** 顶部说明行：版本 + 总量 + 生效时机（常驻，不随分类切换消失）。 */
function CloudUserResourcesHeader({
  profileVersion,
  totalBytes,
}: {
  profileVersion: number | null;
  totalBytes: number;
}) {
  const { intl } = useZCodeIntl();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-3">
      <span className="text-ui-base font-medium text-foreground">
        {intl.formatMessage(
          { id: "settings.cloudUserResources.version" },
          { version: profileVersion ?? "—" },
        )}
      </span>
      <span className="text-ui-base text-foreground-subtle">
        {intl.formatMessage(
          { id: "settings.cloudUserResources.totalBytes" },
          {
            used: formatUserResourceBytes(totalBytes),
            max: formatUserResourceBytes(CLOUD_USER_PROFILE_TOTAL_MAX_BYTES),
            entries: CLOUD_USER_PROFILE_MAX_ENTRIES,
          },
        )}
      </span>
      <span className="w-full text-ui-base leading-6 text-foreground-subtle">
        {intl.formatMessage({ id: "settings.cloudUserResources.effectiveHint" })}
      </span>
    </div>
  );
}

export function CloudUserResourcesSection() {
  const { intl } = useZCodeIntl();
  const context = useCloudWorkspaceContext();
  const resources = useCloudUserResources();
  const [category, setCategory] = useState<CloudUserProfileCategory>("mcp");

  // 非云模式不渲染（本分区是云专属能力；判定与 CloudRuntimeSection 同一依据）。
  if (!context) return null;

  const format = intl.formatMessage.bind(intl);
  const tabs = CLOUD_USER_PROFILE_CATEGORIES.map((value) => ({
    value,
    label: format({ id: `settings.cloudUserResources.category.${value}` }),
  }));

  return (
    <CloudSectionShell
      title={format({ id: "settings.cloudUserResources.title" })}
      description={format({ id: "settings.cloudUserResources.description" })}
    >
      <CloudUserResourcesHeader
        profileVersion={resources.profileVersion}
        totalBytes={resources.totalBytes}
      />
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
        <SettingsSegmentedTabs items={tabs} value={category} onValueChange={setCategory} />
        <span className="text-ui-base text-foreground-subtle">
          {format(
            { id: "settings.cloudUserResources.categoryLimit" },
            { max: formatUserResourceBytes(CLOUD_USER_PROFILE_ENTRY_MAX_BYTES[category]) },
          )}
        </span>
      </div>
      {resources.status === "loading" && resources.entries.length === 0 ? (
        <CloudSectionHint tone="muted">
          {format({ id: "settings.cloudUserResources.loading" })}
        </CloudSectionHint>
      ) : null}
      {resources.status === "error" ? (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <span className="text-ui-base text-destructive" role="alert">
            {resources.error === null
              ? format({ id: "settings.cloudUserResources.error.unknown" })
              : describeUserResourcesErrorText(resources.error, format)}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => void resources.load()}>
            {format({ id: "settings.cloudUserResources.retry" })}
          </Button>
        </div>
      ) : null}
      {isUserResourceArchiveCategory(category) ? (
        <CloudUserResourceArchivePanel category={category} resources={resources} />
      ) : isUserResourceMarkdownCategory(category) ? (
        <CloudUserResourceMarkdownPanel category={category} resources={resources} />
      ) : category === "mcp" ? (
        <CloudUserResourceMcpPanel resources={resources} />
      ) : (
        <CloudUserResourceAgentsMdPanel resources={resources} />
      )}
      <CloudSectionHint tone="muted">
        {format({ id: "settings.cloudUserResources.credentialsNote" })}
      </CloudSectionHint>
    </CloudSectionShell>
  );
}

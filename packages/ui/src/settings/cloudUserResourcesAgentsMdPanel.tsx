/**
 * 用户全局 AGENTS.md 面板（specs/cloud-agent/14 §4.5/§9.4①）。
 *
 * 语义：单例条目（固定 `entryId = user-agents`，见 `userResourcesModel` 的说明），
 * 文本编辑器直接编辑正文 → PUT → 沙箱连接建立时整文件覆盖写入 `~/.zcode/AGENTS.md`
 * （14 §4.5/§4.7②：连接期同步，不再有"新 Run 安装"口径）。
 *
 * 回显：挂载时按需 `GET …/entries/agents-md/user-agents` 取正文（14 §9.4①）；
 * 未保存的本地草稿不被远端事实覆盖（`dirty` 标志），保存成功后清脏。
 */
import { useEffect, useState } from "react";
import { CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES } from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import {
  CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID,
  formatUserResourceBytes,
  userResourceEntryKey,
} from "@/cloud/userResourcesModel.js";
import { CloudSectionHint } from "@/settings/cloudRuntimeSectionParts.js";
import {
  describeUserResourceActionErrorText,
  UserResourceEntryRow,
  UserResourceGroupHeader,
  UserResourceInlineError,
} from "@/settings/cloudUserResourcesSectionParts.js";
import type { UseCloudUserResourcesResult } from "@/hooks/cloud/useCloudUserResources.js";

export function CloudUserResourceAgentsMdPanel({
  resources,
}: {
  resources: UseCloudUserResourcesResult;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const format = intl.formatMessage.bind(intl);
  const key = userResourceEntryKey("agents-md", CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID);
  const entry = resources.entries.find((candidate) => candidate.category === "agents-md") ?? null;
  const content = resources.contentByKey[key];
  const contentStatus = resources.contentStatusByKey[key];
  const pending = resources.pendingByKey[key];
  const entryError = resources.errorByKey[key];

  // 首次进入按需取正文（只尝试一次；失败停在 error 由用户显式重试，避免 effect 与失败成环）。
  useEffect(() => {
    if (entry === null) return;
    if (content !== undefined || contentStatus !== undefined) return;
    void resources.loadContent("agents-md", CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID);
  }, [entry, content, contentStatus, resources]);

  // 回显/保存成功后的正文填入草稿；已有本地未保存修改时不覆盖（不把用户正在输入的字吃掉）。
  useEffect(() => {
    if (content === undefined || content.payload.category !== "agents-md") return;
    if (dirty) return;
    setDraft(content.payload.content);
  }, [content, dirty]);

  const save = async () => {
    setSaved(false);
    const result = await resources.saveAgentsMd(draft);
    if (!result.ok) {
      setFormError(describeUserResourceActionErrorText(result.error, format));
      return;
    }
    setFormError(null);
    setDirty(false);
    setSaved(true);
  };

  const removeEntry = async () => {
    const confirmed = await confirmDialog({
      title: format({ id: "settings.cloudUserResources.entry.deleteTitle" }),
      description: format(
        { id: "settings.cloudUserResources.entry.deleteDescription" },
        { name: CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID },
      ),
      confirmLabel: format({ id: "common.delete" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    const result = await resources.remove("agents-md", CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID);
    if (result.ok) {
      setDraft("");
      setDirty(false);
    }
  };

  return (
    <>
      <UserResourceGroupHeader
        title={format({ id: "settings.cloudUserResources.category.agents-md" })}
        hint={format(
          { id: "settings.cloudUserResources.agentsMd.hint" },
          {
            max: formatUserResourceBytes(CLOUD_USER_PROFILE_AGENTS_MD_MAX_BYTES),
            path: "~/.zcode/AGENTS.md",
          },
        )}
        count={entry === null ? 0 : 1}
      />
      {entry === null ? (
        <CloudSectionHint tone="muted">
          {format({ id: "settings.cloudUserResources.agentsMd.empty" })}
        </CloudSectionHint>
      ) : (
        <UserResourceEntryRow
          entry={entry}
          pendingLabel={
            pending === undefined
              ? null
              : format({ id: "settings.cloudUserResources.entry.pending" })
          }
          errorText={
            entryError === undefined
              ? null
              : describeUserResourceActionErrorText({ kind: "server", error: entryError }, format)
          }
          onEnabledChange={(enabled) =>
            resources.setEnabled("agents-md", CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID, enabled)
          }
          onDelete={removeEntry}
        />
      )}
      <div className="space-y-2 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-base font-medium text-foreground">
            {format({ id: "settings.cloudUserResources.agentsMd.editorLabel" })}
          </span>
          {contentStatus === "loading" ? (
            <span className="text-ui-base text-foreground-subtle">
              {format({ id: "settings.cloudUserResources.loading" })}
            </span>
          ) : null}
          {contentStatus === "error" ? (
            <>
              <span className="text-ui-base text-destructive" role="alert">
                {format({ id: "settings.cloudUserResources.error.contentLoad" })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  void resources.loadContent("agents-md", CLOUD_USER_RESOURCES_AGENTS_MD_ENTRY_ID, {
                    force: true,
                  })
                }
              >
                {format({ id: "settings.cloudUserResources.retry" })}
              </Button>
            </>
          ) : null}
          {saved ? (
            <span className="text-ui-base text-foreground">
              {format({ id: "settings.cloudUserResources.savedHint" })}
            </span>
          ) : null}
          {dirty && !saved ? (
            <span className="text-ui-base text-foreground-subtle">
              {format({ id: "settings.cloudUserResources.agentsMd.dirty" })}
            </span>
          ) : null}
        </div>
        <Textarea
          rows={10}
          value={draft}
          placeholder={format({ id: "settings.cloudUserResources.agentsMd.placeholder" })}
          aria-invalid={formError !== null}
          onChange={(event) => {
            setDraft(event.target.value);
            setDirty(true);
            setSaved(false);
            setFormError(null);
          }}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={pending === "agents-md-text"}
            onClick={() => void save()}
          >
            {format({ id: "common.save" })}
          </Button>
          <UserResourceInlineError text={formError} />
        </div>
        <span className="text-ui-base text-foreground-subtle">
          {format({ id: "settings.cloudUserResources.agentsMd.note" })}
        </span>
      </div>
    </>
  );
}

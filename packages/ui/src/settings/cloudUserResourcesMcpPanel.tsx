/**
 * MCP 条目面板（specs/cloud-agent/14 §3.2/§9.4①）。
 *
 * 录入方式 = 表单（entryId + displayName + JSON 配置文本域）：字段化录入的最终形状属 MCP
 * 契约（`packages/shared/src/mcp.ts`），UI 不复制其字段名，只做「是 JSON 对象且 ≤256KiB」
 * 的客户端预校验（14 §3.2 同一口径）；凭据字段（token/headers/env）随配置一起保存，
 * 面板明确标注"凭据随该条目只经认证通道下发到云沙箱"。
 *
 * 编辑回显走 `GET …/entries/mcp/:entryId`（14 §9.4①）——本批次为该端点存在的理由；
 * 保存后正文缓存由 hook 用 PUT 响应回填（sha256 对齐当前版本）。
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { userResourceEntryKey } from "@/cloud/userResourcesModel.js";
import { CloudSectionHint } from "@/settings/cloudRuntimeSectionParts.js";
import {
  describeUserResourceActionErrorText,
  UserResourceEntryRow,
  UserResourceGroupHeader,
  UserResourceInlineError,
} from "@/settings/cloudUserResourcesSectionParts.js";
import type { UseCloudUserResourcesResult } from "@/hooks/cloud/useCloudUserResources.js";

/** 编辑态：`entryId` 为空 = 新建。 */
interface McpEditorState {
  readonly entryId: string;
  readonly displayName: string;
  readonly configJson: string;
}

const EMPTY_EDITOR: McpEditorState = { entryId: "", displayName: "", configJson: "" };

export function CloudUserResourceMcpPanel({
  resources,
}: {
  resources: UseCloudUserResourcesResult;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const [editor, setEditor] = useState<McpEditorState>(EMPTY_EDITOR);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const format = intl.formatMessage.bind(intl);
  const mcpEntries = resources.entries.filter((entry) => entry.category === "mcp");
  const editingEntryId = editor.entryId.trim();
  const editingKey =
    editingEntryId.length === 0 ? null : userResourceEntryKey("mcp", editingEntryId);
  const editingExisting = mcpEntries.some((entry) => entry.entryId === editingEntryId);
  const editorContent = editingKey === null ? undefined : resources.contentByKey[editingKey];
  const editorContentStatus =
    editingKey === null ? undefined : resources.contentStatusByKey[editingKey];
  const editorLoading = editorContentStatus === "loading";
  const saving = editingKey !== null && resources.pendingByKey[editingKey] === "mcp-json";

  /**
   * 进入编辑态时按需拉一次正文（14 §9.4①）。
   *
   * 只在「本键从未尝试过」（status === undefined）时自动取数：失败后停在 error，
   * 由用户点"重新加载"显式重试——不做自动重试，避免视图 effect 与失败响应互相触发成环。
   */
  useEffect(() => {
    if (editingEntryId.length === 0 || editingExisting === false) return;
    if (editorContent !== undefined || editorContentStatus !== undefined) return;
    void resources.loadContent("mcp", editingEntryId);
  }, [editingEntryId, editingExisting, editorContent, editorContentStatus, resources]);

  const beginEdit = (entryId: string, displayName: string) => {
    setFormError(null);
    setSaved(false);
    setEditor({ entryId, displayName, configJson: "" });
  };

  // 回显到达后填进文本域：只在编辑态内容仍为空时写入，不覆盖用户正在输入的文本。
  useEffect(() => {
    if (editorContent === undefined) return;
    setEditor((current) => {
      if (current.configJson.trim().length > 0) return current;
      if (editorContent.payload.category !== "mcp") return current;
      return { ...current, configJson: JSON.stringify(editorContent.payload.config, null, 2) };
    });
  }, [editorContent]);

  const submit = async () => {
    setSaved(false);
    const result = await resources.saveMcpEntry({
      entryId: editor.entryId.trim(),
      configJson: editor.configJson,
      displayName: editor.displayName.trim().length === 0 ? undefined : editor.displayName.trim(),
    });
    if (!result.ok) {
      setFormError(describeUserResourceActionErrorText(result.error, format));
      return;
    }
    setFormError(null);
    setSaved(true);
    setEditor(EMPTY_EDITOR);
  };

  const removeEntry = async (entryId: string) => {
    const confirmed = await confirmDialog({
      title: format({ id: "settings.cloudUserResources.entry.deleteTitle" }),
      description: format(
        { id: "settings.cloudUserResources.entry.deleteDescription" },
        { name: entryId },
      ),
      confirmLabel: format({ id: "common.delete" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    if (editor.entryId.trim() === entryId) setEditor(EMPTY_EDITOR);
    await resources.remove("mcp", entryId);
  };

  return (
    <>
      <UserResourceGroupHeader
        title={format({ id: "settings.cloudUserResources.category.mcp" })}
        hint={format({ id: "settings.cloudUserResources.mcp.hint" })}
        count={mcpEntries.length}
      />
      {mcpEntries.length === 0 ? (
        <CloudSectionHint tone="muted">
          {format({ id: "settings.cloudUserResources.empty" })}
        </CloudSectionHint>
      ) : null}
      {mcpEntries.map((entry) => {
        const key = userResourceEntryKey("mcp", entry.entryId);
        const entryError = resources.errorByKey[key];
        return (
          <UserResourceEntryRow
            key={key}
            entry={entry}
            pendingLabel={
              resources.pendingByKey[key] === undefined
                ? null
                : format({ id: "settings.cloudUserResources.entry.pending" })
            }
            errorText={
              entryError === undefined
                ? null
                : describeUserResourceActionErrorText({ kind: "server", error: entryError }, format)
            }
            extraControl={
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => beginEdit(entry.entryId, entry.displayName ?? "")}
              >
                {format({ id: "settings.cloudUserResources.mcp.edit" })}
              </Button>
            }
            onEnabledChange={(enabled) => resources.setEnabled("mcp", entry.entryId, enabled)}
            onDelete={() => removeEntry(entry.entryId)}
          />
        );
      })}
      <div className="space-y-2 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-base font-medium text-foreground">
            {editor.entryId.trim().length === 0
              ? format({ id: "settings.cloudUserResources.mcp.new" })
              : format({ id: "settings.cloudUserResources.mcp.editing" }, { id: editor.entryId })}
          </span>
          {editorLoading ? (
            <span className="text-ui-base text-foreground-subtle">
              {format({ id: "settings.cloudUserResources.loading" })}
            </span>
          ) : null}
          {editorContentStatus === "error" ? (
            <>
              <span className="text-ui-base text-destructive" role="alert">
                {format({ id: "settings.cloudUserResources.error.contentLoad" })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void resources.loadContent("mcp", editingEntryId, { force: true })}
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
        </div>
        <div className="flex flex-wrap gap-2">
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-ui-base text-foreground-subtle">
              {format({ id: "settings.cloudUserResources.mcp.entryIdLabel" })}
            </span>
            <Input
              size="sm"
              value={editor.entryId}
              placeholder="primary"
              disabled={editingExisting}
              onChange={(event) => {
                // 改 entryId = 换一条（新建）；编辑已有条目时该输入被禁用，避免误造第二条。
                setEditor({
                  ...EMPTY_EDITOR,
                  displayName: editor.displayName,
                  entryId: event.target.value,
                });
                setFormError(null);
                setSaved(false);
              }}
            />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-ui-base text-foreground-subtle">
              {format({ id: "settings.cloudUserResources.mcp.displayNameLabel" })}
            </span>
            <Input
              size="sm"
              value={editor.displayName}
              onChange={(event) => setEditor({ ...editor, displayName: event.target.value })}
            />
          </label>
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-ui-base text-foreground-subtle">
            {format({ id: "settings.cloudUserResources.mcp.configLabel" })}
          </span>
          <Textarea
            rows={6}
            value={editor.configJson}
            placeholder={'{\n  "command": "npx",\n  "args": ["-y", "mcp-server"]\n}'}
            aria-invalid={formError !== null}
            onChange={(event) => {
              setEditor({ ...editor, configJson: event.target.value });
              setFormError(null);
              setSaved(false);
            }}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={saving || editor.entryId.trim().length === 0}
            onClick={() => void submit()}
          >
            {format({ id: "common.save" })}
          </Button>
          {editor.entryId.trim().length === 0 ? null : (
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditor(EMPTY_EDITOR)}>
              {format({ id: "common.cancel" })}
            </Button>
          )}
          <UserResourceInlineError text={formError} />
        </div>
        <span className="text-ui-base text-foreground-subtle">
          {format({ id: "settings.cloudUserResources.mcp.credentialsNote" })}
        </span>
      </div>
    </>
  );
}

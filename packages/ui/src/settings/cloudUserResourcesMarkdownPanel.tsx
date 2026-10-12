/**
 * 单文件 markdown 条目面板（commands / subagents；specs/cloud-agent/14 §4.5、W11 §13D）。
 *
 * 语义（14 §4.5 简化修订）：条目形态 = **单文件 markdown 文本**，`entryId` = 落盘文件名
 * `<name>.md`（同步时经既有 `writeCommandFile`/`createAgent` 落到沙箱）；同 key 重复保存 =
 * 幂等整条替换（覆盖语义，14 §4.7②）。因此本面板不提供归档上传（tar 解包环节已消除）。
 *
 * 录入形态参照 agents-md 编辑器：文件选择读文本（entryId 自动取文件名）或直接粘贴/手输；
 * 非法 entryId 在输入时即时提示（同一条 shared 校验规则，14 §4.5）。
 *
 * 编辑回显走 `GET …/entries/:category/:entryId`（14 §9.4①）；保存后正文缓存由 hook 用
 * PUT 响应回填（sha256 对齐当前版本）。
 */
import { useEffect, useRef, useState } from "react";
import {
  CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES,
  type CloudUserProfileMarkdownCategory,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import {
  CLOUD_USER_RESOURCES_MARKDOWN_ENTRY_ID_SUFFIX,
  formatUserResourceBytes,
  userResourceEntryKey,
  validateUserResourceMarkdownEntryId,
} from "@/cloud/userResourcesModel.js";
import { CloudSectionHint } from "@/settings/cloudRuntimeSectionParts.js";
import {
  describeUserResourceActionErrorText,
  UserResourceEntryRow,
  UserResourceGroupHeader,
  UserResourceInlineError,
} from "@/settings/cloudUserResourcesSectionParts.js";
import type { UseCloudUserResourcesResult } from "@/hooks/cloud/useCloudUserResources.js";

/** 编辑态：`entryId` 为空 = 新建。 */
interface MarkdownEditorState {
  readonly entryId: string;
  readonly displayName: string;
  readonly content: string;
}

const EMPTY_EDITOR: MarkdownEditorState = { entryId: "", displayName: "", content: "" };

export function CloudUserResourceMarkdownPanel({
  category,
  resources,
}: {
  category: CloudUserProfileMarkdownCategory;
  resources: UseCloudUserResourcesResult;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [editor, setEditor] = useState<MarkdownEditorState>(EMPTY_EDITOR);
  const [formError, setFormError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const format = intl.formatMessage.bind(intl);
  const categoryEntries = resources.entries.filter((entry) => entry.category === category);
  const editingEntryId = editor.entryId.trim();
  const editingKey =
    editingEntryId.length === 0 ? null : userResourceEntryKey(category, editingEntryId);
  const editingExisting = categoryEntries.some((entry) => entry.entryId === editingEntryId);
  const editorContent = editingKey === null ? undefined : resources.contentByKey[editingKey];
  const editorContentStatus =
    editingKey === null ? undefined : resources.contentStatusByKey[editingKey];
  const saving = editingKey !== null && resources.pendingByKey[editingKey] === "markdown-text";
  // 非法 entryId 即时提示（14 §4.5）：输入非空且不通过 shared 校验时给出原因文案。
  const entryIdFailure =
    editingEntryId.length === 0 ? null : validateUserResourceMarkdownEntryId(editingEntryId);
  const entryIdErrorText =
    entryIdFailure !== null && !entryIdFailure.ok
      ? describeUserResourceActionErrorText(
          { kind: "validation", failure: entryIdFailure.failure },
          format,
        )
      : null;

  /**
   * 进入编辑态时按需拉一次正文（14 §9.4①）。
   *
   * 只在「本键从未尝试过」（status === undefined）时自动取数：失败后停在 error，
   * 由用户点"重试"显式重试——不做自动重试，避免视图 effect 与失败响应互相触发成环。
   */
  useEffect(() => {
    if (editingEntryId.length === 0 || editingExisting === false) return;
    if (editorContent !== undefined || editorContentStatus !== undefined) return;
    void resources.loadContent(category, editingEntryId);
  }, [category, editingEntryId, editingExisting, editorContent, editorContentStatus, resources]);

  // 回显到达后填进文本域：只在编辑态正文仍为空时写入，不覆盖用户正在输入的文本。
  useEffect(() => {
    if (editorContent === undefined) return;
    setEditor((current) => {
      if (current.content.length > 0) return current;
      if (editorContent.payload.category !== category) return current;
      return { ...current, content: editorContent.payload.content };
    });
  }, [category, editorContent]);

  const beginEdit = (entryId: string, displayName: string) => {
    setFormError(null);
    setSaved(false);
    setEditor({ entryId, displayName, content: "" });
  };

  /** 文件选择：读文本 + entryId 自动取文件名（须匹配 `.md` 规则，非法由即时提示呈现）。 */
  const readFile = async (file: File) => {
    setSaved(false);
    setFormError(null);
    let content: string;
    try {
      content = await file.text();
    } catch {
      setFormError(format({ id: "settings.cloudUserResources.markdown.fileReadFailed" }));
      return;
    }
    setEditor({ entryId: file.name, displayName: file.name, content });
  };

  const submit = async () => {
    setSaved(false);
    const result = await resources.saveMarkdownEntry({
      category,
      entryId: editingEntryId,
      content: editor.content,
      displayName: editor.displayName.trim().length === 0 ? undefined : editor.displayName.trim(),
    });
    if (!result.ok) {
      setFormError(describeUserResourceActionErrorText(result.error, format));
      return;
    }
    setFormError(null);
    setSaved(true);
    setEditor(EMPTY_EDITOR);
    if (fileInputRef.current) fileInputRef.current.value = "";
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
    await resources.remove(category, entryId);
  };

  return (
    <>
      <UserResourceGroupHeader
        title={format({ id: `settings.cloudUserResources.category.${category}` })}
        hint={format(
          { id: "settings.cloudUserResources.markdown.hint" },
          {
            max: formatUserResourceBytes(CLOUD_USER_PROFILE_MARKDOWN_MAX_BYTES),
            suffix: CLOUD_USER_RESOURCES_MARKDOWN_ENTRY_ID_SUFFIX,
          },
        )}
        count={categoryEntries.length}
      />
      {categoryEntries.length === 0 ? (
        <CloudSectionHint tone="muted">
          {format({ id: "settings.cloudUserResources.empty" })}
        </CloudSectionHint>
      ) : null}
      {categoryEntries.map((entry) => {
        const key = userResourceEntryKey(entry.category, entry.entryId);
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
                {format({ id: "settings.cloudUserResources.markdown.edit" })}
              </Button>
            }
            onEnabledChange={(enabled) => resources.setEnabled(category, entry.entryId, enabled)}
            onDelete={() => removeEntry(entry.entryId)}
          />
        );
      })}
      <div className="space-y-2 border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-ui-base font-medium text-foreground">
            {editingEntryId.length === 0
              ? format({ id: "settings.cloudUserResources.markdown.new" })
              : format(
                  { id: "settings.cloudUserResources.markdown.editing" },
                  { id: editingEntryId },
                )}
          </span>
          {editingKey !== null && editorContentStatus === "loading" ? (
            <span className="text-ui-base text-foreground-subtle">
              {format({ id: "settings.cloudUserResources.loading" })}
            </span>
          ) : null}
          {editingKey !== null && editorContentStatus === "error" ? (
            <>
              <span className="text-ui-base text-destructive" role="alert">
                {format({ id: "settings.cloudUserResources.error.contentLoad" })}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() =>
                  void resources.loadContent(category, editingEntryId, { force: true })
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
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-ui-base text-foreground-subtle">
              {format({ id: "settings.cloudUserResources.markdown.entryIdLabel" })}
            </span>
            <Input
              size="sm"
              value={editor.entryId}
              placeholder={`my-${category === "commands" ? "command" : "agent"}.md`}
              disabled={editingExisting}
              aria-invalid={entryIdErrorText !== null}
              onChange={(event) => {
                // 改 entryId = 换一条（新建）；编辑已有条目时该输入被禁用，避免误造第二条。
                setEditor({
                  ...EMPTY_EDITOR,
                  displayName: editor.displayName,
                  content: editor.content,
                  entryId: event.target.value,
                });
                setFormError(null);
                setSaved(false);
              }}
            />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-ui-base text-foreground-subtle">
              {format({ id: "settings.cloudUserResources.markdown.displayNameLabel" })}
            </span>
            <Input
              size="sm"
              value={editor.displayName}
              onChange={(event) => setEditor({ ...editor, displayName: event.target.value })}
            />
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,text/markdown"
            className="hidden"
            onChange={(event) => {
              const file = event.currentTarget.files?.[0];
              if (file !== undefined) void readFile(file);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            {format({ id: "settings.cloudUserResources.markdown.pickFile" })}
          </Button>
        </div>
        {entryIdErrorText === null ? null : <UserResourceInlineError text={entryIdErrorText} />}
        <label className="flex flex-col gap-1">
          <span className="text-ui-base text-foreground-subtle">
            {format({ id: "settings.cloudUserResources.markdown.contentLabel" })}
          </span>
          <Textarea
            rows={8}
            value={editor.content}
            placeholder={format({ id: "settings.cloudUserResources.markdown.placeholder" })}
            aria-invalid={formError !== null}
            onChange={(event) => {
              setEditor({ ...editor, content: event.target.value });
              setFormError(null);
              setSaved(false);
            }}
          />
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            disabled={saving || entryIdErrorText !== null || editingEntryId.length === 0}
            onClick={() => void submit()}
          >
            {format({ id: "common.save" })}
          </Button>
          {editingEntryId.length === 0 ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                setEditor(EMPTY_EDITOR);
                setFormError(null);
                setSaved(false);
              }}
            >
              {format({ id: "common.cancel" })}
            </Button>
          )}
          <UserResourceInlineError text={formError} />
        </div>
        <span className="text-ui-base text-foreground-subtle">
          {format(
            { id: "settings.cloudUserResources.markdown.note" },
            { suffix: CLOUD_USER_RESOURCES_MARKDOWN_ENTRY_ID_SUFFIX },
          )}
        </span>
      </div>
    </>
  );
}

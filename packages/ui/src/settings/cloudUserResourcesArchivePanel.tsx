/**
 * 归档类类别面板（skills / plugins；specs/cloud-agent/14 §1.1/§4.3/§9.4）。
 *
 * 录入方式 = 归档上传（tar+gzip，上限取 shared 的类别常量）；同一 `entryId` 重复上传
 * 是**幂等整条替换**（PUT 语义），因此不提供"编辑"，只提供"上传/替换"。
 * commands/subagents 已改单文件 markdown 文本（`cloudUserResourcesMarkdownPanel`，14 §4.5）。
 *
 * 客户端只做便宜前置（entryId 形状、文件大小、base64 编码）；tar 的膨胀/穿越/manifest
 * 权威校验在沙箱既有导入服务（14 §4.4：上传侧不解析 tar，禁止第二套权威校验）。
 */
import { useRef, useState } from "react";
import {
  CLOUD_USER_PROFILE_ENTRY_MAX_BYTES,
  type CloudUserProfileArchiveCategory,
} from "@zcode/shared";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useConfirmDialog } from "@/hooks/useConfirmDialog.js";
import { formatUserResourceBytes, userResourceEntryKey } from "@/cloud/userResourcesModel.js";
import { CloudSectionHint } from "@/settings/cloudRuntimeSectionParts.js";
import {
  describeUserResourceActionErrorText,
  UserResourceEntryRow,
  UserResourceGroupHeader,
  UserResourceInlineError,
} from "@/settings/cloudUserResourcesSectionParts.js";
import type { UseCloudUserResourcesResult } from "@/hooks/cloud/useCloudUserResources.js";

export function CloudUserResourceArchivePanel({
  category,
  resources,
}: {
  category: CloudUserProfileArchiveCategory;
  resources: UseCloudUserResourcesResult;
}) {
  const { intl } = useZCodeIntl();
  const confirmDialog = useConfirmDialog();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [entryId, setEntryId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  const categoryEntries = resources.entries.filter((entry) => entry.category === category);
  const maxBytes = CLOUD_USER_PROFILE_ENTRY_MAX_BYTES[category];
  const format = intl.formatMessage.bind(intl);
  const categoryLabel = intl.formatMessage({
    id: `settings.cloudUserResources.category.${category}`,
  });
  const uploading = Object.entries(resources.pendingByKey).some(
    ([key, action]) => action === "upload" && key.startsWith(`${category}\u0000`),
  );

  const submit = async () => {
    if (!file) {
      setFormError(format({ id: "settings.cloudUserResources.archive.noFile" }));
      return;
    }
    setFormError(null);
    const result = await resources.uploadArchive({
      category,
      entryId: entryId.trim(),
      displayName: displayName.trim().length === 0 ? undefined : displayName.trim(),
      file,
    });
    if (result.ok) {
      setEntryId("");
      setDisplayName("");
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = "";
      return;
    }
    setFormError(describeUserResourceActionErrorText(result.error, format));
  };

  const removeEntry = async (id: string) => {
    const confirmed = await confirmDialog({
      title: format({ id: "settings.cloudUserResources.entry.deleteTitle" }),
      description: format(
        { id: "settings.cloudUserResources.entry.deleteDescription" },
        { name: id },
      ),
      confirmLabel: format({ id: "common.delete" }),
      confirmVariant: "destructive",
    });
    if (!confirmed) return;
    await resources.remove(category, id);
  };

  return (
    <>
      <UserResourceGroupHeader
        title={categoryLabel}
        hint={format(
          { id: "settings.cloudUserResources.archive.hint" },
          { max: formatUserResourceBytes(maxBytes) },
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
            onEnabledChange={(enabled) => resources.setEnabled(category, entry.entryId, enabled)}
            onDelete={() => removeEntry(entry.entryId)}
          />
        );
      })}
      <div className="border-t border-border px-4 py-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-ui-base text-foreground-subtle">
              {format({ id: "settings.cloudUserResources.archive.entryIdLabel" })}
            </span>
            <Input
              size="sm"
              value={entryId}
              placeholder="my-skill"
              onChange={(event) => {
                setEntryId(event.target.value);
                setFormError(null);
              }}
            />
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1">
            <span className="text-ui-base text-foreground-subtle">
              {format({ id: "settings.cloudUserResources.archive.displayNameLabel" })}
            </span>
            <Input
              size="sm"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
            />
          </label>
          <input
            ref={fileInputRef}
            type="file"
            accept=".tar.gz,application/gzip,application/x-gzip"
            className="hidden"
            onChange={(event) => {
              setFile(event.currentTarget.files?.[0] ?? null);
              setFormError(null);
            }}
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
          >
            {file === null
              ? format({ id: "settings.cloudUserResources.archive.chooseFile" })
              : file.name}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={uploading || entryId.trim().length === 0 || file === null}
            onClick={() => void submit()}
          >
            {format({ id: "settings.cloudUserResources.archive.upload" })}
          </Button>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="text-ui-base text-foreground-subtle">
            {format({ id: "settings.cloudUserResources.archive.entryIdHint" })}
          </span>
          <UserResourceInlineError text={formError} />
        </div>
      </div>
    </>
  );
}

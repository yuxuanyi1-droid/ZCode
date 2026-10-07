/**
 * 云项目仓库选择器（specs/cloud-agent/04 §3.1、09 §2.2、11 §4.1）。
 *
 * 用**原 Dialog 组件**承载，不新开页面（04 §3.0.1）。选择器必须能表达真实状态：
 * `not_configured`（部署未装配 installation 投影）与撤权/未安装是不同事实，
 * 不能都渲染成「没有仓库」（CT-02）。
 */
import { useState } from "react";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useCloudRepositories } from "@/hooks/cloud/useCloudRepositories.js";

interface CloudRepositoryPickerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (repositoryId: number) => Promise<void>;
}

/**
 * 仓库选择器（04 §3.1）：分页 / 搜索 / 空态 / 撤权与未安装引导，
 * 用**原 Dialog 组件**承载，不新开页面。
 */
export function CloudRepositoryPickerDialog({
  open,
  onOpenChange,
  onSubmit,
}: CloudRepositoryPickerDialogProps) {
  const { intl } = useZCodeIntl();
  const repositories = useCloudRepositories();
  const [submittingId, setSubmittingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const blocking = repositories.blockingReason;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="cloud-repository-picker">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "cloud.projects.pickerTitle" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "cloud.projects.description" })}
          </DialogDescription>
        </DialogHeader>

        <Input
          value={repositories.query}
          placeholder={intl.formatMessage({ id: "cloud.projects.pickerSearch" })}
          onChange={(event) => repositories.setQuery(event.target.value)}
        />

        {blocking === "not_configured" ? (
          <p className="text-ui-base text-destructive">
            {intl.formatMessage({ id: "settings.cloudRuntime.github.notConfigured" })}
          </p>
        ) : null}
        {blocking === "revoked" ? (
          <p className="text-ui-base text-destructive">
            {intl.formatMessage({ id: "settings.cloudRuntime.github.revoked" })}
          </p>
        ) : null}

        <ul className="max-h-72 overflow-y-auto" data-testid="cloud-repository-list">
          {repositories.repositories.map((repository) => (
            <li key={repository.repositoryId}>
              <button
                type="button"
                data-testid="cloud-repository-row"
                disabled={submittingId !== null}
                className="flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-ui-base text-foreground-subtle outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
                onClick={() => {
                  setError(null);
                  setSubmittingId(repository.repositoryId);
                  void onSubmit(repository.repositoryId)
                    .catch((submitError) => {
                      setError(
                        submitError instanceof Error ? submitError.message : String(submitError),
                      );
                    })
                    .finally(() => setSubmittingId(null));
                }}
              >
                <span className="min-w-0 flex-1 truncate">
                  {repository.owner}/{repository.name}
                </span>
                <span className="shrink-0 text-foreground-subtlest">{repository.availability}</span>
                {submittingId === repository.repositoryId ? (
                  <Loader2 aria-hidden="true" className="size-3.5 animate-spin" />
                ) : null}
              </button>
            </li>
          ))}
        </ul>

        {repositories.status === "ready" && repositories.repositories.length === 0 ? (
          <p className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "cloud.projects.pickerEmpty" })}
          </p>
        ) : null}
        {repositories.hasMore ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void repositories.loadMore()}
          >
            {intl.formatMessage({ id: "settings.cloudRuntime.github.loadMore" })}
          </Button>
        ) : null}
        {error ? (
          <p className="text-ui-base text-destructive" role="status">
            {error}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "cloud.projects.cancel" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

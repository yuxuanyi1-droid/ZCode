/**
 * 新建 Cloud Task 草稿对话框（specs/cloud-agent/04 §3.2、11 §5、CT-03/CT-11）。
 *
 * 规则：
 * - 用**原 Dialog 组件**承载（04 §3.0.1），列在侧栏项目行下，不新开页面。
 * - 只创建**持久 draft**：不建沙箱、不建 session、不做任何运行时 IO（04 §3.2.1）。
 * - `creationKey` 在提交前生成并随请求冻结；响应丢失后重试命中同一 Task（11 §5）。
 * - 启动配置在创建时一次收齐：`start` 请求必须与已保存的 `draftStartConfig` 一致，
 *   缺 provider 的 draft 会在首发被拒（03 §6 start 行），因此不提供「先建空 draft」。
 * - provider 候选来自控制面 capabilities（唯一目录来源）；分支来自控制面
 *   `/api/cloud/repositories/:id/branches`，不落 attachment 也不预热 session。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import type { CloudBranchRecord } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { logger } from "@/logger.js";
import { createCloudCreationKey } from "@/cloud/cloudDraftScope.js";
import { useCloudRepositories } from "@/hooks/cloud/useCloudRepositories.js";
import { useCloudTasks } from "@/hooks/cloud/useCloudTasks.js";

export interface CloudTaskCreateDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly projectId: string;
  readonly repositoryId: number | null;
  readonly defaultBranch: string | null;
  readonly providerNames: readonly string[];
  /** 创建成功后回调：由外层负责把 taskId 交给入口建立工作区。 */
  readonly onCreated: (taskId: string) => void;
}

export function CloudTaskCreateDialog({
  open,
  onOpenChange,
  projectId,
  repositoryId,
  defaultBranch,
  providerNames,
  onCreated,
}: CloudTaskCreateDialogProps) {
  const { intl } = useZCodeIntl();
  const tasks = useCloudTasks({ projectId });
  const repositories = useCloudRepositories();
  const [title, setTitle] = useState("");
  const [baseBranch, setBaseBranch] = useState(() => defaultBranch ?? "");
  const [provider, setProvider] = useState("");
  const [branches, setBranches] = useState<readonly CloudBranchRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // 同一次「新建任务」动作的 creationKey：无论重试多少次都用同一个 key（11 §5）。
  const [creationKey, setCreationKey] = useState(() => createCloudCreationKey());

  // 只有一个 provider 时直接采用；多个必须显式选择，不替用户猜。
  useEffect(() => {
    setProvider((current) => (current.length > 0 ? current : (providerNames[0] ?? "")));
  }, [providerNames]);

  useEffect(() => {
    if (!open || repositoryId === null) {
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const page = await repositories.listBranches(repositoryId);
        if (!cancelled) {
          setBranches(page.items);
        }
      } catch {
        // 分支取不到时保持空列表：不伪造默认分支，也不放行提交。
        if (!cancelled) {
          setBranches([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // listBranches 只随控制面端口变化，展开对话框时取一次即可。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, repositoryId, repositories.listBranches]);

  const canSubmit =
    !submitting &&
    title.trim().length > 0 &&
    baseBranch.trim().length > 0 &&
    provider.trim().length > 0;

  const submit = useCallback(async () => {
    if (!canSubmit) {
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const task = await tasks.createDraftTask({
        projectId,
        title: title.trim(),
        creationKey,
        draftStartConfig: { baseBranch: baseBranch.trim(), provider: provider.trim() },
      });
      setTitle("");
      setCreationKey(createCloudCreationKey());
      onOpenChange(false);
      onCreated(task.taskId);
    } catch (submitError) {
      // 保留 creationKey 与已填内容：用户重试时命中同一 Task（11 §5、CT-03）。
      const reason = submitError instanceof Error ? submitError.message : String(submitError);
      setError(intl.formatMessage({ id: "cloud.tasks.createFailed" }, { reason }));
      logger.warn("[cloud] 创建云任务失败", { projectId, reason });
    } finally {
      setSubmitting(false);
    }
  }, [
    baseBranch,
    canSubmit,
    creationKey,
    intl,
    onCreated,
    onOpenChange,
    projectId,
    provider,
    tasks,
    title,
  ]);

  const branchItems = useMemo(() => {
    const names = branches.map((branch) => branch.name);
    // 默认分支可能还没进入第一页列表，仍然要能选中它。
    if (baseBranch.length > 0 && !names.includes(baseBranch)) {
      return [baseBranch, ...names];
    }
    return names;
  }, [baseBranch, branches]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="cloud-task-create-dialog">
        <DialogHeader>
          <DialogTitle>{intl.formatMessage({ id: "cloud.tasks.new" })}</DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "cloud.projects.description" })}
          </DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "cloud.tasks.newTitleLabel" })}
          </span>
          <Input
            value={title}
            autoFocus
            maxLength={512}
            data-testid="cloud-task-new-title"
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "cloud.draftStartConfig.baseBranch" })}
          </span>
          <Select value={baseBranch} onValueChange={setBaseBranch}>
            <SelectTrigger className="w-full" data-testid="cloud-task-new-base-branch">
              <SelectValue
                placeholder={intl.formatMessage({ id: "cloud.draftStartConfig.baseBranch.empty" })}
              />
            </SelectTrigger>
            <SelectContent>
              {branchItems.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-ui-base text-foreground-subtle">
            {intl.formatMessage({ id: "cloud.draftStartConfig.provider" })}
          </span>
          <Select value={provider} onValueChange={setProvider}>
            <SelectTrigger className="w-full" data-testid="cloud-task-new-provider">
              <SelectValue
                placeholder={intl.formatMessage({ id: "cloud.draftStartConfig.provider.empty" })}
              />
            </SelectTrigger>
            <SelectContent>
              {providerNames.map((name) => (
                <SelectItem key={name} value={name}>
                  {name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
        {error ? (
          <p className="text-ui-base text-destructive" role="status">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
            {intl.formatMessage({ id: "cloud.projects.cancel" })}
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void submit()}>
            {submitting ? <Loader2 className="size-3.5 animate-spin" aria-hidden="true" /> : null}
            {intl.formatMessage({ id: "cloud.tasks.newSubmit" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

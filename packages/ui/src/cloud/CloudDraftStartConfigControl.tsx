/**
 * Cloud 草稿启动配置控件（specs/cloud-agent/04 §3.2/§3.4.1、11 §5、W8 §3「composer contextHeader」）。
 *
 * 放在**原 composer 的 contextHeader** 里（原草稿态已有 workspace 切换 + 分支切换），
 * 承载云草稿的三个受控选择：基础分支、provider、受控模板。
 *
 * 约束：
 * - 配置的唯一 owner 是控制面 Task 服务：本地编辑经 `PATCH` 带 `expectedRevision` 保存，
 *   并发冲突保留编辑并提示，**不覆盖**服务端事实（11 §5、CT-05）。
 * - 只有 `draft` 可写；进入 active 后只读展示（否则会改到已被接纳的 Run recipe，
 *   03 §6.1「后续 append 不能改写启动 recipe」）。
 * - 模板引用是服务端受控引用：能力声明里没有模板目录，因此这里只展示已保存值，
 *   不提供自由输入（不造看不见的写入路径）。
 * - 无沙箱 draft 不做任何运行时 IO：分支列表来自控制面 `/api/cloud/repositories/:id/branches`，
 *   不落 attachment、不预热 session（04 §3.4.1、11 §9）。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { ChevronDownIcon, GitBranchIcon, LoaderIcon, PackageIcon, ServerIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandList,
} from "@/components/ui/command.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { cn } from "@/components/lib/utils.js";
import type { CloudBranchRecord, CloudDraftStartConfig } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useCloudCapabilities } from "@/hooks/cloud/useCloudCapabilities.js";
import { useCloudTask } from "@/hooks/cloud/useCloudTask.js";
import { useCloudRepositories } from "@/hooks/cloud/useCloudRepositories.js";
import { useCloudProjects } from "@/hooks/cloud/useCloudProjects.js";

export interface CloudDraftStartConfigControlProps {
  /** 当前工作区身份对应的云任务（`cloud-task:<taskId>`）；控件按它读写启动配置。 */
  readonly taskId: string;
  /** 任务的 projectId；用于定位仓库以查询分支。 */
  readonly projectId?: string | null;
  readonly className?: string;
}

interface CloudDraftStartConfigState {
  readonly config: CloudDraftStartConfig | null;
  readonly editable: boolean;
  readonly saving: boolean;
  readonly error: string | null;
}

/**
 * 云草稿启动配置的读 / 写入口。
 *
 * 保存失败时**保留本地编辑**（11 §5 并发冲突保留编辑），只是把错误显示出来；
 * 下一次保存仍以服务端最新 revision 为期望值。
 */
export function useCloudDraftStartConfig(taskId: string): CloudDraftStartConfigState & {
  save(config: CloudDraftStartConfig): Promise<void>;
} {
  const { task, saveDraftStartConfig } = useCloudTask({ taskId });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const config = task?.draftStartConfig ?? null;
  // 只有 draft 可写；archived/active 等状态下启动配置已经被接纳事务固定（03 §6.1）。
  const editable = task?.status === "draft";

  const save = useCallback(
    async (next: CloudDraftStartConfig) => {
      if (!task) {
        return;
      }
      setSaving(true);
      setError(null);
      try {
        await saveDraftStartConfig(next, task.revision);
      } catch (saveError) {
        setError(saveError instanceof Error ? saveError.message : String(saveError));
      } finally {
        setSaving(false);
      }
    },
    [saveDraftStartConfig, task],
  );

  return useMemo(
    () => ({ config, editable, saving, error, save }),
    [config, editable, error, save, saving],
  );
}

export function CloudDraftStartConfigControl({
  taskId,
  projectId,
  className,
}: CloudDraftStartConfigControlProps) {
  const { config, editable, saving, error, save } = useCloudDraftStartConfig(taskId);
  const repositories = useCloudRepositories();
  const projects = useCloudProjects();
  const capabilities = useCloudCapabilities();
  const { intl } = useZCodeIntl();

  const repositoryId = useMemo(() => {
    const target = projects.projects.find((project) => project.projectId === projectId);
    return target?.repositoryId ?? null;
  }, [projectId, projects.projects]);

  const configValue = config?.provider ?? null;

  const [branches, setBranches] = useState<readonly CloudBranchRecord[]>([]);
  const [loadingBranches, setLoadingBranches] = useState(false);

  useEffect(() => {
    if (repositoryId === null) {
      setBranches([]);
      return;
    }
    let cancelled = false;
    setLoadingBranches(true);
    void (async () => {
      try {
        const page = await repositories.listBranches(repositoryId);
        if (!cancelled) {
          setBranches(page.items);
        }
      } catch {
        // 分支列表取不到时保持空列表 + 只读展示：不伪造默认分支。
        if (!cancelled) {
          setBranches([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingBranches(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // repositories.listBranches 由控制面端口决定，仓库变化才需要重取。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [repositoryId, repositories.listBranches]);

  const providerItems = useMemo(() => {
    const declared = capabilities.capabilities?.providers ?? [];
    const options = declared.map((provider) => provider.provider);
    // 已保存但当前能力声明里没有的 provider（例如部署换了 driver）仍要展示，
    // 否则用户看到的是「配置消失」而不是「该 provider 当前不可用」。
    if (configValue && !options.includes(configValue)) {
      return [configValue, ...options];
    }
    return options;
  }, [capabilities.capabilities, configValue]);

  if (!config) {
    // 还没保存过启动配置：不渲染半成品控件（首发会被 start 一致性校验拒绝）。
    return null;
  }

  return (
    <div className={cn("flex min-w-0 flex-wrap items-center gap-0", className)}>
      <DraftStartConfigPicker
        icon={<GitBranchIcon className="size-4 text-foreground-subtle" aria-hidden="true" />}
        triggerLabel={config.baseBranch}
        title={intl.formatMessage({ id: "cloud.draftStartConfig.baseBranch" })}
        testId="cloud-draft-start-config-base-branch"
        emptyLabel={intl.formatMessage({ id: "cloud.draftStartConfig.baseBranch.empty" })}
        disabled={!editable || saving || loadingBranches}
        loading={loadingBranches}
        items={branches.map((branch) => ({ value: branch.name, isDefault: branch.isDefault }))}
        selectedValue={config.baseBranch}
        onSelect={(value) => void save({ ...config, baseBranch: value })}
      />
      <DraftStartConfigPicker
        icon={<ServerIcon className="size-4 text-foreground-subtle" aria-hidden="true" />}
        triggerLabel={config.provider}
        title={intl.formatMessage({ id: "cloud.draftStartConfig.provider" })}
        testId="cloud-draft-start-config-provider"
        emptyLabel={intl.formatMessage({ id: "cloud.draftStartConfig.provider.empty" })}
        disabled={!editable || saving}
        loading={false}
        // provider 候选来自控制面 capabilities（唯一目录来源，不在 UI 侧另建列表）。
        items={providerItems.map((value) => ({ value, isDefault: false }))}
        selectedValue={config.provider}
        onSelect={(value) => void save({ ...config, provider: value })}
      />
      {config.templateRef ? (
        <span className="flex items-center gap-1.5 px-2 text-ui-base text-foreground-subtle">
          <PackageIcon className="size-3.5" aria-hidden="true" />
          <span className="sr-only">
            {intl.formatMessage({ id: "cloud.draftStartConfig.templateRef" })}
          </span>
          <span className="max-w-40 truncate">{config.templateRef}</span>
        </span>
      ) : null}
      {saving ? (
        <LoaderIcon className="size-3.5 animate-spin text-foreground-subtle" aria-hidden="true" />
      ) : null}
      {error ? (
        <span className="px-2 text-ui-base text-destructive" role="status">
          {error}
        </span>
      ) : null}
    </div>
  );
}

interface DraftStartConfigPickerProps {
  readonly icon: React.ReactNode;
  readonly triggerLabel: string;
  /** 无障碍标签与提示文案（本地化后的展示文本）。 */
  readonly title: string;
  readonly testId: string;
  readonly emptyLabel: string;
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly items: readonly { value: string; isDefault: boolean }[];
  readonly selectedValue: string;
  readonly onSelect: (value: string) => void;
}

function DraftStartConfigPicker({
  icon,
  triggerLabel,
  title,
  testId,
  emptyLabel,
  disabled,
  loading,
  items,
  selectedValue,
  onSelect,
}: DraftStartConfigPickerProps) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          data-testid={testId}
          aria-label={title}
          className="h-8 gap-1.5 px-2 text-ui-base font-normal text-foreground-subtle hover:text-foreground"
        >
          {icon}
          <span className="max-w-32 truncate">{triggerLabel}</span>
          {loading ? (
            <LoaderIcon className="size-3.5 animate-spin" aria-hidden="true" />
          ) : (
            <ChevronDownIcon className="size-3.5" aria-hidden="true" />
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        side="top"
        // 输入框在底部：锁定上方弹出，避免菜单遮挡输入区（与 GitBranchSwitcher 同款处理）。
        avoidCollisions={false}
        className="w-72 gap-0 bg-menu p-0"
      >
        <Command className="bg-transparent p-0 text-foreground">
          <CommandList className="max-h-72">
            <CommandEmpty className="px-4 py-5 text-foreground-subtle">{emptyLabel}</CommandEmpty>
            <CommandGroup className="space-y-0.5 p-1">
              {items.map((item) => (
                <CommandItem
                  key={item.value}
                  value={item.value}
                  data-checked={item.value === selectedValue ? "true" : undefined}
                  className="items-center gap-3 rounded-lg px-3 py-2 text-ui-base"
                  onSelect={() => onSelect(item.value)}
                >
                  <span className="min-w-0 flex-1 truncate text-left">{item.value}</span>
                  {item.isDefault ? (
                    <span className="text-ui-base text-foreground-subtle">default</span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

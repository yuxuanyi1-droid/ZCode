/**
 * 侧栏 Project → Task 区域（specs/cloud-agent/04 §3.0/§3.0.1/§3.1、11 §4/§5、W8 §3）。
 *
 * 这是「在原侧栏增加项目 → 任务数据与管理动作」的实现，**不是**另一套 Cloud 导航：
 * 它是原 `WorkspaceSidebar` 滚动区里的一个分组，样式与折叠行为沿用既有 section 规则，
 * 选中任务仍然走原任务选择语义（由外层把 taskId 交给入口去建立工作区）。
 *
 * 约束：
 * - 展开项目只查控制面 Task，**不连沙箱**（04 §3.1）；这里不 import 任何 execution 服务。
 * - 项目不带连接状态、不显示沙箱（Project 不持有沙箱）。
 * - 新建项目只有仓库一种类型，添加动作走**原 Dialog**（04 §3.0.1）。
 * - 草稿创建使用 `creationKey`，响应丢失后按原 key 重试仍得同一个 Task（11 §5、CT-03）。
 * - 未收到 Task 前不伪造「已创建」（04 §3.2.1）。
 */
import { useCallback, useMemo, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { CloudProjectRecord } from "@zcode/shared";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible.js";
import { cn } from "@/components/lib/utils.js";
import { CloudRepositoryPickerDialog } from "@/cloud/CloudRepositoryPickerDialog.js";
import type { UseCloudProjectsResult } from "@/hooks/cloud/useCloudProjects.js";
import { useCloudTasks } from "@/hooks/cloud/useCloudTasks.js";
import { useCloudCapabilities } from "@/hooks/cloud/useCloudCapabilities.js";
import { createCloudCreationKey } from "@/cloud/cloudDraftScope.js";
import { CloudArchivedTaskRow, CloudTaskRow } from "@/cloud/CloudProjectTaskRows.js";
import {
  projectCloudTasksForArchivedSection,
  projectCloudTasksForSidebar,
} from "@/cloud/cloudSidebarTaskList.js";
import { CloudTaskCreateDialog } from "@/cloud/CloudTaskCreateDialog.js";

export interface CloudProjectTaskSectionProps {
  /** 当前工作区身份对应的云任务（可选）：只用于高亮。 */
  readonly activeTaskId?: string | null;
  /** 选中任务：由外层负责把 taskId 交给入口建立/切换工作区。 */
  readonly onOpenTask: (taskId: string) => void;
  /** 「添加仓库」Dialog 的开关由**原项目区的分组头**持有（04 §3.0.1），这里只负责渲染。 */
  readonly repositoryPickerOpen: boolean;
  readonly onRepositoryPickerOpenChange: (open: boolean) => void;
  /**
   * 控制面 Project 投影：由侧栏持有唯一实例后传入，避免同一投影开出第二份订阅与第二次
   * `GET /api/cloud/projects`（侧栏顶部的「新建任务」也要用它决定去向）。
   */
  readonly projects: UseCloudProjectsResult;
  /**
   * 当前正在创建草稿的项目 id（null = 没有打开创建 Dialog）。
   * 由侧栏持有：顶部「新建任务」与项目行内的「新建任务」共用**同一个** Dialog。
   */
  readonly createTaskProjectId: string | null;
  readonly onCreateTaskProjectIdChange: (projectId: string | null) => void;
  readonly className?: string;
}

export function CloudProjectTaskSection({
  activeTaskId,
  onOpenTask,
  repositoryPickerOpen,
  onRepositoryPickerOpenChange,
  projects,
  createTaskProjectId,
  onCreateTaskProjectIdChange,
  className,
}: CloudProjectTaskSectionProps) {
  const { intl } = useZCodeIntl();
  const capabilities = useCloudCapabilities();
  const [openProjectId, setOpenProjectId] = useState<string | null>(null);

  // provider 候选来自控制面 capabilities（唯一目录来源，UI 不另建列表）。
  const providerNames = useMemo(
    () => (capabilities.capabilities?.providers ?? []).map((entry) => entry.provider),
    [capabilities.capabilities],
  );
  const createTaskProject = useMemo(
    () =>
      createTaskProjectId === null
        ? null
        : (projects.projects.find((project) => project.projectId === createTaskProjectId) ?? null),
    [createTaskProjectId, projects.projects],
  );

  const handleToggle = useCallback((projectId: string, open: boolean) => {
    setOpenProjectId(open ? projectId : null);
  }, []);

  return (
    // 这是**原侧栏项目区的列表本体**（specs/cloud-agent 04 §3.0/§3.0.1）：
    // 容器、分组头、标题（`workspaceSidebar.projectsSection`）与「添加」动作都由外层
    // `WorkspacePurposeSection` 提供，云模式复用同一套，不新造标题、也不另起分区。
    <div
      className={cn("flex min-h-0 flex-col gap-0.5", className)}
      data-testid="cloud-project-list-body"
    >
      {projects.status === "loading" && projects.projects.length === 0 ? (
        <p className="px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "settings.cloudRuntime.loading" })}
        </p>
      ) : null}

      {projects.status === "error" && projects.error ? (
        <div className="flex items-center gap-1 px-3 py-2">
          <span className="min-w-0 flex-1 truncate text-ui-base text-destructive">
            {projects.error}
          </span>
          <button
            type="button"
            aria-label={intl.formatMessage({ id: "settings.cloudRuntime.retry" })}
            data-testid="cloud-project-retry"
            className="flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtle outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
            onClick={() => void projects.refresh()}
          >
            <RefreshCw aria-hidden="true" className="size-3.5" />
          </button>
        </div>
      ) : null}

      {projects.projects.length === 0 &&
      projects.status !== "loading" &&
      projects.status !== "error" ? (
        // 空态沿用**原项目区文案**：云模式下项目区就是云 Project 投影（04 §3.0.1）。
        <div className="px-3 py-2 text-ui-base text-foreground-subtle">
          {intl.formatMessage({ id: "workspaceSidebar.noProjects" })}
        </div>
      ) : null}

      {projects.projects.length === 0 ? null : (
        <ul className="flex min-h-0 flex-col gap-0.5" data-testid="cloud-project-list">
          {projects.projects.map((project) => (
            <li key={project.projectId}>
              <CloudProjectRow
                project={project}
                open={openProjectId === project.projectId}
                onOpenChange={(open) => handleToggle(project.projectId, open)}
                activeTaskId={activeTaskId ?? null}
                onOpenTask={onOpenTask}
                onRequestCreateTask={onCreateTaskProjectIdChange}
                onRemove={() => void projects.deleteProject(project.projectId)}
              />
            </li>
          ))}
        </ul>
      )}

      {createTaskProject !== null ? (
        // 只在需要时挂载：Dialog 内部会取该项目的 Task 列表、分支与 provider 候选，
        // 常驻挂载会为「没在创建」的状态白白多发请求。
        <CloudTaskCreateDialog
          key={createTaskProject.projectId}
          open
          onOpenChange={(open) => {
            if (!open) {
              onCreateTaskProjectIdChange(null);
            }
          }}
          projectId={createTaskProject.projectId}
          repositoryId={createTaskProject.repositoryId ?? null}
          defaultBranch={createTaskProject.defaultBranch ?? null}
          providerNames={providerNames}
          onCreated={onOpenTask}
        />
      ) : null}

      <CloudRepositoryPickerDialog
        open={repositoryPickerOpen}
        onOpenChange={onRepositoryPickerOpenChange}
        onSubmit={async (repositoryId) => {
          // creationKey 在提交前生成并随请求冻结：响应丢失后按原 key 重试仍得到同一项目
          // （03 §6、CT-01）。失败时把 key 留在本轮闭包里，由用户重试同一动作。
          await projects.createProject(repositoryId, { creationKey: createCloudCreationKey() });
          onRepositoryPickerOpenChange(false);
        }}
      />
    </div>
  );
}

interface CloudProjectRowProps {
  readonly project: CloudProjectRecord;
  readonly open: boolean;
  readonly activeTaskId: string | null;
  readonly onOpenTask: (taskId: string) => void;
  readonly onRequestCreateTask: (projectId: string) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly onRemove: () => void;
}

function CloudProjectRow({
  project,
  open,
  activeTaskId,
  onOpenTask,
  onRequestCreateTask,
  onOpenChange,
  onRemove,
}: CloudProjectRowProps) {
  const { intl } = useZCodeIntl();
  const label = describeCloudProjectLabel(project);

  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="group/project flex h-7 min-w-0 items-center rounded-md hover:bg-hover">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-testid="cloud-project-row"
            className="flex h-7 min-w-0 flex-1 items-center gap-1 px-1.5 text-left text-ui-base text-foreground-subtle outline-none focus-visible:ring-2 focus-visible:ring-ring/30"
          >
            {open ? (
              <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
            ) : (
              <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 truncate">{label}</span>
          </button>
        </CollapsibleTrigger>
        <button
          type="button"
          aria-label={intl.formatMessage({ id: "cloud.projects.remove" })}
          title={intl.formatMessage({ id: "cloud.projects.remove" })}
          data-testid="cloud-project-remove"
          className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-foreground-subtlest opacity-0 outline-none transition-opacity hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30 group-hover/project:opacity-100 [@media(hover:none)]:opacity-100"
          onClick={onRemove}
        >
          <Trash2 aria-hidden="true" className="size-3.5" />
        </button>
      </div>
      <CollapsibleContent>
        {/* 只有展开时才挂载 Task 列表：折叠的项目不发 listProjectTasks（04 §3.1）。 */}
        {open ? (
          <CloudProjectTaskList
            projectId={project.projectId}
            activeTaskId={activeTaskId}
            onOpenTask={onOpenTask}
            onRequestCreateTask={onRequestCreateTask}
          />
        ) : null}
      </CollapsibleContent>
    </Collapsible>
  );
}

interface CloudProjectTaskListProps {
  readonly projectId: string;
  readonly activeTaskId: string | null;
  readonly onOpenTask: (taskId: string) => void;
  /** 交给上层（项目区）打开**同一个**云任务创建 Dialog。 */
  readonly onRequestCreateTask: (projectId: string) => void;
}

function CloudProjectTaskList({
  projectId,
  activeTaskId,
  onOpenTask,
  onRequestCreateTask,
}: CloudProjectTaskListProps) {
  const { intl } = useZCodeIntl();
  const tasks = useCloudTasks({ projectId });
  // 归档分区（04 §3 2026-10-08 巡检修订）：默认收起，头部显示数量；恢复入口在行内。
  const [archivedSectionOpen, setArchivedSectionOpen] = useState(false);
  const archivedTasks = useMemo(
    () => projectCloudTasksForArchivedSection(tasks.tasks),
    [tasks.tasks],
  );

  return (
    <div className="flex flex-col gap-0.5 pb-1 pl-4 pr-1">
      <div className="flex min-w-0 items-center">
        <button
          type="button"
          data-testid="cloud-task-new"
          className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left text-ui-base text-foreground-subtlest outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
          onClick={() => onRequestCreateTask(projectId)}
        >
          <Plus aria-hidden="true" className="size-3.5" />
          <span className="truncate">{intl.formatMessage({ id: "cloud.tasks.new" })}</span>
        </button>
        {tasks.status === "loading" ? (
          <Loader2
            aria-hidden="true"
            className="mr-1 size-3.5 animate-spin text-foreground-subtlest"
          />
        ) : null}
      </div>

      {tasks.tasks.length === 0 && tasks.status !== "loading" ? (
        <p className="px-1.5 text-ui-base leading-6 text-foreground-subtlest">
          {tasks.status === "error" && tasks.error
            ? tasks.error
            : intl.formatMessage({ id: "cloud.tasks.empty" })}
        </p>
      ) : null}

      <ul className="flex flex-col gap-0.5" data-testid="cloud-task-list">
        {projectCloudTasksForSidebar(tasks.tasks).map((task) => (
          <li key={task.taskId}>
            <CloudTaskRow
              task={task}
              selected={task.taskId === activeTaskId}
              onOpen={() => onOpenTask(task.taskId)}
            />
          </li>
        ))}
      </ul>

      {archivedTasks.length > 0 ? (
        // 已归档分区：可折叠、默认收起。归档不再是死胡同——行内可恢复（04 §3 巡检修订）。
        <Collapsible open={archivedSectionOpen} onOpenChange={setArchivedSectionOpen}>
          <div className="mt-1 flex h-6 min-w-0 items-center rounded-md">
            <CollapsibleTrigger asChild>
              <button
                type="button"
                data-testid="cloud-task-archived-section"
                className="flex h-6 min-w-0 flex-1 items-center gap-1 rounded-md px-1.5 text-left text-ui-base text-foreground-subtlest outline-none hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/30"
              >
                {archivedSectionOpen ? (
                  <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                ) : (
                  <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                )}
                <span className="truncate">
                  {intl.formatMessage(
                    { id: "cloud.tasks.archivedSection" },
                    { count: archivedTasks.length },
                  )}
                </span>
              </button>
            </CollapsibleTrigger>
          </div>
          <CollapsibleContent>
            {archivedSectionOpen ? (
              <ul className="flex flex-col gap-0.5" data-testid="cloud-task-archived-list">
                {archivedTasks.map((task) => (
                  <li key={task.taskId}>
                    <CloudArchivedTaskRow
                      task={task}
                      selected={task.taskId === activeTaskId}
                      onOpen={() => onOpenTask(task.taskId)}
                    />
                  </li>
                ))}
              </ul>
            ) : null}
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </div>
  );
}

/** 项目展示名：owner/name 优先，其次 displayName，最后回退 projectId。 */
export function describeCloudProjectLabel(project: CloudProjectRecord): string {
  return project.repoOwner && project.repoName
    ? `${project.repoOwner}/${project.repoName}`
    : (project.displayName ?? project.projectId);
}

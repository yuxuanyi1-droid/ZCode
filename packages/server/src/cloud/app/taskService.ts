/**
 * Task 应用服务：Project / Task / draftStartConfig / revision（W1 §3；
 * 03 §6 projects/tasks 端点行、11 §4/§5 创建与草稿、08 §3.1 状态表）。
 *
 * 规则要点：
 * - Project 的授权事实来自本端口的 GitHubPort（11 §4.3：客户端的 repo slug/installationId
 *   不能自证权限，请求只提交 repositoryId）。
 * - 同 principal 同 repositoryId 重复添加返回既有 Project（11 §4.4）。
 * - Task 草稿用稳定 creationKey 去重，响应丢失以原 key 恢复不重复创建（11 §5）；
 *   workspaceIdentity 首次创建即固定为 `cloud-task:<taskId>`（08 §4.1）。
 * - PATCH 只接受标题与 draftStartConfig + expectedRevision，启动配置只在 draft 可改
 *   （03 §6 PATCH tasks 行）。
 * - 跨主体资源统一 not_found，不泄漏存在性（03 §3）。
 */
import {
  buildCloudTaskWorkspaceIdentity,
  type CloudProjectRecord,
  type CloudTaskRecord,
} from "@zcode/shared";
import { blocksProjectDeletion } from "../domain/taskRunState.js";
import type { CloudCoreDeps } from "./deps.js";
import { fail, ok, type CloudAppResult } from "./result.js";

export interface CreateProjectInput {
  principalId: string;
  repositoryId: number;
  displayName?: string;
}

export interface CreateTaskInput {
  principalId: string;
  projectId: string;
  title: string;
  creationKey: string;
  draftStartConfig?: CloudTaskRecord["draftStartConfig"];
}

export interface PatchTaskInput {
  principalId: string;
  taskId: string;
  expectedRevision: number;
  title?: string;
  draftStartConfig?: CloudTaskRecord["draftStartConfig"];
}

export interface TaskService {
  createProject(input: CreateProjectInput): Promise<CloudAppResult<CloudProjectRecord>>;
  listProjects(input: {
    principalId: string;
    cursor?: string;
    limit?: number;
  }): Promise<CloudAppResult<{ items: CloudProjectRecord[]; nextCursor?: string }>>;
  patchProject(input: {
    principalId: string;
    projectId: string;
    expectedRevision: number;
    displayName?: string;
  }): Promise<CloudAppResult<CloudProjectRecord>>;
  deleteProject(input: {
    principalId: string;
    projectId: string;
  }): Promise<CloudAppResult<{ deleted: true }>>;
  createTask(input: CreateTaskInput): Promise<CloudAppResult<CloudTaskRecord>>;
  getTask(input: { principalId: string; taskId: string }): Promise<CloudAppResult<CloudTaskRecord>>;
  listTasks(input: {
    principalId: string;
    projectId: string;
    cursor?: string;
    limit?: number;
  }): Promise<CloudAppResult<{ items: CloudTaskRecord[]; nextCursor?: string }>>;
  patchTask(input: PatchTaskInput): Promise<CloudAppResult<CloudTaskRecord>>;
}

const DEFAULT_LIMIT = 50;
const DELETE_SCAN_MAX_PAGES = 50;

export function createTaskService(deps: CloudCoreDeps): TaskService {
  const { storage, github, clock, ids } = deps;

  async function ownedProject(principalId: string, projectId: string) {
    const project = await storage.projects.get(projectId);
    if (!project || project.ownerPrincipalId !== principalId) return null;
    return project;
  }

  async function ownedTask(principalId: string, taskId: string) {
    const task = await storage.tasks.get(taskId);
    if (!task || task.ownerPrincipalId !== principalId) return null;
    return task;
  }

  return {
    async createProject(input) {
      // 11 §4.3：按 repositoryId 取权威 owner/name/defaultBranch；请求不携带这些字段。
      const repository = await github.getRepository(input.repositoryId);
      if (!repository) {
        return fail("not_found", "repository-not-authorized");
      }
      if (repository.availability === "unavailable") {
        // 授权投影不可用 ≠ 仓库已删除：不冒充 not_found，也不落库（09 §2.2）。
        return fail("network_unknown", "repository-availability-unknown", {
          repositoryId: repository.repositoryId,
        });
      }
      const existing = await storage.projects.findByRepository(
        input.principalId,
        input.repositoryId,
      );
      if (existing) return ok(existing);
      const now = clock.now();
      const project = await storage.projects.createOrGet({
        projectId: ids.newId(),
        ownerPrincipalId: input.principalId,
        kind: "github-repo",
        repositoryId: repository.repositoryId,
        installationId: repository.installationId,
        repoOwner: repository.owner,
        repoName: repository.name,
        defaultBranch: repository.defaultBranch,
        displayName: input.displayName,
        now,
      });
      return ok(project);
    },

    async listProjects(input) {
      const page = await storage.projects.list(input.principalId, {
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_LIMIT,
      });
      return ok(page);
    },

    async patchProject(input) {
      const project = await ownedProject(input.principalId, input.projectId);
      if (!project) return fail("not_found", "project-not-found");
      const updated = await storage.projects.patchMetadata({
        projectId: project.projectId,
        expectedRevision: input.expectedRevision,
        displayName: input.displayName,
        now: clock.now(),
      });
      if (!updated) {
        // 03 §6：revision CAS 不匹配即 stale，不静默覆盖另一设备的编辑（11 §5）。
        return fail("stale", "project-revision-mismatch");
      }
      return ok(updated);
    },

    async deleteProject(input) {
      const project = await ownedProject(input.principalId, input.projectId);
      if (!project) return fail("not_found", "project-not-found");
      // 03 §6 / 08 §9：默认有活动任务时 409，不级联丢历史。
      let cursor: string | undefined;
      for (let page = 0; page < DELETE_SCAN_MAX_PAGES; page += 1) {
        const tasks = await storage.tasks.listByProject(project.projectId, { cursor, limit: 100 });
        for (const task of tasks.items) {
          const activeRun = await storage.runs.activeOfTask(task.taskId);
          if (blocksProjectDeletion(task, activeRun)) {
            return fail("validation_failed", "project-has-tasks", { taskId: task.taskId });
          }
        }
        if (!tasks.nextCursor) return ok({ deleted: true as const });
        cursor = tasks.nextCursor;
      }
      // 扫描上限内无法确认「无活动任务」时保守拒绝，不冒险删除历史。
      return fail("validation_failed", "project-task-scan-incomplete");
    },

    async createTask(input) {
      const project = await ownedProject(input.principalId, input.projectId);
      if (!project) return fail("not_found", "project-not-found");
      // 11 §5：稳定 creationKey 去重（响应丢失用原 key 恢复）。
      const existing = await storage.tasks.findByCreationKey(input.principalId, input.creationKey);
      if (existing) {
        if (existing.projectId !== project.projectId) {
          return fail("idempotency_conflict", "creation-key-project-mismatch");
        }
        return ok(existing);
      }
      const taskId = ids.newId();
      const created = await storage.tasks.createDraft({
        taskId,
        ownerPrincipalId: input.principalId,
        projectId: project.projectId,
        title: input.title,
        creationKey: input.creationKey,
        draftStartConfig: input.draftStartConfig,
        // 08 §4.1：首次创建固定 cloud-task:<taskId>，跨 provider/run 永不改变。
        workspaceIdentity: buildCloudTaskWorkspaceIdentity(taskId),
        now: clock.now(),
      });
      return ok(created);
    },

    async getTask(input) {
      const task = await ownedTask(input.principalId, input.taskId);
      if (!task) return fail("not_found", "task-not-found");
      return ok(task);
    },

    async listTasks(input) {
      const project = await ownedProject(input.principalId, input.projectId);
      if (!project) return fail("not_found", "project-not-found");
      const page = await storage.tasks.listByProject(project.projectId, {
        cursor: input.cursor,
        limit: input.limit ?? DEFAULT_LIMIT,
      });
      return ok(page);
    },

    async patchTask(input) {
      const task = await ownedTask(input.principalId, input.taskId);
      if (!task) return fail("not_found", "task-not-found");
      if (input.draftStartConfig !== undefined && task.status !== "draft") {
        // 03 §6/11 §5：启动配置只在 draft 可改；active 上的新选择必须走 start/reopen 冲突路径。
        return fail("validation_failed", "draft-start-config-frozen", { status: task.status });
      }
      const updated = await storage.tasks.patchMetadata({
        taskId: task.taskId,
        expectedRevision: input.expectedRevision,
        title: input.title,
        draftStartConfig: input.draftStartConfig,
        now: clock.now(),
      });
      if (!updated) return fail("stale", "task-revision-mismatch");
      return ok(updated);
    },
  };
}

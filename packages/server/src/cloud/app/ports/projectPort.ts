/**
 * Project 持久端口（specs/cloud-agent 03 §4 projects 表、11 §4）。W2 实现。
 */
import type { CloudProjectRecord } from "@zcode/shared";
import type { CursorPage } from "./cursorPage.js";

export interface CreateProjectRequest {
  projectId: string;
  ownerPrincipalId: string;
  kind: "github-repo";
  repositoryId: number;
  installationId: number;
  repoOwner: string;
  repoName: string;
  defaultBranch?: string;
  displayName?: string;
  now: number;
}

export interface ProjectRepo {
  /**
   * 读取未归档 Project。`includeArchived` 只给 deleteProject 的幂等探测使用：
   * 普通读路径保持「已归档 = 不可见」（15 §R3、03 §6）。
   */
  get(
    projectId: string,
    options?: { includeArchived?: boolean },
  ): Promise<CloudProjectRecord | null>;
  /** 同 principal 同 repositoryId 重复添加返回既有 Project（11 §4.4 唯一约束）。 */
  findByRepository(principalId: string, repositoryId: number): Promise<CloudProjectRecord | null>;
  createOrGet(request: CreateProjectRequest): Promise<CloudProjectRecord>;
  list(
    principalId: string,
    page: { cursor?: string; limit: number },
  ): Promise<CursorPage<CloudProjectRecord>>;
  /** 展示元数据 CAS：expectedRevision 不匹配返回 null，不静默覆盖另一设备（11 §5）。 */
  patchMetadata(request: {
    projectId: string;
    expectedRevision: number;
    displayName?: string;
    now: number;
  }): Promise<CloudProjectRecord | null>;
  /**
   * 软删除（15 §R3、03 §6 deleteProject「明确归档，不静默销毁」）：
   * `UPDATE ... SET archived_at=?, updated_at=? WHERE project_id=? AND archived_at IS NULL`。
   * 首次归档返回 true；已归档时不做第二次写入（保留首次归档时间），返回 false。
   * 任务历史与外键保持完整，不级联删除。
   */
  archive(projectId: string, now: number): Promise<boolean>;
}

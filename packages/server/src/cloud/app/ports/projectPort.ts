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
  get(projectId: string): Promise<CloudProjectRecord | null>;
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
}

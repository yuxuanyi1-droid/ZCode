/**
 * Task 持久端口（specs/cloud-agent 03 §4 tasks 表、08 §2/§3.1、11 §4/§5）。W2 实现。
 */
import type {
  CloudDraftStartConfig,
  CloudTaskArtifactRecord,
  CloudTaskRecord,
  CloudTaskStatus,
} from "@zcode/shared";
import type { CursorPage } from "./cursorPage.js";

export interface CreateDraftTaskRequest {
  taskId: string;
  ownerPrincipalId: string;
  projectId: string;
  title: string;
  /** 稳定创建键：(owner, creationKey) 唯一，响应丢失用原 key 恢复（11 §5）。 */
  creationKey: string;
  draftStartConfig?: CloudDraftStartConfig;
  /** 首次创建即固定 `cloud-task:<taskId>`（08 §4.1）。 */
  workspaceIdentity: string;
  now: number;
}

export interface TaskRepo {
  get(taskId: string): Promise<CloudTaskRecord | null>;
  findByCreationKey(ownerPrincipalId: string, creationKey: string): Promise<CloudTaskRecord | null>;
  createDraft(request: CreateDraftTaskRequest): Promise<CloudTaskRecord>;
  listByProject(
    projectId: string,
    page: { cursor?: string; limit: number },
  ): Promise<CursorPage<CloudTaskRecord>>;
  /** 标题/draftStartConfig 的 revision CAS；只在 draft 接受 draftStartConfig（11 §5）。 */
  patchMetadata(request: {
    taskId: string;
    expectedRevision: number;
    title?: string;
    draftStartConfig?: CloudDraftStartConfig;
    now: number;
  }): Promise<CloudTaskRecord | null>;
  /**
   * 状态迁移 CAS：`from` 列表不匹配返回 null（08 §3.1 允许操作表）。
   *
   * `revision` 是**新的 revision**（必须严格大于当前值），不是 CAS 期望值——这条最容易误用。
   * 期望值形式的 CAS 只在 `patchMetadata.expectedRevision` 与 `setCompleteRequested.expectedRevision`。
   */
  transitionStatus(request: {
    taskId: string;
    from: readonly CloudTaskStatus[];
    to: CloudTaskStatus;
    revision: number;
    activeRunId?: string | null;
    archivedFromStatus?: CloudTaskStatus;
    completeRequested?: boolean;
    now: number;
  }): Promise<CloudTaskRecord | null>;
  /** 首次接纳冻结基线/任务分支（11 §6：之后草稿选择不覆盖已冻结事实）。 */
  freezeBaseline(request: {
    taskId: string;
    baseBranch: string;
    baseSha: string;
    taskBranch: string;
    now: number;
  }): Promise<CloudTaskRecord>;
  /** 记录最近确认 checkpoint 的 remote SHA（08 §8.2）。 */
  recordCheckpointSha(request: { taskId: string; remoteSha: string; now: number }): Promise<void>;
  /**
   * 写产物投影（W2 口径确认）：**不接受 `now`**，审计时间用 worker 真实时钟。
   */
  recordArtifact(artifact: CloudTaskArtifactRecord): Promise<void>;
  /**
   * 持久验收意图（08 §9「用户 complete 先持久验收意图」，W1 CR-6）：revision CAS；
   * 一旦置位即阻断新输入/写入，最终 completed 仍需保存/产物核验与活动 Run 终止确认。
   */
  setCompleteRequested(request: {
    taskId: string;
    expectedRevision: number;
    requested: boolean;
    now: number;
  }): Promise<CloudTaskRecord | null>;
}

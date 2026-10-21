import { createHash } from "node:crypto";

import type {
  CloudInputDto,
  CloudProjectDto,
  CloudRunSummaryDto,
  CloudTaskDto,
} from "@zcode/cloud-protocol";

import type { InputRecord, ProjectRecord, RunRecord, TaskRecord } from "../domain/types.js";
import type { CloudStore } from "../adapters/storage/db.js";

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isTerminalRun(run: RunRecord): boolean {
  return run.status === "stopped" || run.status === "expired" || run.status === "failed";
}

export function parseGitHubRepo(repoUrl: string): { owner: string; name: string } | null {
  const match = /github\.com[/:]([^/]+)\/([^/?#]+?)(?:\.git)?$/u.exec(repoUrl.trim());
  if (!match?.[1] || !match[2]) {
    return null;
  }
  return { owner: match[1], name: match[2] };
}

export function parseRepoUrl(repoUrl: string): { owner: string; name: string } {
  const cleaned = repoUrl.replace(/\.git$/u, "").replace(/\/+$/u, "");
  if (cleaned.includes("@") && cleaned.includes(":")) {
    const tail = cleaned.split(":").pop() ?? cleaned;
    const parts = tail.split("/").filter(Boolean);
    return { owner: parts.at(-2) ?? "local", name: parts.at(-1) ?? "repo" };
  }
  const parts = cleaned.split("/").filter(Boolean);
  return { owner: parts.at(-2) ?? "local", name: parts.at(-1) ?? "repo" };
}

export function toProjectDto(project: ProjectRecord): CloudProjectDto {
  return {
    id: project.id,
    name: project.name,
    repoUrl: project.repoUrl,
    repoOwner: project.repoOwner,
    repoName: project.repoName,
    defaultBranch: project.defaultBranch,
    createdAt: project.createdAt,
  };
}

export function toRunDto(run: RunRecord | null): CloudRunSummaryDto | null {
  if (!run) {
    return null;
  }
  return {
    id: run.id,
    generation: run.generation,
    status: run.status,
    provider: run.provider,
    checkoutPath: run.checkoutPath,
    lastError: run.lastError,
    dataAtRisk: run.dataAtRisk,
    createdAt: run.createdAt,
    readyAt: run.readyAt,
    endedAt: run.endedAt,
  };
}

export function toTaskDto(store: CloudStore, task: TaskRecord): CloudTaskDto {
  const active = task.activeRunId ? store.getRun(task.activeRunId) : null;
  // 无 active run 时回退到最近一次 Run，UI 需要展示终态与诊断。
  const run = active ?? store.listRuns(task.id)[0] ?? null;
  const artifact = store.getArtifact(task.id);
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    taskStableId: task.taskStableId,
    workspaceIdentity: task.workspaceIdentity,
    baseBranch: task.baseBranch,
    baseSha: task.baseSha,
    taskBranch: task.taskBranch,
    activeRunId: task.activeRunId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    run: toRunDto(run),
    artifact: artifact
      ? {
          kind: artifact.kind,
          taskBranch: artifact.taskBranch,
          prNumber: artifact.prNumber,
          prUrl: artifact.prUrl,
          prStatus: artifact.prStatus,
          publishedSha: artifact.publishedSha,
        }
      : null,
  };
}

export function toInputDto(input: InputRecord): CloudInputDto {
  return {
    commandId: input.commandId,
    intent: input.intent,
    status: input.deliveryStatus,
    createdAt: input.createdAt,
    runtimeAckedAt: input.runtimeAckedAt,
    lastError: input.lastError,
  };
}

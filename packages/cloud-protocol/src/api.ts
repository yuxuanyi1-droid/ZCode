import { z } from "zod";

import { CLOUD_INPUT_INTENTS, CLOUD_RUN_STATUSES, CLOUD_TASK_STATUSES } from "./constants.js";

export type CloudTaskStatus = (typeof CLOUD_TASK_STATUSES)[number];
export type CloudRunStatus = (typeof CLOUD_RUN_STATUSES)[number];
export type CloudInputIntent = (typeof CLOUD_INPUT_INTENTS)[number];

export interface CloudProjectDto {
  id: string;
  name: string;
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  createdAt: number;
}

export interface CloudRunSummaryDto {
  id: string;
  generation: number;
  status: CloudRunStatus;
  provider: string;
  checkoutPath: string | null;
  lastError: string | null;
  dataAtRisk: boolean;
  createdAt: number;
  readyAt: number | null;
  endedAt: number | null;
}

export interface CloudArtifactDto {
  kind: "code" | "noChanges";
  taskBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prStatus: string | null;
  publishedSha: string | null;
}

export interface CloudTaskDto {
  id: string;
  projectId: string;
  title: string;
  status: CloudTaskStatus;
  taskStableId: string;
  workspaceIdentity: string;
  baseBranch: string | null;
  baseSha: string | null;
  taskBranch: string | null;
  activeRunId: string | null;
  createdAt: number;
  updatedAt: number;
  run: CloudRunSummaryDto | null;
  artifact: CloudArtifactDto | null;
}

export interface CloudInputDto {
  commandId: string;
  intent: CloudInputIntent;
  status: string;
  createdAt: number;
  runtimeAckedAt: number | null;
  lastError: string | null;
}

export interface CloudHistoryEventDto {
  logEpoch: number;
  seq: number;
  kind: string;
  payload: unknown;
  ingestedAt: number;
}

export interface CloudHistoryPageDto {
  events: CloudHistoryEventDto[];
  nextCursor: string | null;
}

export interface CloudProviderCapabilityDto {
  id: string;
  label: string;
  pause: boolean;
  maxLifetimeSeconds: number;
  verified: boolean;
}

export interface CloudProjectListDto {
  projects: CloudProjectDto[];
}

export interface CloudTaskListDto {
  tasks: CloudTaskDto[];
  nextCursor: string | null;
}

export const createProjectRequestSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    repoUrl: z.string().trim().min(1),
    defaultBranch: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const createTaskRequestSchema = z
  .object({
    projectId: z.string().min(1),
    title: z.string().trim().min(1).max(200).optional(),
    baseBranch: z.string().trim().min(1).max(200).optional(),
  })
  .strict();

export const submitInputRequestSchema = z
  .object({
    commandId: z.string().min(1).max(128),
    intent: z.enum(["start", "append"]),
    prompt: z.string().min(1).max(200_000),
    modelSelection: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const reopenTaskRequestSchema = z.object({}).strict();

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;
export type SubmitInputRequest = z.infer<typeof submitInputRequestSchema>;

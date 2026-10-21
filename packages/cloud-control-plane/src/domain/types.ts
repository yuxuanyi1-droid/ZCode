import type { CloudInputIntent, CloudRunStatus, CloudTaskStatus } from "@zcode/cloud-protocol";

export interface ProjectRecord {
  id: string;
  name: string;
  repoUrl: string;
  repoOwner: string;
  repoName: string;
  defaultBranch: string;
  createdAt: number;
}

export interface TaskRecord {
  id: string;
  projectId: string;
  title: string;
  status: CloudTaskStatus;
  provider: string;
  taskStableId: string;
  workspaceIdentity: string;
  baseBranch: string | null;
  baseSha: string | null;
  taskBranch: string | null;
  activeRunId: string | null;
  nextRunGeneration: number;
  revision: number;
  archivedAt: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface RunRecord {
  id: string;
  taskId: string;
  generation: number;
  status: CloudRunStatus;
  provider: string;
  providerHandle: string | null;
  templateVersion: string;
  checkoutPath: string;
  attachTokenEnc: string;
  createdAt: number;
  readyAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  lastError: string | null;
  dataAtRisk: boolean;
}

export interface InputRecord {
  id: string;
  taskId: string;
  commandId: string;
  intent: CloudInputIntent;
  payloadJson: string;
  payloadHash: string;
  acceptanceSeq: number;
  deliveryStatus: "accepted" | "delivered" | "acked" | "failed";
  targetRunId: string | null;
  deliveredAt: number | null;
  runtimeAckedAt: number | null;
  lastError: string | null;
  createdAt: number;
}

export interface ArtifactRecord {
  taskId: string;
  kind: "code" | "noChanges";
  taskBranch: string | null;
  prNumber: number | null;
  prUrl: string | null;
  prStatus: string | null;
  publishedSha: string | null;
  updatedAt: number;
}

export interface ProjectionRecord {
  taskId: string;
  logEpoch: number;
  seq: number;
  kind: string;
  payloadJson: string;
  ingestedAt: number;
}

/**
 * 存储端口 fake：Project/Task/Run repository 与整体装配（输入/投影/凭据/写路径见同目录其余 fake 文件）。
 * 语义对齐端口 JSDoc：唯一约束、CAS（revision/generation）、事务内 count+reserve（08 §6）。
 */
import type { CloudProjectRecord, CloudRunRecord, CloudTaskRecord } from "@zcode/shared";
import type {
  ProjectRepo,
  RunRepo,
  StoragePort,
  TaskRepo,
} from "../src/cloud/app/ports/storagePort.js";
import type { ClockPort } from "../src/cloud/app/ports/clockPort.js";
import type { FakeOutbox } from "./cloudCoreFakes.js";
import {
  paginate,
  createCredentialsRepo,
  createInputsRepo,
  createPayloadReadRepo,
  createProjectionsRepo,
  createStorageFakeState,
} from "./cloudCoreStorageRepoFakes.js";
import { createWritePathFake } from "./cloudCoreStorageWriteFake.js";

export interface FakeStorageOptions {
  maxConcurrentRuns?: number;
  /** 令 recordProviderHandle 返回 false（迟到 handle / 旧代际）。 */
  failRecordProviderHandle?: boolean;
  /** 模拟 DB worker 失败/磁盘满：事务提交前抛错（CP-02）。 */
  failAcceptInput?: boolean;
  writable?: boolean;
}

export interface FakeStorage extends StoragePort {
  readonly projectsById: Map<string, CloudProjectRecord>;
  readonly tasksById: Map<string, CloudTaskRecord>;
  readonly runsById: Map<string, CloudRunRecord>;
  readonly inputsByKey: Map<string, CloudTaskInputRecord>;
  readonly checkpoints: CloudCheckpointRecord[];
  readonly projectionRecords: CloudProjectionRecord[];
  readonly revokedRuns: string[];
  readonly quotaReleases: string[];
  /** 持久正文（投递时只读；不进 receipt 投影、不进日志，02 §6.1）。 */
  readonly payloadText: Map<string, string>;
  taskRevisionBumps: number;
  createOperations: string[];
}

export function createFakeStorage(
  clock: ClockPort,
  outbox: FakeOutbox,
  options: FakeStorageOptions = {},
): FakeStorage {
  const state = createStorageFakeState();
  const {
    projectsById,
    tasksById,
    runsById,
    inputsByKey,
    checkpoints,
    projectionRecords,
    revokedRuns,
    quotaReleases,
    payloadText,
  } = state;
  const createOperations: string[] = [];
  const inputsRepo = createInputsRepo(state);
  const projectionsRepo = createProjectionsRepo(state);
  const credentialsRepo = createCredentialsRepo(state);
  const payloadsRepo = createPayloadReadRepo(state);
  const projectsRepo: ProjectRepo = {
    async get(projectId) {
      return projectsById.get(projectId) ?? null;
    },
    async findByRepository(principalId, repositoryId) {
      return (
        [...projectsById.values()].find(
          (item) => item.ownerPrincipalId === principalId && item.repositoryId === repositoryId,
        ) ?? null
      );
    },
    async createOrGet(request) {
      const existing = await projectsRepo.findByRepository(
        request.ownerPrincipalId,
        request.repositoryId,
      );
      if (existing) return existing;
      const record: CloudProjectRecord = {
        projectId: request.projectId,
        ownerPrincipalId: request.ownerPrincipalId,
        kind: request.kind,
        repositoryId: request.repositoryId,
        installationId: request.installationId,
        repoOwner: request.repoOwner,
        repoName: request.repoName,
        defaultBranch: request.defaultBranch,
        displayName: request.displayName,
        revision: 0,
        createdAt: request.now,
        updatedAt: request.now,
      };
      projectsById.set(record.projectId, record);
      return record;
    },
    async list(principalId, page) {
      return paginate(
        [...projectsById.values()].filter((item) => item.ownerPrincipalId === principalId),
        page,
      );
    },
    async patchMetadata(request) {
      const current = projectsById.get(request.projectId);
      if (!current || current.revision !== request.expectedRevision) return null;
      const updated: CloudProjectRecord = {
        ...current,
        displayName: request.displayName ?? current.displayName,
        revision: current.revision + 1,
        updatedAt: request.now,
      };
      projectsById.set(updated.projectId, updated);
      return updated;
    },
  };

  const tasksRepo: TaskRepo = {
    async get(taskId) {
      return tasksById.get(taskId) ?? null;
    },
    async findByCreationKey(ownerPrincipalId, creationKey) {
      return (
        [...tasksById.values()].find(
          (item) => item.ownerPrincipalId === ownerPrincipalId && item.creationKey === creationKey,
        ) ?? null
      );
    },
    async createDraft(request) {
      const record: CloudTaskRecord = {
        taskId: request.taskId,
        ownerPrincipalId: request.ownerPrincipalId,
        projectId: request.projectId,
        title: request.title,
        status: "draft",
        creationKey: request.creationKey,
        draftStartConfig: request.draftStartConfig,
        workspaceIdentity: request.workspaceIdentity,
        nextRunGeneration: 1,
        revision: 0,
        createdAt: request.now,
        updatedAt: request.now,
      };
      tasksById.set(record.taskId, record);
      return record;
    },
    async listByProject(projectId, page) {
      return paginate(
        [...tasksById.values()].filter((item) => item.projectId === projectId),
        page,
      );
    },
    async patchMetadata(request) {
      const current = tasksById.get(request.taskId);
      if (!current || current.revision !== request.expectedRevision) return null;
      const updated: CloudTaskRecord = {
        ...current,
        title: request.title ?? current.title,
        draftStartConfig: request.draftStartConfig ?? current.draftStartConfig,
        revision: current.revision + 1,
        updatedAt: request.now,
      };
      tasksById.set(updated.taskId, updated);
      return updated;
    },
    async transitionStatus(request) {
      const current = tasksById.get(request.taskId);
      if (!current) return null;
      if (!request.from.includes(current.status)) return null;
      if (request.revision !== undefined && request.revision !== current.revision) return null;
      const updated: CloudTaskRecord = {
        ...current,
        status: request.to,
        revision: current.revision + 1,
        updatedAt: request.now,
      };
      if (request.activeRunId !== undefined && request.activeRunId !== null) {
        updated.activeRunId = request.activeRunId;
      }
      if (request.archivedFromStatus) updated.archivedFromStatus = request.archivedFromStatus;
      if (request.completeRequested !== undefined) {
        updated.completeRequested = request.completeRequested;
      }
      tasksById.set(updated.taskId, updated);
      return updated;
    },
    async freezeBaseline(request) {
      const current = tasksById.get(request.taskId);
      if (!current) throw new Error("task missing");
      const updated: CloudTaskRecord = {
        ...current,
        baseBranch: request.baseBranch,
        baseSha: request.baseSha,
        taskBranch: request.taskBranch,
        updatedAt: request.now,
      };
      tasksById.set(updated.taskId, updated);
      return updated;
    },
    async recordCheckpointSha(request) {
      const current = tasksById.get(request.taskId);
      if (!current) return;
      tasksById.set(current.taskId, {
        ...current,
        lastCheckpointSha: request.remoteSha,
        updatedAt: request.now,
      });
    },
    async recordArtifact() {
      return;
    },
    async setCompleteRequested(request) {
      const current = tasksById.get(request.taskId);
      if (!current || current.revision !== request.expectedRevision) return null;
      const updated: CloudTaskRecord = {
        ...current,
        completeRequested: request.requested,
        revision: current.revision + 1,
        updatedAt: request.now,
      };
      tasksById.set(updated.taskId, updated);
      return updated;
    },
  };

  const runsRepo: RunRepo = {
    async get(runId) {
      return runsById.get(runId) ?? null;
    },
    async activeOfTask(taskId) {
      return (
        [...runsById.values()]
          .filter((item) => item.taskId === taskId)
          .sort((left, right) => right.runGeneration - left.runGeneration)[0] ?? null
      );
    },
    async reserveRun(request) {
      const task = tasksById.get(request.taskId);
      if (!task) throw new Error("task missing");
      const run: CloudRunRecord = {
        runId: request.runId,
        taskId: request.taskId,
        runGeneration: task.nextRunGeneration,
        executionKind: "sandbox",
        firstInputCommandId: request.firstInputCommandId,
        executionRecipe: request.executionRecipe,
        provider: request.executionRecipe.provider,
        status: "provisioning",
        connectionEpoch: 1,
        dataAtRisk: false,
        createdAt: request.now,
        updatedAt: request.now,
      };
      runsById.set(run.runId, run);
      tasksById.set(task.taskId, {
        ...task,
        status: "active",
        activeRunId: run.runId,
        nextRunGeneration: task.nextRunGeneration + 1,
        revision: task.revision + 1,
        updatedAt: request.now,
      });
      return { run, runGeneration: run.runGeneration };
    },
    async listNonTerminal() {
      return [...runsById.values()].filter(
        (item) =>
          item.status !== "stopped" && item.status !== "expired" && item.status !== "failed",
      );
    },
    async recordProviderHandle(request) {
      const run = runsById.get(request.runId);
      if (!run) return false;
      // 故障注入：模拟"写 handle 前 run 已被新代际接管/终态"的迟到 handle 路径。
      if (options.failRecordProviderHandle) return false;
      if (run.runGeneration !== request.runGeneration) return false;
      runsById.set(run.runId, {
        ...run,
        provider: request.provider,
        providerHandle: request.providerHandle,
        workspacePath: request.workspacePath ?? run.workspacePath,
        expiresAt: request.providerDeadline ?? run.expiresAt,
        deadlineEstimate: request.deadlineEstimate ?? run.deadlineEstimate,
        updatedAt: request.now,
      });
      return true;
    },
    async transitionStatus(request) {
      const run = runsById.get(request.runId);
      if (!run || run.runGeneration !== request.runGeneration) return null;
      if (!request.from.includes(run.status)) return null;
      const updated: CloudRunRecord = {
        ...run,
        status: request.to,
        endReason: request.endReason ?? run.endReason,
        lastError: request.lastError ?? run.lastError,
        dataAtRisk: request.dataAtRisk ?? run.dataAtRisk,
        updatedAt: request.now,
      };
      runsById.set(updated.runId, updated);
      return updated;
    },
    async bumpConnectionEpoch(request) {
      const run = runsById.get(request.runId);
      if (!run || run.runGeneration !== request.runGeneration) return null;
      if (run.connectionEpoch !== request.expectedEpoch) return run.connectionEpoch;
      const next = run.connectionEpoch + 1;
      runsById.set(run.runId, { ...run, connectionEpoch: next });
      return next;
    },
    async updateLease(request) {
      const run = runsById.get(request.runId);
      if (!run || run.runGeneration !== request.runGeneration) return false;
      runsById.set(run.runId, {
        ...run,
        expiresAt: request.expiresAt ?? run.expiresAt,
        deadlineEstimate: request.deadlineEstimate ?? run.deadlineEstimate,
        deadlineConfidence: request.deadlineConfidence ?? run.deadlineConfidence,
        hardDeadlineAt: request.hardDeadlineAt ?? run.hardDeadlineAt,
        updatedAt: request.now,
      });
      return true;
    },
    async touchBusinessActivity(request) {
      const run = runsById.get(request.runId);
      if (!run) return;
      runsById.set(run.runId, { ...run, lastBusinessActivityAt: request.at });
    },
    async requestStop(request) {
      const run = [...runsById.values()]
        .filter((item) => item.taskId === request.taskId)
        .sort((left, right) => right.runGeneration - left.runGeneration)[0];
      if (!run) return false;
      runsById.set(run.runId, {
        ...run,
        stopRequested: true,
        stopOperationId: request.operationId,
        updatedAt: request.now,
      });
      return true;
    },
    async clearStopRequest(request) {
      const run = [...runsById.values()].find(
        (item) =>
          item.taskId === request.taskId && item.stopOperationId === request.expectedOperationId,
      );
      if (!run) return false;
      runsById.set(run.runId, { ...run, stopRequested: false, stopOperationId: undefined });
      return true;
    },
    async releaseQuota(request) {
      // 配额释放只记录事实（测试断言用）：端口语义是「provider 确认后才释放」（01 §4.3）。
      quotaReleases.push(request.runId);
    },
    async setRunRuntimeSessionId(request) {
      const run = runsById.get(request.runId);
      if (!run || run.runGeneration !== request.runGeneration) return false;
      runsById.set(run.runId, { ...run, runtimeSessionId: request.runtimeSessionId });
      return true;
    },
    async setRunDataAtRisk(request) {
      const run = runsById.get(request.runId);
      if (!run || run.runGeneration !== request.runGeneration) return false;
      runsById.set(run.runId, { ...run, dataAtRisk: request.dataAtRisk });
      return true;
    },
  };

  const storage: FakeStorage = {
    projectsById,
    tasksById,
    runsById,
    inputsByKey,
    checkpoints,
    projectionRecords,
    revokedRuns,
    quotaReleases,
    payloadText,
    get taskRevisionBumps() {
      return state.taskRevisionBumps.value;
    },
    createOperations,
    projects: projectsRepo,
    tasks: tasksRepo,
    runs: runsRepo,
    inputs: inputsRepo,
    projections: projectionsRepo,
    credentials: credentialsRepo,
    payloads: payloadsRepo,
    ...createWritePathFake({
      state,
      runs: runsRepo,
      tasks: tasksRepo,
      outbox,
      options,
      createOperations,
    }),
  };
  return storage;
}

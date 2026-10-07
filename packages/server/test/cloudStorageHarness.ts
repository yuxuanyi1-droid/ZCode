/**
 * cloud storage 集成测试脚手架（W2 §6：临时 SQLite + 临时附件目录）。
 *
 * 只做装配与清理，不含断言：每个测试文件各自建库、跑完删除，避免共享状态掩盖事务
 * 隔离问题。默认走 `in-process` 传输（同一份运行时，便于单步调试），需要验证真实
 * worker 线程的用例显式传 `transportMode: "worker"`。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createCloudStorage } from "../src/cloud/adapters/storage/cloudStorageClient.js";
import type {
  CloudStorage,
  CloudStorageOptions,
} from "../src/cloud/adapters/storage/cloudStorageClient.js";

/** 固定基准时间：所有端口方法都显式传 now，测试不依赖真实时钟。 */
export const TEST_NOW = 1_760_000_000_000;

export function nextNow(offsetMs: number): number {
  return TEST_NOW + offsetMs;
}

export interface TestStorageHandle {
  readonly storage: CloudStorage;
  readonly root: string;
  readonly dataDir: string;
  readonly attachmentsDir: string;
  readonly databasePath: string;
  close(): Promise<void>;
}

export interface OpenTestStorageOptions {
  transportMode?: CloudStorageOptions["transportMode"];
  faults?: CloudStorageOptions["faults"];
  attachmentLimits?: CloudStorageOptions["attachmentLimits"];
  thresholds?: CloudStorageOptions["thresholds"];
  synchronous?: CloudStorageOptions["synchronous"];
  /** 复用既有根目录（重启/崩溃恢复用例）。 */
  root?: string;
}

export async function openTestStorage(
  options: OpenTestStorageOptions = {},
): Promise<TestStorageHandle> {
  const root = options.root ?? (await mkdtemp(path.join(tmpdir(), "zcode-cloud-storage-")));
  const dataDir = path.join(root, "data");
  const attachmentsDir = path.join(root, "attachments");
  const storage = await createCloudStorage({
    dataDir,
    attachmentsDir,
    transportMode: options.transportMode ?? "in-process",
    ...(options.faults === undefined ? {} : { faults: options.faults }),
    ...(options.attachmentLimits === undefined
      ? {}
      : { attachmentLimits: options.attachmentLimits }),
    ...(options.thresholds === undefined ? {} : { thresholds: options.thresholds }),
    ...(options.synchronous === undefined ? {} : { synchronous: options.synchronous }),
  });
  return {
    storage,
    root,
    dataDir,
    attachmentsDir,
    databasePath: path.join(dataDir, "cloud.db"),
    async close() {
      await storage.close();
    },
  };
}

export async function removeTestRoot(root: string): Promise<void> {
  await rm(root, { recursive: true, force: true });
}

export function newUuid(): string {
  return randomUUID();
}

export interface SeededTask {
  principalId: string;
  projectId: string;
  taskId: string;
}

/** 建 subject/project/draft task 的最小前置（03 §3/§4、11 §4）。 */
export async function seedDraftTask(
  storage: CloudStorage,
  options: {
    now?: number;
    creationKey?: string;
    repositoryId?: number;
    /** 传 null 表示刻意不写草稿启动配置（首个 start 才固定选择，11 §5）。 */
    draftStartConfig?: { baseBranch: string; provider: string } | null;
    taskId?: string;
    projectId?: string;
  } = {},
): Promise<SeededTask> {
  const now = options.now ?? TEST_NOW;
  const principalId = newUuid();
  await storage.ensurePrincipal({ principalId, now });
  const project = await storage.storage.projects.createOrGet({
    projectId: options.projectId ?? newUuid(),
    ownerPrincipalId: principalId,
    kind: "github-repo",
    repositoryId: options.repositoryId ?? 42,
    installationId: 7,
    repoOwner: "zcode",
    repoName: "cloud-fixture",
    defaultBranch: "main",
    now,
  });
  const taskId = options.taskId ?? newUuid();
  const task = await storage.storage.tasks.createDraft({
    taskId,
    ownerPrincipalId: principalId,
    projectId: project.projectId,
    title: "fixture task",
    creationKey: options.creationKey ?? `ck-${taskId}`,
    draftStartConfig:
      options.draftStartConfig === null
        ? undefined
        : (options.draftStartConfig ?? { baseBranch: "main", provider: "daytona" }),
    workspaceIdentity: `cloud-task:${taskId}`,
    now,
  });
  return { principalId, projectId: project.projectId, taskId: task.taskId };
}

/** 合法 sha256 形状的占位 hash（测试不解释内容）。 */
export function fakeSha256(seed: string): string {
  const base = (seed.repeat(64) + "0".repeat(64)).slice(0, 64);
  return base.replace(/[^0-9a-f]/g, "a");
}

/** 合法 git object id（40 hex）。 */
export function fakeGitSha(seed: string): string {
  return fakeSha256(seed).slice(0, 40);
}

export interface SeededRun {
  runId: string;
  commandId: string;
  createOperationId: string;
}

/**
 * 在已 seed 的 draft task 上执行首接纳，得到一个 provisioning 状态的 run
 * （03 §6.1：Run recipe、firstInputCommandId、create 意图同一事务）。
 */
export async function seedActiveRun(
  storage: CloudStorage,
  seeded: SeededTask,
  options: {
    now?: number;
    taskBranch?: string;
    start?: { baseBranch: string; provider: string };
  } = {},
): Promise<SeededRun> {
  const now = options.now ?? TEST_NOW + 1;
  const commandId = newUuid();
  const createOperationId = newUuid();
  const result = await storage.storage.acceptInput({
    taskId: seeded.taskId,
    commandId,
    intent: "start",
    payloadHash: fakeSha256("harness"),
    prompt: "harness 首条工作",
    expectedTaskRevision: 0,
    // 启动选择必须与已持久 draftStartConfig 一致（seedDraftTask 的默认值）。
    start: options.start ?? { baseBranch: "main", provider: "daytona" },
    runRecipe: {
      provider: "daytona",
      resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
      firstCommandConfig: {},
      baseSha: fakeGitSha("harness-base"),
    },
    taskBranch: options.taskBranch ?? `cloud/harness-${seeded.taskId.slice(0, 8)}`,
    createOperationId,
    quota: { maxConcurrentRuns: 8 },
    now,
  });
  if (result.status !== "accepted" || !result.runId) {
    throw new Error(`seedActiveRun 失败：${result.status}`);
  }
  return { runId: result.runId, commandId, createOperationId };
}

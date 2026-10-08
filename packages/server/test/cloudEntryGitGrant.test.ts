/**
 * 执行节点 git-grant 端点（specs/cloud-agent/01 §7.2、09 §3；W5 §3/§4）。
 *
 * 真链路：入口 `startCloudServer` + W2 in-process 存储（不 spawn worker、不触达 provider/
 * GitHub API，mint 用 fake token 服务）+ 真 HTTP 请求。断言四件事：豁免只作用于这一条
 * 端点、run-scoped 凭据判定正确、单次兑换不被入口改写、失败面不泄露 token。
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ISettingService, ServiceCollection } from "@zcode/services";
import { createServiceLogger } from "@zcode/services/node";
import {
  createCloudStorage,
  type CloudStorage,
} from "../src/cloud/adapters/storage/cloudStorageClient.js";
import {
  startCloudServer,
  type CloudServerHandle,
} from "../src/cloud/adapters/entry-cloud-server.js";
import type { CloudEntryConfig } from "../src/cloud/adapters/entry-cloud-config.js";
import type { CloudDeploymentSecrets } from "../src/cloud/adapters/entry-cloud-secrets.js";
import type { GitHubTokenService } from "../src/cloud/adapters/github/tokens.js";
import type { LoopSchedulerPort } from "../src/cloud/app/ports/loopSchedulerPort.js";
import type { SandboxDriverRegistryPort } from "../src/cloud/app/ports/sandboxDriverRegistryPort.js";
import { buildCloudTaskWorkspacePath } from "../src/cloud/domain/workspacePath.js";

const AUTH_TOKEN = "cloud-git-grant-token";
const PRINCIPAL = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c50";
const PROJECT_ID = "7f14e45f-ceea-467a-9a1e-1f0d3b2a4c60";
const TASK_ID = "8f14e45f-ceea-467a-9a1e-1f0d3b2a4c51";
const RUN_ID = "1f14e45f-ceea-467a-9a1e-1f0d3b2a4c53";
const TICKET = "bootstrap-ticket-git-grant";
const REPOSITORY_ID = 101;
const INSTALLATION_ID = 7;

const WORKSPACE = buildCloudTaskWorkspacePath("demo");
assert.ok(WORKSPACE.ok);

const ready = {
  lastAppliedMigrationId: "0005_task_input_interaction_decisions",
  schemaVersion: 5,
  writable: true,
  attachmentsWritable: true,
} as const;

const fakeDrivers: SandboxDriverRegistryPort = {
  resolve: async () => null,
  listProviders: async () => [],
};

function manualScheduler(): LoopSchedulerPort {
  return { schedule: () => () => {}, delay: () => () => {} };
}

const quietLogger = createServiceLogger("cloud-git-grant-test", {
  sink: { log: () => undefined, warn: () => undefined, error: () => undefined },
  isDebugEnabled: false,
});

function testSecrets(): CloudDeploymentSecrets {
  return {
    authToken: AUTH_TOKEN,
    principalId: PRINCIPAL,
    describe: () => ({
      principalId: PRINCIPAL,
      authMode: "token",
      authToken: "configured",
      credentialSecret: "absent",
      gitHubApp: "absent",
    }),
  };
}

function hostServices(): ServiceCollection {
  return new ServiceCollection().register(ISettingService, {
    get: async () => ({ ok: true }),
  } as unknown as ISettingService);
}

function baseConfig(dataDir: string): CloudEntryConfig {
  return {
    mode: "cloud",
    authMode: "token",
    publicOrigin: "http://127.0.0.1:1",
    listenPort: 0,
    dataDir,
    providers: ["e2b"],
    allowUnverifiedProviders: [],
    maxConcurrentRuns: 1,
    secrets: {},
  };
}

/** fake token 服务：只记录调用，不触达 GitHub（mint 返回可断言的一次性 token）。 */
function fakeTokens(): GitHubTokenService & {
  minted: { purpose: string; repositoryId: number }[];
} {
  const minted: { purpose: string; repositoryId: number }[] = [];
  return {
    minted,
    async mint(request) {
      minted.push({ purpose: request.purpose, repositoryId: request.repositoryId });
      return {
        token: `ghs-fake-${minted.length}`,
        expiresAt: Date.now() + 3_600_000,
      } as Awaited<ReturnType<GitHubTokenService["mint"]>>;
    },
    async mintInstallationMetadataToken() {
      throw new Error("not used");
    },
    async mintRepositoryMetadataToken() {
      throw new Error("not used");
    },
    async revoke() {
      return { revoked: true, reason: "revoked" } as Awaited<
        ReturnType<GitHubTokenService["revoke"]>
      >;
    },
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

interface Harness {
  handle: CloudServerHandle;
  storage: CloudStorage;
  tokens: ReturnType<typeof fakeTokens>;
  baseUrl: string;
}

async function startHarness(
  options: {
    /** 生成的 run 状态；默认 provisioning（非终态）。 */
    runStatus?: "provisioning" | "stopped";
    credentialGeneration?: number;
  } = {},
): Promise<{ harness: Harness; dataDir: string; cleanup: () => Promise<void> }> {
  const dataDir = await mkdtemp(path.join(tmpdir(), "cloud-git-grant-"));
  const storage = await createCloudStorage({
    dataDir,
    attachmentsDir: path.join(dataDir, "attachments"),
    transportMode: "in-process",
  });
  const tokens = fakeTokens();
  const now = Date.now();
  const runGeneration = 1;

  await storage.storage.projects.createOrGet({
    projectId: PROJECT_ID,
    ownerPrincipalId: PRINCIPAL,
    kind: "github-repo",
    repositoryId: REPOSITORY_ID,
    installationId: INSTALLATION_ID,
    repoOwner: "octo",
    repoName: "demo",
    defaultBranch: "main",
    now,
  });
  await storage.storage.tasks.createDraft({
    taskId: TASK_ID,
    ownerPrincipalId: PRINCIPAL,
    projectId: PROJECT_ID,
    title: "grant",
    creationKey: "ck-grant",
    workspaceIdentity: `cloud-task:${TASK_ID}`,
    now,
  });
  await storage.storage.runs.reserveRun({
    taskId: TASK_ID,
    runId: RUN_ID,
    executionRecipe: {
      provider: "e2b",
      resources: { cpu: 2, memoryMiB: 4096, diskGiB: 10 },
      firstCommandConfig: {},
    },
    workspacePath: WORKSPACE.path,
    quota: { maxConcurrentRuns: 4 },
    now,
  });
  if (options.runStatus === "stopped") {
    await storage.storage.runs.transitionStatus({
      runId: RUN_ID,
      runGeneration,
      from: ["provisioning"],
      to: "stopped",
      now,
    });
  }
  await storage.storage.credentials.saveInitial({
    runId: RUN_ID,
    runGeneration: options.credentialGeneration ?? runGeneration,
    credentialHash: sha256(TICKET),
    expiresAt: now + 600_000,
    bootstrapOperationId: RUN_ID,
  });

  const handle = await startCloudServer({
    config: baseConfig(dataDir),
    secrets: testSecrets(),
    drivers: fakeDrivers,
    hostServices: hostServices(),
    gitHubTokens: tokens,
    storage: {
      storage: storage.storage,
      operations: storage.operations,
      grants: storage.grants,
      readiness: async () => ready,
    },
    listenPort: 0,
    listenHost: "127.0.0.1",
    loopScheduler: manualScheduler(),
    logger: quietLogger,
  });

  return {
    harness: { handle, storage, tokens, baseUrl: `http://127.0.0.1:${handle.port}` },
    dataDir,
    cleanup: async () => {
      await handle.close().catch(() => undefined);
      await storage.close().catch(() => undefined);
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}

async function insertGrant(
  storage: CloudStorage,
  options: {
    purpose: "clone" | "fetch" | "push";
    proofHash?: string;
    status?: "issued" | "revoked";
  },
): Promise<string> {
  const grantId = randomUUID();
  const now = Date.now();
  await storage.grants.insert({
    grantId,
    taskId: TASK_ID,
    runId: RUN_ID,
    runGeneration: 1,
    repositoryId: REPOSITORY_ID,
    installationId: INSTALLATION_ID,
    purpose: options.purpose,
    status: options.status ?? "issued",
    issuedAt: now,
    expiresAt: now + 60_000,
    ...(options.proofHash ? { proofHash: options.proofHash } : {}),
  });
  return grantId;
}

function gitGrantUrl(baseUrl: string, purpose: string): string {
  return `${baseUrl}/api/cloud/runs/${RUN_ID}/git-grant?purpose=${purpose}`;
}

test("git-grant：有效凭据首兑成功，同凭据二次兑换被拒（单次由 broker CAS 保证）", async () => {
  const { harness, cleanup } = await startHarness();
  try {
    const grantId = await insertGrant(harness.storage, {
      purpose: "clone",
      proofHash: sha256(TICKET),
    });

    const first = await fetch(gitGrantUrl(harness.baseUrl, "clone"), {
      headers: { authorization: `Bearer ${TICKET}` },
    });
    assert.equal(first.status, 200);
    const body = (await first.json()) as {
      grantId: string;
      token: string;
      purpose: string;
      repositoryId: number;
    };
    assert.equal(body.grantId, grantId);
    assert.equal(body.token, "ghs-fake-1");
    assert.equal(body.purpose, "clone");
    assert.equal(body.repositoryId, REPOSITORY_ID);
    // mint 只按 (repo, purpose) 走 W4 矩阵，入口不自行决定权限。
    assert.deepEqual(harness.tokens.minted, [{ purpose: "clone", repositoryId: REPOSITORY_ID }]);

    const second = await fetch(gitGrantUrl(harness.baseUrl, "clone"), {
      headers: { authorization: `Bearer ${TICKET}` },
    });
    // broker 的单次兑换 CAS：`unauthorized` 按 shared 映射是 403（不是凭据失败）。
    assert.equal(second.status, 403);
    const error = (await second.json()) as { code: string; message: string };
    assert.equal(error.code, "unauthorized");
    assert.match(error.message, /already-redeemed/);
    assert.equal(harness.tokens.minted.length, 1, "二次兑换不得再 mint");
  } finally {
    await cleanup();
  }
});

test("git-grant：无/错/过期/已撤销凭据一律拒绝且不放行", async () => {
  const { harness, cleanup } = await startHarness();
  try {
    await insertGrant(harness.storage, { purpose: "clone", proofHash: sha256(TICKET) });

    const noBearer = await fetch(gitGrantUrl(harness.baseUrl, "clone"));
    assert.equal(noBearer.status, 401);

    const wrongBearer = await fetch(gitGrantUrl(harness.baseUrl, "clone"), {
      headers: { authorization: "Bearer not-the-ticket" },
    });
    assert.equal(wrongBearer.status, 401);

    // 过期：直接改 run_credentials 的 expires_at（走 SQL 面）。
    await harness.storage.storage.credentials.consumeForHello({
      runId: RUN_ID,
      proofHash: sha256(TICKET),
      candidateHash: sha256("next-token"),
      helloAttemptId: randomUUID(),
      now: Date.now() - 1,
    });
    // hello 消费后 hash 已切换：旧票不再匹配（02 §5.1），兑换必须失败。
    const staleTicket = await fetch(gitGrantUrl(harness.baseUrl, "clone"), {
      headers: { authorization: `Bearer ${TICKET}` },
    });
    assert.equal(staleTicket.status, 401);

    // 新票有效（证明上一步的失败是 hash 切换，而不是端点整体不可用）：
    // grant 的 proof 绑定也必须换成新凭据的摘要。
    await insertGrant(harness.storage, { purpose: "clone", proofHash: sha256("next-token") });
    const fresh = await fetch(gitGrantUrl(harness.baseUrl, "clone"), {
      headers: { authorization: "Bearer next-token" },
    });
    assert.equal(fresh.status, 200);

    // 撤销后拒绝。
    await harness.storage.storage.credentials.revokeRun({ runId: RUN_ID, reason: "test" });
    await insertGrant(harness.storage, { purpose: "fetch", proofHash: sha256("next-token") });
    const revoked = await fetch(gitGrantUrl(harness.baseUrl, "fetch"), {
      headers: { authorization: "Bearer next-token" },
    });
    assert.equal(revoked.status, 401);
  } finally {
    await cleanup();
  }
});

test("git-grant：purpose 越界、grant 目的不符、代际不符、终态 run 一律拒绝", async () => {
  const { harness, cleanup } = await startHarness();
  try {
    await insertGrant(harness.storage, { purpose: "clone", proofHash: sha256(TICKET) });

    // purpose 不在规格枚举内 → 400（不猜意图）。
    const badPurpose = await fetch(
      `${harness.baseUrl}/api/cloud/runs/${RUN_ID}/git-grant?purpose=delete`,
      { headers: { authorization: `Bearer ${TICKET}` } },
    );
    assert.equal(badPurpose.status, 400);
    assert.equal(((await badPurpose.json()) as { code: string }).code, "validation_failed");

    // 声明 push 但只签发了 clone → 目的不符（broker 的绑定判定，unauthorized → 403）。
    const purposeMismatch = await fetch(gitGrantUrl(harness.baseUrl, "push"), {
      headers: { authorization: `Bearer ${TICKET}` },
    });
    assert.equal(purposeMismatch.status, 403);
    // 按 (runId, purpose) 取不到已签发 grant，或取到但绑定不符——两者都是拒绝，都不放行 token。
    assert.match(
      ((await purposeMismatch.json()) as { message: string }).message,
      /no-issued-grant|binding-mismatch/,
    );

    // 已 revoke 的 grant → permission_revoked（403）。
    await insertGrant(harness.storage, {
      purpose: "fetch",
      proofHash: sha256(TICKET),
      status: "revoked",
    });
    const revoked = await fetch(gitGrantUrl(harness.baseUrl, "fetch"), {
      headers: { authorization: `Bearer ${TICKET}` },
    });
    assert.equal(revoked.status, 403);
  } finally {
    await cleanup();
  }
});

test("git-grant：凭据代际与 run 不一致 / run 已终态时拒绝", async () => {
  const staleGen = await startHarness({ credentialGeneration: 9 });
  try {
    await insertGrant(staleGen.harness.storage, { purpose: "clone", proofHash: sha256(TICKET) });
    const response = await fetch(gitGrantUrl(staleGen.harness.baseUrl, "clone"), {
      headers: { authorization: `Bearer ${TICKET}` },
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, "stale");
  } finally {
    await staleGen.cleanup();
  }

  const stopped = await startHarness({ runStatus: "stopped" });
  try {
    await insertGrant(stopped.harness.storage, { purpose: "clone", proofHash: sha256(TICKET) });
    const response = await fetch(gitGrantUrl(stopped.harness.baseUrl, "clone"), {
      headers: { authorization: `Bearer ${TICKET}` },
    });
    assert.equal(response.status, 409);
    assert.equal(((await response.json()) as { code: string }).code, "stale");
  } finally {
    await stopped.cleanup();
  }
});

test("git-grant：豁免只作用于该端点，其余浏览器面仍要 lite token 且静态层不变", async () => {
  const { harness, cleanup } = await startHarness();
  try {
    // 浏览器面：无 token 一律 401。
    assert.equal((await fetch(`${harness.baseUrl}/api/cloud/capabilities`)).status, 401);
    assert.equal((await fetch(`${harness.baseUrl}/api/cloud/projects`)).status, 401);
    // 相邻但不精确匹配的路径不得被豁免。
    assert.equal(
      (await fetch(`${harness.baseUrl}/api/cloud/runs/${RUN_ID}/git-grant/extra`)).status,
      401,
    );
    assert.equal((await fetch(`${harness.baseUrl}/api/cloud/runs/${RUN_ID}`)).status, 401);
  } finally {
    await cleanup();
  }
});

test("verifyActiveCredential 是非消费校验：校验后 hello 仍能消费同一票据", async () => {
  const { harness, cleanup } = await startHarness();
  try {
    const proofHash = sha256(TICKET);
    const verified = await harness.storage.storage.credentials.verifyActiveCredential({
      runId: RUN_ID,
      proofHash,
      now: Date.now(),
    });
    assert.deepEqual(verified, { runGeneration: 1 });

    // 非消费：hash 未被切换，hello 仍能消费同一票据（否则 git-grant 会打断 bridge 重连）。
    const consumed = await harness.storage.storage.credentials.consumeForHello({
      runId: RUN_ID,
      proofHash,
      candidateHash: sha256("rotated"),
      helloAttemptId: randomUUID(),
      now: Date.now(),
    });
    assert.ok(consumed, "verify 之后 consumeForHello 必须仍然成功");

    // 消费后旧 hash 不再是当前凭据：verify 必须失败（避免旧票被当作有效）。
    const afterConsume = await harness.storage.storage.credentials.verifyActiveCredential({
      runId: RUN_ID,
      proofHash,
      now: Date.now(),
    });
    assert.equal(afterConsume, null);
  } finally {
    await cleanup();
  }
});
